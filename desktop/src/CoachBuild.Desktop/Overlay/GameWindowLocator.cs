using System.Diagnostics;
using System.Runtime.InteropServices;

namespace CoachBuild.Desktop.Overlay;

/// <summary>
/// Finds the window the game is drawing into, so the overlay can be placed on
/// the monitor the player is actually looking at.
/// </summary>
public interface IGameWindowLocator
{
    /// <summary>The game's main window handle, or 0 when it is not running.</summary>
    nint FindGameWindow();
}

/// <summary>Always reports "no game window" — the inert default for tests and headless hosts.</summary>
public sealed class NullGameWindowLocator : IGameWindowLocator
{
    public static NullGameWindowLocator Instance { get; } = new();

    public nint FindGameWindow() => 0;
}

/// <summary>
/// Locates <c>League of Legends.exe</c>'s main window.
///
/// <para>Why this exists: <c>DisplayDpiService.GetDisplayForWindow</c> was
/// only ever asked about the OVERLAY's own HWND, which Windows places on the
/// primary monitor at first Show(). On a multi-monitor desk where League runs
/// on the secondary, the overlay drew a perfectly correct highlight on the
/// wrong screen and logged <c>highlight Q at … visible=True</c> while doing
/// it — the log looked healthy and the user saw nothing. Nothing in 1.0.7 ever
/// asked where League was.</para>
///
/// <para>The process scan is cached: it costs a process-table walk, and
/// <c>EnsureDisplay</c> runs on the 750 ms render tick.</para>
/// </summary>
public sealed class LeagueGameWindowLocator : IGameWindowLocator
{
    // "League of Legends.exe" is the game client. The launcher
    // (LeagueClient.exe) is deliberately NOT here: it is not what the overlay
    // has to sit on top of, and following it would move the overlay to the
    // launcher's monitor mid-game.
    private const string GameProcessName = "League of Legends";

    private readonly Func<string, IReadOnlyList<nint>> _mainWindows;
    private readonly Func<nint, bool> _isWindow;
    private readonly TimeProvider _time;
    private readonly TimeSpan _rescanAfter;
    private readonly object _gate = new();
    private nint _cached;
    private DateTimeOffset _scannedAt = DateTimeOffset.MinValue;

    public LeagueGameWindowLocator(
        Func<string, IReadOnlyList<nint>>? mainWindows = null,
        Func<nint, bool>? isWindow = null,
        TimeProvider? timeProvider = null,
        TimeSpan? rescanAfter = null)
    {
        _mainWindows = mainWindows ?? FindMainWindows;
        _isWindow = isWindow ?? (handle => IsWindow(handle) && IsWindowVisible(handle));
        _time = timeProvider ?? TimeProvider.System;
        _rescanAfter = rescanAfter ?? TimeSpan.FromSeconds(5);
    }

    public nint FindGameWindow()
    {
        lock (_gate)
        {
            var now = _time.GetUtcNow();
            if (_cached != 0 && now - _scannedAt < _rescanAfter && _isWindow(_cached))
                return _cached;

            _scannedAt = now;
            _cached = 0;
            foreach (var handle in _mainWindows(GameProcessName))
            {
                if (handle == 0 || !_isWindow(handle)) continue;
                _cached = handle;
                break;
            }

            return _cached;
        }
    }

    /// <summary>
    /// The one process-table walk in the app. Shared with
    /// <see cref="DeferredGameWindowLocator"/> so the two locators can differ in
    /// WHEN they scan without ever differing in WHAT a scan returns.
    /// </summary>
    internal static IReadOnlyList<nint> FindMainWindows(string processName)
    {
        Process[] processes;
        try
        {
            processes = Process.GetProcessesByName(processName);
        }
        catch
        {
            // A denied process query must never take the render tick down.
            return Array.Empty<nint>();
        }

        var handles = new List<nint>(processes.Length);
        foreach (var process in processes)
        {
            try
            {
                var handle = process.MainWindowHandle;
                if (handle != 0) handles.Add(handle);
            }
            catch
            {
                // Elevated or exiting process: skip it, keep the others.
            }
            finally
            {
                process.Dispose();
            }
        }

        return handles;
    }

    internal static bool IsLiveWindow(nint handle) => IsWindow(handle) && IsWindowVisible(handle);

    [DllImport("user32.dll")]
    private static extern bool IsWindow(nint hWnd);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(nint hWnd);
}

/// <summary>
/// <see cref="LeagueGameWindowLocator"/>'s answer, computed off the caller's
/// thread. This is what the overlay uses; the synchronous locator above is kept
/// as the reference implementation the equivalence tests compare against.
///
/// <para><b>Why (measured, 1.0.9).</b> <c>FindGameWindow</c> is reached from
/// <c>OverlayWindow.EnsureDisplay</c>, which runs on the WPF dispatcher inside
/// the 750 ms render tick. Its scan is <c>Process.GetProcessesByName</c> — an
/// <c>NtQuerySystemInformation</c> walk of every process on the box (353 on the
/// bench). Interleaved A/B over 20 calls at the production 3 s cadence:
/// <b>8.924 ms mean / 9.107 ms median / 197.3 ms of UI-thread time per minute</b>
/// for the synchronous locator, against <b>0.272 ms / 0.002 ms / 15.0 ms</b> for
/// this one. All of that was spent recomputing a window handle that changes at
/// most once per match.</para>
///
/// <para><b>It moves when the answer is computed, never what it is.</b>
/// <list type="bullet">
/// <item>The <b>first</b> resolve is synchronous, so 1.0.8's "the overlay lands
/// on League's monitor straight away" is unchanged at the one moment it
/// matters.</item>
/// <item>Every later refresh is single-flighted onto the thread pool and the
/// caller is served the last known handle — which is already up to
/// <c>rescanAfter</c> stale today.</item>
/// <item>A handle that has stopped being a window is dropped
/// <b>synchronously</b> (<c>IsWindow</c>/<c>IsWindowVisible</c> are cheap), so a
/// closed game window still degrades to the own-HWND path within one tick,
/// exactly as before.</item>
/// </list></para>
///
/// <para><b>The one accepted regression.</b> A game window that MOVES to another
/// monitor is picked up on the render tick after the background scan lands
/// rather than on the tick that triggered it — worst case one extra
/// <c>DisplayRecheckMs</c> (3 s) on top of the existing 5 s scan cache. Asserted
/// by <c>A_changed_process_table_is_served_one_call_late_and_never_wrong</c> so
/// it is a stated cost, not a surprise.</para>
/// </summary>
public sealed class DeferredGameWindowLocator : IGameWindowLocator
{
    private const string GameProcessName = "League of Legends";

    private readonly Func<string, IReadOnlyList<nint>> _mainWindows;
    private readonly Func<nint, bool> _isWindow;
    private readonly Func<Action, Task> _schedule;
    private readonly TimeProvider _time;
    private readonly TimeSpan _rescanAfter;
    private nint _cached;
    private long _scannedAtUtcTicks;
    private int _refreshing;
    private int _backgroundScans;
    private bool _resolvedOnce;
    private Task _pendingRefresh = Task.CompletedTask;

    public DeferredGameWindowLocator(
        Func<string, IReadOnlyList<nint>>? mainWindows = null,
        Func<nint, bool>? isWindow = null,
        TimeProvider? timeProvider = null,
        TimeSpan? rescanAfter = null,
        Func<Action, Task>? schedule = null)
    {
        _mainWindows = mainWindows ?? LeagueGameWindowLocator.FindMainWindows;
        _isWindow = isWindow ?? LeagueGameWindowLocator.IsLiveWindow;
        _time = timeProvider ?? TimeProvider.System;
        _rescanAfter = rescanAfter ?? TimeSpan.FromSeconds(5);
        _schedule = schedule ?? (static work => Task.Run(work));
        _scannedAtUtcTicks = DateTimeOffset.MinValue.UtcTicks;
    }

    /// <summary>
    /// The most recently scheduled background scan. Exposed so a test can settle
    /// the locator deterministically instead of sleeping; production never reads
    /// it.
    /// </summary>
    public Task PendingRefresh => Volatile.Read(ref _pendingRefresh);

    /// <summary>
    /// How many scans have run off the caller's thread. This is the number that
    /// proves the walk actually left the dispatcher — a locator that quietly fell
    /// back to scanning inline would still return the right handle.
    /// </summary>
    public int BackgroundScans => Volatile.Read(ref _backgroundScans);

    public nint FindGameWindow()
    {
        if (!_resolvedOnce)
        {
            // Synchronous on purpose, and only ever once per locator: at first
            // Show() there is no previous answer to serve, and serving 0 would
            // put the overlay on the primary monitor until the first background
            // scan landed — the exact 1.0.7 defect 1.0.8 fixed.
            _resolvedOnce = true;
            Refresh();
            return Volatile.Read(ref _cached);
        }

        var cached = Volatile.Read(ref _cached);
        if (cached != 0 && !_isWindow(cached))
        {
            Interlocked.CompareExchange(ref _cached, 0, cached);
            cached = 0;
        }

        if (_time.GetUtcNow().UtcTicks - Volatile.Read(ref _scannedAtUtcTicks) >= _rescanAfter.Ticks)
            ScheduleRefresh();

        return cached;
    }

    private void ScheduleRefresh()
    {
        // Single-flight. Without this, a scan slower than the render tick would
        // stack one queued process-table walk per tick.
        if (Interlocked.CompareExchange(ref _refreshing, 1, 0) != 0) return;

        try
        {
            Volatile.Write(ref _pendingRefresh, _schedule(() =>
            {
                try
                {
                    Refresh();
                    Interlocked.Increment(ref _backgroundScans);
                }
                finally
                {
                    Volatile.Write(ref _refreshing, 0);
                }
            }));
        }
        catch
        {
            // The work item could not be queued at all. Release the flight so
            // the next tick retries rather than latching the locator on a stale
            // handle forever, and stay silent: this runs on the render tick.
            Volatile.Write(ref _refreshing, 0);
        }
    }

    private void Refresh()
    {
        nint found = 0;
        try
        {
            foreach (var handle in _mainWindows(GameProcessName))
            {
                if (handle == 0 || !_isWindow(handle)) continue;
                found = handle;
                break;
            }
        }
        catch
        {
            // A denied process query must never fault the thread pool.
            found = 0;
        }

        Volatile.Write(ref _cached, found);
        // Stamped even for a failed or empty scan, so a box where the walk
        // always fails cannot hot-loop one queued scan per render tick.
        Volatile.Write(ref _scannedAtUtcTicks, _time.GetUtcNow().UtcTicks);
    }
}

/// <summary>
/// The display-source decision and its log wording, split out of
/// <see cref="OverlayWindow"/> so both are assertable without a WPF window.
/// </summary>
public static class OverlayDisplayResolver
{
    public const string LeagueSource = "league";
    public const string SelfSource = "self";

    /// <summary>
    /// Which HWND the overlay's monitor should be resolved from. The game
    /// window wins whenever it exists; the overlay's own handle is the
    /// fallback and reproduces 1.0.7 behaviour exactly.
    /// </summary>
    public static (nint Handle, string Source) ChooseHandle(nint ownHandle, nint gameHandle)
    {
        return gameHandle != 0 ? (gameHandle, LeagueSource) : (ownHandle, SelfSource);
    }

    public static string Describe(DisplayInfo display, string source)
    {
        ArgumentNullException.ThrowIfNull(display);
        return $"{display.DeviceName} {display.Width}x{display.Height}@{display.DpiX} source={source}";
    }

    /// <summary>
    /// The line to log for a resolved display, or null when it has not changed.
    /// A monitor swap is called out explicitly: "highlight … visible=True" on
    /// the wrong screen is the single failure mode whose log looks healthiest.
    /// </summary>
    public static string? DescribeChange(DisplayInfo? previous, DisplayInfo current, string source)
    {
        ArgumentNullException.ThrowIfNull(current);
        if (previous is not null && previous == current) return null;

        var described = Describe(current, source);
        if (previous is null) return $"display {described}";
        return string.Equals(previous.DeviceName, current.DeviceName, StringComparison.Ordinal)
            ? $"display {described} (was {previous.Width}x{previous.Height}@{previous.DpiX})"
            : $"display {described} (moved from {previous.DeviceName})";
    }
}
