using CoachBuild.Core;
using Xunit;

namespace CoachBuild.Core.Tests;

/// <summary>
/// The aggregation rules behind the champ-select recommendation.
///
/// <para>The load-bearing test in here is
/// <see cref="AMatchupIsNeverReadBackwards"/>. Everything else is arithmetic;
/// that one is the product rule the brief states twice, and it is the kind of
/// thing a later "we already have this data, why not use it both ways"
/// refactor breaks without noticing.</para>
/// </summary>
public sealed class LaneScoreAggregatorTests
{
    private static LaneScoreRecord Record(
        int myChampionId,
        int opponentChampionId,
        int score,
        int roleId = LaneRoles.Top,
        string? myName = null,
        string scoredAt = "2026-09-01T12:00:00.0000000+00:00") => new()
        {
            Game = new LaneScoreGame
            {
                MatchId = $"{myChampionId}-{opponentChampionId}-{score}-{scoredAt}",
                QueueId = RankedQueues.SoloDuo,
                MyChampionId = myChampionId,
                MyChampionName = myName,
                RoleId = roleId,
                OpponentChampionId = opponentChampionId,
                EnemyChampionIds = [opponentChampionId],
            },
            Score = score,
            ScoredAt = scoredAt,
        };

    /// <summary>
    /// <b>Volibear 9/10 into Gwen says nothing about Gwen into Volibear.</b>
    ///
    /// <para>It is a fact about picking Volibear when Gwen is already locked. The
    /// inverse is a different question the user has never answered, and inventing
    /// an answer for it would put a recommendation in front of them backed by no
    /// game they ever played.</para>
    /// </summary>
    [Fact]
    public void AMatchupIsNeverReadBackwards()
    {
        LaneScoreRecord[] history = [Record(myChampionId: 106, opponentChampionId: 887, score: 9)];

        var forward = LaneScoreAggregator.Recommend(history, enemyChampionId: 887, roleId: LaneRoles.Top);
        Assert.Equal(1, forward.TotalGames);
        Assert.Equal(106, Assert.Single(forward.Best).ChampionId);

        // The same data, asked the other way round. Volibear was the ANSWER, not
        // the enemy, so there is nothing here and the panel shows nothing.
        var inverse = LaneScoreAggregator.Recommend(history, enemyChampionId: 106, roleId: LaneRoles.Top);
        Assert.Equal(0, inverse.TotalGames);
        Assert.Empty(inverse.Best);
        Assert.Empty(inverse.Worst);
    }

    [Fact]
    public void TheMeanAndTheSampleCountAreBothReported()
    {
        LaneScoreRecord[] history =
        [
            Record(106, 887, 9),
            Record(106, 887, 8),
            Record(106, 887, 8),
        ];

        var entry = Assert.Single(LaneScoreAggregator.Recommend(history, 887, LaneRoles.Top).Best);

        Assert.Equal(3, entry.Games);
        Assert.Equal(8.3, entry.Mean);
    }

    /// <summary>
    /// Roles do not pool. A Volibear top game and a Volibear jungle game into the
    /// same enemy are different questions, and averaging them would produce a
    /// number that describes neither while looking like more evidence.
    /// </summary>
    [Fact]
    public void RolesAreAggregatedSeparately()
    {
        LaneScoreRecord[] history =
        [
            Record(106, 887, 9, roleId: LaneRoles.Top),
            Record(106, 887, 2, roleId: LaneRoles.Jungle),
        ];

        Assert.Equal(9.0, Assert.Single(LaneScoreAggregator.Recommend(history, 887, LaneRoles.Top).Best).Mean);
        Assert.Equal(2.0, Assert.Single(LaneScoreAggregator.Recommend(history, 887, LaneRoles.Jungle).Best).Mean);
        Assert.Empty(LaneScoreAggregator.Recommend(history, 887, LaneRoles.Utility).Best);
    }

    /// <summary>
    /// The two ends never share a row. With one champion recorded, showing it as
    /// both the recommendation and the warning would be worse than saying
    /// nothing at all.
    /// </summary>
    [Fact]
    public void TheGoodAndBadEndsAreDisjoint()
    {
        var single = LaneScoreAggregator.Recommend([Record(106, 887, 9)], 887, LaneRoles.Top);
        Assert.Equal(106, Assert.Single(single.Best).ChampionId);
        Assert.Empty(single.Worst);

        LaneScoreRecord[] many =
        [
            Record(106, 887, 9), Record(75, 887, 8), Record(86, 887, 7),
            Record(24, 887, 3), Record(122, 887, 2),
        ];
        var wide = LaneScoreAggregator.Recommend(many, 887, LaneRoles.Top);

        Assert.Equal([106, 75, 86], wide.Best.Select(entry => entry.ChampionId));
        Assert.Equal([122, 24], wide.Worst.Select(entry => entry.ChampionId));
        Assert.Empty(wide.Best.Select(entry => entry.ChampionId)
            .Intersect(wide.Worst.Select(entry => entry.ChampionId)));
        Assert.Equal(5, wide.TotalGames);
    }

    /// <summary>
    /// Equal means must not reorder between two reads of the same data — that
    /// reads to a user as the app changing its mind. Sample size breaks the tie,
    /// then the champion id.
    /// </summary>
    [Fact]
    public void EqualMeansAreOrderedDeterministically()
    {
        LaneScoreRecord[] history =
        [
            Record(300, 887, 8),
            Record(100, 887, 8), Record(100, 887, 8),
            Record(200, 887, 8),
        ];

        var first = LaneScoreAggregator.Recommend(history, 887, LaneRoles.Top);
        var second = LaneScoreAggregator.Recommend(history.Reverse().ToArray(), 887, LaneRoles.Top);

        // n=2 outranks the two n=1 entries; the n=1 pair breaks by id.
        Assert.Equal([100, 200, 300], first.Best.Select(entry => entry.ChampionId));
        Assert.Equal(first.Best.Select(entry => entry.ChampionId), second.Best.Select(entry => entry.ChampionId));
    }

    /// <summary>
    /// The mean is the arithmetic mean and nothing else. No shrinkage toward
    /// 5.5, no weighting by recency, no confidence factor: the brief forbids
    /// inventing certainty, and <c>Games</c> beside the number is what says how
    /// much of it there is.
    /// </summary>
    [Fact]
    public void TheMeanIsNotShrunkTowardTheMiddleByASmallSample()
    {
        var single = Assert.Single(LaneScoreAggregator.Recommend([Record(106, 887, 10)], 887, LaneRoles.Top).Best);
        Assert.Equal(10.0, single.Mean);
        Assert.Equal(1, single.Games);

        var low = Assert.Single(LaneScoreAggregator.Recommend([Record(106, 887, 1)], 887, LaneRoles.Top).Best);
        Assert.Equal(1.0, low.Mean);
    }

    [Fact]
    public void TheNewestChampionNameWins()
    {
        LaneScoreRecord[] history =
        [
            Record(106, 887, 8, myName: "Volibear the Relentless Storm", scoredAt: "2026-01-01T00:00:00.0000000+00:00"),
            Record(106, 887, 8, myName: "Volibear", scoredAt: "2026-09-01T00:00:00.0000000+00:00"),
        ];

        Assert.Equal("Volibear", Assert.Single(LaneScoreAggregator.Recommend(history, 887, LaneRoles.Top).Best).ChampionName);
    }

    [Fact]
    public void AnEmptyHistoryIsAnEmptyRecommendation()
    {
        var empty = LaneScoreAggregator.Recommend(null, 887, LaneRoles.Top);
        Assert.Equal(0, empty.TotalGames);
        Assert.Empty(empty.Best);
        Assert.Empty(empty.Worst);
        Assert.Equal(887, empty.EnemyChampionId);
        Assert.Equal(LaneRoles.Top, empty.RoleId);
    }
}
