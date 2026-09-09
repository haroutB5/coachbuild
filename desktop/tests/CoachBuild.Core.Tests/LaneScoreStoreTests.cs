using System.Text.Json;
using CoachBuild.Core;
using Xunit;

namespace CoachBuild.Core.Tests;

/// <summary>
/// Persistence for the lane-score history.
///
/// <para>The subject of the first test is the brief's central demand: the
/// history is months of the user's own judgement about their own games, it
/// cannot be reconstructed from anywhere, and the store it sits beside
/// (<c>OverlaySettingsStore</c>) has a documented shape where a field missing
/// from a hand-written clone path is silently reset on the next write of any
/// unrelated value. So: write everything, reload, compare everything.</para>
/// </summary>
public sealed class LaneScoreStoreTests : IDisposable
{
    private readonly string _directory;
    private readonly string _path;

    public LaneScoreStoreTests()
    {
        _directory = Path.Combine(Path.GetTempPath(), "cb-lane-scores-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(_directory);
        _path = Path.Combine(_directory, LaneScoreStore.FileName);
    }

    public void Dispose()
    {
        try { Directory.Delete(_directory, recursive: true); } catch { }
    }

    private LaneScoreStore Store() => new(_path);

    private static LaneScoreGame Game(
        string matchId = "7351234567",
        int queueId = RankedQueues.SoloDuo,
        int? opponent = 887,
        int? roleId = LaneRoles.Top) => new()
    {
        MatchId = matchId,
        PlayedAt = "2026-09-09T09:19:40.0000000+00:00",
        QueueId = queueId,
        MyChampionId = 106,
        MyChampionName = "Volibear",
        RoleId = roleId,
        OpponentChampionId = opponent,
        OpponentChampionName = opponent is null ? null : "Gwen",
        EnemyChampionIds = [887, 24, 86, 122, 875],
        PositionSource = "teamPosition",
        CapturedAt = "2026-09-09T09:51:12.0000000+00:00",
    };

    /// <summary>
    /// THE regression test the brief asks for by name. Every field of a
    /// fully-populated document goes to disk and comes back identical.
    ///
    /// <para>If someone later adds a projection, a clone or a "tidy up" mapping
    /// step inside the store, this is what catches the field they forget.</para>
    /// </summary>
    [Fact]
    public void AFullyPopulatedDocumentSurvivesAWriteReloadCycle()
    {
        var store = Store();
        var captured = Game();
        Assert.True(store.Capture(captured));
        Assert.True(store.Capture(Game(matchId: "7351234568", opponent: null)));
        Assert.True(store.Submit(new LaneScoreSubmitRequest
        {
            MatchId = "7351234567",
            Score = 9,
            Note = "  perma-shoved, she could not trade back  ",
        }, DateTimeOffset.Parse("2026-09-09T22:00:00Z")).Ok);
        Assert.True(store.Submit(new LaneScoreSubmitRequest
        {
            MatchId = "7351234568",
            Skip = true,
        }, DateTimeOffset.Parse("2026-09-09T22:01:00Z")).Ok);
        Assert.True(store.Capture(Game(matchId: "7351234569")));

        // A brand-new store instance, so nothing can be served from a cache.
        var reloaded = new LaneScoreStore(_path).Read();

        Assert.Equal(LaneScoreDocument.CurrentSchemaVersion, reloaded.SchemaVersion);
        Assert.Equal(["7351234568"], reloaded.Skipped);

        var record = Assert.Single(reloaded.Scores);
        Assert.Equal(9, record.Score);
        Assert.Equal("perma-shoved, she could not trade back", record.Note);
        Assert.Equal("2026-09-09T22:00:00.0000000+00:00", record.ScoredAt);

        var game = record.Game;
        Assert.Equal(captured.MatchId, game.MatchId);
        Assert.Equal(captured.PlayedAt, game.PlayedAt);
        Assert.Equal(captured.QueueId, game.QueueId);
        Assert.Equal(captured.MyChampionId, game.MyChampionId);
        Assert.Equal(captured.MyChampionName, game.MyChampionName);
        Assert.Equal(captured.RoleId, game.RoleId);
        Assert.Equal(captured.OpponentChampionId, game.OpponentChampionId);
        Assert.Equal(captured.OpponentChampionName, game.OpponentChampionName);
        Assert.Equal(captured.EnemyChampionIds, game.EnemyChampionIds);
        Assert.Equal(captured.PositionSource, game.PositionSource);
        Assert.Equal(captured.CapturedAt, game.CapturedAt);

        var stillPending = Assert.Single(reloaded.Pending);
        Assert.Equal("7351234569", stillPending.MatchId);
        Assert.Equal(captured.EnemyChampionIds, stillPending.EnemyChampionIds);
    }

    /// <summary>
    /// The trap from the other direction: a key written by a FUTURE version must
    /// survive a write by this one. Without <c>JsonExtensionData</c> the user
    /// downgrades once and silently loses whatever the newer build recorded.
    /// </summary>
    [Fact]
    public void AKeyThisBuildDoesNotModelSurvivesAWrite()
    {
        File.WriteAllText(_path, """
        {
          "schemaVersion": 1,
          "pending": [],
          "scores": [],
          "skipped": [],
          "somethingVersion2Added": { "keep": "me" }
        }
        """);

        Assert.True(Store().Capture(Game()));

        using var document = JsonDocument.Parse(File.ReadAllText(_path));
        var preserved = document.RootElement.GetProperty("somethingVersion2Added");
        Assert.Equal("me", preserved.GetProperty("keep").GetString());
    }

    [Fact]
    public void AGameIsNeverCapturedTwice()
    {
        var store = Store();
        Assert.True(store.Capture(Game()));
        Assert.False(store.Capture(Game()));
        Assert.Single(store.Read().Pending);
    }

    /// <summary>
    /// The restart case stated in the brief. A scored game and a skipped game
    /// must both be remembered as "dealt with", or every app restart re-asks.
    /// </summary>
    [Fact]
    public void AScoredOrSkippedGameIsNeverOfferedAgain()
    {
        var store = Store();
        store.Capture(Game(matchId: "scored"));
        store.Capture(Game(matchId: "skipped"));
        store.Submit(new LaneScoreSubmitRequest { MatchId = "scored", Score = 7 }, DateTimeOffset.UtcNow);
        store.Submit(new LaneScoreSubmitRequest { MatchId = "skipped", Skip = true }, DateTimeOffset.UtcNow);

        var afterRestart = new LaneScoreStore(_path);
        Assert.False(afterRestart.Capture(Game(matchId: "scored")));
        Assert.False(afterRestart.Capture(Game(matchId: "skipped")));
        Assert.Null(afterRestart.Pending());
    }

    [Fact]
    public void AGameCanNeverBeScoredTwice()
    {
        var store = Store();
        store.Capture(Game());
        Assert.True(store.Submit(new LaneScoreSubmitRequest { MatchId = "7351234567", Score = 9 }, DateTimeOffset.UtcNow).Ok);

        var second = store.Submit(new LaneScoreSubmitRequest { MatchId = "7351234567", Score = 2 }, DateTimeOffset.UtcNow);
        Assert.False(second.Ok);
        Assert.Equal("already-scored", second.Reason);
        Assert.Equal(9, Assert.Single(store.Read().Scores).Score);
    }

    /// <summary>
    /// Out-of-range scores are REJECTED, never clamped. A 0 or a 47 is a caller
    /// bug, and quietly turning it into a 1 or a 10 puts a number the user never
    /// chose into a history they will later make decisions from.
    /// </summary>
    [Theory]
    [InlineData(0)]
    [InlineData(-3)]
    [InlineData(11)]
    [InlineData(47)]
    public void AnOutOfRangeScoreIsRejectedRatherThanClamped(int score)
    {
        var store = Store();
        store.Capture(Game());

        var result = store.Submit(new LaneScoreSubmitRequest { MatchId = "7351234567", Score = score }, DateTimeOffset.UtcNow);

        Assert.False(result.Ok);
        Assert.Equal("bad-score", result.Reason);
        Assert.Empty(store.Read().Scores);
        Assert.Single(store.Read().Pending);
    }

    [Fact]
    public void AMissingScoreIsRejected()
    {
        var store = Store();
        store.Capture(Game());
        Assert.Equal("bad-score",
            store.Submit(new LaneScoreSubmitRequest { MatchId = "7351234567" }, DateTimeOffset.UtcNow).Reason);
    }

    [Fact]
    public void AnUnknownMatchIsRejected()
    {
        var store = Store();
        store.Capture(Game());
        Assert.Equal("unknown-match",
            store.Submit(new LaneScoreSubmitRequest { MatchId = "not-a-game", Score = 5 }, DateTimeOffset.UtcNow).Reason);
    }

    /// <summary>
    /// The honest-degradation path. A game captured with no resolvable opponent
    /// cannot be scored until the user says who it was — storing an
    /// unattributed score would be quietly throwing the game away, because
    /// nothing can ever aggregate it.
    /// </summary>
    [Fact]
    public void AGameWithNoKnownOpponentCannotBeScoredWithoutOne()
    {
        var store = Store();
        store.Capture(Game(opponent: null));

        var refused = store.Submit(new LaneScoreSubmitRequest { MatchId = "7351234567", Score = 9 }, DateTimeOffset.UtcNow);
        Assert.False(refused.Ok);
        Assert.Equal("opponent-required", refused.Reason);

        var accepted = store.Submit(
            new LaneScoreSubmitRequest { MatchId = "7351234567", Score = 9, OpponentChampionId = 24 },
            DateTimeOffset.UtcNow);
        Assert.True(accepted.Ok);
        Assert.Equal(24, Assert.Single(store.Read().Scores).Game.OpponentChampionId);
    }

    /// <summary>
    /// The user may only name someone who was actually on the enemy team. This
    /// is the one place a bad client could otherwise inject an arbitrary matchup
    /// into the history.
    /// </summary>
    [Fact]
    public void AnOpponentWhoWasNotOnTheEnemyTeamIsRejected()
    {
        var store = Store();
        store.Capture(Game(opponent: null));

        var result = store.Submit(
            new LaneScoreSubmitRequest { MatchId = "7351234567", Score = 9, OpponentChampionId = 99999 },
            DateTimeOffset.UtcNow);

        Assert.False(result.Ok);
        Assert.Equal("bad-opponent", result.Reason);
        Assert.Empty(store.Read().Scores);
    }

    /// <summary>
    /// A correction to a matchup we thought we knew is accepted, and it clears
    /// the champion NAME we had cached against the old id. Keeping "Gwen" beside
    /// championId 24 would be a display bug that outlives the correction.
    /// </summary>
    [Fact]
    public void CorrectingAResolvedOpponentAlsoDropsTheStaleName()
    {
        var store = Store();
        store.Capture(Game(opponent: 887));

        Assert.True(store.Submit(
            new LaneScoreSubmitRequest { MatchId = "7351234567", Score = 4, OpponentChampionId = 24 },
            DateTimeOffset.UtcNow).Ok);

        var stored = Assert.Single(store.Read().Scores).Game;
        Assert.Equal(24, stored.OpponentChampionId);
        Assert.Null(stored.OpponentChampionName);
    }

    [Fact]
    public void ANonRankedGameIsNeverCaptured()
    {
        var store = Store();
        Assert.False(store.Capture(Game(queueId: 430)));   // normal blind
        Assert.False(store.Capture(Game(queueId: 450)));   // ARAM
        Assert.False(store.Capture(Game(queueId: 0)));     // custom / practice tool
        Assert.Empty(store.Read().Pending);

        Assert.True(store.Capture(Game(matchId: "solo", queueId: RankedQueues.SoloDuo)));
        Assert.True(store.Capture(Game(matchId: "flex", queueId: RankedQueues.Flex)));
        Assert.Equal(2, store.Read().Pending.Count);
    }

    /// <summary>
    /// The second lock on the demo door. The demo service never calls this store
    /// at all; if a future wiring mistake makes it, the store still refuses.
    /// </summary>
    [Fact]
    public void ADemoGameCanNeverEnterTheRealStore()
    {
        var store = Store();
        Assert.False(store.Capture(Game(matchId: LaneScoreService.DemoMatchIdPrefix + "0000000001")));
        Assert.Empty(store.Read().Pending);
    }

    /// <summary>
    /// A write leaves the directory with exactly the document in it. A leftover
    /// <c>.tmp-*</c> would mean the move did not happen and the next crash-time
    /// read could find a half-written file.
    /// </summary>
    [Fact]
    public void AWriteLeavesNoTemporaryFileBehind()
    {
        var store = Store();
        store.Capture(Game());
        store.Submit(new LaneScoreSubmitRequest { MatchId = "7351234567", Score = 6 }, DateTimeOffset.UtcNow);

        Assert.Equal([_path], Directory.GetFiles(_directory));
    }

    /// <summary>
    /// A file that exists but cannot be parsed is LEFT ALONE. Recording one new
    /// score is never worth deleting a history the user cannot rebuild, so the
    /// mutation becomes a no-op and the caller is told.
    /// </summary>
    [Fact]
    public void AnUnreadableFileIsNeverOverwritten()
    {
        File.WriteAllText(_path, "{ this is not json");
        var store = Store();

        Assert.False(store.Capture(Game()));
        Assert.Equal("store-unreadable",
            store.Submit(new LaneScoreSubmitRequest { MatchId = "7351234567", Score = 5 }, DateTimeOffset.UtcNow).Reason);
        Assert.Equal("{ this is not json", File.ReadAllText(_path));
    }

    /// <summary>A missing file is an empty history, not an exception.</summary>
    [Fact]
    public void AMissingFileReadsAsAnEmptyHistory()
    {
        var document = Store().Read();
        Assert.Empty(document.Pending);
        Assert.Empty(document.Scores);
        Assert.Empty(document.Skipped);
        Assert.Null(Store().Pending());
    }

    /// <summary>Newest first: the game they remember is the last one they played.</summary>
    [Fact]
    public void ThePendingCardOffersTheMostRecentlyCapturedGame()
    {
        var store = Store();
        store.Capture(Game(matchId: "older"));
        store.Capture(Game(matchId: "newer"));
        Assert.Equal("newer", store.Pending()!.MatchId);
    }

    [Fact]
    public void ANoteIsTrimmedAndBounded()
    {
        Assert.Null(LaneScoreStore.NormalizeNote("   "));
        Assert.Null(LaneScoreStore.NormalizeNote(null));
        Assert.Equal("kited well", LaneScoreStore.NormalizeNote("  kited well  "));
        Assert.Equal(280, LaneScoreStore.NormalizeNote(new string('x', 400))!.Length);
    }
}
