using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace CoachBuild.Core;

/// <summary>Product-law predicates kept together so callers do not invent a second policy.</summary>
public static partial class ComplianceRules
{
    public const string AllowedOrigin = CompanionWire.AppOrigin;
    public const string AllowedHeaders = "content-type";
    public const string AllowedMethods = "GET,POST,OPTIONS";
    public const string MaxAge = "600";

    public static bool IsAllowedOrigin(string? origin) =>
        string.Equals(origin, AllowedOrigin, StringComparison.Ordinal);

    public static bool IsValidSession(string? supplied, string expected) =>
        !string.IsNullOrEmpty(supplied) &&
        string.Equals(supplied, expected, StringComparison.Ordinal);

    public static bool IsLoopback(Uri? uri) =>
        uri is not null &&
        (string.Equals(uri.Host, "127.0.0.1", StringComparison.OrdinalIgnoreCase) ||
         string.Equals(uri.Host, "localhost", StringComparison.OrdinalIgnoreCase));

    public static int? RoleIdFromPosition(string? position)
    {
        return position?.Trim().ToLowerInvariant() switch
        {
            "top" => 0,
            "jungle" => 1,
            "middle" => 2,
            "bottom" => 3,
            "utility" => 4,
            _ => null
        };
    }

    /// <summary>
    /// The only busy decision used by update gating. A write transaction is
    /// included even if the visible phase has already moved to None.
    /// </summary>
    public static bool IsCompanionBusy(string? phase, int activeLcuWriteTransactions) =>
        string.Equals(phase, "ChampSelect", StringComparison.Ordinal) ||
        string.Equals(phase, "InProgress", StringComparison.Ordinal) ||
        activeLcuWriteTransactions > 0;

    public static int? PositiveInt(JsonElement obj, string property)
    {
        if (obj.ValueKind != JsonValueKind.Object || !obj.TryGetProperty(property, out var value))
            return null;
        if (value.ValueKind != JsonValueKind.Number || !value.TryGetInt32(out var result) || result <= 0)
            return null;
        return result;
    }

    public static string? NonBlankString(JsonElement obj, string property)
    {
        if (obj.ValueKind != JsonValueKind.Object || !obj.TryGetProperty(property, out var value) ||
            value.ValueKind != JsonValueKind.String)
            return null;
        var result = value.GetString()?.Trim();
        return string.IsNullOrEmpty(result) ? null : result;
    }

    public static int? ResolveOwnChampionId(JsonElement cell, JsonElement session, int localCellId)
    {
        var locked = PositiveInt(cell, "championId");
        if (locked is not null) return locked;

        var intent = PositiveInt(cell, "championPickIntent");
        if (intent is not null) return intent;

        return ResolveOwnActionChampionId(session, localCellId);
    }

    public static int? ResolveOwnActionChampionId(JsonElement session, int localCellId)
    {
        if (session.ValueKind != JsonValueKind.Object ||
            !session.TryGetProperty("actions", out var actions) || actions.ValueKind != JsonValueKind.Array)
            return null;

        var inProgress = new List<int>();
        var completed = new List<int>();
        foreach (var row in actions.EnumerateArray())
        {
            // Riot's session.actions is an array of arrays. Accepting a flat
            // row as well is a harmless compatibility fallback for fixtures.
            var candidates = row.ValueKind == JsonValueKind.Array
                ? row.EnumerateArray()
                : new[] { row }.AsEnumerable();
            foreach (var action in candidates)
            {
                if (action.ValueKind != JsonValueKind.Object ||
                    !IsOwnPickAction(action, localCellId))
                    continue;
                var championId = PositiveInt(action, "championId");
                if (championId is null) continue;
                var isCompleted = action.TryGetProperty("completed", out var completedValue) &&
                                  completedValue.ValueKind == JsonValueKind.True;
                (isCompleted ? completed : inProgress).Add(championId.Value);
            }
        }
        return inProgress.FirstOrDefault() is var active && active > 0
            ? active
            : completed.FirstOrDefault() is var done && done > 0 ? done : null;
    }

    public static bool IsOwnPickAction(JsonElement action, int localCellId)
    {
        var sameCell = action.TryGetProperty("actorCellId", out var actor) &&
                       actor.ValueKind == JsonValueKind.Number &&
                       actor.TryGetInt32(out var actorId) && actorId == localCellId;
        var isPick = action.TryGetProperty("type", out var type) &&
                     type.ValueKind == JsonValueKind.String &&
                     string.Equals(type.GetString(), "pick", StringComparison.Ordinal);
        return sameCell && isPick;
    }

    public static IReadOnlyList<int> ResolveTheirTeamChampionIds(JsonElement session)
    {
        var result = new List<int>();
        if (session.ValueKind != JsonValueKind.Object ||
            !session.TryGetProperty("theirTeam", out var team) || team.ValueKind != JsonValueKind.Array)
            return result;

        foreach (var member in team.EnumerateArray())
        {
            if (member.ValueKind != JsonValueKind.Object) continue;
            var locked = PositiveInt(member, "championId");
            var intent = PositiveInt(member, "championPickIntent");
            if (locked is not null) result.Add(locked.Value);
            else if (intent is not null) result.Add(intent.Value);
        }
        return result;
    }

    public static string? ResolveTimerPhase(JsonElement session)
    {
        if (session.ValueKind != JsonValueKind.Object ||
            !session.TryGetProperty("timer", out var timer) || timer.ValueKind != JsonValueKind.Object)
            return null;
        return NonBlankString(timer, "phase");
    }

    public static string Redact(string? value, IEnumerable<string>? secrets = null)
    {
        if (string.IsNullOrEmpty(value)) return string.Empty;
        var result = value;
        if (secrets is not null)
        {
            foreach (var secret in secrets.Where(s => !string.IsNullOrEmpty(s)))
                result = result.Replace(secret, "[redacted]", StringComparison.Ordinal);
        }
        result = SessionQueryRegex().Replace(result, "session=[redacted]");
        result = AuthTokenRegex().Replace(result, "remoting-auth-token=[redacted]");
        result = RiotIdRegex().Replace(result, "[player-redacted]");
        result = UuidRegex().Replace(result, "[id-redacted]");
        return result;
    }

    [GeneratedRegex("(?i)(session=)[^&\\s]+")]
    private static partial Regex SessionQueryRegex();

    [GeneratedRegex("(?i)(remoting-auth-token=)[^\\s]+")]
    private static partial Regex AuthTokenRegex();

    // This is deliberately conservative. The native bridge never receives a
    // player name from champ select; this protects diagnostic callers that pass
    // a Riot ID-shaped value accidentally.
    [GeneratedRegex("\\b[A-Za-z0-9][A-Za-z0-9 _.-]{1,31}#[A-Za-z0-9]{2,8}\\b")]
    private static partial Regex RiotIdRegex();

    // A RIOT PUUID IS A DASHED UUID, and nothing this product logs is.
    //
    // The rule above catches `Name#TAG`; it cannot catch the account
    // identifier, which is the one that survives a name change and the one
    // Riot's own APIs key on. Redacting every dashed UUID is safe here rather
    // than merely cautious: every Guid in the shipped desktop is formatted "N"
    // (SessionTokenStore's token, the atomic-write temp suffixes in
    // App.xaml.cs and OverlaySettingsStore, SelfTestRunner's scratch
    // directory), so no line the product writes contains this shape at all --
    // which means any that arrives came from outside.
    //
    // "outside" now includes the `diagnostics` field: free text chosen by
    // whatever POSTed to the bridge, written into the one file the user is
    // asked to send us. See ApplyDiagnosticsParser.
    //
    // KNOWN LIMIT, stated rather than papered over: a bare summoner name with
    // no `#tag` is indistinguishable from ordinary prose and no regex can find
    // it. The defence there is that the bridge never receives one -- champ
    // select carries champion ids, and the item-set path carries a numeric
    // summonerId it does not log.
    [GeneratedRegex("\\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\\b")]
    private static partial Regex UuidRegex();
}

