using System.Net;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using CoachBuild.Core;
using Xunit;

namespace CoachBuild.Core.Tests;

/// <summary>
/// The regression suite for the defect that made the in-game skill order
/// impossible for every user, on every champion, in every game, from 1.0.7
/// through 1.0.10.
///
/// <para><c>LivePlayerListResolver.ResolveOwnChampionId</c> read a
/// <c>championId</c> property off a Live Client Data player-list entry. Riot
/// has never published that property — the documented entry carries
/// <c>championName</c> and <c>rawChampionName</c> and no numeric id. So the id
/// was always null, and <c>RequestSkillOrderIfNeeded</c>, gated on
/// <c>championId is &gt; 0</c>, was never reached.</para>
///
/// <para>The one test that covered it passed a hand-written fixture that
/// invented the field. <see cref="The_fixture_the_old_test_used_could_not_exist"/>
/// is the test that fixture should have been.</para>
/// </summary>
public sealed class ChampionIdentityTests
{
    /// <summary>
    /// The local player's entry exactly as a real game publishes it. Field set
    /// and values are Riot's documented shape, cross-checked against this
    /// repo's own 2026-07-27 capture (quoted verbatim in
    /// <c>overlay-host/lib/gameState.js</c>) — including the empty
    /// <c>summonerName</c> recent patches leave behind, and
    /// <c>"position":"NONE"</c>.
    /// </summary>
    private const string ModernPlayerList = """
    [
      {"championName":"Volibear","isBot":false,"isDead":false,"items":[],"level":1,
       "position":"NONE","rawChampionName":"game_character_displayname_Volibear",
       "respawnTimer":0.0,"riotId":"MunsterHunter#EUW","riotIdGameName":"MunsterHunter",
       "riotIdTagLine":"EUW","runes":{},"scores":{},"skinID":0,"summonerName":"",
       "summonerSpells":{},"team":"ORDER"},
      {"championName":"Lee Sin","isBot":false,"isDead":false,"items":[],"level":1,
       "position":"JUNGLE","rawChampionName":"game_character_displayname_LeeSin",
       "riotId":"Someone#EUW","riotIdGameName":"Someone","riotIdTagLine":"EUW",
       "summonerName":"","team":"CHAOS"}
    ]
    """;

    private const string ModernActivePlayer = """
    {"level":6,"riotId":"MunsterHunter#EUW","riotIdGameName":"MunsterHunter",
     "riotIdTagLine":"EUW","summonerName":"",
     "abilities":{"Passive":{"displayName":"The Relentless Storm"},
                  "Q":{"abilityLevel":1},"W":{"abilityLevel":3},
                  "E":{"abilityLevel":1},"R":{"abilityLevel":1}}}
    """;

    // ------------------------------------------------------- the headline bug

    [Fact]
    public void The_real_player_list_carries_no_champion_id_and_still_resolves()
    {
        using var players = JsonDocument.Parse(ModernPlayerList);
        var me = ActivePlayer(ModernActivePlayer);

        var match = LiveLocalPlayerResolver.Match(players.RootElement, me);
        Assert.NotNull(match);
        Assert.Equal(LivePlayerMatchKey.RiotId, match!.MatchedBy);

        // The field the shipped code read. It is not there. This assertion is
        // the whole bug in one line.
        Assert.False(match.Player.TryGetProperty("championId", out _));

        var champion = LiveLocalPlayerResolver.ReadChampion(match.Player);
        Assert.Equal("Volibear", champion.RawKey);
        Assert.Equal("Volibear", champion.DisplayName);
        Assert.Equal("NONE", champion.Position);

        var (id, source) = ChampionIdLookup.Resolve(Roster, champion.RawKey, champion.DisplayName);
        Assert.Equal(106, id);
        Assert.Equal(ChampionIdSource.RawChampionName, source);
    }

    /// <summary>
    /// The 1.0.10 fixture, replayed. It resolves — and it is fiction: no Live
    /// Client Data payload has ever had these fields. A fixture that carries an
    /// input production never sends cannot fail when production breaks, which
    /// is exactly what happened here.
    /// </summary>
    [Fact]
    public void The_fixture_the_old_test_used_could_not_exist()
    {
        using var invented = JsonDocument.Parse("""
        [{"riotId":"Own#EUW","championId":103,"summonerId":"do-not-retain"}]
        """);
        var entry = invented.RootElement[0];

        // What the old code needed, and what the invented fixture supplied.
        Assert.Equal(103, ComplianceRules.PositiveInt(entry, "championId"));

        // What a real entry supplies instead: names, and only names.
        using var real = JsonDocument.Parse(ModernPlayerList);
        var champion = LiveLocalPlayerResolver.ReadChampion(real.RootElement[0]);
        Assert.Null(ComplianceRules.PositiveInt(real.RootElement[0], "championId"));
        Assert.True(champion.HasName);

        // And the invented entry has no name at all, so name-first resolution
        // reports nothing rather than inventing an answer from a stray id.
        var inventedChampion = LiveLocalPlayerResolver.ReadChampion(entry);
        Assert.False(inventedChampion.HasName);
        Assert.Equal((null, ChampionIdSource.None),
            ChampionIdLookup.Resolve(Roster, inventedChampion.RawKey, inventedChampion.DisplayName));
    }

    // --------------------------------------------------- champion-id lookup

    [Theory]
    // rawChampionName is the locale-independent key and is tried first.
    [InlineData("Volibear", "Volibear", 106, ChampionIdSource.RawChampionName)]
    // Wukong's key and display name differ. Matching the display name only
    // would fail on an English client, which is the easy one to get wrong.
    [InlineData("MonkeyKing", "Wukong", 62, ChampionIdSource.RawChampionName)]
    // Punctuation is dropped on both sides: Kaisa == Kai'Sa.
    [InlineData("Kaisa", "Kai'Sa", 145, ChampionIdSource.RawChampionName)]
    [InlineData("Nunu", "Nunu & Willump", 20, ChampionIdSource.RawChampionName)]
    [InlineData("DrMundo", "Dr. Mundo", 36, ChampionIdSource.RawChampionName)]
    // A non-English client localises championName. rawChampionName does not
    // move, which is why it is the preferred rung.
    [InlineData("Chogath", "Kaiser Cho'Gath", 31, ChampionIdSource.RawChampionName)]
    // rawChampionName missing entirely: fall back to the display name.
    [InlineData(null, "Bel'Veth", 200, ChampionIdSource.ChampionName)]
    [InlineData(null, "Wukong", 62, ChampionIdSource.ChampionName)]
    // Neither name is a champion: report nothing rather than guess.
    [InlineData("NotAChampion", "Also Not A Champion", 0, ChampionIdSource.None)]
    [InlineData(null, null, 0, ChampionIdSource.None)]
    public void Champion_ids_resolve_from_the_names_live_client_data_actually_sends(
        string? rawChampionName,
        string? championName,
        int expectedId,
        ChampionIdSource expectedSource)
    {
        var (id, source) = ChampionIdLookup.Resolve(Roster, rawChampionName, championName);
        Assert.Equal(expectedId == 0 ? null : expectedId, id);
        Assert.Equal(expectedSource, source);
    }

    /// <summary>
    /// Held-out data. Every one of the 173 entries the live endpoint actually
    /// returned is driven through the resolver by both of the names Live Client
    /// Data can send. A normalisation rule tuned to the champions I happened to
    /// think of fails here.
    /// </summary>
    [Fact]
    public void Every_champion_on_the_live_roster_resolves_by_key_and_by_display_name()
    {
        var roster = LiveRoster;
        Assert.InRange(roster.Count, 150, 400);

        foreach (var champion in roster)
        {
            var byKey = ChampionIdLookup.Resolve(roster, champion.Key, null);
            Assert.Equal((champion.Id, ChampionIdSource.RawChampionName), byKey);

            var byName = ChampionIdLookup.Resolve(roster, null, champion.Name);
            Assert.Equal((champion.Id, ChampionIdSource.ChampionName), byName);

            // The prefixed wire form, which is what actually arrives.
            using var entry = JsonDocument.Parse(
                $$"""{"rawChampionName":"game_character_displayname_{{champion.Key}}"}""");
            var read = LiveLocalPlayerResolver.ReadChampion(entry.RootElement);
            Assert.Equal(champion.Key, read.RawKey);
            Assert.Equal(champion.Id, ChampionIdLookup.Resolve(roster, read.RawKey, null).Id);
        }
    }

    [Fact]
    public void The_live_roster_has_no_normalisation_collisions()
    {
        var seen = new Dictionary<string, int>(StringComparer.Ordinal);
        foreach (var champion in LiveRoster)
        {
            foreach (var candidate in new[] { champion.Key, champion.Name })
            {
                var normalized = ChampionNameKey.Normalize(candidate);
                if (seen.TryGetValue(normalized, out var owner))
                    Assert.Equal(champion.Id, owner);
                seen[normalized] = champion.Id;
            }
        }
    }

    // ------------------------------------------------------ identity rungs

    [Fact]
    public void Rung_1_matches_the_whole_riot_id_ignoring_case_and_hash_spacing()
    {
        using var players = JsonDocument.Parse(ModernPlayerList);
        foreach (var spelling in new[] { "MunsterHunter#EUW", "munsterhunter#euw", "MunsterHunter #EUW", "  MunsterHunter# EUW " })
        {
            var identity = new LiveLocalIdentity(spelling, null, null, null);
            var match = LiveLocalPlayerResolver.Match(players.RootElement, identity);
            Assert.Equal(LivePlayerMatchKey.RiotId, match?.MatchedBy);
            Assert.Equal("Volibear", LiveLocalPlayerResolver.ReadChampion(match!.Player).RawKey);
        }
    }

    [Fact]
    public void Rung_2_matches_the_split_pair_when_the_client_publishes_no_whole_riot_id()
    {
        using var players = JsonDocument.Parse("""
        [{"riotIdGameName":"MunsterHunter","riotIdTagLine":"EUW","summonerName":"",
          "rawChampionName":"game_character_displayname_Volibear","position":"TOP"},
         {"riotIdGameName":"Someone","riotIdTagLine":"EUW","summonerName":""}]
        """);
        var identity = new LiveLocalIdentity(null, "munsterhunter", "euw", null);

        var match = LiveLocalPlayerResolver.Match(players.RootElement, identity);
        Assert.Equal(LivePlayerMatchKey.GameNameAndTagLine, match?.MatchedBy);
    }

    [Fact]
    public void Rung_3_matches_the_game_name_alone_when_the_tag_line_is_absent()
    {
        using var players = JsonDocument.Parse("""
        [{"riotIdGameName":"MunsterHunter","summonerName":"",
          "rawChampionName":"game_character_displayname_Volibear"},
         {"riotIdGameName":"Someone","summonerName":""}]
        """);
        var identity = new LiveLocalIdentity(null, "MunsterHunter", null, null);

        Assert.Equal(
            LivePlayerMatchKey.GameName,
            LiveLocalPlayerResolver.Match(players.RootElement, identity)?.MatchedBy);
    }

    [Fact]
    public void Rung_3_refuses_an_ambiguous_game_name_rather_than_guessing()
    {
        // Two players, same game name, different tag lines. Picking one is a
        // coin toss that silently shows another player's champion.
        using var players = JsonDocument.Parse("""
        [{"riotIdGameName":"Twin","riotIdTagLine":"EUW","rawChampionName":"game_character_displayname_Volibear"},
         {"riotIdGameName":"Twin","riotIdTagLine":"NA1","rawChampionName":"game_character_displayname_Ahri"}]
        """);
        var identity = new LiveLocalIdentity(null, "Twin", null, null);

        Assert.Null(LiveLocalPlayerResolver.Match(players.RootElement, identity));
    }

    [Fact]
    public void Rung_4_matches_the_legacy_summoner_name()
    {
        using var players = JsonDocument.Parse("""
        [{"summonerName":"MunsterHunter","rawChampionName":"game_character_displayname_Volibear"},
         {"summonerName":"Someone"}]
        """);
        var identity = new LiveLocalIdentity(null, null, null, "munsterhunter");

        Assert.Equal(
            LivePlayerMatchKey.SummonerName,
            LiveLocalPlayerResolver.Match(players.RootElement, identity)?.MatchedBy);
    }

    [Fact]
    public void Rung_5_takes_the_sole_entry_and_only_the_sole_entry()
    {
        // Practice Tool: one entry, which is the local player by construction.
        using var solo = JsonDocument.Parse("""
        [{"riotId":"Different#EUW","rawChampionName":"game_character_displayname_Volibear"}]
        """);
        var identity = new LiveLocalIdentity("MunsterHunter#EUW", "MunsterHunter", "EUW", null);
        Assert.Equal(
            LivePlayerMatchKey.SoleEntry,
            LiveLocalPlayerResolver.Match(solo.RootElement, identity)?.MatchedBy);

        // A matchmade game has ten, so the last-resort rung can never fire there.
        using var lobby = JsonDocument.Parse("""
        [{"riotId":"A#EUW"},{"riotId":"B#EUW"}]
        """);
        Assert.Null(LiveLocalPlayerResolver.Match(lobby.RootElement, identity));
    }

    [Fact]
    public void An_empty_player_list_during_the_loading_screen_is_not_a_match()
    {
        using var empty = JsonDocument.Parse("[]");
        var identity = new LiveLocalIdentity("MunsterHunter#EUW", "MunsterHunter", "EUW", null);
        Assert.Null(LiveLocalPlayerResolver.Match(empty.RootElement, identity));
    }

    // ------------------------------------------------- active-player identity

    [Fact]
    public void Active_player_identity_survives_an_empty_summoner_name()
    {
        var identity = ActivePlayer(ModernActivePlayer);
        Assert.NotNull(identity);
        Assert.Equal("MunsterHunter#EUW", identity!.RiotId);
        Assert.Equal("MunsterHunter", identity.GameName);
        Assert.Equal("EUW", identity.TagLine);
        Assert.Null(identity.SummonerName);
    }

    [Fact]
    public void Active_player_identity_is_rebuilt_from_the_parts_when_riot_id_is_absent()
    {
        var identity = ActivePlayer("""
        {"level":6,"riotIdGameName":"MunsterHunter","riotIdTagLine":"EUW","summonerName":""}
        """);
        Assert.Equal("MunsterHunter#EUW", identity?.RiotId);
    }

    [Fact]
    public void A_legacy_client_that_only_has_summoner_name_still_produces_an_identity()
    {
        var identity = ActivePlayer("""{"level":6,"summonerName":"MunsterHunter"}""");
        Assert.NotNull(identity);
        Assert.Equal("MunsterHunter", identity!.SummonerName);
        Assert.Null(identity.RiotId);

        // …and a client that puts the whole Riot ID in summonerName is read as one.
        var hybrid = ActivePlayer("""{"level":6,"summonerName":"MunsterHunter#EUW"}""");
        Assert.Equal("MunsterHunter#EUW", hybrid?.RiotId);
        Assert.Equal("EUW", hybrid?.TagLine);
    }

    [Fact]
    public void An_active_player_with_nothing_identifying_produces_no_identity()
    {
        Assert.Null(ActivePlayer("""{"level":6,"summonerName":""}"""));
        Assert.Null(ActivePlayer("""{"level":6}"""));
    }

    [Theory]
    [InlineData("\"MunsterHunter#EUW\"", "MunsterHunter#EUW", "MunsterHunter", "EUW")]
    [InlineData("\"MunsterHunter\"", null, "MunsterHunter", null)]
    public void The_bare_active_player_name_endpoint_is_read_in_both_of_its_formats(
        string body,
        string? riotId,
        string? gameName,
        string? tagLine)
    {
        using var document = JsonDocument.Parse(body);
        var identity = LiveLocalPlayerResolver.ReadActivePlayerName(document.RootElement);
        Assert.Equal(riotId, identity?.RiotId);
        Assert.Equal(gameName, identity?.GameName);
        Assert.Equal(tagLine, identity?.TagLine);
    }

    // ------------------------------------------------------------ diagnostics

    [Fact]
    public void A_failed_match_can_be_described_without_naming_another_player()
    {
        using var players = JsonDocument.Parse(ModernPlayerList);
        var shape = LiveLocalPlayerResolver.Describe(players.RootElement);

        Assert.Equal(2, shape.Entries);
        Assert.Equal(2, shape.WithRiotId);
        Assert.Equal(2, shape.WithGameName);
        // The modern empty summonerName, which is the whole reason a
        // summonerName-only implementation would break: counted, and visible.
        Assert.Equal(0, shape.WithSummonerName);

        var described = shape.ToString();
        Assert.Contains("n=2", described, StringComparison.Ordinal);
        Assert.Contains("summonerName=0", described, StringComparison.Ordinal);
        // No other player's name is in the line. Nothing to redact.
        Assert.DoesNotContain("Someone", described, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("MunsterHunter", described, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void The_own_identity_line_survives_redaction_and_still_shows_the_shape()
    {
        var identity = new LiveLocalIdentity("MunsterHunter#EUW", "MunsterHunter", "EUW", null);
        var described = identity.Describe();
        var redacted = ComplianceRules.Redact(described);

        // RedactedLog rewrites anything Riot-ID shaped, so a raw identity would
        // print as [player-redacted] and answer nothing. The masked form is
        // what actually reaches the file, and it still carries the length and
        // the tag line — enough to see a case or whitespace difference.
        Assert.Equal(described, redacted);
        Assert.Contains("(13)", described, StringComparison.Ordinal);
        Assert.Contains("tag=EUW", described, StringComparison.Ordinal);
        Assert.DoesNotContain("MunsterHunter#EUW", described, StringComparison.Ordinal);

        Assert.Equal("[player-redacted]", ComplianceRules.Redact("MunsterHunter#EUW"));
    }

    // ------------------------------------------------- position is not a gate

    /// <summary>
    /// The user's game reported <c>position=NONE</c>. That must not block the
    /// skill order: an unresolved lane fans out across all five and takes the
    /// highest sample size, which is the only thing they asked for.
    /// </summary>
    [Fact]
    public async Task Position_NONE_still_produces_a_skill_order()
    {
        Assert.Null(SkillOrderLaneResolver.MapPositionToLane("NONE"));

        var provider = new LaneScriptedProvider(lane => lane switch
        {
            "TOP" => 8839,
            "JUNGLE" => 2329,
            _ => 0,
        });

        var selection = await SkillOrderLaneResolver.ResolveAsync(
            provider, 106, laneOverride: null, detectedPosition: "NONE", CancellationToken.None);

        Assert.Equal(SkillOrderStatus.Ok, selection.Result.Status);
        Assert.Equal("TOP", selection.Lane);
        Assert.True(selection.IsLaneAuto);
        Assert.Equal(5, provider.Requested.Count);
    }

    [Fact]
    public async Task A_missing_position_field_is_treated_the_same_as_NONE()
    {
        var provider = new LaneScriptedProvider(lane => lane == "MID" ? 500 : 0);

        var selection = await SkillOrderLaneResolver.ResolveAsync(
            provider, 106, laneOverride: null, detectedPosition: null, CancellationToken.None);

        Assert.Equal("MID", selection.Lane);
        Assert.Equal(SkillOrderStatus.Ok, selection.Result.Status);
    }

    // ------------------------------------------------------ the directory

    [Fact]
    public async Task A_failed_roster_fetch_is_retried_rather_than_latched()
    {
        var clock = new FakeDirectoryClock(DateTimeOffset.UnixEpoch);
        var handler = new ScriptedChampionsHandler(call => call == 0
            ? new HttpResponseMessage(HttpStatusCode.InternalServerError)
            : Json("""[{"id":106,"key":"Volibear","name":"Volibear"}]"""));
        using var directory = new ChampionDirectory(
            endpoint: new Uri("https://example.invalid/api/champions"),
            timeProvider: clock,
            handler: handler);

        Assert.Null(await directory.LoadAsync(CancellationToken.None));
        Assert.Equal("HTTP 500", directory.LastFailure);

        // Inside the cooldown: no second request, and still no roster. A hot
        // loop against a failing endpoint is how the previous failure mode got
        // its 15 s/60 s cooldowns in the first place.
        Assert.Null(await directory.LoadAsync(CancellationToken.None));
        Assert.Equal(1, handler.Calls);

        clock.Advance(TimeSpan.FromMilliseconds(ChampionDirectory.FailureRetryMilliseconds + 1));
        var roster = await directory.LoadAsync(CancellationToken.None);

        Assert.Equal(2, handler.Calls);
        Assert.Equal(106, Assert.Single(roster!).Id);
        Assert.Null(directory.LastFailure);
    }

    [Fact]
    public async Task A_successful_roster_is_fetched_once_and_reused()
    {
        var handler = new ScriptedChampionsHandler(_ => Json("""[{"id":106,"key":"Volibear","name":"Volibear"}]"""));
        using var directory = new ChampionDirectory(
            endpoint: new Uri("https://example.invalid/api/champions"),
            handler: handler);

        Assert.NotNull(await directory.LoadAsync(CancellationToken.None));
        Assert.NotNull(await directory.LoadAsync(CancellationToken.None));
        Assert.NotNull(directory.Cached);
        Assert.Equal(1, handler.Calls);
    }

    [Fact]
    public async Task An_empty_roster_is_a_failure_not_an_answer()
    {
        var clock = new FakeDirectoryClock(DateTimeOffset.UnixEpoch);
        var handler = new ScriptedChampionsHandler(call => call == 0 ? Json("[]") : Json("""[{"id":106,"key":"Volibear","name":"Volibear"}]"""));
        using var directory = new ChampionDirectory(
            endpoint: new Uri("https://example.invalid/api/champions"),
            timeProvider: clock,
            handler: handler);

        // Caching an empty list as a success would make every champion
        // unresolvable for the whole process lifetime off one bad response.
        Assert.Null(await directory.LoadAsync(CancellationToken.None));
        Assert.Equal("empty roster", directory.LastFailure);

        clock.Advance(TimeSpan.FromMilliseconds(ChampionDirectory.FailureRetryMilliseconds + 1));
        Assert.NotNull(await directory.LoadAsync(CancellationToken.None));
    }

    /// <summary>
    /// The two roster columns spell the same champion differently
    /// (<c>Kaisa</c>/<c>Kai'Sa</c>, <c>DrMundo</c>/<c>Dr. Mundo</c>,
    /// <c>LeeSin</c>/<c>Lee Sin</c>), and an entry that publishes only one of
    /// them makes the other column answer for both. That is the cross-column
    /// case punctuation folding exists for; without it these resolve to nothing
    /// and the champion is unresolvable on a roster shape change.
    /// </summary>
    [Fact]
    public void Punctuation_and_spacing_do_not_stop_the_two_roster_columns_meeting()
    {
        using var namesOnly = JsonDocument.Parse("""
        [{"id":145,"name":"Kai'Sa"},{"id":36,"name":"Dr. Mundo"},{"id":64,"name":"Lee Sin"}]
        """);
        var byName = ChampionIdLookup.Parse(namesOnly.RootElement);

        // rawChampionName is always the unpunctuated key.
        Assert.Equal(145, ChampionIdLookup.Resolve(byName, "Kaisa", null).Id);
        Assert.Equal(36, ChampionIdLookup.Resolve(byName, "DrMundo", null).Id);
        Assert.Equal(64, ChampionIdLookup.Resolve(byName, "LeeSin", null).Id);

        using var keysOnly = JsonDocument.Parse("""
        [{"id":145,"key":"Kaisa"},{"id":36,"key":"DrMundo"},{"id":64,"key":"LeeSin"}]
        """);
        var byKey = ChampionIdLookup.Parse(keysOnly.RootElement);

        // championName is the punctuated display name.
        Assert.Equal(145, ChampionIdLookup.Resolve(byKey, null, "Kai'Sa").Id);
        Assert.Equal(36, ChampionIdLookup.Resolve(byKey, null, "Dr. Mundo").Id);
        Assert.Equal(64, ChampionIdLookup.Resolve(byKey, null, "Lee Sin").Id);

        // …and case never matters on either side.
        Assert.Equal(106, ChampionIdLookup.Resolve(Roster, "VOLIBEAR", null).Id);
        Assert.Equal(62, ChampionIdLookup.Resolve(Roster, null, "wukong").Id);
    }

    [Fact]
    public void Roster_entries_missing_a_field_are_dropped_not_defaulted()
    {
        using var document = JsonDocument.Parse("""
        [{"id":106,"key":"Volibear","name":"Volibear"},
         {"id":0,"key":"Broken","name":"Broken"},
         {"key":"NoId","name":"No Id"},
         {"id":62,"key":"MonkeyKing"},
         {"id":103,"name":"Ahri"}]
        """);
        var parsed = ChampionIdLookup.Parse(document.RootElement);

        Assert.Equal(3, parsed.Count);
        Assert.Equal(62, ChampionIdLookup.Resolve(parsed, "MonkeyKing", null).Id);
        Assert.Equal(103, ChampionIdLookup.Resolve(parsed, null, "Ahri").Id);
        Assert.Null(ChampionIdLookup.Resolve(parsed, "Broken", "Broken").Id);
    }

    // ---------------------------------------------------------------- helpers

    private static LiveLocalIdentity? ActivePlayer(string json)
    {
        using var document = JsonDocument.Parse(json);
        return LiveLocalPlayerResolver.ReadActivePlayer(document.RootElement);
    }

    private static readonly IReadOnlyList<ChampionRef> Roster =
    [
        new(103, "Ahri", "Ahri"),
        new(200, "Belveth", "Bel'Veth"),
        new(31, "Chogath", "Cho'Gath"),
        new(36, "DrMundo", "Dr. Mundo"),
        new(145, "Kaisa", "Kai'Sa"),
        new(64, "LeeSin", "Lee Sin"),
        new(20, "Nunu", "Nunu & Willump"),
        new(106, "Volibear", "Volibear"),
        new(62, "MonkeyKing", "Wukong"),
    ];

    private static IReadOnlyList<ChampionRef>? _liveRoster;

    /// <summary>The real endpoint body, captured 2026-08-18. Not authored to suit the resolver.</summary>
    private static IReadOnlyList<ChampionRef> LiveRoster
    {
        get
        {
            if (_liveRoster is not null) return _liveRoster;
            var path = Path.Combine(AppContext.BaseDirectory, "Fixtures", "champions.live.json");
            using var document = JsonDocument.Parse(File.ReadAllText(path));
            _liveRoster = ChampionIdLookup.Parse(document.RootElement);
            return _liveRoster;
        }
    }

    private static HttpResponseMessage Json(string body) =>
        new(HttpStatusCode.OK) { Content = new StringContent(body, Encoding.UTF8, "application/json") };

    private sealed class ScriptedChampionsHandler(Func<int, HttpResponseMessage> script) : HttpMessageHandler
    {
        private int _calls;

        public int Calls => Volatile.Read(ref _calls);

        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            var call = Interlocked.Increment(ref _calls) - 1;
            return Task.FromResult(script(call));
        }
    }

    private sealed class LaneScriptedProvider(Func<string, int> sampleSizeForLane) : ISkillOrderProvider
    {
        public List<string> Requested { get; } = [];

        public Task<SkillOrderResult> GetSkillOrderAsync(int championId, string? role, CancellationToken ct)
        {
            lock (Requested) Requested.Add(role ?? "null");
            var sampleSize = sampleSizeForLane(role ?? string.Empty);
            return Task.FromResult(sampleSize <= 0
                ? new SkillOrderResult(SkillOrderStatus.NoData, OverlaySkillOrder.Empty, championId)
                : new SkillOrderResult(
                    SkillOrderStatus.Ok,
                    new OverlaySkillOrder(
                        Enumerable.Range(0, 18).Select(i => (OverlayAbility)(i % 4)).ToArray(),
                        18,
                        Completed: true,
                        "published"),
                    championId,
                    sampleSize));
        }
    }

    private sealed class FakeDirectoryClock(DateTimeOffset start) : TimeProvider
    {
        private DateTimeOffset _now = start;

        public override DateTimeOffset GetUtcNow() => _now;

        public void Advance(TimeSpan delta) => _now += delta;
    }
}
