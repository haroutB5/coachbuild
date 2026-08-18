using System.Globalization;
using System.Text.Json;

namespace CoachBuild.Core;

/// <summary>
/// The local player's own identity, as the Live Client Data API publishes it.
///
/// <para>All four fields are optional on purpose. Riot has moved this surface
/// more than once: <c>summonerName</c> predates Riot IDs and recent patches
/// leave it empty or set it to the game name alone, while
/// <c>riotId</c>/<c>riotIdGameName</c>/<c>riotIdTagLine</c> were added later and
/// are not guaranteed on every endpoint or every client build. Binding the
/// whole pipeline to one of them — as 1.0.10 did with <c>riotId</c> — makes a
/// single schema move blank the overlay with no way to tell why.</para>
/// </summary>
public sealed record LiveLocalIdentity(
    string? RiotId,
    string? GameName,
    string? TagLine,
    string? SummonerName)
{
    public bool IsUsable =>
        !string.IsNullOrWhiteSpace(RiotId) ||
        !string.IsNullOrWhiteSpace(GameName) ||
        !string.IsNullOrWhiteSpace(SummonerName);

    /// <summary>
    /// A compliance-safe rendering for the log.
    ///
    /// <para><see cref="RedactedLog"/> rewrites anything Riot-ID shaped to
    /// <c>[player-redacted]</c>, so printing the raw identity produces a line
    /// that cannot answer the only question it exists to answer. What survives
    /// redaction and still separates the realistic causes — case, stray
    /// whitespace around <c>#</c>, an empty field, a schema move — is the
    /// leading characters, the exact length, and the tag line.</para>
    /// </summary>
    public string Describe() =>
        $"gameName={Mask(GameName)} tag={TagLine ?? "-"} riotId={Mask(RiotId)} summonerName={Mask(SummonerName)}";

    internal static string Mask(string? value)
    {
        if (value is null) return "null";
        if (value.Length == 0) return "empty";
        var head = value.Length <= 2 ? value : value[..2];
        return $"{head}~({value.Length.ToString(CultureInfo.InvariantCulture)})";
    }
}

/// <summary>Which key actually matched the local player in the player list.</summary>
public enum LivePlayerMatchKey
{
    RiotId,
    GameNameAndTagLine,
    GameName,
    SummonerName,
    SoleEntry,
}

public sealed record LivePlayerMatch(LivePlayerMatchKey MatchedBy, JsonElement Player);

/// <summary>
/// The local player's own champion, as it appears on their player-list entry.
///
/// <para>There is no numeric champion id here and there never has been. Riot's
/// documented player-list entry carries <c>championName</c> (localised) and
/// <c>rawChampionName</c> (<c>game_character_displayname_&lt;Key&gt;</c>,
/// locale-independent) and nothing else about champion identity — confirmed
/// against Riot's own API reference and against this repo's 2026-07-27 capture
/// of a real game. Reading a <c>championId</c> property off this object, as
/// <see cref="LivePlayerListResolver"/> did through 1.0.10, always returns
/// null.</para>
/// </summary>
public sealed record LiveChampionIdentity(string? RawKey, string? DisplayName, string? Position)
{
    public bool HasName => !string.IsNullOrWhiteSpace(RawKey) || !string.IsNullOrWhiteSpace(DisplayName);

    /// <summary>The name to show, preferring the locale-independent one.</summary>
    public string? PreferredName =>
        !string.IsNullOrWhiteSpace(RawKey) ? RawKey
        : !string.IsNullOrWhiteSpace(DisplayName) ? DisplayName
        : null;
}

/// <summary>
/// Structural facts about a player-list payload. Deliberately carries no other
/// player's name: the counts are enough to separate "the schema moved" from
/// "the values disagree", which is the whole diagnostic job.
/// </summary>
public sealed record LivePlayerListShape(
    int Entries,
    int WithRiotId,
    int WithGameName,
    int WithTagLine,
    int WithSummonerName)
{
    public override string ToString() =>
        $"n={Entries} riotId={WithRiotId} gameName={WithGameName} tag={WithTagLine} summonerName={WithSummonerName}";
}

/// <summary>
/// Finds the local player's own entry in a Live Client Data player list.
///
/// <para>Every rung is case-insensitive and trims, and the Riot ID rung
/// tolerates whitespace around the <c>#</c>. The rungs are ordered strongest
/// first, and the resolver reports <em>which</em> rung matched so a field
/// report says what the client actually published rather than only that it
/// failed.</para>
/// </summary>
public static class LiveLocalPlayerResolver
{
    private const string RawChampionNamePrefix = "game_character_displayname_";

    /// <summary>Reads the identity off an <c>allgamedata.activePlayer</c> (or a bare <c>activeplayer</c>) object.</summary>
    public static LiveLocalIdentity? ReadActivePlayer(JsonElement activePlayer)
    {
        if (activePlayer.ValueKind != JsonValueKind.Object) return null;
        var riotId = ReadString(activePlayer, "riotId");
        var gameName = ReadString(activePlayer, "riotIdGameName");
        var tagLine = ReadString(activePlayer, "riotIdTagLine");
        var summonerName = ReadString(activePlayer, "summonerName");

        // A summonerName that is really a Riot ID is the common shape on the
        // clients that dropped the dedicated riotId field.
        if (riotId is null && summonerName is not null && summonerName.Contains('#'))
            riotId = summonerName;
        if (riotId is not null && (gameName is null || tagLine is null))
        {
            var split = SplitRiotId(riotId);
            gameName ??= split.GameName;
            tagLine ??= split.TagLine;
        }
        if (riotId is null && gameName is not null && tagLine is not null)
            riotId = $"{gameName}#{tagLine}";

        var identity = new LiveLocalIdentity(riotId, gameName, tagLine, summonerName);
        return identity.IsUsable ? identity : null;
    }

    /// <summary>
    /// Reads <c>/liveclientdata/activeplayername</c>, which is a bare JSON
    /// string whose format has changed across patches — sometimes
    /// <c>Name#TAG</c>, sometimes the game name alone. Both are accepted.
    /// </summary>
    public static LiveLocalIdentity? ReadActivePlayerName(JsonElement value)
    {
        if (value.ValueKind != JsonValueKind.String) return null;
        var text = value.GetString()?.Trim();
        if (string.IsNullOrEmpty(text)) return null;
        if (!text.Contains('#')) return new LiveLocalIdentity(null, text, null, text);
        var split = SplitRiotId(text);
        return new LiveLocalIdentity(text, split.GameName, split.TagLine, text);
    }

    /// <summary>Fills gaps in <paramref name="current"/> from <paramref name="incoming"/>; incoming wins where both are set.</summary>
    public static LiveLocalIdentity? Merge(LiveLocalIdentity? current, LiveLocalIdentity? incoming)
    {
        if (incoming is null) return current;
        if (current is null) return incoming;
        return new LiveLocalIdentity(
            incoming.RiotId ?? current.RiotId,
            incoming.GameName ?? current.GameName,
            incoming.TagLine ?? current.TagLine,
            incoming.SummonerName ?? current.SummonerName);
    }

    public static LivePlayerMatch? Match(JsonElement playerList, LiveLocalIdentity? identity)
    {
        if (playerList.ValueKind != JsonValueKind.Array || identity is null) return null;

        // 1 — the whole Riot ID, whitespace around '#' collapsed.
        if (Canonical(identity.RiotId) is { } riotId &&
            Unique(playerList, player => string.Equals(Canonical(ReadString(player, "riotId")), riotId, StringComparison.OrdinalIgnoreCase))
                is { } byRiotId)
            return new LivePlayerMatch(LivePlayerMatchKey.RiotId, byRiotId);

        // 2 — the split pair, for clients that publish the parts but not the whole.
        if (Fold(identity.GameName) is { } gameName && Fold(identity.TagLine) is { } tagLine &&
            Unique(playerList, player =>
                string.Equals(Fold(ReadString(player, "riotIdGameName")), gameName, StringComparison.OrdinalIgnoreCase) &&
                string.Equals(Fold(ReadString(player, "riotIdTagLine")), tagLine, StringComparison.OrdinalIgnoreCase))
                is { } byPair)
            return new LivePlayerMatch(LivePlayerMatchKey.GameNameAndTagLine, byPair);

        // 3 — game name alone, but only when it is unambiguous in this lobby.
        if (Fold(identity.GameName) is { } soloName &&
            Unique(playerList, player =>
                string.Equals(Fold(ReadString(player, "riotIdGameName")), soloName, StringComparison.OrdinalIgnoreCase) ||
                string.Equals(Fold(SplitRiotId(ReadString(player, "riotId")).GameName), soloName, StringComparison.OrdinalIgnoreCase))
                is { } byGameName)
            return new LivePlayerMatch(LivePlayerMatchKey.GameName, byGameName);

        // 4 — the legacy field. Recent patches leave it empty, which is why it
        // cannot be the only rung, but a client that still fills it is a client
        // that may not fill anything else.
        if (Fold(identity.SummonerName) is { } summonerName &&
            Unique(playerList, player =>
                string.Equals(Fold(ReadString(player, "summonerName")), summonerName, StringComparison.OrdinalIgnoreCase))
                is { } bySummonerName)
            return new LivePlayerMatch(LivePlayerMatchKey.SummonerName, bySummonerName);

        // 5 — last resort. A one-entry player list is the Practice Tool, where
        // the sole entry is the local player by construction. This can never
        // fire in a matchmade game, which is exactly why it is safe.
        var sole = Sole(playerList);
        return sole is { } only ? new LivePlayerMatch(LivePlayerMatchKey.SoleEntry, only) : null;
    }

    public static LiveChampionIdentity ReadChampion(JsonElement player)
    {
        if (player.ValueKind != JsonValueKind.Object)
            return new LiveChampionIdentity(null, null, null);
        var raw = ReadString(player, "rawChampionName");
        if (raw is not null && raw.StartsWith(RawChampionNamePrefix, StringComparison.OrdinalIgnoreCase))
        {
            var stripped = raw[RawChampionNamePrefix.Length..].Trim();
            raw = stripped.Length == 0 ? null : stripped;
        }
        else if (raw is not null && raw.Contains('_'))
        {
            // An unknown prefix shape is not something to guess at; the
            // localised name is a better answer than a mangled key.
            raw = null;
        }
        return new LiveChampionIdentity(raw, ReadString(player, "championName"), ReadString(player, "position"));
    }

    public static LivePlayerListShape Describe(JsonElement playerList)
    {
        if (playerList.ValueKind != JsonValueKind.Array) return new LivePlayerListShape(0, 0, 0, 0, 0);
        int entries = 0, riotId = 0, gameName = 0, tagLine = 0, summonerName = 0;
        foreach (var player in playerList.EnumerateArray())
        {
            entries++;
            if (ReadString(player, "riotId") is not null) riotId++;
            if (ReadString(player, "riotIdGameName") is not null) gameName++;
            if (ReadString(player, "riotIdTagLine") is not null) tagLine++;
            if (ReadString(player, "summonerName") is not null) summonerName++;
        }
        return new LivePlayerListShape(entries, riotId, gameName, tagLine, summonerName);
    }

    /// <summary>Collapses whitespace around '#', so "Name #EUW" and "Name#EUW" are the same identity.</summary>
    internal static string? Canonical(string? riotId)
    {
        var folded = Fold(riotId);
        if (folded is null) return null;
        var hash = folded.IndexOf('#');
        if (hash < 0) return folded;
        var head = folded[..hash].TrimEnd();
        var tail = folded[(hash + 1)..].TrimStart();
        if (head.Length == 0 || tail.Length == 0) return folded;
        return string.Create(head.Length + 1 + tail.Length, (head, tail), static (span, parts) =>
        {
            parts.head.AsSpan().CopyTo(span);
            span[parts.head.Length] = '#';
            parts.tail.AsSpan().CopyTo(span[(parts.head.Length + 1)..]);
        });
    }

    internal static (string? GameName, string? TagLine) SplitRiotId(string? riotId)
    {
        var folded = Fold(riotId);
        if (folded is null) return (null, null);
        var hash = folded.IndexOf('#');
        if (hash < 0) return (folded, null);
        var head = folded[..hash].TrimEnd();
        var tail = folded[(hash + 1)..].TrimStart();
        return (head.Length == 0 ? null : head, tail.Length == 0 ? null : tail);
    }

    private static JsonElement? Unique(JsonElement playerList, Func<JsonElement, bool> predicate)
    {
        JsonElement? found = null;
        foreach (var player in playerList.EnumerateArray())
        {
            if (player.ValueKind != JsonValueKind.Object || !predicate(player)) continue;
            // Two entries answering to the same key is not a match; picking one
            // would be a coin toss that silently shows another player's champion.
            if (found is not null) return null;
            found = player;
        }
        return found;
    }

    private static JsonElement? Sole(JsonElement playerList)
    {
        JsonElement? only = null;
        foreach (var player in playerList.EnumerateArray())
        {
            if (player.ValueKind != JsonValueKind.Object) return null;
            if (only is not null) return null;
            only = player;
        }
        return only;
    }

    private static string? Fold(string? value)
    {
        if (value is null) return null;
        var trimmed = value.Trim();
        return trimmed.Length == 0 ? null : trimmed;
    }

    private static string? ReadString(JsonElement source, string property)
    {
        if (source.ValueKind != JsonValueKind.Object ||
            !source.TryGetProperty(property, out var value) ||
            value.ValueKind != JsonValueKind.String)
            return null;
        var text = value.GetString()?.Trim();
        return string.IsNullOrEmpty(text) ? null : text;
    }
}
