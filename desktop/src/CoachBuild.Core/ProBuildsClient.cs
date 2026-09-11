using System.Text.Json;
using System.Text.RegularExpressions;

namespace CoachBuild.Core;

/// <summary>
/// One probuildstats pro game: a <c>ProMatchSummary</c> row off the champion
/// page's <c>window.__APOLLO_STATE__</c> blob. Numeric throughout — no icon
/// mapping, no DOM anchors.
/// </summary>
public sealed record ProMatchRow(
    string CalculatedRole,
    string Version,
    long MatchTimestamp,
    bool Win,
    int OpponentChampionId,
    string ProName,
    string? Team,
    int PrimaryStyle,
    int SubStyle,
    IReadOnlyList<int> Perks,
    IReadOnlyList<int> Shards,
    IReadOnlyList<int> CompletedItems,
    IReadOnlyList<int> FinalBuild,
    int RoleBoundItem,
    IReadOnlyList<ProItemEvent> ItemPath);

/// <summary>One timestamped <c>itemPath</c> event: type 1 is a buy, 2 a sell/undo.</summary>
public sealed record ProItemEvent(int ItemId, long Timestamp, int Type);

/// <summary>
/// What a probuildstats fetch produced: either a picked payload (plus every
/// fetched row, so the caller can re-pick for a discovered role without a
/// second request) or a typed failure. Never throws for content reasons —
/// transport and shape defects both land here.
/// </summary>
public sealed record ProBuildsFetch(
    SiteImportPayload? Payload,
    IReadOnlyList<ProMatchRow>? Rows,
    string? Failure,
    bool Retryable,
    long ElapsedMs);

/// <summary>
/// The C# seam the automatic import drives for the third ("Pro") source.
/// Deliberately NOT a WebView2 worker: a plain <see cref="HttpClient"/> GET
/// of the SSR page, so the fetch runs fully in parallel with the u.gg and
/// Coachless worker fetches and never contends for a worker core.
/// </summary>
public interface IProBuildsClient
{
    /// <summary>
    /// Fetches the champion page and picks the build for <paramref
    /// name="roleId"/> (role-less when null). The returned rows let the
    /// caller re-pick via <see
    /// cref="ProBuildsClient.BuildPayload(IReadOnlyList{ProMatchRow}, string, int?)"/>
    /// once champ select resolves a role — no second request.
    /// </summary>
    Task<ProBuildsFetch> FetchAsync(string championSlug, int? roleId, CancellationToken cancellationToken = default);
}

/// <summary>
/// Third import source: probuildstats.com (u.gg's sister pro-builds site).
/// One SSR page per champion carries every pro game as a numeric
/// <c>ProMatchSummary</c> row inside <c>window.__APOLLO_STATE__</c>; the pick
/// rule below reduces those rows to ONE row (never a mix), and the same
/// validation the other sources use decides whether that row may be written.
/// </summary>
public sealed class ProBuildsClient : IProBuildsClient
{
    private readonly HttpClient _http;

    /// <summary>How long one page fetch may take before it counts as a transient failure.</summary>
    public static readonly TimeSpan FetchTimeout = TimeSpan.FromSeconds(10);

    /// <summary>Bare domain: <c>www.</c> 301-redirects (verified 2026-09-11).</summary>
    public const string Host = "probuildstats.com";

    public ProBuildsClient(HttpClient http)
    {
        _http = http ?? throw new ArgumentNullException(nameof(http));
    }

    /// <summary>The production <see cref="HttpClient"/>: browser User-Agent (plain GET returns the SSR), 10 s timeout.</summary>
    public static HttpClient CreateHttpClient()
    {
        var http = new HttpClient { Timeout = FetchTimeout };
        http.DefaultRequestHeaders.UserAgent.ParseAdd(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36");
        return http;
    }

    /// <summary>
    /// The champion slug vocabulary the URL builder accepts. Lowercase
    /// letters and digits only — the same fold <see
    /// cref="ChampionNameKey.Normalize"/> produces, so a caller passes its
    /// normalized key straight through. Anything else is refused without a
    /// request (it can only be a caller bug, never a champion).
    /// </summary>
    public static bool IsValidSlug(string? slug) =>
        !string.IsNullOrEmpty(slug) &&
        Regex.IsMatch(slug, "^[a-z0-9]+$");

    /// <summary>
    /// The probuildstats role token for an app role id. Identical to the
    /// u.gg/Coachless token EXCEPT role 4, which is <c>supp</c> here, not
    /// <c>support</c> (verified live: <c>leona?role=supp</c>). Kept as its own
    /// method — NOT folded into <c>SiteDeepLink.RoleToken</c> — so that
    /// mapping can never leak into the other two builders.
    /// </summary>
    public static string? RoleToken(int? roleId) => roleId switch
    {
        0 => "top",
        1 => "jungle",
        2 => "mid",
        3 => "adc",
        4 => "supp",
        _ => null,
    };

    /// <summary>
    /// The inverse of <see cref="RoleToken"/> over the tokens the page data
    /// actually carries (<c>calculatedRole</c>). Accepts <c>support</c> as an
    /// alias of <c>supp</c> — the page says <c>supp</c>, but a guess here
    /// costs nothing and a refusal would cost the build.
    /// </summary>
    public static int? RoleIdFromToken(string? token) => token?.Trim().ToLowerInvariant() switch
    {
        "top" => 0,
        "jungle" => 1,
        "mid" => 2,
        "adc" => 3,
        "supp" or "support" => 4,
        _ => null,
    };

    /// <summary>
    /// The only URL this client ever GETs:
    /// <c>https://probuildstats.com/champion/{slug}[?role={token}]</c>.
    /// Null when the slug cannot name a champion.
    /// </summary>
    public static Uri? BuildUrl(string? championSlug, int? roleId)
    {
        var slug = ChampionNameKey.Normalize(championSlug);
        if (!IsValidSlug(slug)) return null;
        var role = RoleToken(roleId);
        return new Uri(
            role is null
                ? $"https://{Host}/champion/{slug}"
                : $"https://{Host}/champion/{slug}?role={role}",
            UriKind.Absolute);
    }

    /// <summary>Typed fetch failures. <see cref="UnknownChampion"/> is final; the rest were already retried once.</summary>
    public static class Failures
    {
        public const string UnknownChampion = "unknown champion";
        public const string NoBuild = SiteImportFailures.NoBuild;
        public const string Transient = "pro page unavailable (transient)";
    }

    public async Task<ProBuildsFetch> FetchAsync(
        string championSlug,
        int? roleId,
        CancellationToken cancellationToken = default)
    {
        var clock = System.Diagnostics.Stopwatch.StartNew();
        var slug = ChampionNameKey.Normalize(championSlug);
        var url = BuildUrl(slug, roleId);
        if (url is null)
            return new ProBuildsFetch(null, null, $"{Failures.UnknownChampion} \"{championSlug}\"", false, clock.ElapsedMilliseconds);

        // One retry on anything retryable: the transient 718-byte
        // "technical issues" shell (no apollo JSON at all) was seen live, so
        // a missing/empty apollo blob re-GETs once rather than failing. An
        // unknown champion (empty apollo state) or a page with no match list
        // is final — retrying it would just fetch the same answer twice.
        for (var attempt = 0; attempt < 2; attempt++)
        {
            string body;
            try
            {
                using var response = await _http.GetAsync(url, cancellationToken).ConfigureAwait(false);
                var code = (int)response.StatusCode;
                if (code is >= 500 and <= 599)
                {
                    if (attempt == 0) continue;
                    return new ProBuildsFetch(null, null, $"{Failures.Transient} (HTTP {code})", true, clock.ElapsedMilliseconds);
                }
                if (!response.IsSuccessStatusCode)
                    return new ProBuildsFetch(null, null, $"{Failures.Transient} (HTTP {code})", false, clock.ElapsedMilliseconds);
                body = await response.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                throw;
            }
            catch (Exception error) when (error is HttpRequestException or TaskCanceledException or TimeoutException)
            {
                if (attempt == 0) continue;
                return new ProBuildsFetch(null, null, $"{Failures.Transient} ({error.Message})", true, clock.ElapsedMilliseconds);
            }

            var parsed = ParseDocument(body);
            if (parsed.Rows is not null)
            {
                var (payload, failure) = BuildPayload(parsed.Rows, slug, roleId);
                return payload is null
                    ? new ProBuildsFetch(null, parsed.Rows, failure, false, clock.ElapsedMilliseconds)
                    : new ProBuildsFetch(payload, parsed.Rows, null, false, clock.ElapsedMilliseconds);
            }
            if (!parsed.Retryable || attempt == 1)
                return new ProBuildsFetch(null, null, parsed.Failure, parsed.Retryable, clock.ElapsedMilliseconds);
        }
        return new ProBuildsFetch(null, null, Failures.Transient, true, clock.ElapsedMilliseconds);
    }

    /// <summary>
    /// Picks the build for <paramref name="roleId"/> out of already-fetched
    /// <paramref name="rows"/> — the client-side filter that lets a role-less
    /// lobby reuse the role-less fetch once u.gg resolves the role, with no
    /// second request. Pure, so the whole pick rule is unit-testable on
    /// synthetic rows.
    /// </summary>
    public static (SiteImportPayload? Payload, string? Failure) BuildPayload(
        IReadOnlyList<ProMatchRow> rows,
        string championSlug,
        int? roleId)
    {
        var slug = ChampionNameKey.Normalize(championSlug);
        var token = RoleToken(roleId);
        var (row, failure) = ProBuildsPicker.Pick(rows, token);
        if (row is null)
            return (null, failure ?? Failures.NoBuild);
        var blocks = ProBuildsItems.BuildBlocks(row);
        var runes = new SiteImportRunes(row.PrimaryStyle, row.SubStyle, row.Perks, row.Shards);
        if (SiteImportValidator.ValidateRunes(runes) is { } runeError)
            return (null, runeError);
        if (blocks.Count == 0)
            return (null, Failures.NoBuild);
        var payload = new SiteImportPayload(
            SiteImportSource.Pro, slug, row.CalculatedRole, runes, blocks)
        {
            Notes = [ProBuildsPicker.DescribePick(row, rows.Count)],
        };
        return (payload, null);
    }

    /// <summary>
    /// Reads the apollo blob out of a page body: the
    /// <c>&lt;script id="apollo-state"&gt;window.__APOLLO_STATE__ = {...}&lt;/script&gt;</c>
    /// assignment, whose <c>ROOT_QUERY</c> key starting with
    /// <c>getProChampionMatchList(</c> holds the <c>matchList[]</c> rows.
    /// Public (not just for the fetch above) so tests can prove the HTML
    /// contract byte-identical without a network round trip.
    /// </summary>
    public readonly record struct ParsedDocument(IReadOnlyList<ProMatchRow>? Rows, string? Failure, bool Retryable);

    public static ParsedDocument ParseDocument(string? body)
    {
        if (string.IsNullOrEmpty(body))
            return new ParsedDocument(null, Failures.Transient + " (empty page)", true);
        var script = body.IndexOf("id=\"apollo-state\"", StringComparison.Ordinal);
        if (script < 0)
            return new ParsedDocument(null, Failures.Transient + " (no pro data on page)", true);
        var assignment = body.IndexOf("window.__APOLLO_STATE__", script, StringComparison.Ordinal);
        if (assignment < 0)
            return new ParsedDocument(null, Failures.Transient + " (no pro data on page)", true);
        var jsonStart = body.IndexOf('{', assignment);
        var scriptEnd = body.IndexOf("</script>", jsonStart, StringComparison.Ordinal);
        if (jsonStart < 0 || scriptEnd < 0 || scriptEnd <= jsonStart)
            return new ParsedDocument(null, Failures.Transient + " (no pro data on page)", true);
        JsonDocument? document = null;
        try
        {
            document = JsonDocument.Parse(body.Substring(jsonStart, scriptEnd - jsonStart));
        }
        catch (JsonException)
        {
            return new ParsedDocument(null, Failures.Transient + " (unreadable pro data)", true);
        }
        using (document)
        {
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object)
                return new ParsedDocument(null, Failures.Transient + " (unreadable pro data)", true);
            // Unknown slug: the page 200s with an EMPTY apollo state. That
            // emptiness is the validity signal, not the status code — and it
            // is final, not retryable.
            if (!root.EnumerateObject().Any())
                return new ParsedDocument(null, Failures.UnknownChampion, false);
            if (!root.TryGetProperty("ROOT_QUERY", out var query) ||
                query.ValueKind != JsonValueKind.Object)
                return new ParsedDocument(null, Failures.NoBuild, false);
            foreach (var property in query.EnumerateObject())
            {
                if (!property.Name.StartsWith("getProChampionMatchList(", StringComparison.Ordinal))
                    continue;
                if (property.Value.ValueKind != JsonValueKind.Object ||
                    !property.Value.TryGetProperty("matchList", out var list) ||
                    list.ValueKind != JsonValueKind.Array)
                    return new ParsedDocument(null, Failures.NoBuild, false);
                var rows = new List<ProMatchRow>();
                foreach (var row in list.EnumerateArray())
                {
                    if (ReadRow(row) is { } parsed) rows.Add(parsed);
                }
                if (rows.Count == 0)
                    return new ParsedDocument(null, Failures.NoBuild, false);
                return new ParsedDocument(rows, null, false);
            }
            return new ParsedDocument(null, Failures.NoBuild, false);
        }
    }

    private static ProMatchRow? ReadRow(JsonElement row)
    {
        if (row.ValueKind != JsonValueKind.Object) return null;
        if (!row.TryGetProperty("runes", out var runes) || runes.ValueKind != JsonValueKind.Object)
            return null;
        var perks = new[]
        {
            ReadInt(runes, "perk0"), ReadInt(runes, "perk1"), ReadInt(runes, "perk2"),
            ReadInt(runes, "perk3"), ReadInt(runes, "perk4"), ReadInt(runes, "perk5"),
        };
        if (perks.Any(id => id <= 0)) return null;
        if (!row.TryGetProperty("statShards", out var shardsElement) ||
            shardsElement.ValueKind != JsonValueKind.Array)
            return null;
        var shards = shardsElement.EnumerateArray()
            .Where(element => element.ValueKind == JsonValueKind.Number && element.TryGetInt32(out _))
            .Select(element => element.GetInt32())
            .ToArray();
        if (shards.Length != 3 || shards.Any(id => id <= 0)) return null;
        var role = ReadString(row, "calculatedRole")?.Trim().ToLowerInvariant() ?? string.Empty;
        if (string.IsNullOrEmpty(role)) return null;
        return new ProMatchRow(
            role,
            ReadString(row, "version")?.Trim() ?? string.Empty,
            ReadLong(row, "matchTimestamp"),
            row.TryGetProperty("win", out var win) && win.ValueKind == JsonValueKind.True,
            ReadInt(row, "opponentChampionId"),
            ReadString(row, "normalizedName")?.Trim() ?? string.Empty,
            ReadString(row, "currentTeam")?.Trim() is { Length: > 0 } team ? team : null,
            ReadInt(runes, "primaryStyle"),
            ReadInt(runes, "subStyle"),
            perks,
            shards,
            ReadIntArray(row, "completedItems"),
            ReadIntArray(row, "finalBuild"),
            ReadInt(row, "roleBoundItem"),
            ReadItemPath(row));
    }

    private static IReadOnlyList<ProItemEvent> ReadItemPath(JsonElement row)
    {
        var events = new List<ProItemEvent>();
        if (row.TryGetProperty("itemPath", out var path) && path.ValueKind == JsonValueKind.Array)
        {
            foreach (var item in path.EnumerateArray())
            {
                if (item.ValueKind != JsonValueKind.Object) continue;
                var id = ReadInt(item, "itemId");
                if (id <= 0) continue;
                events.Add(new ProItemEvent(id, ReadLong(item, "timestamp"), ReadInt(item, "type")));
            }
        }
        return events;
    }

    private static IReadOnlyList<int> ReadIntArray(JsonElement element, string property)
    {
        if (!element.TryGetProperty(property, out var array) || array.ValueKind != JsonValueKind.Array)
            return Array.Empty<int>();
        return array.EnumerateArray()
            .Where(item => item.ValueKind == JsonValueKind.Number && item.TryGetInt32(out _))
            .Select(item => item.GetInt32())
            .Where(id => id > 0)
            .ToArray();
    }

    private static string? ReadString(JsonElement element, string property) =>
        element.TryGetProperty(property, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;

    private static int ReadInt(JsonElement element, string property) =>
        element.TryGetProperty(property, out var value) &&
            value.ValueKind == JsonValueKind.Number && value.TryGetInt32(out var result) ? result : 0;

    private static long ReadLong(JsonElement element, string property) =>
        element.TryGetProperty(property, out var value) &&
            value.ValueKind == JsonValueKind.Number && value.TryGetInt64(out var result) ? result : 0;
}

/// <summary>
/// The one-row pick rule. Candidates are the rows whose
/// <c>calculatedRole</c> matches the requested token (every row when
/// role-less); the current patch is the highest <c>version</c> present and
/// its rows win when there are at least 3 of them, else every candidate
/// counts. Of those, the modal (keystone, sub-style) pair wins and the most
/// recent game with it is the build; a row that fails <see
/// cref="PerkTreeCatalog"/> validation yields to the next most recent row in
/// the same set. Never a mix of rows: one row is one legal page.
/// </summary>
public static class ProBuildsPicker
{
    /// <summary>How many current-patch rows it takes to trust the patch filter.</summary>
    public const int MinCurrentPatchRows = 3;

    public static (ProMatchRow? Row, string? Failure) Pick(
        IReadOnlyList<ProMatchRow>? rows,
        string? roleToken)
    {
        if (rows is null || rows.Count == 0)
            return (null, ProBuildsClient.Failures.NoBuild);
        var wanted = roleToken?.Trim().ToLowerInvariant();
        var candidates = string.IsNullOrEmpty(wanted)
            ? rows.ToArray()
            : rows.Where(row => string.Equals(row.CalculatedRole, wanted, StringComparison.OrdinalIgnoreCase)).ToArray();
        if (candidates.Length == 0)
            return (null, $"no pro game for role \"{wanted}\"");
        var current = candidates
            .Select(row => ParseVersion(row.Version))
            .OrderByDescending(version => version)
            .First();
        var onPatch = candidates
            .Where(row => ParseVersion(row.Version) == current)
            .ToArray();
        var pool = onPatch.Length >= MinCurrentPatchRows ? onPatch : candidates;
        var modal = pool
            .GroupBy(row => (row.Perks[0], row.SubStyle))
            .OrderByDescending(group => group.Count())
            .ThenByDescending(group => group.Max(row => row.MatchTimestamp))
            .First()
            .Key;
        foreach (var row in pool
                     .Where(row => row.Perks[0] == modal.Item1 && row.SubStyle == modal.Item2)
                     .OrderByDescending(row => row.MatchTimestamp))
        {
            if (PerkTreeCatalog.ValidatePage(row.PrimaryStyle, row.SubStyle, row.Perks, row.Shards) is null)
                return (row, null);
        }
        return (null, "no pro game with a valid rune page");
    }

    /// <summary>
    /// The payload note naming the chosen row: pro handle, team when present,
    /// patch, win/loss and opponent champion id. No other personal data — the
    /// row's riot user name and tag line never leave the page.
    /// </summary>
    public static string DescribePick(ProMatchRow row, int rowsSeen)
    {
        var patch = string.IsNullOrEmpty(row.Version)
            ? "unknown patch"
            : "patch " + row.Version.Replace('_', '.');
        var team = string.IsNullOrEmpty(row.Team) ? string.Empty : $", {row.Team}";
        var name = string.IsNullOrEmpty(row.ProName) ? "a pro" : row.ProName;
        var outcome = row.Win ? "win" : "loss";
        return $"probuildstats: most recent {row.CalculatedRole} game on {patch} " +
            $"({name}{team}, {outcome} vs champion {row.OpponentChampionId}; 1 of {rowsSeen} games)";
    }

    private static (int Major, int Minor) ParseVersion(string? version)
    {
        if (string.IsNullOrEmpty(version)) return (0, 0);
        var parts = version.Split('_', '.');
        return parts.Length >= 2 &&
            int.TryParse(parts[0], out var major) &&
            int.TryParse(parts[1], out var minor)
            ? (major, minor)
            : (0, 0);
    }
}

/// <summary>
/// The item blocks for the chosen pro row. Starting = the early buys
/// (type-1 <c>itemPath</c> events within the first 120 s — timestamps are
/// milliseconds — minus trinkets, wards and the role quest item); Core = the
/// row's <c>completedItems</c> in order; Final = <c>finalBuild</c> minus
/// trinkets, wards, consumables and the role quest item (Dark Seal 1082 is a
/// build item and stays). Empty blocks are dropped, never written empty.
/// </summary>
public static class ProBuildsItems
{
    /// <summary>Events at or before this are opening buys. The page stamps milliseconds.</summary>
    public const long StartingWindowMs = 120_000;

    private static readonly HashSet<int> TrinketsAndWards = [3340, 3363, 3364, 2055];

    private static readonly HashSet<int> Consumables = [2003, 2031, 2033, 2138, 2139, 2140];

    public static IReadOnlyList<SiteImportItemBlock> BuildBlocks(ProMatchRow row)
    {
        ArgumentNullException.ThrowIfNull(row);
        var blocks = new List<SiteImportItemBlock>();
        var starting = row.ItemPath
            .Where(item => item.Type == 1 && item.Timestamp <= StartingWindowMs)
            .OrderBy(item => item.Timestamp)
            .Select(item => item.ItemId)
            .Where(id => !TrinketsAndWards.Contains(id) && id != row.RoleBoundItem)
            .Distinct()
            .ToArray();
        if (starting.Length > 0)
            blocks.Add(new SiteImportItemBlock("Starting Items", starting));
        if (row.CompletedItems.Count > 0)
            blocks.Add(new SiteImportItemBlock("Core Items", row.CompletedItems));
        var final = row.FinalBuild
            .Where(id => !TrinketsAndWards.Contains(id) &&
                !Consumables.Contains(id) &&
                id != row.RoleBoundItem)
            .ToArray();
        if (final.Length > 0)
            blocks.Add(new SiteImportItemBlock("Final Build", final));
        return blocks;
    }
}
