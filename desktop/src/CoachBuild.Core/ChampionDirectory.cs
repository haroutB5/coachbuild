using System.Globalization;
using System.Net.Http;
using System.Text;
using System.Text.Json;

namespace CoachBuild.Core;

/// <summary>One entry of the app's public champion roster (<c>GET /api/champions</c>).</summary>
/// <param name="Id">The numeric champion id <c>/api/skill-order?champ=</c> expects (Volibear = 106).</param>
/// <param name="Key">The locale-independent key (ddragon id): <c>Volibear</c>, <c>MonkeyKing</c>, <c>Kaisa</c>.</param>
/// <param name="Name">The display name, which IS localised upstream: <c>Wukong</c>, <c>Kai'Sa</c>.</param>
public sealed record ChampionRef(int Id, string Key, string Name);

/// <summary>Where a resolved champion id came from. Logged, so a wrong overlay is traceable to a rung.</summary>
public enum ChampionIdSource
{
    None,

    /// <summary>Matched <c>rawChampionName</c> against the roster's locale-independent key. Strongest.</summary>
    RawChampionName,

    /// <summary>Matched the localised <c>championName</c> against the roster's display name.</summary>
    ChampionName,

    /// <summary>
    /// The champion the LCU saw locked in during the champ select that this
    /// game came out of. Exact and network-free, but it says what was picked,
    /// not what is on screen — so it is only a fallback.
    /// </summary>
    ChampSelect,
}

/// <summary>
/// Folds a champion name to a comparison key.
///
/// <para>Upstream spells the same champion three ways: <c>Kaisa</c> (roster
/// key and <c>rawChampionName</c>), <c>Kai'Sa</c> (display name),
/// <c>Nunu &amp; Willump</c> vs <c>Nunu</c>, <c>Dr. Mundo</c> vs
/// <c>DrMundo</c>. Dropping everything that is not a letter or digit and
/// lowercasing makes all of those meet, and it cannot collide two real
/// champions — checked against the live 173-entry roster.</para>
/// </summary>
public static class ChampionNameKey
{
    public static string Normalize(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return string.Empty;
        var builder = new StringBuilder(value.Length);
        foreach (var character in value)
        {
            if (char.IsLetterOrDigit(character))
                builder.Append(char.ToLowerInvariant(character));
        }
        return builder.ToString();
    }
}

public static class ChampionIdLookup
{
    /// <summary>Parses the <c>GET /api/champions</c> body. Entries missing any of the three fields are dropped, not defaulted.</summary>
    public static IReadOnlyList<ChampionRef> Parse(JsonElement root)
    {
        if (root.ValueKind != JsonValueKind.Array) return Array.Empty<ChampionRef>();
        var champions = new List<ChampionRef>();
        foreach (var entry in root.EnumerateArray())
        {
            if (entry.ValueKind != JsonValueKind.Object) continue;
            var id = ComplianceRules.PositiveInt(entry, "id");
            if (id is not > 0) continue;
            var key = ReadString(entry, "key");
            var name = ReadString(entry, "name");
            if (key is null && name is null) continue;
            champions.Add(new ChampionRef(id.Value, key ?? name!, name ?? key!));
        }
        return champions;
    }

    /// <summary>
    /// Resolves the champion id from the two names Live Client Data actually
    /// publishes. The locale-independent key is tried first, against both roster
    /// columns, before the localised display name is trusted at all.
    /// </summary>
    public static (int? Id, ChampionIdSource Source) Resolve(
        IReadOnlyList<ChampionRef>? champions,
        string? rawChampionName,
        string? championName)
    {
        if (champions is null || champions.Count == 0) return (null, ChampionIdSource.None);

        var raw = ChampionNameKey.Normalize(rawChampionName);
        if (raw.Length > 0)
        {
            if (Find(champions, champion => ChampionNameKey.Normalize(champion.Key) == raw) is { } byKey)
                return (byKey, ChampionIdSource.RawChampionName);
            if (Find(champions, champion => ChampionNameKey.Normalize(champion.Name) == raw) is { } byRawAgainstName)
                return (byRawAgainstName, ChampionIdSource.RawChampionName);
        }

        var display = ChampionNameKey.Normalize(championName);
        if (display.Length > 0)
        {
            if (Find(champions, champion => ChampionNameKey.Normalize(champion.Name) == display) is { } byName)
                return (byName, ChampionIdSource.ChampionName);
            if (Find(champions, champion => ChampionNameKey.Normalize(champion.Key) == display) is { } byNameAgainstKey)
                return (byNameAgainstKey, ChampionIdSource.ChampionName);
        }

        return (null, ChampionIdSource.None);
    }

    private static int? Find(IReadOnlyList<ChampionRef> champions, Func<ChampionRef, bool> predicate)
    {
        foreach (var champion in champions)
        {
            if (predicate(champion)) return champion.Id;
        }
        return null;
    }

    private static string? ReadString(JsonElement source, string property)
    {
        if (!source.TryGetProperty(property, out var value) || value.ValueKind != JsonValueKind.String)
            return null;
        var text = value.GetString()?.Trim();
        return string.IsNullOrEmpty(text) ? null : text;
    }
}

public interface IChampionDirectory
{
    /// <summary>The roster if it has already been fetched successfully, else null. Never blocks, never fetches.</summary>
    IReadOnlyList<ChampionRef>? Cached { get; }

    /// <summary>The reason the last attempt produced nothing, for the log. Null once the roster is loaded.</summary>
    string? LastFailure { get; }

    /// <summary>Fetches the roster, deduping concurrent callers and backing off after a failure. Never throws.</summary>
    Task<IReadOnlyList<ChampionRef>?> LoadAsync(CancellationToken cancellationToken);
}

/// <summary>
/// The champion roster, fetched once per app run from the app's own public
/// endpoint.
///
/// <para>This exists because Live Client Data identifies the local player's
/// champion by <em>name</em> and <c>/api/skill-order</c> is keyed by numeric
/// <em>id</em>. Through 1.0.10 the desktop app bridged that gap by reading a
/// <c>championId</c> property off the player-list entry — a field Riot has
/// never published — so the id was always null and the skill order was never
/// requested. The Electron overlay this app replaced did it correctly, via this
/// same endpoint; the .NET port dropped the step.</para>
///
/// <para>A success is cached for the life of the process (the roster changes a
/// few times a year). A failure is cached only for
/// <see cref="FailureRetryMilliseconds"/>, so a blip at load-in cannot latch
/// the overlay blank for the match — the same discipline 1.0.8 had to add to
/// the skill-order fetch for exactly that reason.</para>
/// </summary>
public sealed class ChampionDirectory : IChampionDirectory, IDisposable
{
    public const int FailureRetryMilliseconds = 20_000;

    public static readonly Uri DefaultEndpoint = new(
        "https://coachbuild.vercel.app/api/champions",
        UriKind.Absolute);

    private readonly HttpClient _client;
    private readonly bool _ownsClient;
    private readonly Uri _endpoint;
    private readonly TimeProvider _time;
    private readonly object _gate = new();
    private IReadOnlyList<ChampionRef>? _champions;
    private string? _lastFailure;
    private DateTimeOffset? _failedAt;
    private Task<IReadOnlyList<ChampionRef>?>? _loading;
    private bool _disposed;

    public ChampionDirectory(
        HttpClient? client = null,
        Uri? endpoint = null,
        TimeProvider? timeProvider = null,
        HttpMessageHandler? handler = null)
    {
        _client = client ?? (handler is null ? new HttpClient() : new HttpClient(handler, disposeHandler: false));
        _ownsClient = client is null;
        _endpoint = endpoint ?? DefaultEndpoint;
        _time = timeProvider ?? TimeProvider.System;
        if (!_endpoint.IsAbsoluteUri ||
            (!string.Equals(_endpoint.Scheme, Uri.UriSchemeHttp, StringComparison.OrdinalIgnoreCase) &&
             !string.Equals(_endpoint.Scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase)))
            throw new ArgumentException("Champion directory endpoint must be an absolute HTTP(S) URI", nameof(endpoint));
    }

    public IReadOnlyList<ChampionRef>? Cached { get { lock (_gate) return _champions; } }

    public string? LastFailure { get { lock (_gate) return _champions is null ? _lastFailure : null; } }

    /// <summary>How many attempts have been made. Exposed so a test can prove a failure is retried rather than latched.</summary>
    public int Attempts { get; private set; }

    public Task<IReadOnlyList<ChampionRef>?> LoadAsync(CancellationToken cancellationToken)
    {
        lock (_gate)
        {
            if (_disposed) return Task.FromResult<IReadOnlyList<ChampionRef>?>(null);
            if (_champions is not null) return Task.FromResult<IReadOnlyList<ChampionRef>?>(_champions);
            if (_loading is not null) return _loading;
            if (_failedAt is { } failedAt &&
                _time.GetUtcNow() - failedAt < TimeSpan.FromMilliseconds(FailureRetryMilliseconds))
                return Task.FromResult<IReadOnlyList<ChampionRef>?>(null);

            var request = FetchAsync(cancellationToken);
            _loading = request;
            if (request.IsCompleted) _loading = null;
            return request;
        }
    }

    private async Task<IReadOnlyList<ChampionRef>?> FetchAsync(CancellationToken cancellationToken)
    {
        Attempts++;
        IReadOnlyList<ChampionRef>? parsed = null;
        string? failure = null;
        try
        {
            using var response = await _client.GetAsync(
                _endpoint,
                HttpCompletionOption.ResponseHeadersRead,
                cancellationToken).ConfigureAwait(false);
            if (!response.IsSuccessStatusCode)
            {
                failure = $"HTTP {((int)response.StatusCode).ToString(CultureInfo.InvariantCulture)}";
            }
            else
            {
                await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken)
                    .ConfigureAwait(false);
                using var document = await JsonDocument.ParseAsync(stream, cancellationToken: cancellationToken)
                    .ConfigureAwait(false);
                var champions = ChampionIdLookup.Parse(document.RootElement);
                // An empty roster is a failure, not an answer. Caching it as a
                // success would make every champion unresolvable for the whole
                // process lifetime off one bad response.
                if (champions.Count == 0) failure = "empty roster";
                else parsed = champions;
            }
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            lock (_gate) _loading = null;
            throw;
        }
        catch (OperationCanceledException)
        {
            failure = "Timeout";
        }
        catch (HttpRequestException error)
        {
            failure = $"HttpRequestException/{error.HttpRequestError}";
        }
        catch (JsonException)
        {
            failure = "malformed JSON";
        }
        catch (Exception error)
        {
            failure = error.GetType().Name;
        }

        lock (_gate)
        {
            _loading = null;
            if (parsed is not null)
            {
                _champions = parsed;
                _lastFailure = null;
                _failedAt = null;
            }
            else
            {
                _lastFailure = failure;
                _failedAt = _time.GetUtcNow();
            }
        }
        return parsed;
    }

    public void Dispose()
    {
        lock (_gate)
        {
            if (_disposed) return;
            _disposed = true;
        }
        if (_ownsClient) _client.Dispose();
    }
}
