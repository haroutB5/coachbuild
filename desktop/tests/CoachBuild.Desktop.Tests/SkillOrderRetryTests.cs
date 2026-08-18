using System.Net;
using System.Net.Http;
using System.Net.Sockets;
using System.Text;
using CoachBuild.Core;
using Xunit;

namespace CoachBuild.Desktop.Tests;

/// <summary>
/// The regression suite for the 1.0.7 defect that 1.0.7 claimed to fix.
///
/// <para>1.0.7 shipped a skill-order retry that armed the backoff only from a
/// <c>catch</c> around <c>SkillOrderLaneResolver.ResolveAsync</c>. Nothing on
/// that path throws: <c>SkillOrderProvider.FetchAsync</c> ends in a bare catch
/// and <c>GetSafelyAsync</c> wraps a second one on top of it, so every failure
/// arrives as a VALUE. The success branch then set
/// <c>_skillOrderRetryAt = null</c> — actively disarming the retry it was
/// supposed to arm. Measured before the fix, driving the real
/// <c>ReadSnapshotAsync</c> for 30 in-game ticks with a provider that fails
/// once and is healthy afterwards: 1 provider call, order length 0,
/// <b>first good tick: NEVER</b>.</para>
///
/// <para>The 1.0.7 tests covered <c>HideOverlay</c> and
/// <c>OverlayRenderer.Invalidate</c>. Neither covered the retry, which is how
/// dead code shipped as a fix. These tests are the missing ones.</para>
/// </summary>
public sealed class SkillOrderRetryTests
{
    private const string LocalRiotId = "Bench#EUW";
    private const int AhriId = 103;
    private const double TickSeconds = 0.75;

    // App's snapshot poll is 750 ms. 30 ticks is 22.5 s — the same window the
    // pre-fix bench measured, and long enough for the 20 s first Error retry.
    private const int GameTicks = 30;

    // NoData waits 75 s (past SkillOrderProvider's own 60 s no-data cooldown),
    // so its recovery needs a longer window. Virtual time, so this is free.
    private const int LongGameTicks = 140;

    /// <summary>
    /// THE bench-measured scenario. Pre-fix this measured
    /// "provider calls: 1 | first good tick: NEVER | final order len: 0".
    /// </summary>
    [Fact]
    public async Task One_failed_fetch_then_healthy_recovers_on_the_first_tick_after_the_backoff()
    {
        var clock = new FakeClock();
        var provider = new ScriptedSkillOrderProvider(
            call => call == 0 ? Error() : Ok());

        var run = await RunInGameAsync(provider, clock, GameTicks);

        // Pre-fix: NEVER. The retry never armed, so the same-key
        // short-circuit returned for the rest of the match.
        Assert.Equal(27, run.FirstGoodTick);
        Assert.Equal(18, run.FinalOrderLength);
        Assert.Equal(2, provider.Calls);

        // 20 s backoff at 750 ms per tick: due on tick 27 (20.25 s), and
        // BuildOverlayState re-reads the result after requesting it, so a fast
        // fetch is visible on the SAME tick. Pin the window, not "eventually".
        Assert.InRange(run.FirstGoodTick * TickSeconds, 20.0, 22.5);
    }

    [Fact]
    public async Task A_healthy_first_fetch_still_costs_exactly_one_call_and_shows_immediately()
    {
        var clock = new FakeClock();
        var provider = new ScriptedSkillOrderProvider(_ => Ok());

        var run = await RunInGameAsync(provider, clock, GameTicks);

        Assert.Equal(0, run.FirstGoodTick);
        Assert.Equal(18, run.FinalOrderLength);
        Assert.Equal(1, provider.Calls);
    }

    [Fact]
    public async Task Two_failed_fetches_then_healthy_still_recovers_inside_the_game()
    {
        var clock = new FakeClock();
        var provider = new ScriptedSkillOrderProvider(
            call => call < 2 ? Error() : Ok());

        // Second Error backoff is 45 s, so recovery lands at 20 + 45 = 65 s.
        var run = await RunInGameAsync(provider, clock, LongGameTicks);

        Assert.Equal(87, run.FirstGoodTick);
        Assert.Equal(18, run.FinalOrderLength);
        Assert.Equal(3, provider.Calls);
    }

    /// <summary>
    /// NoData is a verdict from a healthy endpoint, not a failure. It gets one
    /// confirmation past the provider's 60 s no-data cooldown, not the Error
    /// schedule — the endpoint must not be hammered for an answer it gave.
    /// </summary>
    [Fact]
    public async Task No_data_retries_once_and_then_stops_hammering()
    {
        var clock = new FakeClock();
        var provider = new ScriptedSkillOrderProvider(_ => NoData());

        var run = await RunInGameAsync(provider, clock, LongGameTicks);

        Assert.Equal(-1, run.FirstGoodTick);
        Assert.Equal(0, run.FinalOrderLength);
        // One initial fetch plus exactly one confirmation across 105 s.
        Assert.Equal(2, provider.Calls);
    }

    [Fact]
    public async Task No_data_that_later_publishes_an_order_is_picked_up()
    {
        var clock = new FakeClock();
        var provider = new ScriptedSkillOrderProvider(
            call => call == 0 ? NoData() : Ok());

        var run = await RunInGameAsync(provider, clock, LongGameTicks);

        // 75 s / 750 ms = tick 100 is exactly when the retry is due.
        Assert.Equal(100, run.FirstGoodTick);
        Assert.Equal(18, run.FinalOrderLength);
        Assert.Equal(2, provider.Calls);
    }

    [Fact]
    public async Task A_permanently_failing_endpoint_stops_after_the_schedule_is_exhausted()
    {
        var clock = new FakeClock();
        var provider = new ScriptedSkillOrderProvider(_ => Error());

        // 20 + 45 + 90 = 155 s of schedule; run past it.
        var run = await RunInGameAsync(provider, clock, 300);

        Assert.Equal(-1, run.FirstGoodTick);
        // Initial fetch plus three scheduled retries, then silence. A retry
        // loop with no cap would be a self-inflicted outage on our own API.
        Assert.Equal(4, provider.Calls);
    }

    /// <summary>
    /// The seven failure modes measured on the pre-fix bench, all of which
    /// returned a VALUE and none of which threw — which is exactly why the
    /// 1.0.7 catch-based retry never fired. Each now arms the retry, and each
    /// recovers once the transport is healthy again. Driven through the real
    /// <see cref="SkillOrderProvider"/> and the real
    /// <see cref="SkillOrderLaneResolver"/>, not a stub of them.
    /// </summary>
    [Theory]
    [InlineData(SkillOrderFailureMode.NetworkDown, 27)]
    [InlineData(SkillOrderFailureMode.Http500, 27)]
    [InlineData(SkillOrderFailureMode.Http429, 27)]
    [InlineData(SkillOrderFailureMode.Garbage200, 27)]
    [InlineData(SkillOrderFailureMode.Timeout, 27)]
    [InlineData(SkillOrderFailureMode.UnexpectedException, 27)]
    // http 200 "null" is the one mode that maps to NoData, so it waits 75 s.
    [InlineData(SkillOrderFailureMode.Null200, 100)]
    public async Task Every_injected_failure_mode_arms_the_retry_and_recovers(
        SkillOrderFailureMode mode,
        int expectedFirstGoodTick)
    {
        var clock = new FakeClock();
        var handler = new FailingSkillOrderHandler(mode, failuresBeforeHealthy: 1);
        using var http = new HttpClient(handler);
        // The provider shares the fake clock so its OWN 15 s / 60 s failure
        // cooldowns advance with the retry schedule. That relationship is the
        // reason the 1.0.7 values of 3 s and 8 s were unusable even after the
        // retry was armed: both landed inside the 15 s error cooldown and were
        // served the cached failure without touching the network.
        using var provider = new SkillOrderProvider(
            http,
            SkillOrderProvider.DefaultEndpoint,
            clock);
        var counting = new CountingSkillOrderProvider(provider);

        var run = await RunInGameAsync(counting, clock, LongGameTicks);

        Assert.Equal(expectedFirstGoodTick, run.FirstGoodTick);
        Assert.Equal(18, run.FinalOrderLength);
        Assert.Equal(2, counting.Calls);
        Assert.Equal(2, handler.Requests);
    }

    [Fact]
    public async Task A_lane_change_mid_game_still_clears_the_key_and_refetches()
    {
        // The 1.0.7 user workaround (tray > Lane) must keep working: it is the
        // only recovery path older builds have.
        var clock = new FakeClock();
        var provider = new ScriptedSkillOrderProvider(_ => Ok());

        await using var harness = await InGameHarness.CreateAsync(provider, clock);
        var before = await harness.Host.ReadSnapshotAsync(CancellationToken.None);
        Assert.Equal(18, before.Overlay?.SkillOrder.Order.Count);

        harness.Host.SetLaneOverride("TOP");
        if (harness.Host.PendingSkillOrderFetch is { } pending) await pending;
        var after = await harness.Host.ReadSnapshotAsync(CancellationToken.None);

        Assert.Equal(18, after.Overlay?.SkillOrder.Order.Count);
        Assert.Equal("TOP", after.Overlay?.Lane);
        Assert.Equal(2, provider.Calls);
    }

    // ---------------------------------------------------------------- harness

    private sealed record GameRun(int FirstGoodTick, int FinalOrderLength);

    private static async Task<GameRun> RunInGameAsync(
        ISkillOrderProvider provider,
        FakeClock clock,
        int ticks)
    {
        await using var harness = await InGameHarness.CreateAsync(provider, clock);

        var firstGood = -1;
        var finalLength = 0;
        for (var tick = 0; tick < ticks; tick++)
        {
            var snapshot = await harness.Host.ReadSnapshotAsync(CancellationToken.None);
            finalLength = snapshot.Overlay?.SkillOrder.Order.Count ?? 0;
            if (firstGood < 0 && finalLength > 0) firstGood = tick;

            // In production 750 ms of wall clock separates two ticks, which is
            // far longer than a fetch. Settle it deterministically rather than
            // sleeping, so the measured recovery tick is exact.
            if (harness.Host.PendingSkillOrderFetch is { } pending) await pending;
            clock.Advance(TimeSpan.FromSeconds(TickSeconds));
        }

        return new GameRun(firstGood, finalLength);
    }

    private sealed class InGameHarness : IAsyncDisposable
    {
        private readonly string _root;
        private readonly FakeLiveClientHandler _live;

        private InGameHarness(CoreDesktopHostServices host, string root, FakeLiveClientHandler live)
        {
            Host = host;
            _root = root;
            _live = live;
        }

        public CoreDesktopHostServices Host { get; }

        public static async Task<InGameHarness> CreateAsync(
            ISkillOrderProvider provider,
            FakeClock clock)
        {
            var root = Path.Combine(
                Path.GetTempPath(),
                "CoachBuild-RetryTests",
                Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(root);
            var live = new FakeLiveClientHandler();
            var host = new CoreDesktopHostServices(
                new string('a', 64),
                root,
                skillOrders: provider,
                bridgePorts: [FindFreePort()],
                liveHandler: live,
                timeProvider: clock,
                championDirectory: new FakeChampionDirectory());

            host.State.SetPhase("InProgress");
            // BuildOverlayState clears the per-game state on the first tick it
            // sees InProgress. Production sees that transition before the live
            // pollers repopulate; do the same here or the seed is wiped.
            await host.ReadSnapshotAsync(CancellationToken.None);

            await host.LivePolling.TickAllGameDataAsync();
            await host.LivePolling.TickPlayerListAsync();
            await host.LivePolling.TickSkillsAsync();
            if (host.PendingSkillOrderFetch is { } pending) await pending;

            return new InGameHarness(host, root, live);
        }

        public async ValueTask DisposeAsync()
        {
            await Host.DisposeAsync();
            _live.Dispose();
            try { Directory.Delete(_root, recursive: true); } catch { }
        }
    }

    // ------------------------------------------------------------------ fakes

    private static SkillOrderResult Ok() => new(
        SkillOrderStatus.Ok,
        new OverlaySkillOrder(EighteenLevelOrder(), 18, Completed: true, "published"),
        AhriId,
        35300);

    private static SkillOrderResult Error() =>
        new(SkillOrderStatus.Error, OverlaySkillOrder.Empty, AhriId);

    private static SkillOrderResult NoData() =>
        new(SkillOrderStatus.NoData, OverlaySkillOrder.Empty, AhriId);

    private static IReadOnlyList<CoachBuild.Core.OverlayAbility> EighteenLevelOrder() =>
        Enumerable.Range(0, 18)
            .Select(index => (CoachBuild.Core.OverlayAbility)(index % 3))
            .ToArray();

    private sealed class ScriptedSkillOrderProvider : ISkillOrderProvider
    {
        private readonly Func<int, SkillOrderResult> _script;
        private int _calls;

        public ScriptedSkillOrderProvider(Func<int, SkillOrderResult> script) => _script = script;

        public int Calls => Volatile.Read(ref _calls);

        public Task<SkillOrderResult> GetSkillOrderAsync(int championId, string? role, CancellationToken ct)
        {
            var call = Interlocked.Increment(ref _calls) - 1;
            return Task.FromResult(_script(call));
        }
    }

    private sealed class CountingSkillOrderProvider : ISkillOrderProvider
    {
        private readonly ISkillOrderProvider _inner;
        private int _calls;

        public CountingSkillOrderProvider(ISkillOrderProvider inner) => _inner = inner;

        public int Calls => Volatile.Read(ref _calls);

        public Task<SkillOrderResult> GetSkillOrderAsync(int championId, string? role, CancellationToken ct)
        {
            Interlocked.Increment(ref _calls);
            return _inner.GetSkillOrderAsync(championId, role, ct);
        }
    }

    private static int FindFreePort()
    {
        using var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        return ((IPEndPoint)listener.LocalEndpoint).Port;
    }

    /// <summary>
    /// A fake Live Client Data server on the 2999 contract: enough of
    /// allgamedata, playerlist and activeplayer for the real capture path to
    /// resolve identity, champion, lane and skill ranks.
    /// </summary>
    internal sealed class FakeLiveClientHandler : HttpMessageHandler
    {
        // Riot's real shape. Through 1.0.10 the PlayerList fixture below
        // carried "championId":103 - a field Live Client Data has never sent -
        // so every test in this file passed while the pipeline it exercises
        // could not resolve a champion in a real game at all. Removing it turns
        // all 14 of these red against 1.0.10's production code.
        private const string AllGameData = """
        {"activePlayer":{"riotId":"Bench#EUW","riotIdGameName":"Bench",
                         "riotIdTagLine":"EUW","summonerName":""}}
        """;

        private const string PlayerList = """
        [{"riotId":"Bench#EUW","riotIdGameName":"Bench","riotIdTagLine":"EUW",
          "summonerName":"","championName":"Ahri",
          "rawChampionName":"game_character_displayname_Ahri","position":"MIDDLE",
          "team":"ORDER","isBot":false,"level":1}]
        """;

        private const string ActivePlayer = """
        {"level":1,"abilities":{"Q":{"abilityLevel":0},"W":{"abilityLevel":0},
                                "E":{"abilityLevel":0},"R":{"abilityLevel":0}}}
        """;

        public bool Reachable { get; set; } = true;

        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            if (!Reachable) throw new HttpRequestException("connection refused");

            var body = request.RequestUri!.AbsolutePath switch
            {
                "/liveclientdata/allgamedata" => AllGameData,
                "/liveclientdata/playerlist" => PlayerList,
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
}

public enum SkillOrderFailureMode
{
    NetworkDown,
    Http500,
    Http429,
    Garbage200,
    Null200,
    Timeout,
    UnexpectedException,
}

/// <summary>
/// Reproduces each of the seven injected transports from the pre-fix bench,
/// then goes healthy. Every one of them returns a value rather than throwing
/// out of <c>SkillOrderProvider</c>, which is the whole reason a catch-based
/// retry was dead code.
/// </summary>
internal sealed class FailingSkillOrderHandler : HttpMessageHandler
{
    private const string HealthyBody = """
    {"order":["Q","W","E","Q","Q","R","Q","W","Q","W","R","W","W","E","E","R","E","E"],
     "completed":true,"observedLevels":18,"completionBasis":"published","sampleSize":35300}
    """;

    private readonly SkillOrderFailureMode _mode;
    private readonly int _failuresBeforeHealthy;
    private int _requests;

    public FailingSkillOrderHandler(SkillOrderFailureMode mode, int failuresBeforeHealthy)
    {
        _mode = mode;
        _failuresBeforeHealthy = failuresBeforeHealthy;
    }

    public int Requests => Volatile.Read(ref _requests);

    protected override Task<HttpResponseMessage> SendAsync(
        HttpRequestMessage request,
        CancellationToken cancellationToken)
    {
        var index = Interlocked.Increment(ref _requests) - 1;
        if (index >= _failuresBeforeHealthy) return Task.FromResult(Json(HttpStatusCode.OK, HealthyBody));

        return _mode switch
        {
            SkillOrderFailureMode.NetworkDown =>
                throw new HttpRequestException("No connection could be made."),
            SkillOrderFailureMode.Http500 =>
                Task.FromResult(new HttpResponseMessage(HttpStatusCode.InternalServerError)),
            SkillOrderFailureMode.Http429 =>
                Task.FromResult(new HttpResponseMessage(HttpStatusCode.TooManyRequests)),
            SkillOrderFailureMode.Garbage200 =>
                Task.FromResult(Json(HttpStatusCode.OK, "<html>gateway</html>")),
            SkillOrderFailureMode.Null200 =>
                Task.FromResult(Json(HttpStatusCode.OK, "null")),
            // A client-side timeout surfaces as a cancellation that the caller
            // never requested; that is how HttpClient.Timeout reports itself.
            SkillOrderFailureMode.Timeout =>
                throw new TaskCanceledException("The request timed out."),
            _ => throw new InvalidOperationException("unexpected handler state"),
        };
    }

    private static HttpResponseMessage Json(HttpStatusCode status, string body) => new(status)
    {
        Content = new StringContent(body, Encoding.UTF8, "application/json"),
    };
}

/// <summary>Virtual clock. Nothing here waits on wall time.</summary>
internal sealed class FakeClock : TimeProvider
{
    private DateTimeOffset _now = new(2026, 8, 17, 12, 0, 0, TimeSpan.Zero);

    public override DateTimeOffset GetUtcNow() => _now;

    public void Advance(TimeSpan delta) => _now += delta;
}
