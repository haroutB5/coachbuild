using System.Reflection;
using System.Runtime.ExceptionServices;
using CoachBuild.Core;
using CoachBuild.Desktop.Overlay;
using Xunit;

namespace CoachBuild.Desktop.Tests;

/// <summary>
/// The instruments that decide whether the next remote report is answerable
/// from a log paste. In 1.0.7 a healthy render, a render on the wrong monitor
/// and a render swallowed by exclusive fullscreen produced the SAME line, and
/// three unrelated failures all produced no line at all.
/// </summary>
public sealed class OverlayDiagnosticsTests
{
    private static DisplayInfo Display(string device, int width = 1920, int height = 1080, int dpi = 96) =>
        new(device, 0, 0, width, height, dpi, dpi);

    // ------------------------------------------------- display source choice

    [Fact]
    public void The_game_window_wins_whenever_it_exists()
    {
        var (handle, source) = OverlayDisplayResolver.ChooseHandle(ownHandle: 11, gameHandle: 22);

        Assert.Equal(22, handle);
        Assert.Equal(OverlayDisplayResolver.LeagueSource, source);
    }

    [Fact]
    public void Without_a_game_window_the_overlay_falls_back_to_its_own_handle()
    {
        // This branch is 1.0.7 behaviour exactly, and it is what runs out of a
        // game and during adjust mode.
        var (handle, source) = OverlayDisplayResolver.ChooseHandle(ownHandle: 11, gameHandle: 0);

        Assert.Equal(11, handle);
        Assert.Equal(OverlayDisplayResolver.SelfSource, source);
    }

    [Fact]
    public void A_monitor_swap_is_called_out_by_name_not_folded_into_a_silent_re_resolve()
    {
        var line = OverlayDisplayResolver.DescribeChange(
            Display("\\\\.\\DISPLAY1"),
            Display("\\\\.\\DISPLAY2", 2560, 1440, 120),
            OverlayDisplayResolver.LeagueSource);

        Assert.NotNull(line);
        Assert.Contains("DISPLAY2 2560x1440@120 source=league", line, StringComparison.Ordinal);
        Assert.Contains("moved from", line, StringComparison.Ordinal);
        Assert.Contains("DISPLAY1", line, StringComparison.Ordinal);
    }

    [Fact]
    public void A_resolution_change_on_the_same_monitor_reports_the_old_geometry()
    {
        var line = OverlayDisplayResolver.DescribeChange(
            Display("\\\\.\\DISPLAY1", 1920, 1080, 96),
            Display("\\\\.\\DISPLAY1", 2560, 1440, 96),
            OverlayDisplayResolver.SelfSource);

        Assert.NotNull(line);
        Assert.Contains("was 1920x1080@96", line, StringComparison.Ordinal);
    }

    [Fact]
    public void An_unchanged_display_says_nothing_because_this_runs_every_render_tick()
    {
        Assert.Null(OverlayDisplayResolver.DescribeChange(
            Display("\\\\.\\DISPLAY1"),
            Display("\\\\.\\DISPLAY1"),
            OverlayDisplayResolver.SelfSource));
    }

    // ------------------------------------------------------ game window cache

    [Fact]
    public void The_game_window_scan_is_cached_and_survives_between_render_ticks()
    {
        var clock = new FakeClock();
        var scans = 0;
        var locator = new LeagueGameWindowLocator(
            mainWindows: _ => { scans++; return new nint[] { 42 }; },
            isWindow: _ => true,
            timeProvider: clock,
            rescanAfter: TimeSpan.FromSeconds(5));

        Assert.Equal(42, locator.FindGameWindow());
        Assert.Equal(42, locator.FindGameWindow());
        Assert.Equal(42, locator.FindGameWindow());

        // EnsureDisplay runs on the 750 ms render tick; a process-table walk
        // per tick would be a real cost for a value that changes once a game.
        Assert.Equal(1, scans);

        clock.Advance(TimeSpan.FromSeconds(6));
        Assert.Equal(42, locator.FindGameWindow());
        Assert.Equal(2, scans);
    }

    [Fact]
    public void A_closed_game_window_is_dropped_immediately_rather_than_held_for_the_cache_window()
    {
        var clock = new FakeClock();
        var alive = true;
        var locator = new LeagueGameWindowLocator(
            mainWindows: _ => alive ? new nint[] { 42 } : Array.Empty<nint>(),
            isWindow: _ => alive,
            timeProvider: clock);

        Assert.Equal(42, locator.FindGameWindow());

        alive = false;
        // A stale handle would pin the overlay to the monitor of a game that
        // has already exited.
        Assert.Equal(0, locator.FindGameWindow());
    }

    [Fact]
    public void A_locator_that_throws_never_takes_the_render_tick_down()
    {
        RunOnSta(() =>
        {
            var settingsPath = Path.Combine(Path.GetTempPath(), $"coachbuild-test-{Guid.NewGuid():N}.json");
            var lines = new List<string>();
            var window = new OverlayWindow(new OverlaySettingsStore(settingsPath), new ThrowingLocator())
            {
                Diagnostics = lines.Add,
            };
            try
            {
                window.SetOverlayVisible(true);
                window.ShowInactive();
                lines.Clear();
                window.ApplyState(InGameState());

                // A denied or exiting process query must degrade to 1.0.7's
                // own-handle behaviour, never blank the overlay.
                Assert.Equal(OverlayDisplayResolver.SelfSource, window.DisplaySource);
                Assert.True(window.IsDrawingHighlight);
            }
            finally
            {
                window.Close();
                if (File.Exists(settingsPath)) File.Delete(settingsPath);
            }
        });
    }

    private sealed class ThrowingLocator : IGameWindowLocator
    {
        public nint FindGameWindow() => throw new UnauthorizedAccessException();
    }

    // ------------------------------------------- the scan, off the render tick

    /// <summary>
    /// 1.0.10 moves the process-table walk off the WPF dispatcher. Measured
    /// interleaved over 20 calls at the production 3 s cadence: <b>8.924 ms mean
    /// / 9.107 ms median / 197.3 ms of UI-thread time per minute</b> before,
    /// <b>0.272 ms / 0.002 ms / 15.0 ms</b> after.
    /// </summary>
    [Fact]
    public void The_first_resolve_is_synchronous_so_the_overlay_lands_on_leagues_monitor_at_once()
    {
        // This is 1.0.8's whole fix. At first Show() there is no previous answer
        // to serve, and serving 0 would put the overlay on the primary monitor
        // until a background scan landed — which is exactly the 1.0.7 defect.
        var locator = new DeferredGameWindowLocator(
            mainWindows: _ => new nint[] { 42 },
            isWindow: _ => true,
            schedule: NeverScheduled);

        Assert.Equal(42, locator.FindGameWindow());
        Assert.Equal(0, locator.BackgroundScans);
    }

    [Fact]
    public async Task Every_later_resolve_scans_off_the_calling_thread()
    {
        var clock = new FakeClock();
        var scanThreads = new List<int>();
        var locator = new DeferredGameWindowLocator(
            mainWindows: _ =>
            {
                lock (scanThreads) scanThreads.Add(Environment.CurrentManagedThreadId);
                return new nint[] { 42 };
            },
            isWindow: _ => true,
            timeProvider: clock,
            rescanAfter: TimeSpan.FromSeconds(5));

        var caller = Environment.CurrentManagedThreadId;
        locator.FindGameWindow();
        clock.Advance(TimeSpan.FromSeconds(6));
        locator.FindGameWindow();
        await locator.PendingRefresh;

        Assert.Equal(2, scanThreads.Count);
        Assert.Equal(caller, scanThreads[0]);
        // The measured 197.3 ms/min was all of it on the dispatcher. A locator
        // that quietly scanned inline would still return the right handle, so
        // the thread is the only thing that proves the fix.
        Assert.NotEqual(caller, scanThreads[1]);
        Assert.Equal(1, locator.BackgroundScans);
    }

    /// <summary>
    /// Equivalence with the synchronous reference implementation: for the same
    /// process table both locators return the same handle. The fix moves WHEN
    /// the answer is computed, never WHAT it is.
    /// </summary>
    [Theory]
    [InlineData(new int[0], 0)]
    [InlineData(new[] { 42 }, 42)]
    [InlineData(new[] { 0, 77 }, 77)]
    [InlineData(new[] { 42, 77 }, 42)]
    public async Task Both_locators_agree_on_the_same_process_table(int[] handles, int expectedHandle)
    {
        var table = Array.ConvertAll(handles, static h => (nint)h);
        var expected = (nint)expectedHandle;
        var clock = new FakeClock();
        var reference = new LeagueGameWindowLocator(
            mainWindows: _ => table, isWindow: h => h != 0, timeProvider: clock);
        var deferred = new DeferredGameWindowLocator(
            mainWindows: _ => table, isWindow: h => h != 0, timeProvider: clock);

        Assert.Equal(expected, reference.FindGameWindow());
        Assert.Equal(expected, deferred.FindGameWindow());

        clock.Advance(TimeSpan.FromSeconds(6));
        deferred.FindGameWindow();
        await deferred.PendingRefresh;

        Assert.Equal(reference.FindGameWindow(), deferred.FindGameWindow());
    }

    /// <summary>
    /// The one behaviour that is genuinely different, stated rather than hidden:
    /// a game window that moves is served one call late. Worst case that is one
    /// extra <c>DisplayRecheckMs</c> (3 s) on top of the 5 s scan cache the
    /// overlay already tolerated, for an event that happens at most once a match.
    /// </summary>
    [Fact]
    public async Task A_changed_process_table_is_served_one_call_late_and_never_wrong()
    {
        var clock = new FakeClock();
        var table = new nint[] { 42 };
        var locator = new DeferredGameWindowLocator(
            mainWindows: _ => table,
            isWindow: _ => true,
            timeProvider: clock,
            rescanAfter: TimeSpan.FromSeconds(5));

        Assert.Equal(42, locator.FindGameWindow());

        table = [77];
        clock.Advance(TimeSpan.FromSeconds(6));

        // Still the last known handle: stale, but a real window, never garbage.
        Assert.Equal(42, locator.FindGameWindow());
        await locator.PendingRefresh;
        Assert.Equal(77, locator.FindGameWindow());
    }

    [Fact]
    public void A_closed_game_window_is_dropped_synchronously_without_waiting_for_a_scan()
    {
        // Unchanged from 1.0.8, and deliberately still on the caller's thread:
        // IsWindow/IsWindowVisible are cheap, and a stale handle would pin the
        // overlay to the monitor of a game that has already exited.
        var clock = new FakeClock();
        var alive = true;
        var locator = new DeferredGameWindowLocator(
            mainWindows: _ => new nint[] { 42 },
            isWindow: _ => alive,
            timeProvider: clock,
            schedule: NeverScheduled);

        Assert.Equal(42, locator.FindGameWindow());

        alive = false;
        Assert.Equal(0, locator.FindGameWindow());
    }

    [Fact]
    public async Task A_scan_slower_than_the_render_tick_queues_one_walk_not_one_per_tick()
    {
        var clock = new FakeClock();
        var release = new TaskCompletionSource();
        var scans = 0;
        var locator = new DeferredGameWindowLocator(
            mainWindows: _ =>
            {
                if (Interlocked.Increment(ref scans) > 1) release.Task.Wait();
                return new nint[] { 42 };
            },
            isWindow: _ => true,
            timeProvider: clock,
            rescanAfter: TimeSpan.FromSeconds(5));

        locator.FindGameWindow();
        clock.Advance(TimeSpan.FromSeconds(6));

        // 40 render ticks against one in-flight scan. Without single-flighting,
        // a scan slower than the tick stacks one process-table walk per tick.
        for (var i = 0; i < 40; i++) locator.FindGameWindow();
        release.SetResult();
        await locator.PendingRefresh;

        Assert.Equal(2, Volatile.Read(ref scans));
    }

    [Fact]
    public async Task A_scan_that_always_fails_does_not_queue_a_walk_every_render_tick()
    {
        var clock = new FakeClock();
        var scans = 0;
        var locator = new DeferredGameWindowLocator(
            mainWindows: _ =>
            {
                Interlocked.Increment(ref scans);
                throw new UnauthorizedAccessException();
            },
            isWindow: _ => true,
            timeProvider: clock,
            rescanAfter: TimeSpan.FromSeconds(5));

        locator.FindGameWindow();
        await locator.PendingRefresh;

        // The refresh timestamp is stamped even for a failed scan. Without that
        // a denied process query hot-loops one queued walk per 750 ms tick — a
        // worse version of the cost being fixed.
        for (var i = 0; i < 20; i++) locator.FindGameWindow();
        await locator.PendingRefresh;

        Assert.Equal(1, Volatile.Read(ref scans));
        Assert.Equal(0, locator.FindGameWindow());
    }

    [Fact]
    public void The_overlay_degrades_to_its_own_handle_when_the_background_scan_finds_nothing()
    {
        RunOnSta(() =>
        {
            var settingsPath = Path.Combine(Path.GetTempPath(), $"coachbuild-test-{Guid.NewGuid():N}.json");
            var window = new OverlayWindow(
                new OverlaySettingsStore(settingsPath),
                new DeferredGameWindowLocator(
                    mainWindows: _ => Array.Empty<nint>(),
                    isWindow: _ => true,
                    schedule: NeverScheduled));
            try
            {
                window.SetOverlayVisible(true);
                window.ShowInactive();
                window.ApplyState(InGameState());

                Assert.Equal(OverlayDisplayResolver.SelfSource, window.DisplaySource);
                Assert.NotNull(window.CurrentDisplay);
                Assert.True(window.IsDrawingHighlight);
            }
            finally
            {
                window.Close();
                if (File.Exists(settingsPath)) File.Delete(settingsPath);
            }
        });
    }

    /// <summary>
    /// A scheduler that drops the work item, so a test can assert what the
    /// caller's thread does on its own without racing a background scan.
    /// </summary>
    private static Task NeverScheduled(Action work) => Task.CompletedTask;

    // ------------------------------------------------------------ fullscreen

    [Fact]
    public void Exclusive_fullscreen_is_logged_once_per_transition_not_once_per_tick()
    {
        var advisor = new FullscreenAdvisor();

        var first = advisor.Observe(inGame: true, UserNotificationState.RunningD3dFullScreen, false);
        var second = advisor.Observe(inGame: true, UserNotificationState.RunningD3dFullScreen, false);

        Assert.NotNull(first.LogLine);
        Assert.Contains("exclusive", first.LogLine, StringComparison.OrdinalIgnoreCase);
        Assert.Null(second.LogLine);
    }

    /// <summary>
    /// The gate that keeps this from being a nuisance. Windows 10 1709+
    /// Fullscreen Optimizations converts most exclusive-fullscreen D3D apps to
    /// borderless-flip, where the overlay works fine — so the hint is only
    /// honest when the overlay believes it is currently drawing something the
    /// user should be able to see.
    /// </summary>
    [Fact]
    public void No_hint_fires_while_the_overlay_is_not_drawing_anything_to_miss()
    {
        var advisor = new FullscreenAdvisor();

        var advice = advisor.Observe(
            inGame: true,
            UserNotificationState.RunningD3dFullScreen,
            isDrawingHighlight: false);

        Assert.False(advice.ShowHint);
    }

    [Fact]
    public void The_hint_fires_once_per_app_run_when_a_highlight_is_being_drawn()
    {
        var advisor = new FullscreenAdvisor();

        var first = advisor.Observe(true, UserNotificationState.RunningD3dFullScreen, true);
        var second = advisor.Observe(true, UserNotificationState.RunningD3dFullScreen, true);

        Assert.True(first.ShowHint);
        Assert.False(second.ShowHint);
        Assert.Contains("Borderless", FullscreenAdvisor.HintMessage, StringComparison.Ordinal);
        // Conditional wording, because FSO may well mean the user CAN see it.
        Assert.StartsWith("If the", FullscreenAdvisor.HintMessage, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData(UserNotificationState.AcceptsNotifications)]
    [InlineData(UserNotificationState.Busy)]
    [InlineData(UserNotificationState.PresentationMode)]
    [InlineData(UserNotificationState.App)]
    [InlineData(null)]
    public void Nothing_but_the_measured_d3d_state_counts_as_exclusive_fullscreen(
        UserNotificationState? state)
    {
        var advisor = new FullscreenAdvisor();

        var advice = advisor.Observe(inGame: true, state, isDrawingHighlight: true);

        Assert.Null(advice.LogLine);
        Assert.False(advice.ShowHint);
    }

    [Fact]
    public void Out_of_a_game_the_shell_state_is_never_attributed_to_league()
    {
        var advisor = new FullscreenAdvisor();

        // Any other fullscreen D3D app (or a video player) must not produce a
        // League instruction.
        var advice = advisor.Observe(inGame: false, UserNotificationState.RunningD3dFullScreen, true);

        Assert.Null(advice.LogLine);
        Assert.False(advice.ShowHint);
    }

    [Fact]
    public void Leaving_exclusive_fullscreen_is_logged_so_the_state_is_not_read_as_permanent()
    {
        var advisor = new FullscreenAdvisor();
        advisor.Observe(true, UserNotificationState.RunningD3dFullScreen, false);

        var cleared = advisor.Observe(true, UserNotificationState.AcceptsNotifications, false);

        Assert.NotNull(cleared.LogLine);
        Assert.Contains("cleared", cleared.LogLine, StringComparison.Ordinal);
    }

    /// <summary>
    /// The shell enum is 1-based. QUNS_RUNNING_D3D_FULL_SCREEN is 3, not 2 —
    /// getting this wrong makes the probe report QUNS_BUSY as fullscreen.
    /// </summary>
    [Fact]
    public void The_shell_notification_enum_matches_the_win32_values()
    {
        Assert.Equal(1, (int)UserNotificationState.NotPresent);
        Assert.Equal(2, (int)UserNotificationState.Busy);
        Assert.Equal(3, (int)UserNotificationState.RunningD3dFullScreen);
        Assert.Equal(5, (int)UserNotificationState.AcceptsNotifications);
    }

    // --------------------------------------------- live reachability instrument

    [Fact]
    public void Loopback_reachability_is_reported_once_per_transition()
    {
        var reporter = new LiveReachabilityReporter(2999);

        Assert.Equal("live: 2999 ok", reporter.Observe(new LiveClientProbe(true, null)));
        Assert.Null(reporter.Observe(new LiveClientProbe(true, null)));

        var down = reporter.Observe(new LiveClientProbe(false, "HttpRequestException/ConnectionError"));
        Assert.Equal("live: 2999 unreachable (HttpRequestException/ConnectionError)", down);
        Assert.Null(reporter.Observe(new LiveClientProbe(false, "HttpRequestException/ConnectionError")));

        Assert.Equal("live: 2999 ok", reporter.Observe(new LiveClientProbe(true, null)));
    }

    /// <summary>
    /// A 404 from a live game is routine: <c>activeplayerabilities</c> 404s on
    /// clients that embed abilities, and spectating 404s <c>activeplayer</c>.
    /// Treating a status code as a reachability verdict would flap this line
    /// once a second and make it worthless.
    /// </summary>
    [Fact]
    public void A_non_success_status_is_not_an_unreachable_port()
    {
        var reporter = new LiveReachabilityReporter();

        Assert.Equal("live: 2999 ok", reporter.Observe(new LiveClientProbe(true, null)));
        for (var i = 0; i < 10; i++)
            Assert.Null(reporter.Observe(new LiveClientProbe(true, null)));
    }

    [Fact]
    public void A_changed_failure_reason_is_reported_even_while_still_down()
    {
        var reporter = new LiveReachabilityReporter();
        reporter.Observe(new LiveClientProbe(false, "Timeout"));

        var changed = reporter.Observe(new LiveClientProbe(false, "HttpRequestException/ConnectionError"));

        Assert.NotNull(changed);
        Assert.Contains("ConnectionError", changed, StringComparison.Ordinal);
    }

    // ------------------------------------------- the window's own render token

    /// <summary>
    /// `no-display` used to mean BOTH "the tray has the overlay switched off"
    /// and "the monitor could not be resolved", because a hidden window has no
    /// HWND and therefore no monitor. That sent every reader hunting a display
    /// bug that did not exist.
    /// </summary>
    [Fact]
    public void A_switched_off_overlay_says_so_instead_of_blaming_the_display()
    {
        RunOnSta(() =>
        {
            var settingsPath = Path.Combine(Path.GetTempPath(), $"coachbuild-test-{Guid.NewGuid():N}.json");
            var lines = new List<string>();
            var window = new OverlayWindow(
                new OverlaySettingsStore(settingsPath),
                NullGameWindowLocator.Instance)
            {
                Diagnostics = lines.Add,
            };
            try
            {
                window.SetOverlayVisible(false);
                window.ApplyState(InGameState());

                // Deduped to one line per transition, so do not clear between
                // the two calls above — the token is emitted exactly once.
                Assert.Contains(lines, line => line.Contains("overlay-hidden", StringComparison.Ordinal));
                Assert.DoesNotContain(lines, line => line.Contains("no-display", StringComparison.Ordinal));
                Assert.False(window.IsDrawingHighlight);
            }
            finally
            {
                window.Close();
                if (File.Exists(settingsPath)) File.Delete(settingsPath);
            }
        });
    }

    /// <summary>
    /// With no game window the overlay must behave exactly as 1.0.7 did, and
    /// must say which monitor it landed on.
    /// </summary>
    [Fact]
    public void Without_a_game_window_the_overlay_resolves_and_names_its_own_monitor()
    {
        RunOnSta(() =>
        {
            var settingsPath = Path.Combine(Path.GetTempPath(), $"coachbuild-test-{Guid.NewGuid():N}.json");
            var lines = new List<string>();
            var window = new OverlayWindow(
                new OverlaySettingsStore(settingsPath),
                NullGameWindowLocator.Instance)
            {
                Diagnostics = lines.Add,
            };
            try
            {
                window.SetOverlayVisible(true);
                window.ShowInactive();
                lines.Clear();
                window.ApplyState(InGameState());

                Assert.NotNull(window.CurrentDisplay);
                Assert.Equal(OverlayDisplayResolver.SelfSource, window.DisplaySource);
                var highlight = Assert.Single(
                    lines.Where(line => line.Contains("highlight ", StringComparison.Ordinal)));
                // The monitor identity is the whole point: without it, a render
                // on the wrong screen is indistinguishable from a healthy one.
                Assert.Contains("source=self", highlight, StringComparison.Ordinal);
                Assert.Contains(window.CurrentDisplay!.DeviceName, highlight, StringComparison.Ordinal);
                Assert.True(window.IsDrawingHighlight);
            }
            finally
            {
                window.Close();
                if (File.Exists(settingsPath)) File.Delete(settingsPath);
            }
        });
    }

    /// <summary>
    /// 1.0.7 regression guard: the adjust-mode display must not be re-resolved
    /// under the user, because the working calibration is keyed to it.
    /// </summary>
    [Fact]
    public void An_in_progress_adjustment_keeps_its_display()
    {
        RunOnSta(() =>
        {
            var settingsPath = Path.Combine(Path.GetTempPath(), $"coachbuild-test-{Guid.NewGuid():N}.json");
            var window = new OverlayWindow(
                new OverlaySettingsStore(settingsPath),
                NullGameWindowLocator.Instance);
            try
            {
                window.ShowInactive();
                window.BeginAdjustment();
                var display = window.CurrentDisplay;
                Assert.True(window.IsAdjusting);

                var ensure = typeof(OverlayWindow).GetMethod(
                    "EnsureDisplay",
                    BindingFlags.NonPublic | BindingFlags.Instance)!;
                Assert.True((bool)ensure.Invoke(window, null)!);

                Assert.Same(display, window.CurrentDisplay);
            }
            finally
            {
                window.CancelAdjustment();
                window.Close();
                if (File.Exists(settingsPath)) File.Delete(settingsPath);
            }
        });
    }

    private static OverlayState InGameState() => new(
        InGame: true,
        ChampionName: "Ahri",
        ChampionId: 103,
        Level: 1,
        AbilityRanks: new Dictionary<CoachBuild.Desktop.Overlay.OverlayAbility, int>
        {
            [CoachBuild.Desktop.Overlay.OverlayAbility.Q] = 0,
            [CoachBuild.Desktop.Overlay.OverlayAbility.W] = 0,
            [CoachBuild.Desktop.Overlay.OverlayAbility.E] = 0,
            [CoachBuild.Desktop.Overlay.OverlayAbility.R] = 0,
        },
        SkillOrder: new CoachBuild.Desktop.Overlay.OverlaySkillOrder(
            new[]
            {
                CoachBuild.Desktop.Overlay.OverlayAbility.Q,
                CoachBuild.Desktop.Overlay.OverlayAbility.W,
                CoachBuild.Desktop.Overlay.OverlayAbility.E,
            },
            ObservedLevels: 3,
            Completed: false),
        Lane: "MID",
        IsLaneAuto: false);

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
}
