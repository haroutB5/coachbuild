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

    private static IReadOnlyList<nint> FindMainWindows(string processName)
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

    [DllImport("user32.dll")]
    private static extern bool IsWindow(nint hWnd);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(nint hWnd);
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
