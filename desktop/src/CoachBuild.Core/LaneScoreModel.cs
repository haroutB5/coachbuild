using System.Text.Json;
using System.Text.Json.Serialization;

namespace CoachBuild.Core;

/// <summary>
/// The queues a lane score may be recorded for, in ONE place because the brief
/// says so and because a second copy is how "ranked only" quietly becomes
/// "ranked and whatever else somebody added".
///
/// <para>420 is ranked solo/duo, 440 is ranked flex. Nothing else prompts:
/// normal games, ARAM, rotating modes and the practice tool all have lane
/// phases that are not comparable to a ranked one, and mixing them into the
/// same mean would make the recommendation worse while looking like more
/// data.</para>
///
/// <para>The accepted consequence (brief §"User decisions") is that the feature
/// cannot be exercised in the practice tool. That is what
/// <c>--lane-score-demo</c> exists for.</para>
/// </summary>
public static class RankedQueues
{
    public const int SoloDuo = 420;
    public const int Flex = 440;

    private static readonly int[] AllowedQueues = [SoloDuo, Flex];

    public static IReadOnlyList<int> Allowed => AllowedQueues;

    public static bool IsRanked(int? queueId) =>
        queueId is { } id && Array.IndexOf(AllowedQueues, id) >= 0;

    public static string Describe(int? queueId) => queueId switch
    {
        SoloDuo => "ranked solo",
        Flex => "ranked flex",
        null => "unknown queue",
        _ => $"queue {queueId}"
    };
}

/// <summary>
/// The role vocabulary, kept as the same 0-4 ids
/// <see cref="ComplianceRules.RoleIdFromPosition"/> already produces, so a lane
/// score, a champ-select snapshot and a skill order all mean the same thing by
/// "role 4". Storing the id rather than the LCU's position string also means a
/// future rename upstream cannot silently split one role into two buckets.
/// </summary>
public static class LaneRoles
{
    public const int Top = 0;
    public const int Jungle = 1;
    public const int Middle = 2;
    public const int Bottom = 3;
    public const int Utility = 4;

    public static bool IsValid(int? roleId) => roleId is >= Top and <= Utility;

    /// <summary>Display name for the card and the history panel.</summary>
    public static string Describe(int? roleId) => roleId switch
    {
        Top => "Top",
        Jungle => "Jungle",
        Middle => "Mid",
        Bottom => "Bot",
        Utility => "Support",
        _ => "Unknown role"
    };
}

/// <summary>
/// One game the user has been asked (or is about to be asked) to score.
///
/// <para><b>Every field here is captured at game end, before the user is
/// involved.</b> The score, note and — when the opponent could not be resolved
/// — the opponent are the only things the card contributes. Keeping the capture
/// and the judgement separate is what lets the card survive being ignored: the
/// facts are already on disk, so a restart re-offers the same game rather than
/// losing it.</para>
/// </summary>
public sealed record LaneScoreGame
{
    /// <summary>
    /// The LCU game id, as a string. String rather than long because it is only
    /// ever an identity — nothing sorts or arithmetics on it — and because the
    /// platform has changed the width of this value before.
    /// </summary>
    [JsonPropertyName("matchId")]
    public string MatchId { get; init; } = string.Empty;

    [JsonPropertyName("playedAt")]
    public string? PlayedAt { get; init; }

    [JsonPropertyName("queueId")]
    public int QueueId { get; init; }

    [JsonPropertyName("myChampionId")]
    public int MyChampionId { get; init; }

    [JsonPropertyName("myChampionName")]
    public string? MyChampionName { get; init; }

    /// <summary>0-4 per <see cref="LaneRoles"/>; null when the client did not say.</summary>
    [JsonPropertyName("roleId")]
    public int? RoleId { get; init; }

    /// <summary>
    /// The enemy laner. <b>Null means genuinely unknown</b>, never "probably
    /// the first one" — the brief is explicit that a guessed opponent silently
    /// poisons the recommendation, so an unresolved matchup is handed to the
    /// user to disambiguate from <see cref="EnemyChampionIds"/> instead.
    /// </summary>
    [JsonPropertyName("opponentChampionId")]
    public int? OpponentChampionId { get; init; }

    [JsonPropertyName("opponentChampionName")]
    public string? OpponentChampionName { get; init; }

    /// <summary>
    /// Every champion on the enemy team. This is what the card offers when
    /// <see cref="OpponentChampionId"/> is null, and it is captured even when
    /// the opponent IS known so a mis-resolution stays correctable later.
    /// </summary>
    [JsonPropertyName("enemyChampionIds")]
    public IReadOnlyList<int> EnemyChampionIds { get; init; } = [];

    /// <summary>
    /// Which upstream field the position came from, or the reason there is
    /// none. Diagnostics only — nothing branches on it — but it is the line
    /// that turns "the opponent is unknown again" into a shape we can fix,
    /// because it names the field that was actually read.
    /// </summary>
    [JsonPropertyName("positionSource")]
    public string? PositionSource { get; init; }

    [JsonPropertyName("capturedAt")]
    public string? CapturedAt { get; init; }

    public bool HasKnownOpponent => OpponentChampionId is > 0;
}

/// <summary>A game the user has actually scored. The record the whole feature exists to produce.</summary>
public sealed record LaneScoreRecord
{
    [JsonPropertyName("game")]
    public LaneScoreGame Game { get; init; } = new();

    /// <summary>1-10. 1 = unplayable, 10 = free lane. Validated on the way in, never clamped.</summary>
    [JsonPropertyName("score")]
    public int Score { get; init; }

    [JsonPropertyName("note")]
    public string? Note { get; init; }

    [JsonPropertyName("scoredAt")]
    public string? ScoredAt { get; init; }
}

/// <summary>
/// The whole on-disk document.
///
/// <para><b>Why one JSON document and not JSONL.</b> The brief requires atomic
/// temp-file-plus-move writes, and an atomic write rewrites the file in full
/// whatever the line format is — so JSONL's one real advantage, cheap appends,
/// is not available here anyway. What a single document buys instead is one
/// unambiguous home for <see cref="SchemaVersion"/>: a JSONL file has no header
/// line, so a version has to be repeated on every record or inferred, and
/// inferred versions are how migrations go wrong. Volume is a few hundred
/// ranked games a year, which is nothing to rewrite.</para>
///
/// <para><b>The OverlaySettingsStore trap, and why it cannot happen here.</b>
/// That store's <c>Save()</c> serialises a hand-cloned copy of its modelled
/// type, so any field missing from the clone method is silently reset on the
/// next write of any other setting. This type has NO hand-written clone path —
/// the store mutates the deserialised document and writes that same object
/// back. <see cref="Extra"/> then closes the remaining hole from the other
/// direction: a key written by a NEWER version is round-tripped instead of
/// being dropped by an older one. <c>LaneScoreStoreTests</c> writes a
/// fully-populated document, reloads it and compares every field.</para>
/// </summary>
public sealed class LaneScoreDocument
{
    public const int CurrentSchemaVersion = 1;

    [JsonPropertyName("schemaVersion")]
    public int SchemaVersion { get; set; } = CurrentSchemaVersion;

    /// <summary>Captured, not yet judged. The card reads the newest of these.</summary>
    [JsonPropertyName("pending")]
    public List<LaneScoreGame> Pending { get; set; } = [];

    [JsonPropertyName("scores")]
    public List<LaneScoreRecord> Scores { get; set; } = [];

    /// <summary>
    /// Match ids the user declined to score. Kept forever and kept SEPARATE
    /// from scores: a skip is not a low score, and without this list a restart
    /// would re-prompt for a game they have already dismissed.
    /// </summary>
    [JsonPropertyName("skipped")]
    public List<string> Skipped { get; set; } = [];

    /// <summary>
    /// Unknown keys, preserved verbatim. See the type remarks: this is what
    /// stops an older build from deleting a newer build's data.
    /// </summary>
    [JsonExtensionData]
    public Dictionary<string, JsonElement>? Extra { get; set; }

    /// <summary>True when this match id has been captured, scored or skipped already.</summary>
    public bool Knows(string? matchId) =>
        !string.IsNullOrWhiteSpace(matchId) &&
        (Pending.Any(game => string.Equals(game.MatchId, matchId, StringComparison.Ordinal)) ||
         Scores.Any(record => string.Equals(record.Game.MatchId, matchId, StringComparison.Ordinal)) ||
         Skipped.Contains(matchId, StringComparer.Ordinal));
}
