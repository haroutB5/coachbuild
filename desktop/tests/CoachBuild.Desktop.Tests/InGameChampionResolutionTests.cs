using System.Net;
using System.Net.Http;
using System.Net.Sockets;
using System.Text;
using CoachBuild.Core;
using Xunit;

namespace CoachBuild.Desktop.Tests;

/// <summary>
/// End-to-end regression for the reported symptom: <b>runes and item sets apply,
/// the skill order never shows in game.</b>
///
/// <para>The user's 2026-08-18 log, on Volibear:</para>
/// <code>
/// overlay: waiting-champion (playerlist has not matched the local riotId)
/// live: champion=none position=NONE
/// overlay: live inputs ready
/// overlay: no-skill-order
/// </code>
/// <para>The riotId match was NOT the failure — <c>live: champion=…</c> is only
/// emitted after a match, and <c>live inputs ready</c> requires a resolved
/// champion NAME. Both fired. What was null was the champion <b>id</b>, because
/// it was read from a <c>championId</c> property the Live Client Data player
/// list has never carried, and <c>RequestSkillOrderIfNeeded</c> was gated on
/// <c>championId is &gt; 0</c>. So the skill order was never requested — for
/// anyone, on any champion, in any game.</para>
///
/// <para>Every test here drives the real <c>CoreDesktopHostServices</c> through
/// the real 750 ms snapshot path with real-shaped payloads, and every one of
/// them fails against 1.0.10.</para>
/// </summary>
public sealed class InGameChampionResolutionTests
{
    private const double TickSeconds = 0.75;
    private const int VolibearId = 106;

    /// <summary>The user's own game, reconstructed: Volibear, position NONE, empty summonerName.</summary>
    private const string ModernPlayerList = """
    [{"championName":"Volibear","isBot":false,"isDead":false,"items":[],"level":6,
      "position":"NONE","rawChampionName":"game_character_displayname_Volibear",
      "respawnTimer":0.0,"riotId":"MunsterHunter#EUW","riotIdGameName":"MunsterHunter",
      "riotIdTagLine":"EUW","runes":{},"scores":{},"skinID":0,"summonerName":"",
      "summonerSpells":{},"team":"ORDER"}]
    """;

    private const string ModernAllGameData = """
    {"activePlayer":{"level":6,"riotId":"MunsterHunter#EUW",
                     "riotIdGameName":"MunsterHunter","riotIdTagLine":"EUW","summonerName":""}}
    """;

    /// <summary>A pre-Riot-ID client: summonerName only, on both endpoints.</summary>
    private const string LegacyPlayerList = """
    [{"championName":"Volibear","summonerName":"MunsterHunter","position":"TOP",
      "rawChampionName":"game_character_displayname_Volibear","team":"ORDER"}]
    """;

    private const string LegacyAllGameData = """
    {"activePlayer":{"level":6,"summonerName":"MunsterHunter"}}
    """;

    private const string ActivePlayer = """
    {"level":6,"abilities":{"Passive":{"displayName":"The Relentless Storm"},
                            "Q":{"abilityLevel":2},"W":{"abilityLevel":1},
                            "E":{"abilityLevel":1},"R":{"abilityLevel":1}}}
    """;

    // ------------------------------------------------------- the user's game

    /// <summary>
    /// THE reported failure. Against 1.0.10 this measures order length 0 and a
    /// null champion id forever.
    /// </summary>
    [Fact]
    public async Task The_reported_game_resolves_volibear_and_renders_a_skill_order()
    {
        await using var harness = await Harness.CreateAsync();
        await harness.PumpAsync();

        var snapshot = await harness.Host.ReadSnapshotAsync(CancellationToken.None);

        Assert.Equal((VolibearId, ChampionIdSource.RawChampionName), harness.Host.ResolvedChampion);
        Assert.Equal(18, snapshot.Overlay?.SkillOrder.Order.Count);
        Assert.Equal(VolibearId, harness.Provider.LastChampionId);
    }

    /// <summary>
    /// <c>position=NONE</c> is what the user's client reported, and it must not
    /// be a gate: they asked for the skill order, not the lane.
    /// </summary>
    [Fact]
    public async Task Position_NONE_does_not_block_the_skill_order()
    {
        await using var harness = await Harness.CreateAsync();
        await harness.PumpAsync();
        var snapshot = await harness.Host.ReadSnapshotAsync(CancellationToken.None);

        Assert.Equal(18, snapshot.Overlay?.SkillOrder.Order.Count);
        // No lane was detectable, so every lane was asked and the best-sampled
        // one selected, rather than nothing being rendered.
        Assert.Equal(
            SkillOrderLaneResolver.Lanes.OrderBy(lane => lane, StringComparer.Ordinal),
            harness.Provider.Roles.Distinct().OrderBy(role => role, StringComparer.Ordinal));
        Assert.Equal("TOP", snapshot.Overlay?.Lane);
    }

    [Fact]
    public async Task A_legacy_summoner_name_only_client_still_resolves()
    {
        await using var harness = await Harness.CreateAsync(
            allGameData: LegacyAllGameData,
            playerList: LegacyPlayerList);
        await harness.PumpAsync();
        var snapshot = await harness.Host.ReadSnapshotAsync(CancellationToken.None);

        Assert.Equal((VolibearId, ChampionIdSource.RawChampionName), harness.Host.ResolvedChampion);
        Assert.Equal(18, snapshot.Overlay?.SkillOrder.Order.Count);
    }

    [Fact]
    public async Task A_client_that_publishes_only_the_split_riot_id_parts_still_resolves()
    {
        await using var harness = await Harness.CreateAsync(
            allGameData: """
            {"activePlayer":{"level":6,"riotIdGameName":"MunsterHunter","riotIdTagLine":"EUW","summonerName":""}}
            """,
            playerList: """
            [{"championName":"Volibear","riotIdGameName":"MunsterHunter","riotIdTagLine":"EUW",
              "summonerName":"","rawChampionName":"game_character_displayname_Volibear","position":"TOP"}]
            """);
        await harness.PumpAsync();

        Assert.Equal(VolibearId, harness.Host.ResolvedChampion.Id);
    }

    /// <summary>
    /// The identity source of last resort. <c>allgamedata</c> publishes nothing
    /// identifying, so the bare <c>/liveclientdata/activeplayername</c> string
    /// is polled — and only then.
    /// </summary>
    [Fact]
    public async Task The_bare_active_player_name_endpoint_rescues_an_identity_free_allgamedata()
    {
        await using var harness = await Harness.CreateAsync(
            allGameData: """{"activePlayer":{"level":6,"summonerName":""}}""",
            activePlayerName: "\"MunsterHunter#EUW\"");

        await harness.Live.WaitAsync();
        await harness.Host.LivePolling.TickAllGameDataAsync();
        await harness.Host.LivePolling.TickActivePlayerNameAsync();
        await harness.PumpAsync();

        Assert.Equal(VolibearId, harness.Host.ResolvedChampion.Id);
        Assert.Equal(1, harness.Live.ActivePlayerNameCalls);
    }

    [Fact]
    public async Task The_bare_name_endpoint_is_never_called_when_allgamedata_answers()
    {
        await using var harness = await Harness.CreateAsync();
        await harness.PumpAsync();
        await harness.Host.LivePolling.TickActivePlayerNameAsync();

        Assert.Equal(VolibearId, harness.Host.ResolvedChampion.Id);
        // A healthy client must not pay for the fallback.
        Assert.Equal(0, harness.Live.ActivePlayerNameCalls);
    }

    // ------------------------------------------------ the loading screen

    /// <summary>
    /// The user's in-game window was ~90 seconds, so "the player list was still
    /// empty" was a live alternative explanation. It is not what happened — but
    /// it must still recover rather than latch, because the player list IS
    /// empty for the first seconds of every game.
    /// </summary>
    [Fact]
    public async Task An_empty_player_list_during_loading_recovers_when_it_populates()
    {
        await using var harness = await Harness.CreateAsync(playerList: "[]");

        // 80 ticks at 750 ms = 60 s of loading screen.
        for (var tick = 0; tick < 80; tick++)
        {
            await harness.Host.LivePolling.TickPlayerListAsync();
            var snapshot = await harness.Host.ReadSnapshotAsync(CancellationToken.None);
            Assert.Null(snapshot.Overlay);
            harness.Clock.Advance(TimeSpan.FromSeconds(TickSeconds));
        }
        Assert.Null(harness.Host.ResolvedChampion.Id);

        harness.Live.PlayerList = ModernPlayerList;
        await harness.PumpAsync();

        Assert.Equal(VolibearId, harness.Host.ResolvedChampion.Id);
        var recovered = await harness.Host.ReadSnapshotAsync(CancellationToken.None);
        Assert.Equal(18, recovered.Overlay?.SkillOrder.Order.Count);
    }

    [Fact]
    public async Task Once_resolved_the_champion_stays_resolved_for_the_rest_of_the_match()
    {
        await using var harness = await Harness.CreateAsync();
        await harness.PumpAsync();
        Assert.Equal(VolibearId, harness.Host.ResolvedChampion.Id);

        // A mid-game player-list blip must not un-resolve the champion.
        harness.Live.PlayerList = "[]";
        for (var tick = 0; tick < 20; tick++)
        {
            await harness.Host.LivePolling.TickPlayerListAsync();
            var snapshot = await harness.Host.ReadSnapshotAsync(CancellationToken.None);
            Assert.Equal(18, snapshot.Overlay?.SkillOrder.Order.Count);
            harness.Clock.Advance(TimeSpan.FromSeconds(TickSeconds));
        }

        Assert.Equal((VolibearId, ChampionIdSource.RawChampionName), harness.Host.ResolvedChampion);
    }

    // ------------------------------------------------------- roster failures

    [Fact]
    public async Task A_roster_fetch_that_fails_is_retried_not_latched()
    {
        var directory = new FakeChampionDirectory(preloaded: false, fails: true);
        await using var harness = await Harness.CreateAsync(championDirectory: directory);

        // 40 s of a failing endpoint. This is the shape that latched the
        // overlay blank for a whole match before 1.0.8, and the roster fetch
        // must not reintroduce it.
        for (var tick = 0; tick < 50; tick++) await harness.PumpAsync();
        Assert.Null(harness.Host.ResolvedChampion.Id);
        var attemptsWhileDown = directory.Loads;
        Assert.True(attemptsWhileDown > 1, $"the roster was asked for only {attemptsWhileDown} time(s) across 50 ticks");

        directory.Fails = false;
        await harness.PumpAsync();

        Assert.Equal((VolibearId, ChampionIdSource.RawChampionName), harness.Host.ResolvedChampion);
        Assert.Equal(18, (await harness.Host.ReadSnapshotAsync(CancellationToken.None)).Overlay?.SkillOrder.Order.Count);
    }

    /// <summary>
    /// With the roster unreachable, the champion the LCU watched us lock in is
    /// exact and needs no network. It gets the overlay drawing.
    /// </summary>
    [Fact]
    public async Task Champ_select_supplies_the_id_when_the_roster_cannot_be_reached()
    {
        var directory = new FakeChampionDirectory(preloaded: false, fails: true);
        await using var harness = await Harness.CreateAsync(championDirectory: directory, startInGame: false);

        await harness.EnterChampSelectAsync(VolibearId, roleId: 0);
        await harness.EnterGameAsync();
        await harness.PumpAsync();

        Assert.Equal((VolibearId, ChampionIdSource.ChampSelect), harness.Host.ResolvedChampion);
        Assert.Equal(18, (await harness.Host.ReadSnapshotAsync(CancellationToken.None)).Overlay?.SkillOrder.Order.Count);
    }

    /// <summary>
    /// The player list states what is actually on screen; champ select states
    /// what was picked. When they disagree, the roster wins and the skill order
    /// is refetched for the right champion.
    /// </summary>
    [Fact]
    public async Task The_roster_corrects_a_champ_select_id_that_disagrees()
    {
        var directory = new FakeChampionDirectory(preloaded: false, fails: true);
        await using var harness = await Harness.CreateAsync(championDirectory: directory, startInGame: false);

        await harness.EnterChampSelectAsync(championId: 103, roleId: 2);
        await harness.EnterGameAsync();
        await harness.PumpAsync();
        Assert.Equal((103, ChampionIdSource.ChampSelect), harness.Host.ResolvedChampion);
        Assert.Equal(103, harness.Provider.LastChampionId);

        directory.Fails = false;
        await harness.PumpAsync();

        Assert.Equal((VolibearId, ChampionIdSource.RawChampionName), harness.Host.ResolvedChampion);
        Assert.Equal(VolibearId, harness.Provider.LastChampionId);
    }

    /// <summary>
    /// A game this instance did not watch a champ select for — app started
    /// mid-game, custom game, reconnect. <c>LastOpenedChampionId</c> is never
    /// cleared when a match ends, so adopting it unconditionally would draw a
    /// confident skill order for a champion from an earlier queue.
    /// </summary>
    [Fact]
    public async Task A_stale_champ_select_id_is_not_adopted_for_a_game_it_did_not_precede()
    {
        var directory = new FakeChampionDirectory(preloaded: false, fails: true);
        await using var harness = await Harness.CreateAsync(championDirectory: directory, startInGame: false);

        await harness.EnterChampSelectAsync(championId: 103, roleId: 2);
        // That match ends, and a new InProgress begins without a champ select in
        // between - the app was started mid-game, or this is a custom game.
        harness.Host.State.SetPhase("None");
        await harness.Host.ReadSnapshotAsync(CancellationToken.None);
        await harness.EnterGameAsync();
        await harness.PumpAsync();

        Assert.Equal((null, ChampionIdSource.None), harness.Host.ResolvedChampion);
        Assert.Empty(harness.Provider.Roles);

        // The control: the SAME stale id IS adopted when a champ select really
        // did precede the game, so this test is proving the guard and not a
        // dead champ-select path.
        await harness.EnterChampSelectAsync(championId: 103, roleId: 2);
        await harness.EnterGameAsync();
        await harness.PumpAsync();
        Assert.Equal((103, ChampionIdSource.ChampSelect), harness.Host.ResolvedChampion);
    }

    [Fact]
    public async Task A_champion_missing_from_the_roster_reports_it_rather_than_inventing_an_id()
    {
        var directory = new FakeChampionDirectory(roster: [new ChampionRef(103, "Ahri", "Ahri")]);
        await using var harness = await Harness.CreateAsync(championDirectory: directory);
        await harness.PumpAsync();

        Assert.Null(harness.Host.ResolvedChampion.Id);
        Assert.Empty(harness.Provider.Roles);
        Assert.Contains("is not in the roster", await harness.ReadLogAsync(), StringComparison.Ordinal);
    }

    /// <summary>
    /// Two independent things re-drive champion resolution: the 4 s player-list
    /// tick and the 750 ms snapshot tick. This is the case where only the
    /// second one is left — the champion name is already known and 2999 has
    /// gone quiet, so no further player-list tick will ever land, and the
    /// snapshot tick is the only thing that can re-ask for a roster that was
    /// down at load-in.
    /// </summary>
    [Fact]
    public async Task The_snapshot_tick_keeps_retrying_the_roster_when_the_player_list_stops_arriving()
    {
        var directory = new FakeChampionDirectory(preloaded: false, fails: true);
        await using var harness = await Harness.CreateAsync(championDirectory: directory);

        await harness.PumpAsync();
        Assert.Null(harness.Host.ResolvedChampion.Id);
        var loadsAfterLoadIn = directory.Loads;

        // 2999 goes quiet. No player-list tick lands again for the rest of the
        // match; only the snapshot poll keeps running.
        for (var tick = 0; tick < 5; tick++) await harness.SnapshotOnlyAsync();
        Assert.True(
            directory.Loads > loadsAfterLoadIn,
            $"the roster was not re-asked for: {loadsAfterLoadIn} -> {directory.Loads}");

        directory.Fails = false;
        await harness.SnapshotOnlyAsync();
        await harness.SnapshotOnlyAsync();

        Assert.Equal((VolibearId, ChampionIdSource.RawChampionName), harness.Host.ResolvedChampion);
        Assert.Equal(18, (await harness.Host.ReadSnapshotAsync(CancellationToken.None)).Overlay?.SkillOrder.Order.Count);
    }

    // ------------------------------------------------------------ diagnostics

    [Fact]
    public async Task The_log_names_the_rung_that_matched_and_the_rung_that_produced_the_id()
    {
        await using var harness = await Harness.CreateAsync();
        await harness.PumpAsync();
        var log = await harness.ReadLogAsync();

        Assert.Contains("live: identity matched by RiotId", log, StringComparison.Ordinal);
        Assert.Contains("live: champion=Volibear id=106 via=RawChampionName position=NONE", log, StringComparison.Ordinal);
    }

    /// <summary>
    /// The failure line has to answer "why" in one paste. It names every rung
    /// that was tried and the structural shape of what it compared against —
    /// including the empty <c>summonerName</c> count, which is the single field
    /// most likely to be the cause on a modern client.
    /// </summary>
    [Fact]
    public async Task An_unmatched_identity_says_what_was_compared()
    {
        await using var harness = await Harness.CreateAsync(
            playerList: """
            [{"championName":"Volibear","riotId":"SomebodyElse#EUW","riotIdGameName":"SomebodyElse",
              "riotIdTagLine":"EUW","summonerName":"","rawChampionName":"game_character_displayname_Volibear"},
             {"championName":"Ahri","riotId":"AndAnother#EUW","riotIdGameName":"AndAnother",
              "riotIdTagLine":"EUW","summonerName":""}]
            """);
        await harness.PumpAsync();
        var log = await harness.ReadLogAsync();

        Assert.Contains("live: identity unmatched", log, StringComparison.Ordinal);
        Assert.Contains("tried riotId,gameName+tag,gameName,summonerName,sole-entry", log, StringComparison.Ordinal);
        Assert.Contains("n=2 riotId=2 gameName=2 tag=2 summonerName=0", log, StringComparison.Ordinal);
        // The own identity survives redaction in masked form; nobody else's name
        // is in the file at all.
        Assert.Contains("tag=EUW", log, StringComparison.Ordinal);
        Assert.DoesNotContain("SomebodyElse", log, StringComparison.Ordinal);
        Assert.DoesNotContain("MunsterHunter", log, StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_champion_known_by_name_with_no_id_yet_is_a_named_state()
    {
        var directory = new FakeChampionDirectory(preloaded: false, fails: true);
        await using var harness = await Harness.CreateAsync(championDirectory: directory);
        await harness.PumpAsync();

        var log = await harness.ReadLogAsync();
        // Before 1.0.11 this state was permanent and logged as nothing at all:
        // the log said "live inputs ready" and then "no-skill-order" forever.
        Assert.Contains("overlay: waiting-champion-id", log, StringComparison.Ordinal);
        Assert.Contains("champion roster unavailable", log, StringComparison.Ordinal);
    }

    // ---------------------------------------------------------------- harness

    private sealed class Harness : IAsyncDisposable
    {
        private readonly string _root;

        private Harness(CoreDesktopHostServices host, string root, FakeLive live, RecordingProvider provider, FakeClock clock)
        {
            Host = host;
            _root = root;
            Live = live;
            Provider = provider;
            Clock = clock;
        }

        public CoreDesktopHostServices Host { get; }

        public FakeLive Live { get; }

        public RecordingProvider Provider { get; }

        public FakeClock Clock { get; }

        public static async Task<Harness> CreateAsync(
            string? allGameData = null,
            string? playerList = null,
            string? activePlayerName = null,
            IChampionDirectory? championDirectory = null,
            bool startInGame = true)
        {
            var root = Path.Combine(Path.GetTempPath(), "CoachBuild-ChampionTests", Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(root);
            var live = new FakeLive
            {
                AllGameData = allGameData ?? ModernAllGameData,
                PlayerList = playerList ?? ModernPlayerList,
                ActivePlayerName = activePlayerName,
            };
            var clock = new FakeClock();
            var provider = new RecordingProvider();
            var host = new CoreDesktopHostServices(
                new string('a', 64),
                root,
                skillOrders: provider,
                bridgePorts: [FindFreePort()],
                liveHandler: live,
                timeProvider: clock,
                championDirectory: championDirectory ?? new FakeChampionDirectory());

            var harness = new Harness(host, root, live, provider, clock);
            if (startInGame) await harness.EnterGameAsync();
            return harness;
        }

        public async Task EnterChampSelectAsync(int championId, int? roleId)
        {
            Host.State.SetPhase("ChampSelect");
            Host.WindowDecisions.OnChampSelectEntry(new ChampSelectResolution(
                LocalPlayerCellId: 0,
                CellChampionId: championId,
                PickIntent: null,
                ActionChampionId: null,
                ChampionId: championId,
                RoleId: roleId,
                TheirTeam: [],
                TimerPhase: null));
            // Production's 750 ms poll observes the ChampSelect phase before
            // load-in; that observation is what makes the id this game's.
            await Host.ReadSnapshotAsync(CancellationToken.None);
        }

        public async Task EnterGameAsync()
        {
            Host.State.SetPhase("InProgress");
            // BuildOverlayState clears the per-game state on the first tick it
            // sees InProgress; production sees that transition before the live
            // pollers repopulate.
            await Host.ReadSnapshotAsync(CancellationToken.None);
        }

        /// <summary>One full production cycle: every live tick, then a snapshot, settled.</summary>
        public async Task PumpAsync()
        {
            await Host.LivePolling.TickAllGameDataAsync();
            await Host.LivePolling.TickPlayerListAsync();
            await Host.LivePolling.TickSkillsAsync();
            await SettleAsync();
            await Host.ReadSnapshotAsync(CancellationToken.None);
            await SettleAsync();
            Clock.Advance(TimeSpan.FromSeconds(TickSeconds));
        }

        /// <summary>The 750 ms snapshot poll alone, with no live tick behind it.</summary>
        public async Task SnapshotOnlyAsync()
        {
            await Host.ReadSnapshotAsync(CancellationToken.None);
            await SettleAsync();
            Clock.Advance(TimeSpan.FromSeconds(TickSeconds));
        }

        private async Task SettleAsync()
        {
            for (var round = 0; round < 4; round++)
            {
                if (Host.PendingChampionDirectoryFetch is { } roster) await roster;
                if (Host.PendingSkillOrderFetch is { } order) await order;
            }
        }

        public async Task<string> ReadLogAsync()
        {
            var path = Path.Combine(_root, "companion.log");
            if (!File.Exists(path)) return string.Empty;
            await using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
            using var reader = new StreamReader(stream);
            return await reader.ReadToEndAsync();
        }

        public async ValueTask DisposeAsync()
        {
            await Host.DisposeAsync();
            Live.Dispose();
            try { Directory.Delete(_root, recursive: true); } catch { }
        }
    }

    private sealed class FakeLive : HttpMessageHandler
    {
        private int _activePlayerNameCalls;
        private readonly TaskCompletionSource _ready = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public string AllGameData { get; set; } = ModernAllGameData;

        public string PlayerList { get; set; } = ModernPlayerList;

        public string? ActivePlayerName { get; set; }

        public int ActivePlayerNameCalls => Volatile.Read(ref _activePlayerNameCalls);

        public Task WaitAsync() => Task.CompletedTask;

        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            var path = request.RequestUri!.AbsolutePath;
            if (path == "/liveclientdata/activeplayername")
            {
                Interlocked.Increment(ref _activePlayerNameCalls);
                if (ActivePlayerName is null)
                    return Task.FromResult(new HttpResponseMessage(HttpStatusCode.NotFound));
                return Task.FromResult(Ok(ActivePlayerName));
            }

            var body = path switch
            {
                "/liveclientdata/allgamedata" => AllGameData,
                "/liveclientdata/playerlist" => PlayerList,
                "/liveclientdata/activeplayer" => ActivePlayer,
                _ => null,
            };
            return Task.FromResult(body is null ? new HttpResponseMessage(HttpStatusCode.NotFound) : Ok(body));
        }

        private static HttpResponseMessage Ok(string body) => new(HttpStatusCode.OK)
        {
            Content = new StringContent(body, Encoding.UTF8, "application/json"),
        };
    }

    /// <summary>Records what the pipeline actually asked for, so an id can be asserted at the boundary.</summary>
    private sealed class RecordingProvider : ISkillOrderProvider
    {
        public List<string> Roles { get; } = [];

        public int? LastChampionId { get; private set; }

        public Task<SkillOrderResult> GetSkillOrderAsync(int championId, string? role, CancellationToken ct)
        {
            lock (Roles)
            {
                Roles.Add(role ?? "null");
                LastChampionId = championId;
            }
            var sampleSize = role switch { "TOP" => 8839, "JUNGLE" => 2329, "MID" => 900, _ => 100 };
            return Task.FromResult(new SkillOrderResult(
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

    private static int FindFreePort()
    {
        using var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        return ((IPEndPoint)listener.LocalEndpoint).Port;
    }
}
