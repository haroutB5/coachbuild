using System.Text.Json.Serialization;

namespace CoachBuild.Core;

/// <summary>One (enemy, role, my champion) cell of the user's own history.</summary>
public sealed record LaneScoreSummary(
    [property: JsonPropertyName("championId")] int ChampionId,
    [property: JsonPropertyName("championName")] string? ChampionName,
    /// <summary>
    /// How many of the user's OWN games this mean is made of. It travels with
    /// the mean everywhere and the UI is required to show it: the brief's
    /// "sample honesty" rule exists because an n=1 8/10 and an n=8 8/10 are not
    /// the same claim, and a single number cannot say which one it is.
    /// </summary>
    [property: JsonPropertyName("games")] int Games,
    [property: JsonPropertyName("mean")] double Mean,
    [property: JsonPropertyName("lastPlayedAt")] string? LastPlayedAt);

/// <summary>The wire body of <c>GET /lane-scores/recommendations</c>.</summary>
public sealed record LaneScoreRecommendations(
    [property: JsonPropertyName("enemyChampionId")] int EnemyChampionId,
    [property: JsonPropertyName("roleId")] int RoleId,
    [property: JsonPropertyName("totalGames")] int TotalGames,
    [property: JsonPropertyName("best")] IReadOnlyList<LaneScoreSummary> Best,
    [property: JsonPropertyName("worst")] IReadOnlyList<LaneScoreSummary> Worst);

/// <summary>
/// Turns scored games into the champ-select recommendation. Pure and static:
/// every rule below is a function of the records, so all of it is testable
/// without a file or a socket.
///
/// <para><b>The rule this class exists to hold.</b> A matchup is DIRECTED.
/// "Volibear 9/10 into Gwen" is a fact about picking Volibear when the enemy has
/// already got Gwen; it says nothing whatever about how Gwen feels into
/// Volibear. Nothing here reads a record backwards — the query matches
/// <see cref="LaneScoreGame.OpponentChampionId"/> against the enemy and
/// <see cref="LaneScoreGame.MyChampionId"/> against the answer, and there is no
/// code path that swaps them. <c>LaneScoreAggregatorTests</c> asserts the
/// inverse query returns nothing.</para>
/// </summary>
public static class LaneScoreAggregator
{
    /// <summary>How many entries each end of the ranking shows.</summary>
    public const int EndSize = 3;

    public static LaneScoreRecommendations Recommend(
        IEnumerable<LaneScoreRecord>? records,
        int enemyChampionId,
        int roleId)
    {
        var matching = (records ?? [])
            .Where(record => record.Game.OpponentChampionId == enemyChampionId)
            .Where(record => record.Game.RoleId == roleId)
            .ToArray();

        var ranked = matching
            .GroupBy(record => record.Game.MyChampionId)
            .Select(group => new LaneScoreSummary(
                ChampionId: group.Key,
                // The most recent non-null name wins. Champion names change
                // (Nunu, Dr. Mundo) and the newest record is the closest to what
                // the client calls it today; the id is what actually joins.
                ChampionName: group
                    .OrderByDescending(record => record.ScoredAt, StringComparer.Ordinal)
                    .Select(record => record.Game.MyChampionName)
                    .FirstOrDefault(name => !string.IsNullOrWhiteSpace(name)),
                Games: group.Count(),
                // One decimal. Not a confidence score, not a weighting, not a
                // Bayesian prior pulled toward 5.5 -- the brief is explicit that
                // no derived certainty may be invented. It is the arithmetic
                // mean, and `Games` next to it is what says how much to trust it.
                Mean: Math.Round(group.Average(record => (double)record.Score), 1,
                    MidpointRounding.AwayFromZero),
                LastPlayedAt: group
                    .Select(record => record.Game.PlayedAt ?? record.ScoredAt)
                    .Where(stamp => !string.IsNullOrWhiteSpace(stamp))
                    .OrderByDescending(stamp => stamp, StringComparer.Ordinal)
                    .FirstOrDefault()))
            // Deterministic all the way down: mean, then sample size, then id.
            // Without the last two an equal-mean pair could reorder between two
            // reads of the same data, which reads as the app changing its mind.
            .OrderByDescending(summary => summary.Mean)
            .ThenByDescending(summary => summary.Games)
            .ThenBy(summary => summary.ChampionId)
            .ToArray();

        var best = ranked.Take(EndSize).ToArray();
        // Disjoint BY CONSTRUCTION: the bad end is drawn only from what the good
        // end did not take. With one champion recorded, `best` has it and
        // `worst` is empty -- the alternative (slicing both ends of the same
        // short list) would print the same row as both the recommendation and
        // the warning, which is worse than saying nothing.
        var worst = ranked.Skip(best.Length)
            .OrderBy(summary => summary.Mean)
            .ThenByDescending(summary => summary.Games)
            .ThenBy(summary => summary.ChampionId)
            .Take(EndSize)
            .ToArray();

        return new LaneScoreRecommendations(
            enemyChampionId,
            roleId,
            matching.Length,
            best,
            worst);
    }
}
