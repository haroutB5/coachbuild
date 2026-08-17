using System.Globalization;
using System.Net.Http;
using System.Text.Json;

namespace CoachBuild.Core;

public enum SkillOrderStatus
{
    Ok,
    NoData,
    Error,
}

public enum OverlayAbility
{
    Q,
    W,
    E,
    R,
}

/// <summary>
/// The Core representation of the native overlay's skill-order projection.
/// It intentionally contains only the fields the overlay renders.
/// </summary>
public sealed record OverlaySkillOrder(
    IReadOnlyList<OverlayAbility> Order,
    int ObservedLevels,
    bool Completed,
    string? CompletionBasis = null)
{
    public static OverlaySkillOrder Empty { get; } = new(Array.Empty<OverlayAbility>(), 0, false);
}

public sealed record SkillOrderResult(
    SkillOrderStatus Status,
    OverlaySkillOrder Order,
    int ChampionId,
    int SampleSize = 0);

public interface ISkillOrderProvider
{
    Task<SkillOrderResult> GetSkillOrderAsync(int championId, string? role, CancellationToken ct);
}

public interface IPerGameSkillOrderCache
{
    void ClearSkillOrderCache();
}

/// <summary>
/// Fetches the same public endpoint and preserves skillOrderData.js's
/// per-game cache semantics: successful orders never expire, no-data retries
/// after 60 seconds, and errors retry after 15 seconds. Requests for an unset
/// role (or RoleId 5) resolve to no-data without making a request.
/// </summary>
public sealed class SkillOrderProvider : ISkillOrderProvider, IPerGameSkillOrderCache, IDisposable
{
    public const int ErrorRetryMilliseconds = 15_000;
    public const int NoDataRetryMilliseconds = 60_000;
    public static readonly Uri DefaultEndpoint = new(
        "https://coachbuild.vercel.app/api/skill-order",
        UriKind.Absolute);

    private readonly HttpClient _client;
    private readonly bool _ownsClient;
    private readonly Uri _endpoint;
    private readonly TimeProvider _time;
    private readonly object _gate = new();
    private readonly Dictionary<string, CacheEntry> _cache = new(StringComparer.Ordinal);
    private readonly Dictionary<string, Task<SkillOrderResult>> _loading = new(StringComparer.Ordinal);
    private bool _disposed;

    public SkillOrderProvider(
        HttpClient? client = null,
        Uri? endpoint = null,
        TimeProvider? timeProvider = null)
    {
        _client = client ?? new HttpClient();
        _ownsClient = client is null;
        _endpoint = endpoint ?? DefaultEndpoint;
        // The 15 s / 60 s failure cooldowns below are the reason the caller's
        // retry backoff has to be longer than they are. They were untestable
        // while they read the ambient clock, so nothing pinned that
        // relationship; an injectable clock makes both halves assertable.
        _time = timeProvider ?? TimeProvider.System;
        if (!_endpoint.IsAbsoluteUri ||
            !string.Equals(_endpoint.Scheme, Uri.UriSchemeHttp, StringComparison.OrdinalIgnoreCase) &&
            !string.Equals(_endpoint.Scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase))
            throw new ArgumentException("Skill-order endpoint must be an absolute HTTP(S) URI", nameof(endpoint));
    }

    public Task<SkillOrderResult> GetSkillOrderAsync(
        int championId,
        string? role,
        CancellationToken ct)
    {
        if (_disposed) throw new ObjectDisposedException(nameof(SkillOrderProvider));
        if (championId <= 0) return Task.FromResult(NoData(championId));
        var roleId = RoleId(role);
        if (roleId is null) return Task.FromResult(NoData(championId));

        var key = $"{championId}:{roleId.Value.ToString(CultureInfo.InvariantCulture)}";
        lock (_gate)
        {
            if (_cache.TryGetValue(key, out var cached) && IsFresh(cached))
                return Task.FromResult(cached.Result);
            if (_loading.TryGetValue(key, out var loading)) return loading;

            var request = FetchAsync(championId, roleId.Value, key, ct);
            _loading[key] = request;
            // A test or a custom HttpMessageHandler can complete
            // synchronously before the assignment above. Do not leave a
            // completed task in the in-flight map after FetchAsync removed it.
            if (request.IsCompleted) _loading.Remove(key);
            return request;
        }
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        if (_ownsClient) _client.Dispose();
    }

    public void ClearSkillOrderCache()
    {
        lock (_gate) _cache.Clear();
    }

    private async Task<SkillOrderResult> FetchAsync(
        int championId,
        int roleId,
        string key,
        CancellationToken cancellationToken)
    {
        SkillOrderResult result;
        try
        {
            var uri = BuildUri(championId, roleId);
            using var response = await _client.GetAsync(
                uri,
                HttpCompletionOption.ResponseHeadersRead,
                cancellationToken).ConfigureAwait(false);
            if (!response.IsSuccessStatusCode)
            {
                result = Error(championId);
            }
            else
            {
                await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken)
                    .ConfigureAwait(false);
                using var document = await JsonDocument.ParseAsync(
                    stream,
                    cancellationToken: cancellationToken).ConfigureAwait(false);
                result = Parse(document.RootElement, championId);
            }
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            result = Error(championId);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            lock (_gate) _loading.Remove(key);
            throw;
        }
        catch (HttpRequestException)
        {
            result = Error(championId);
        }
        catch (JsonException)
        {
            result = Error(championId);
        }
        catch
        {
            result = Error(championId);
        }

        lock (_gate)
        {
            _cache[key] = new CacheEntry(result, _time.GetUtcNow());
            _loading.Remove(key);
        }
        return result;
    }

    private bool IsFresh(CacheEntry entry)
    {
        if (entry.Result.Status == SkillOrderStatus.Ok) return true;
        var cooldown = entry.Result.Status == SkillOrderStatus.NoData
            ? TimeSpan.FromMilliseconds(NoDataRetryMilliseconds)
            : TimeSpan.FromMilliseconds(ErrorRetryMilliseconds);
        return _time.GetUtcNow() - entry.CachedAt <= cooldown;
    }

    private Uri BuildUri(int championId, int roleId)
    {
        var separator = string.IsNullOrEmpty(_endpoint.Query) ? "?" : "&";
        return new Uri(
            $"{_endpoint}{separator}champ={championId.ToString(CultureInfo.InvariantCulture)}&role={roleId.ToString(CultureInfo.InvariantCulture)}",
            UriKind.Absolute);
    }

    private static SkillOrderResult Parse(JsonElement root, int championId)
    {
        if (root.ValueKind == JsonValueKind.Null) return NoData(championId);
        if (root.ValueKind != JsonValueKind.Object ||
            !root.TryGetProperty("order", out var order) ||
            order.ValueKind != JsonValueKind.Array ||
            !root.TryGetProperty("completed", out var completed) ||
            completed.ValueKind is not (JsonValueKind.True or JsonValueKind.False) ||
            !root.TryGetProperty("sampleSize", out var sampleSize) ||
            !sampleSize.TryGetInt32(out _))
            return Error(championId);

        var parsedOrder = new List<OverlayAbility>();
        foreach (var item in order.EnumerateArray())
        {
            if (item.ValueKind != JsonValueKind.String || !TryParseAbility(item.GetString(), out var ability))
                return Error(championId);
            parsedOrder.Add(ability);
        }

        var observedLevels = parsedOrder.Count;
        if (root.TryGetProperty("observedLevels", out var observed) &&
            observed.TryGetInt32(out var observedValue) && observedValue >= 0)
            observedLevels = Math.Min(observedValue, parsedOrder.Count);

        string? completionBasis = null;
        if (root.TryGetProperty("completionBasis", out var basis) && basis.ValueKind == JsonValueKind.String)
        {
            var value = basis.GetString();
            completionBasis = value is "published" or "derived" ? value : null;
        }

        return new SkillOrderResult(
            SkillOrderStatus.Ok,
            new OverlaySkillOrder(parsedOrder, observedLevels, completed.GetBoolean(), completionBasis),
            championId,
            sampleSize.GetInt32());
    }

    private static bool TryParseAbility(string? value, out OverlayAbility ability)
    {
        ability = value?.Trim().ToUpperInvariant() switch
        {
            "Q" => OverlayAbility.Q,
            "W" => OverlayAbility.W,
            "E" => OverlayAbility.E,
            "R" => OverlayAbility.R,
            _ => default,
        };
        return value is "Q" or "W" or "E" or "R";
    }

    private static int? RoleId(string? role)
    {
        if (string.IsNullOrWhiteSpace(role)) return null;
        var value = role.Trim().ToUpperInvariant();
        if (int.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out var numeric))
            return numeric is >= 0 and <= 4 ? numeric : null;
        return value switch
        {
            "TOP" => 0,
            "JUNGLE" => 1,
            "MID" or "MIDDLE" => 2,
            "BOT" or "BOTTOM" => 3,
            "SUPPORT" or "UTILITY" => 4,
            _ => null,
        };
    }

    private static SkillOrderResult NoData(int championId) =>
        new(SkillOrderStatus.NoData, OverlaySkillOrder.Empty, championId);

    private static SkillOrderResult Error(int championId) =>
        new(SkillOrderStatus.Error, OverlaySkillOrder.Empty, championId);

    private sealed record CacheEntry(SkillOrderResult Result, DateTimeOffset CachedAt);
}

/// <summary>
/// Resolves only the local player's champion id from a Live Client Data
/// player-list snapshot. It never returns or stores another player's identity.
/// </summary>
public static class LivePlayerListResolver
{
    public static int? ResolveOwnChampionId(JsonElement playerList, string? ownRiotId)
    {
        if (playerList.ValueKind != JsonValueKind.Array || string.IsNullOrWhiteSpace(ownRiotId))
            return null;
        foreach (var player in playerList.EnumerateArray())
        {
            if (player.ValueKind != JsonValueKind.Object ||
                !player.TryGetProperty("riotId", out var riotId) ||
                riotId.ValueKind != JsonValueKind.String ||
                !string.Equals(riotId.GetString(), ownRiotId, StringComparison.Ordinal))
                continue;
            return ComplianceRules.PositiveInt(player, "championId");
        }
        return null;
    }
}
