using System.Text.Json;
using CoachBuild.Core;
using Xunit;

namespace CoachBuild.Core.Tests;

/// <summary>
/// Reading a finished game off the League client.
///
/// <para><b>These fixtures are not ground truth and must not be mistaken for
/// it.</b> The League client was not running on the machine this was written on
/// — the app's own log records <c>lcu_discovery_failed</c> across all four
/// discovery layers — so the exact spelling the platform uses could not be
/// confirmed against a live payload. What these tests DO pin is the behaviour
/// that matters regardless of spelling: several candidate shapes are accepted,
/// the field that won is reported, and <b>anything ambiguous resolves to
/// "unknown opponent" rather than to a guess</b>. The last one is the whole
/// safety property — a wrong opponent silently poisons the recommendation
/// forever, an unknown one costs the user one tap.</para>
/// </summary>
public sealed class LaneScoreCaptureTests
{
    private static readonly DateTimeOffset Now = DateTimeOffset.Parse("2026-09-09T22:00:00Z");
    private const string MyPuuid = "my-puuid";

    private static JsonElement Json(string raw) => JsonDocument.Parse(raw).RootElement.Clone();

    /// <summary>The flat match-history shape: one `participants` array, positions on the participant.</summary>
    private static JsonElement MatchHistoryGame(
        int queueId = RankedQueues.SoloDuo,
        string myPosition = "TOP",
        string enemyTopPosition = "TOP") => Json($$"""
        {
          "gameId": 7351234567,
          "queueId": {{queueId}},
          "gameCreationDate": "2026-09-09T09:19:40.000Z",
          "participants": [
            { "puuid": "{{MyPuuid}}", "championId": 106, "championName": "Volibear",
              "teamId": 100, "teamPosition": "{{myPosition}}" },
            { "puuid": "ally-1", "championId": 64,  "teamId": 100, "teamPosition": "JUNGLE" },
            { "puuid": "enemy-1", "championId": 887, "championName": "Gwen",
              "teamId": 200, "teamPosition": "{{enemyTopPosition}}" },
            { "puuid": "enemy-2", "championId": 24,  "teamId": 200, "teamPosition": "JUNGLE" },
            { "puuid": "enemy-3", "championId": 86,  "teamId": 200, "teamPosition": "MIDDLE" }
          ]
        }
        """);

    [Fact]
    public void TheFlatMatchHistoryShapeResolvesTheLaner()
    {
        var game = LaneScoreCapture.TryBuild(MatchHistoryGame(), MyPuuid, Now);

        Assert.NotNull(game);
        Assert.Equal("7351234567", game.MatchId);
        Assert.Equal(RankedQueues.SoloDuo, game.QueueId);
        Assert.Equal(106, game.MyChampionId);
        Assert.Equal("Volibear", game.MyChampionName);
        Assert.Equal(LaneRoles.Top, game.RoleId);
        Assert.Equal(887, game.OpponentChampionId);
        Assert.Equal("Gwen", game.OpponentChampionName);
        // Only the enemy team, and all of it -- this is what the card offers when
        // the opponent could not be resolved.
        Assert.Equal([887, 24, 86], game.EnemyChampionIds);
        // The field that actually won, so a real game tells us the real shape.
        Assert.Equal("teamPosition", game.PositionSource);
    }

    /// <summary>The nested end-of-game shape: `teams[].players[]`, positions under a different name.</summary>
    [Fact]
    public void TheNestedEndOfGameShapeAlsoResolvesTheLaner()
    {
        var payload = Json($$"""
        {
          "gameId": 7351234599,
          "queueId": 440,
          "teams": [
            { "teamId": 100, "players": [
                { "puuid": "{{MyPuuid}}", "championId": 106, "skinName": "Volibear",
                  "teamId": 100, "selectedPosition": "TOP" } ] },
            { "teamId": 200, "players": [
                { "puuid": "enemy-1", "championId": 887, "teamId": 200, "selectedPosition": "TOP" },
                { "puuid": "enemy-2", "championId": 24,  "teamId": 200, "selectedPosition": "JUNGLE" } ] }
          ]
        }
        """);

        var game = LaneScoreCapture.TryBuild(payload, MyPuuid, Now);

        Assert.NotNull(game);
        Assert.Equal(RankedQueues.Flex, game.QueueId);
        Assert.Equal(887, game.OpponentChampionId);
        Assert.Equal("selectedPosition", game.PositionSource);
    }

    /// <summary>
    /// No position data at all. The game is still worth capturing — we know who
    /// the five enemies were — but the opponent is null and the card will ask.
    /// </summary>
    [Fact]
    public void AnAbsentPositionYieldsAnUnknownOpponentAndNeverAGuess()
    {
        var payload = Json($$"""
        {
          "gameId": 7351234567, "queueId": 420,
          "participants": [
            { "puuid": "{{MyPuuid}}", "championId": 106, "teamId": 100 },
            { "puuid": "enemy-1", "championId": 887, "teamId": 200 },
            { "puuid": "enemy-2", "championId": 24,  "teamId": 200 }
          ]
        }
        """);

        var game = LaneScoreCapture.TryBuild(payload, MyPuuid, Now);

        Assert.NotNull(game);
        Assert.Null(game.OpponentChampionId);
        Assert.Null(game.RoleId);
        // NOT enemies[0]. That is the guess the brief forbids, and the one the
        // repo already deleted once for champ select (audit P2-1).
        Assert.Equal([887, 24], game.EnemyChampionIds);
        Assert.Equal("absent", game.PositionSource);
    }

    /// <summary>
    /// <c>NONE</c> is the client SAYING it does not know. The app's own log shows
    /// it emitting exactly that (<c>position=NONE</c>). Turning a stated unknown
    /// into a lane is the precise failure this feature must not have.
    /// </summary>
    [Theory]
    [InlineData("NONE")]
    [InlineData("INVALID")]
    [InlineData("")]
    public void AStatedUnknownIsNotTreatedAsALane(string position)
    {
        Assert.Null(LaneScoreCapture.Normalize(position));

        var game = LaneScoreCapture.TryBuild(MatchHistoryGame(myPosition: position), MyPuuid, Now);

        Assert.NotNull(game);
        Assert.Null(game.OpponentChampionId);
        Assert.Null(game.RoleId);
    }

    /// <summary>
    /// My lane is known but no enemy claims it — the enemy team's positions are
    /// missing or spelled differently. Ambiguous means ask, and the reason names
    /// the field so the shape can be fixed from a real game.
    /// </summary>
    [Fact]
    public void AnEnemyTeamWithNoMatchingLaneIsUnknownNotGuessed()
    {
        var game = LaneScoreCapture.TryBuild(
            MatchHistoryGame(myPosition: "TOP", enemyTopPosition: "NONE"), MyPuuid, Now);

        Assert.NotNull(game);
        Assert.Null(game.OpponentChampionId);
        Assert.Equal(LaneRoles.Top, game.RoleId);
        Assert.Contains("unmatched", game.PositionSource);
    }

    /// <summary>Two enemies claiming one lane happens in remakes and role swaps. Also ambiguous.</summary>
    [Fact]
    public void TwoEnemiesInOneLaneIsAmbiguousNotFirstWins()
    {
        var payload = Json($$"""
        {
          "gameId": 7351234567, "queueId": 420,
          "participants": [
            { "puuid": "{{MyPuuid}}", "championId": 106, "teamId": 100, "teamPosition": "TOP" },
            { "puuid": "enemy-1", "championId": 887, "teamId": 200, "teamPosition": "TOP" },
            { "puuid": "enemy-2", "championId": 24,  "teamId": 200, "teamPosition": "TOP" }
          ]
        }
        """);

        var game = LaneScoreCapture.TryBuild(payload, MyPuuid, Now);

        Assert.NotNull(game);
        Assert.Null(game.OpponentChampionId);
        Assert.Contains("ambiguous", game.PositionSource);
    }

    /// <summary>The ranked-only gate, checked before anything touches the store.</summary>
    [Theory]
    [InlineData(430)]  // normal blind
    [InlineData(400)]  // normal draft
    [InlineData(450)]  // ARAM
    [InlineData(0)]    // custom / practice tool
    [InlineData(1700)] // arena
    public void ANonRankedGameIsNotCapturedAtAll(int queueId)
    {
        Assert.Null(LaneScoreCapture.TryBuild(MatchHistoryGame(queueId: queueId), MyPuuid, Now));
    }

    [Theory]
    [InlineData(RankedQueues.SoloDuo)]
    [InlineData(RankedQueues.Flex)]
    public void BothRankedQueuesAreCaptured(int queueId)
    {
        Assert.NotNull(LaneScoreCapture.TryBuild(MatchHistoryGame(queueId: queueId), MyPuuid, Now));
    }

    /// <summary>
    /// Without a way to identify the local player the whole capture is abandoned.
    /// Recording somebody else's lane would be worse than recording nothing.
    /// </summary>
    [Fact]
    public void AnUnidentifiableLocalPlayerAbandonsTheCapture()
    {
        Assert.Null(LaneScoreCapture.TryBuild(MatchHistoryGame(), ownPuuid: null, Now));
        Assert.Null(LaneScoreCapture.TryBuild(MatchHistoryGame(), ownPuuid: "somebody-else", Now));
    }

    /// <summary>An explicit local-player flag is used when the payload carries one.</summary>
    [Fact]
    public void AnExplicitLocalPlayerFlagIsHonouredWithoutAPuuid()
    {
        var payload = Json("""
        {
          "gameId": 1, "queueId": 420,
          "participants": [
            { "championId": 106, "teamId": 100, "teamPosition": "TOP", "isLocalPlayer": true },
            { "championId": 887, "teamId": 200, "teamPosition": "TOP" }
          ]
        }
        """);

        var game = LaneScoreCapture.TryBuild(payload, ownPuuid: null, Now);

        Assert.NotNull(game);
        Assert.Equal(106, game.MyChampionId);
        Assert.Equal(887, game.OpponentChampionId);
    }

    /// <summary>The match-history envelope nests games; the newest is taken out of it.</summary>
    [Fact]
    public void TheMatchHistoryEnvelopeIsUnwrapped()
    {
        var payload = Json($$"""
        {
          "games": { "games": [
            { "gameId": 1, "queueId": 420, "participants": [
                { "puuid": "{{MyPuuid}}", "championId": 1, "teamId": 100, "teamPosition": "TOP" },
                { "puuid": "e", "championId": 2, "teamId": 200, "teamPosition": "TOP" } ] },
            { "gameId": 2, "queueId": 420, "participants": [
                { "puuid": "{{MyPuuid}}", "championId": 106, "teamId": 100, "teamPosition": "TOP" },
                { "puuid": "e", "championId": 887, "teamId": 200, "teamPosition": "TOP" } ] }
          ] }
        }
        """);

        var game = LaneScoreCapture.TryBuild(payload, MyPuuid, Now);

        Assert.NotNull(game);
        Assert.Equal("2", game.MatchId);
        Assert.Equal(106, game.MyChampionId);
    }

    /// <summary>
    /// The diagnostic inventory is what makes the real shape verifiable from the
    /// user's next ranked game. It must therefore contain FIELD NAMES and no
    /// VALUES — this log file is the one users are routinely asked to send us,
    /// and puuids and summoner names have no business in it.
    /// </summary>
    [Fact]
    public void TheShapeInventoryNamesFieldsAndLeaksNoValues()
    {
        var payload = Json("""
        {
          "gameId": 7351234567, "queueId": 420,
          "participants": [
            { "puuid": "SECRET-PUUID-VALUE", "summonerName": "SecretSummoner",
              "championId": 106, "teamId": 100, "teamPosition": "TOP" }
          ]
        }
        """);

        var described = LaneScoreCapture.Describe(payload);

        Assert.Contains("queueId", described);
        Assert.Contains("teamPosition", described);
        Assert.Contains("puuid", described);
        Assert.DoesNotContain("SECRET-PUUID-VALUE", described);
        Assert.DoesNotContain("SecretSummoner", described);
        Assert.DoesNotContain("TOP", described);
    }

    [Fact]
    public void GarbageIsRejectedRatherThanThrowing()
    {
        Assert.Null(LaneScoreCapture.TryBuild(Json("[]"), MyPuuid, Now));
        Assert.Null(LaneScoreCapture.TryBuild(Json("{}"), MyPuuid, Now));
        Assert.Null(LaneScoreCapture.TryBuild(Json("""{"queueId":420}"""), MyPuuid, Now));
        Assert.Null(LaneScoreCapture.TryBuild(Json("""{"gameId":1,"queueId":420,"participants":[]}"""), MyPuuid, Now));
    }

    /// <summary>Every spelling the platform has used for a lane maps onto the same five roles.</summary>
    [Theory]
    [InlineData("TOP", "top")]
    [InlineData("top", "top")]
    [InlineData("JUNGLE", "jungle")]
    [InlineData("MIDDLE", "middle")]
    [InlineData("MID", "middle")]
    [InlineData("BOTTOM", "bottom")]
    [InlineData("DUO_CARRY", "bottom")]
    [InlineData("UTILITY", "utility")]
    [InlineData("SUPPORT", "utility")]
    [InlineData("DUO_SUPPORT", "utility")]
    public void LaneSpellingsAreCanonicalised(string raw, string expected)
    {
        Assert.Equal(expected, LaneScoreCapture.Normalize(raw));
        // And the canonical form is the one ComplianceRules already understands,
        // so a lane score, a champ-select snapshot and a skill order all agree
        // on what "role 4" means.
        Assert.NotNull(ComplianceRules.RoleIdFromPosition(expected));
    }
}
