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

    /// <summary>
    /// A real bot-lane game as the live client publishes it: lane and role under
    /// <c>timeline</c>, and <b>all four bot laners reporting lane BOTTOM</b>.
    /// Position alone can never separate an ADC from a support, which is why
    /// every bot-lane game used to ask the user who they laned against.
    /// </summary>
    private static JsonElement BotLaneGame(
        string myRole = "DUO_CARRY",
        string enemyAdcRole = "DUO_CARRY",
        string enemySupportRole = "DUO_SUPPORT") => Json($$"""
        {
          "gameId": 7351299001,
          "queueId": 420,
          "participants": [
            { "puuid": "{{MyPuuid}}", "championId": 22, "championName": "Ashe", "teamId": 100,
              "timeline": { "lane": "BOTTOM", "role": "{{myRole}}" } },
            { "puuid": "ally-sup", "championId": 412, "teamId": 100,
              "timeline": { "lane": "BOTTOM", "role": "DUO_SUPPORT" } },
            { "puuid": "ally-top", "championId": 86, "teamId": 100,
              "timeline": { "lane": "TOP", "role": "SOLO" } },
            { "puuid": "enemy-adc", "championId": 51, "championName": "Caitlyn", "teamId": 200,
              "timeline": { "lane": "BOTTOM", "role": "{{enemyAdcRole}}" } },
            { "puuid": "enemy-sup", "championId": 555, "championName": "Pyke", "teamId": 200,
              "timeline": { "lane": "BOTTOM", "role": "{{enemySupportRole}}" } },
            { "puuid": "enemy-top", "championId": 122, "championName": "Darius", "teamId": 200,
              "timeline": { "lane": "TOP", "role": "SOLO" } }
          ]
        }
        """);

    /// <summary>
    /// The ADC's opponent is the enemy ADC, not the enemy support and not a
    /// question. Two enemies sit at BOTTOM; role is what breaks the tie.
    /// </summary>
    [Fact]
    public void BotLaneResolvesTheEnemyCarryForACarry()
    {
        var game = LaneScoreCapture.TryBuild(BotLaneGame(), MyPuuid, Now);

        Assert.NotNull(game);
        Assert.Equal(51, game.OpponentChampionId);
        Assert.Equal("Caitlyn", game.OpponentChampionName);
        // The log still names what actually worked, both halves of it.
        Assert.Equal("timeline.lane+timeline.role", game.PositionSource);
    }

    /// <summary>And the mirror: a support lands on the enemy support.</summary>
    [Fact]
    public void BotLaneResolvesTheEnemySupportForASupport()
    {
        var game = LaneScoreCapture.TryBuild(BotLaneGame(myRole: "DUO_SUPPORT"), MyPuuid, Now);

        Assert.NotNull(game);
        Assert.Equal(555, game.OpponentChampionId);
        Assert.Equal("Pyke", game.OpponentChampionName);
        Assert.Equal("timeline.lane+timeline.role", game.PositionSource);
    }

    /// <summary>
    /// My role is the client's stated unknown. An unusable role is NOT a licence
    /// to pick one of the two — it falls straight back to asking.
    /// </summary>
    [Theory]
    [InlineData("NONE")]
    [InlineData("")]
    public void BotLaneWithoutAUsableRoleOfMyOwnStaysAmbiguous(string myRole)
    {
        Assert.Null(LaneScoreCapture.NormalizeRole(myRole));

        var game = LaneScoreCapture.TryBuild(BotLaneGame(myRole: myRole), MyPuuid, Now);

        Assert.NotNull(game);
        Assert.Null(game.OpponentChampionId);
        Assert.Contains("ambiguous", game.PositionSource);
    }

    /// <summary>
    /// The sharpest version of the same rule: my role is <c>NONE</c> and so is
    /// exactly ONE enemy's. If unknown were a value rather than an absence,
    /// "NONE matches NONE" would narrow to exactly one enemy and resolve — a
    /// confident opponent built out of two participants who both said they did
    /// not know. It must stay ambiguous.
    /// </summary>
    [Fact]
    public void TwoStatedUnknownRolesDoNotMatchEachOther()
    {
        var game = LaneScoreCapture.TryBuild(
            BotLaneGame(myRole: "NONE", enemyAdcRole: "NONE", enemySupportRole: "DUO_SUPPORT"),
            MyPuuid,
            Now);

        Assert.NotNull(game);
        Assert.Null(game.OpponentChampionId);
        Assert.Contains("ambiguous", game.PositionSource);
    }

    /// <summary>
    /// Roles are present on every participant and NONE of them is mine. Zero
    /// matches is just as ambiguous as two, and a carry must never be handed the
    /// support as an opponent.
    /// </summary>
    [Fact]
    public void BotLaneWhereNoEnemyRoleMatchesStaysAmbiguous()
    {
        var game = LaneScoreCapture.TryBuild(
            BotLaneGame(myRole: "DUO_CARRY", enemyAdcRole: "DUO_SUPPORT", enemySupportRole: "DUO_SUPPORT"),
            MyPuuid,
            Now);

        Assert.NotNull(game);
        Assert.Null(game.OpponentChampionId);
        Assert.Contains("ambiguous", game.PositionSource);
    }

    /// <summary>
    /// The control. Top lane is unique by position, so it resolves without role
    /// ever being consulted — and the source string stays the position field on
    /// its own. If this ever reads "+role" the narrowing has leaked into lanes
    /// that never needed it.
    /// </summary>
    [Fact]
    public void TopLaneStillResolvesOnPositionAloneWithNoRoleSuffix()
    {
        var payload = Json($$"""
        {
          "gameId": 7351299002, "queueId": 420,
          "participants": [
            { "puuid": "{{MyPuuid}}", "championId": 86, "teamId": 100,
              "timeline": { "lane": "TOP", "role": "SOLO" } },
            { "puuid": "enemy-top", "championId": 122, "teamId": 200,
              "timeline": { "lane": "TOP", "role": "SOLO" } },
            { "puuid": "enemy-adc", "championId": 51, "teamId": 200,
              "timeline": { "lane": "BOTTOM", "role": "DUO_CARRY" } }
          ]
        }
        """);

        var game = LaneScoreCapture.TryBuild(payload, MyPuuid, Now);

        Assert.NotNull(game);
        Assert.Equal(122, game.OpponentChampionId);
        Assert.Equal("timeline.lane", game.PositionSource);
        Assert.DoesNotContain("+", game.PositionSource);
    }

    /// <summary>
    /// The tie-breaker's own contract. <c>DUO_CARRY</c> and <c>DUO_SUPPORT</c>
    /// must never land on the same token, and every stated unknown must be
    /// unusable rather than a value that can accidentally match.
    /// </summary>
    [Theory]
    [InlineData("DUO_CARRY", "carry")]
    [InlineData("duo_carry", "carry")]
    [InlineData("ADC", "carry")]
    [InlineData("DUO_SUPPORT", "support")]
    [InlineData("SUPPORT", "support")]
    [InlineData("SOLO", "solo")]
    [InlineData("NONE", null)]
    [InlineData("INVALID", null)]
    [InlineData("", null)]
    [InlineData("SUPER_CARRY", null)]
    public void RoleSpellingsAreCanonicalisedAndUnknownsStayUnusable(string raw, string? expected)
    {
        Assert.Equal(expected, LaneScoreCapture.NormalizeRole(raw));
    }

    [Fact]
    public void TheCarryAndTheSupportNeverShareARoleToken()
    {
        Assert.NotEqual(LaneScoreCapture.NormalizeRole("DUO_CARRY"), LaneScoreCapture.NormalizeRole("DUO_SUPPORT"));
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

    // ------------------------------------------------------------------
    // Which ROLE ID a bot-lane game is filed under.
    //
    // The lane cannot answer this on its own. Match history says
    // `timeline.lane = BOTTOM` for the ADC and the support alike, so before
    // 2.3.2 a support's game was stored as role 3 while champ select — which
    // reads `assignedPosition` and therefore says `utility` — asked for role 4.
    // Two different roles aggregated into one bucket, and a support's own
    // history was unreachable under its own id.
    // ------------------------------------------------------------------

    /// <summary>
    /// The fix. A support at BOTTOM is filed as 4 (utility), the same id champ
    /// select asks for, and the opponent narrowing is untouched by it: the enemy
    /// support is still resolved as the opponent in the very same capture. This
    /// asserts both halves because the change must not buy a correct bucket at
    /// the price of the matching it sits next to.
    /// </summary>
    [Fact]
    public void ASupportAtBottomIsFiledAsUtilityAndStillResolvesTheEnemySupport()
    {
        var game = LaneScoreCapture.TryBuild(BotLaneGame(myRole: "DUO_SUPPORT"), MyPuuid, Now);

        Assert.NotNull(game);
        Assert.Equal(LaneRoles.Utility, game.RoleId);
        Assert.NotEqual(LaneRoles.Bottom, game.RoleId);
        // The opponent matching, unchanged.
        Assert.Equal(555, game.OpponentChampionId);
        Assert.Equal("Pyke", game.OpponentChampionName);
        Assert.Equal("timeline.lane+timeline.role", game.PositionSource);
        // And this is the id champ select will query with, so the two sides of
        // the feature now name the same bucket.
        Assert.Equal(ComplianceRules.RoleIdFromPosition("utility"), game.RoleId);
    }

    /// <summary>The other bot laner is unaffected: a carry at BOTTOM is still 3.</summary>
    [Fact]
    public void ACarryAtBottomStaysBottom()
    {
        var game = LaneScoreCapture.TryBuild(BotLaneGame(myRole: "DUO_CARRY"), MyPuuid, Now);

        Assert.NotNull(game);
        Assert.Equal(LaneRoles.Bottom, game.RoleId);
        Assert.Equal(51, game.OpponentChampionId);
    }

    /// <summary>
    /// An unusable role at BOTTOM keeps today's answer of 3. <c>NONE</c>,
    /// <c>INVALID</c>, blank and an unknown spelling all mean "the client is not
    /// telling us", and a stated unknown must never be read as evidence of a
    /// support: an absence is not a classification. Note the capture is already
    /// ambiguous about the OPPONENT in these cases — the role id must still be
    /// the lane's own answer, not null and not 4.
    /// </summary>
    [Theory]
    [InlineData("NONE")]
    [InlineData("INVALID")]
    [InlineData("")]
    [InlineData("SUPER_CARRY")]
    public void AnUnusableRoleAtBottomKeepsBottom(string myRole)
    {
        Assert.Null(LaneScoreCapture.NormalizeRole(myRole));

        var game = LaneScoreCapture.TryBuild(BotLaneGame(myRole: myRole), MyPuuid, Now);

        Assert.NotNull(game);
        Assert.Equal(LaneRoles.Bottom, game.RoleId);
        Assert.Contains("ambiguous", game.PositionSource);
    }

    /// <summary>
    /// And the role field missing ENTIRELY — not blank, not NONE, absent — is
    /// the same story. This is the shape an older client (or the end-of-game
    /// block) hands over, and it must degrade to the lane's answer rather than
    /// throw the game away or guess at it.
    /// </summary>
    [Fact]
    public void ABottomGameWithNoRoleFieldAtAllKeepsBottom()
    {
        var payload = Json($$"""
        {
          "gameId": 7351299003, "queueId": 420,
          "participants": [
            { "puuid": "{{MyPuuid}}", "championId": 22, "teamId": 100,
              "timeline": { "lane": "BOTTOM" } },
            { "puuid": "enemy-adc", "championId": 51, "teamId": 200,
              "timeline": { "lane": "BOTTOM" } },
            { "puuid": "enemy-sup", "championId": 555, "teamId": 200,
              "timeline": { "lane": "BOTTOM" } }
          ]
        }
        """);

        var game = LaneScoreCapture.TryBuild(payload, MyPuuid, Now);

        Assert.NotNull(game);
        Assert.Equal(LaneRoles.Bottom, game.RoleId);
        Assert.Null(game.OpponentChampionId);
    }

    /// <summary>
    /// The control, through the real capture path: the three solo lanes are
    /// untouched. Each fixture carries a role, and one of them deliberately
    /// carries <c>DUO_SUPPORT</c> at TOP — a nonsense pairing the client should
    /// never emit, present precisely so that a support branch which forgot to
    /// check the lane would be caught here rather than in production.
    /// </summary>
    [Theory]
    [InlineData("TOP", "SOLO", LaneRoles.Top)]
    [InlineData("TOP", "DUO_SUPPORT", LaneRoles.Top)]
    [InlineData("JUNGLE", "NONE", LaneRoles.Jungle)]
    [InlineData("JUNGLE", "DUO_SUPPORT", LaneRoles.Jungle)]
    [InlineData("MIDDLE", "SOLO", LaneRoles.Middle)]
    [InlineData("MIDDLE", "DUO_SUPPORT", LaneRoles.Middle)]
    public void NonBottomLanesAreUnchangedWhateverTheRoleSays(string lane, string role, int expected)
    {
        var payload = Json($$"""
        {
          "gameId": 7351299004, "queueId": 420,
          "participants": [
            { "puuid": "{{MyPuuid}}", "championId": 86, "teamId": 100,
              "timeline": { "lane": "{{lane}}", "role": "{{role}}" } },
            { "puuid": "enemy-1", "championId": 122, "teamId": 200,
              "timeline": { "lane": "{{lane}}", "role": "{{role}}" } }
          ]
        }
        """);

        var game = LaneScoreCapture.TryBuild(payload, MyPuuid, Now);

        Assert.NotNull(game);
        Assert.Equal(expected, game.RoleId);
    }

    /// <summary>
    /// A client that spells the lane <c>UTILITY</c> outright never needed the
    /// role at all, and still does not: it was already 4 and stays 4. This is
    /// the case that proves the new branch ADDS a route to utility rather than
    /// replacing the one that worked.
    /// </summary>
    [Theory]
    [InlineData("UTILITY", "DUO_SUPPORT")]
    [InlineData("UTILITY", "NONE")]
    [InlineData("SUPPORT", "DUO_SUPPORT")]
    public void AnExplicitUtilityLaneIsStillUtility(string lane, string role)
    {
        var payload = Json($$"""
        {
          "gameId": 7351299005, "queueId": 420,
          "participants": [
            { "puuid": "{{MyPuuid}}", "championId": 412, "teamId": 100,
              "timeline": { "lane": "{{lane}}", "role": "{{role}}" } },
            { "puuid": "enemy-sup", "championId": 555, "teamId": 200,
              "timeline": { "lane": "{{lane}}", "role": "{{role}}" } }
          ]
        }
        """);

        var game = LaneScoreCapture.TryBuild(payload, MyPuuid, Now);

        Assert.NotNull(game);
        Assert.Equal(LaneRoles.Utility, game.RoleId);
    }

    /// <summary>
    /// The rule stated directly, over every lane x role pair that matters —
    /// the truth table, executable. <c>ResolveRoleId</c> is fed the canonical
    /// tokens the capture path itself produces, and the raw client spellings
    /// alongside them, because <c>NormalizeRole</c> is idempotent over its own
    /// output and a test that only ever passed raw values could not prove the
    /// production call site behaves the same way.
    /// </summary>
    [Theory]
    // Bottom + support, in both the raw and the canonical spelling -> utility.
    [InlineData("bottom", "DUO_SUPPORT", LaneRoles.Utility)]
    [InlineData("bottom", "support", LaneRoles.Utility)]
    [InlineData("bottom", "SUPP", LaneRoles.Utility)]
    // Bottom + carry -> bottom, unchanged.
    [InlineData("bottom", "DUO_CARRY", LaneRoles.Bottom)]
    [InlineData("bottom", "carry", LaneRoles.Bottom)]
    // Bottom + unusable -> bottom, never a guess.
    [InlineData("bottom", "NONE", LaneRoles.Bottom)]
    [InlineData("bottom", null, LaneRoles.Bottom)]
    [InlineData("bottom", "SOLO", LaneRoles.Bottom)]
    // The solo lanes, whatever the role claims.
    [InlineData("top", "DUO_SUPPORT", LaneRoles.Top)]
    [InlineData("jungle", "DUO_SUPPORT", LaneRoles.Jungle)]
    [InlineData("middle", "DUO_SUPPORT", LaneRoles.Middle)]
    // Already utility.
    [InlineData("utility", "DUO_SUPPORT", LaneRoles.Utility)]
    [InlineData("utility", null, LaneRoles.Utility)]
    public void TheRoleIdTruthTable(string position, string? role, int expected)
    {
        Assert.Equal(expected, LaneScoreCapture.ResolveRoleId(position, role));
    }

    /// <summary>
    /// No lane means no role id, still. Role alone must not manufacture one:
    /// knowing somebody was a support says nothing about whether this game had
    /// a readable lane phase at all, and the store's null is what the card and
    /// the log both already handle.
    /// </summary>
    [Fact]
    public void RoleAloneNeverInventsALane()
    {
        Assert.Null(LaneScoreCapture.ResolveRoleId(null, "DUO_SUPPORT"));
        Assert.Null(LaneScoreCapture.ResolveRoleId("", "DUO_SUPPORT"));
    }
}
