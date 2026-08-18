using System.Net;
using System.Net.Http;
using System.Net.Sockets;
using System.Runtime.ExceptionServices;
using System.Text;
using CoachBuild.Core;
using CoachBuild.Desktop.Overlay;
using Xunit;
// CoachBuild.Core and CoachBuild.Desktop.Overlay each declare an OverlayAbility
// and an OverlaySkillOrder: the wire type and the render type. This file needs
// both - the stub provider answers in wire types, the window consumes render
// types - so neither is imported unqualified.
using CoreAbility = CoachBuild.Core.OverlayAbility;
using CoreSkillOrder = CoachBuild.Core.OverlaySkillOrder;
using UiAbility = CoachBuild.Desktop.Overlay.OverlayAbility;
using UiSkillOrder = CoachBuild.Desktop.Overlay.OverlaySkillOrder;

namespace CoachBuild.Desktop.Tests;

/// <summary>
/// What happens to the highlight between one level-up and the end of the game.
///
/// <para>Two field defects drive this file, both from the user's 2026-08-18
/// 1.0.11 log:</para>
///
/// <list type="number">
/// <item><description><b>The highlight outlived the game.</b>
/// <c>phase: InProgress -&gt; None</c> at 20:32:02, <c>2999 unreachable</c> a
/// second later, and then at <b>20:34:06</b> — two minutes after the match
/// ended — <c>overlay: highlight E … visible=True … source=self</c>. The
/// <c>source=self</c> is the tell: League was gone, so the overlay had fallen
/// back to its own monitor and was still asserting a recommendation for a
/// finished game. Hiding the window was never enough, because the state stayed
/// loaded and several paths re-render it later.</description></item>
/// <item><description><b>Latency.</b> The live poll sampled at 1000 ms and the
/// projection collected the result at 750 ms, so the worst case from level-up
/// to pixels was 1.75 s against an unspent window that is frequently
/// shorter. That is the arithmetic that killed v1.0.6's identical gate.</description></item>
/// </list>
/// </summary>
public sealed class LiveGameLifecycleTests
{
    private const int VolibearId = 106;

    private const string PlayerList = """
    [{"championName":"Volibear","rawChampionName":"game_character_displayname_Volibear",
      "riotId":"MunsterHunter#EUW","riotIdGameName":"MunsterHunter","riotIdTagLine":"EUW",
      "position":"TOP","summonerName":"","team":"ORDER"}]
    """;

    private const string AllGameData = """
    {"activePlayer":{"level":1,"riotId":"MunsterHunter#EUW",
                     "riotIdGameName":"MunsterHunter","riotIdTagLine":"EUW","summonerName":""}}
    """;

    /// <summary>
    /// The real wire shape, confirmed against a captured Practice Tool game
    /// (CHANGELOG 0.65.1): <c>level</c> at the top, per-ability
    /// <c>abilityLevel</c>, and a <c>Passive</c> key that carries no rank at
    /// all and must never enter the point arithmetic.
    /// </summary>
    private static string ActivePlayer(int level, int q, int w, int e, int r) =>
        "{\"level\":" + level.ToString(System.Globalization.CultureInfo.InvariantCulture)
        + ",\"abilities\":{\"Passive\":{\"displayName\":\"The Relentless Storm\"}"
        + ",\"Q\":{\"abilityLevel\":" + q.ToString(System.Globalization.CultureInfo.InvariantCulture) + "}"
        + ",\"W\":{\"abilityLevel\":" + w.ToString(System.Globalization.CultureInfo.InvariantCulture) + "}"
        + ",\"E\":{\"abilityLevel\":" + e.ToString(System.Globalization.CultureInfo.InvariantCulture) + "}"
        + ",\"R\":{\"abilityLevel\":" + r.ToString(System.Globalization.CultureInfo.InvariantCulture) + "}}}";

    // ------------------------------------------------- appearing fast enough

    /// <summary>
    /// The whole point of the push seam. A level-up must reach the overlay from
    /// the live poll itself, with NO snapshot tick in between — in 1.0.11 the
    /// only route to the window was <c>ReadSnapshotAsync</c>, so every
    /// appearance waited up to another 750 ms after the game had already told
    /// us.
    /// </summary>
    [Fact]
    public async Task A_level_up_reaches_the_overlay_without_waiting_for_a_snapshot_tick()
    {
        await using var harness = await Harness.CreateAsync();
        await harness.SettleInGameAsync();

        var pushes = new List<OverlayState?>();
        harness.Host.OverlayStateChanged += pushes.Add;

        // Level 1, point spent: nothing banked, nothing to draw.
        harness.Live.ActivePlayer = ActivePlayer(1, 1, 0, 0, 0);
        await harness.Host.LivePolling.TickSkillsAsync();
        pushes.Clear();

        // The player levels up. No ReadSnapshotAsync anywhere below this line.
        harness.Live.ActivePlayer = ActivePlayer(2, 1, 0, 0, 0);
        await harness.Host.LivePolling.TickSkillsAsync();

        var pushed = Assert.Single(pushes);
        Assert.NotNull(pushed);
        Assert.Equal(2, pushed!.Level);
        Assert.True(pushed.HasPointToSpend);
        Assert.NotNull(pushed.NextAbility());
    }

    /// <summary>
    /// Spending the point must take the box away just as promptly as levelling
    /// up put it there. An asymmetry here is what turns a prompt back into
    /// decoration.
    /// </summary>
    [Fact]
    public async Task Spending_the_point_pushes_a_state_with_nothing_to_draw()
    {
        await using var harness = await Harness.CreateAsync();
        await harness.SettleInGameAsync();

        harness.Live.ActivePlayer = ActivePlayer(2, 1, 0, 0, 0);
        await harness.Host.LivePolling.TickSkillsAsync();

        var pushes = new List<OverlayState?>();
        harness.Host.OverlayStateChanged += pushes.Add;

        harness.Live.ActivePlayer = ActivePlayer(2, 1, 1, 0, 0);
        await harness.Host.LivePolling.TickSkillsAsync();

        var pushed = Assert.Single(pushes);
        Assert.NotNull(pushed);
        Assert.False(pushed!.HasPointToSpend);
        Assert.Null(pushed.NextAbility());
    }

    /// <summary>
    /// The cost side of the same seam. Four reads a second must not become four
    /// dispatcher round trips and four renders a second: the push is gated on
    /// the skill state actually moving, which happens about 36 times in a game.
    /// </summary>
    [Fact]
    public async Task An_unchanged_game_pushes_nothing_at_all()
    {
        await using var harness = await Harness.CreateAsync();
        await harness.SettleInGameAsync();

        var pushes = 0;
        harness.Host.OverlayStateChanged += _ => Interlocked.Increment(ref pushes);

        // 40 polls = ten seconds at the production cadence, with the player
        // standing still.
        for (var poll = 0; poll < 40; poll++) await harness.Host.LivePolling.TickSkillsAsync();

        Assert.Equal(0, Volatile.Read(ref pushes));
    }

    /// <summary>
    /// The cadence itself, stated as the latency it buys. 250 ms is not a
    /// preference: v1.0.6 shipped this same gate on a 750 ms-1.5 s sampler and
    /// the box was effectively never seen.
    /// </summary>
    [Fact]
    public void The_appearance_latency_is_one_live_poll_not_a_live_poll_plus_a_snapshot()
    {
        Assert.Equal(250, LivePollingCoordinator.SkillsPollMs);

        // Worst case before: the live poll interval, then the projection had to
        // wait for the next 750 ms snapshot to be collected.
        const int oneThousandAndSevenFifty = 1000 + 750;
        var after = LivePollingCoordinator.SkillsPollMs;

        Assert.True(
            oneThousandAndSevenFifty / (double)after >= 7.0,
            $"worst-case appearance is {after} ms against 1750 ms before: {oneThousandAndSevenFifty / (double)after:0.0}x, under the 7x this release claims");
    }

    // ------------------------------------------------ the highlight that stayed

    /// <summary>
    /// THE regression, at the host. Once the phase leaves InProgress there must
    /// be no overlay state left to hand anybody, and no later tick may produce
    /// one — the field re-assert was two minutes after the fact, so this drives
    /// 200 snapshot ticks, which at 750 ms is two and a half minutes.
    /// </summary>
    [Fact]
    public async Task Leaving_the_game_clears_the_state_and_no_later_tick_revives_it()
    {
        await using var harness = await Harness.CreateAsync();
        await harness.SettleInGameAsync();
        harness.Live.ActivePlayer = ActivePlayer(2, 1, 0, 0, 0);
        await harness.Host.LivePolling.TickSkillsAsync();

        var inGame = await harness.Host.ReadSnapshotAsync(CancellationToken.None);
        Assert.NotNull(inGame.Overlay);
        Assert.NotNull(inGame.Overlay!.NextAbility());

        // The user's log: InProgress -> None, and 2999 stops answering.
        harness.Host.State.SetPhase("None");
        harness.Live.LiveClientGone = true;

        for (var tick = 0; tick < 200; tick++)
        {
            var snapshot = await harness.Host.ReadSnapshotAsync(CancellationToken.None);
            Assert.Null(snapshot.Overlay);
        }

        // And the retained inputs are gone, not merely unreported: a champion
        // id surviving the match is how a later phase could rebuild a state.
        Assert.Equal((null, ChampionIdSource.None), harness.Host.ResolvedChampion);
    }

    /// <summary>
    /// The other half of the same defect: the feed can die while the phase is
    /// still InProgress (the game process exits before the client notices).
    /// 1.0.11 answered that by serving its last snapshot forever, because a
    /// null read was simply dropped and looked identical to "nothing changed".
    /// </summary>
    [Fact]
    public async Task A_live_feed_that_stops_answering_drops_the_snapshot_rather_than_repeating_it()
    {
        await using var harness = await Harness.CreateAsync();
        await harness.SettleInGameAsync();
        harness.Live.ActivePlayer = ActivePlayer(2, 1, 0, 0, 0);
        await harness.Host.LivePolling.TickSkillsAsync();
        Assert.NotNull((await harness.Host.ReadSnapshotAsync(CancellationToken.None)).Overlay);

        harness.Live.LiveClientGone = true;

        // One short of the threshold the snapshot is still served: a single
        // dropped poll must not blank a live game.
        for (var poll = 0; poll < LivePollingCoordinator.SkillMissesBeforeDrop - 1; poll++)
            await harness.Host.LivePolling.TickSkillsAsync();
        Assert.NotNull((await harness.Host.ReadSnapshotAsync(CancellationToken.None)).Overlay);

        await harness.Host.LivePolling.TickSkillsAsync();

        Assert.Null((await harness.Host.ReadSnapshotAsync(CancellationToken.None)).Overlay);
        var log = await harness.ReadLogAsync();
        Assert.Contains("skill feed silent", log, StringComparison.Ordinal);
    }

    /// <summary>
    /// The grace itself, in wall-clock terms, because the test above reads the
    /// constant and so cannot notice it moving.
    ///
    /// <para>Long enough that one dropped poll or a brief loopback hiccup never
    /// blanks a live game; short enough that a feed which has genuinely gone
    /// away cannot leave a recommendation on screen for a length of time a
    /// player would notice. The field failure was two minutes.</para>
    /// </summary>
    [Fact]
    public void The_silence_a_snapshot_survives_is_seconds_not_a_whole_game()
    {
        var silenceMs = LivePollingCoordinator.SkillMissesBeforeDrop * LivePollingCoordinator.SkillsPollMs;

        Assert.InRange(silenceMs, 2_000, 8_000);
    }

    /// <summary>
    /// The exact sequence behind the 20:34:06 line, on the real window.
    ///
    /// <para>The user was trying to move the overlay — that is the other half of
    /// their report — so adjust mode was open. Adjust mode suppresses every
    /// render, the game ended underneath it, and leaving it restored the
    /// visibility the window had before adjustment and repainted the retained
    /// in-game state. Two minutes late, on the wrong monitor, for a match that
    /// no longer existed.</para>
    /// </summary>
    [Fact]
    public void An_adjust_session_that_outlives_the_game_does_not_resurrect_the_highlight()
    {
        RunOnSta(() =>
        {
            var settingsPath = Path.Combine(Path.GetTempPath(), $"coachbuild-test-{Guid.NewGuid():N}.json");
            var lines = new List<string>();
            var window = new OverlayWindow(new OverlaySettingsStore(settingsPath))
            {
                Diagnostics = lines.Add,
            };
            try
            {
                window.SetOverlayVisible(true);
                window.ShowInactive();
                window.ApplyState(InGameState(level: 2, q: 1));
                Assert.True(window.IsDrawingHighlight);

                // The user opens adjust mode from the tray, mid-game.
                window.BeginAdjustment();
                Assert.True(window.IsAdjusting);

                // The game ends while adjust mode is still open. App's poll
                // clears rather than merely hiding; the alignment boxes the
                // user is working with must survive that.
                window.ClearForNoGame("phase None");
                Assert.True(window.IsAdjusting);

                // ...and two minutes later they press Esc.
                window.CancelAdjustment();

                Assert.False(window.IsAdjusting);
                Assert.False(window.IsDrawingHighlight);
                Assert.False(window.IsVisible);
                Assert.Null(window.Renderer.LastModel?.HighlightedAbility);
                Assert.Contains(lines, line => line.Contains("highlight hidden", StringComparison.Ordinal));
            }
            finally
            {
                window.Close();
                if (File.Exists(settingsPath)) File.Delete(settingsPath);
            }
        });
    }

    /// <summary>
    /// The same guarantee against the other re-render path in the field log: a
    /// display change (League exiting drops the overlay back to its own
    /// monitor, which is what <c>source=self</c> recorded). Two hundred ticks,
    /// with a show and a monitor re-resolve in the middle.
    /// </summary>
    [Fact]
    public void After_the_game_no_amount_of_re_rendering_puts_the_highlight_back()
    {
        RunOnSta(() =>
        {
            var settingsPath = Path.Combine(Path.GetTempPath(), $"coachbuild-test-{Guid.NewGuid():N}.json");
            var window = new OverlayWindow(new OverlaySettingsStore(settingsPath));
            try
            {
                window.SetOverlayVisible(true);
                window.ShowInactive();
                window.ApplyState(InGameState(level: 2, q: 1));
                Assert.True(window.IsDrawingHighlight);

                window.ClearForNoGame("phase None");

                for (var tick = 0; tick < 200; tick++)
                {
                    window.ClearForNoGame("phase None");
                    if (tick == 100) window.ShowInactive();
                    Assert.False(window.IsDrawingHighlight);
                    Assert.Null(window.Renderer.LastModel?.HighlightedAbility);
                }
            }
            finally
            {
                window.Close();
                if (File.Exists(settingsPath)) File.Delete(settingsPath);
            }
        });
    }

    // ----------------------------------------------------- champ-select speed

    /// <summary>
    /// Lane B took the web path to ~0.1-0.8 s and named this 1500 ms tick as the
    /// remaining floor under it. Champ select is the only phase that gets the
    /// faster cadence: it is the only one where the user changes something
    /// several times a second and then looks at the app for the answer.
    /// </summary>
    [Theory]
    [InlineData("ChampSelect", LivePollingCoordinator.ChampSelectGameflowPollMs)]
    [InlineData("InProgress", LivePollingCoordinator.GameflowPollMs)]
    [InlineData("None", LivePollingCoordinator.GameflowPollMs)]
    [InlineData("Lobby", LivePollingCoordinator.GameflowPollMs)]
    [InlineData("Matchmaking", LivePollingCoordinator.GameflowPollMs)]
    [InlineData(null, LivePollingCoordinator.GameflowPollMs)]
    public void Only_champ_select_gets_the_fast_gameflow_cadence(string? phase, int expectedMs)
    {
        Assert.Equal(expectedMs, (int)CoreDesktopHostServices.GameflowDelayForPhase(phase).TotalMilliseconds);
    }

    [Fact]
    public void The_champ_select_cadence_is_a_real_improvement_and_not_a_rename()
    {
        Assert.True(
            LivePollingCoordinator.ChampSelectGameflowPollMs * 4 <= LivePollingCoordinator.GameflowPollMs,
            "champ select must be at least 4x faster than the general cadence");
        // ...and not so fast that the LCU is being hammered for a value a human
        // is reading off a screen.
        Assert.True(LivePollingCoordinator.ChampSelectGameflowPollMs >= 200);
    }

    // ---------------------------------------------------------------- helpers

    private static OverlayState InGameState(int level, int q) => new(
        InGame: true,
        ChampionName: "Volibear",
        ChampionId: VolibearId,
        Level: level,
        AbilityRanks: new Dictionary<UiAbility, int>
        {
            [UiAbility.Q] = q,
            [UiAbility.W] = 0,
            [UiAbility.E] = 0,
            [UiAbility.R] = 0,
        },
        SkillOrder: new UiSkillOrder(
            [UiAbility.Q, UiAbility.W, UiAbility.E, UiAbility.Q],
            4,
            Completed: false),
        Lane: "TOP",
        IsLaneAuto: true);

    private static void RunOnSta(Action action)
    {
        Exception? failure = null;
        var thread = new Thread(() =>
        {
            try { action(); }
            catch (Exception exception) { failure = exception; }
        });
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();
        thread.Join();
        if (failure is not null) ExceptionDispatchInfo.Capture(failure).Throw();
    }

    private sealed class Harness : IAsyncDisposable
    {
        private readonly string _root;

        private Harness(CoreDesktopHostServices host, string root, FakeLive live)
        {
            Host = host;
            _root = root;
            Live = live;
        }

        public CoreDesktopHostServices Host { get; }

        public FakeLive Live { get; }

        public static async Task<Harness> CreateAsync()
        {
            var root = Path.Combine(Path.GetTempPath(), "CoachBuild-LifecycleTests", Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(root);
            var live = new FakeLive();
            var host = new CoreDesktopHostServices(
                new string('a', 64),
                root,
                skillOrders: new StubProvider(),
                bridgePorts: [FindFreePort()],
                liveHandler: live,
                championDirectory: new FakeChampionDirectory());

            var harness = new Harness(host, root, live);
            host.State.SetPhase("InProgress");
            // Production sees the phase transition before the live pollers
            // repopulate; the per-game reset is driven by that observation.
            await host.ReadSnapshotAsync(CancellationToken.None);
            return harness;
        }

        /// <summary>Every live tick plus a snapshot, settled, so a skill order exists.</summary>
        public async Task SettleInGameAsync()
        {
            await Host.LivePolling.TickAllGameDataAsync();
            await Host.LivePolling.TickPlayerListAsync();
            await Host.LivePolling.TickSkillsAsync();
            for (var round = 0; round < 4; round++)
            {
                if (Host.PendingChampionDirectoryFetch is { } roster) await roster;
                if (Host.PendingSkillOrderFetch is { } order) await order;
            }

            await Host.ReadSnapshotAsync(CancellationToken.None);
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
        public string AllGameDataBody { get; set; } = AllGameData;

        public string PlayerListBody { get; set; } = PlayerList;

        public string ActivePlayer { get; set; } = LiveGameLifecycleTests.ActivePlayer(1, 0, 0, 0, 0);

        /// <summary>The game process has exited; 2999 refuses connections.</summary>
        public bool LiveClientGone { get; set; }

        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            if (LiveClientGone) throw new HttpRequestException("connection refused", null, HttpStatusCode.ServiceUnavailable);
            var body = request.RequestUri!.AbsolutePath switch
            {
                "/liveclientdata/allgamedata" => AllGameDataBody,
                "/liveclientdata/playerlist" => PlayerListBody,
                "/liveclientdata/activeplayer" => ActivePlayer,
                _ => null,
            };
            return Task.FromResult(body is null
                ? new HttpResponseMessage(HttpStatusCode.NotFound)
                : new HttpResponseMessage(HttpStatusCode.OK)
                {
                    Content = new StringContent(body, Encoding.UTF8, "application/json"),
                });
        }
    }

    private sealed class StubProvider : ISkillOrderProvider
    {
        public Task<SkillOrderResult> GetSkillOrderAsync(int championId, string? role, CancellationToken ct) =>
            Task.FromResult(new SkillOrderResult(
                SkillOrderStatus.Ok,
                new CoreSkillOrder(
                    [
                        CoreAbility.Q, CoreAbility.W, CoreAbility.E, CoreAbility.Q,
                        CoreAbility.Q, CoreAbility.R, CoreAbility.Q, CoreAbility.E,
                        CoreAbility.Q, CoreAbility.E, CoreAbility.R, CoreAbility.E,
                        CoreAbility.E, CoreAbility.W, CoreAbility.W, CoreAbility.R,
                        CoreAbility.W, CoreAbility.W,
                    ],
                    18,
                    Completed: true,
                    "published"),
                championId,
                8839));
    }

    private static int FindFreePort()
    {
        using var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        return ((IPEndPoint)listener.LocalEndpoint).Port;
    }
}
