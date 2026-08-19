using System.Runtime.InteropServices;
using CoachBuild.Core;
using ThreadingTimer = System.Threading.Timer;

namespace CoachBuild.Desktop.Overlay;

/// <summary>
/// Polls the player's own shop bind and drives <see cref="ShopVisibilityLatch"/>.
///
/// <para><b>A watcher, never a grabber.</b> The obvious way to notice a key is
/// <c>RegisterHotKey</c>, and it is the wrong one here: a registered hotkey is
/// EXCLUSIVE — Windows delivers it to the registering window and the foreground
/// application never sees the keystroke at all. Registering the player's shop
/// bind would therefore stop that key from opening their shop, which is the
/// precise opposite of the feature. This class only ever READS key state; it
/// consumes nothing, blocks nothing, and injects nothing.</para>
///
/// <para><b>Why not a low-level keyboard hook.</b> <c>WH_KEYBOARD_LL</c> would
/// also pass the key through, but it is a global input hook installed into
/// every process's input path — a far larger and more intrusive surface than
/// reading a key's state, for no additional information. 1.0.15 already ruled
/// low-level hooks out of this codebase on evidence, and nothing here needs
/// them.</para>
///
/// <para><b>Cost, re-measured on this machine 2026-08-19.</b> The six
/// <c>GetAsyncKeyState</c> calls one tick makes: <b>0.0023 ms</b> mean over
/// 20,000 samples. <c>GetForegroundWindow</c> +
/// <c>GetWindowThreadProcessId</c>: <b>0.0009 ms</b> over 20,000. At the 50 ms
/// tick below that is <b>0.046 ms of work per second of play</b> — 0.005% of
/// one core. The alternative that was considered and rejected, one
/// <c>BitBlt</c> from the screen DC, measured <b>16.65 ms for a single
/// pixel</b> (300 samples) — a full 60 Hz frame of blocking per sample, and
/// 333 ms per second of play at this cadence.</para>
///
/// <para>The timer runs on a thread-pool thread, not the WPF dispatcher: the
/// dispatcher already carries the 750 ms render tick, and 1.0.9's perf work
/// exists because a periodic blocking call had been put on it.</para>
/// </summary>
public sealed class ShopKeyWatcher : IDisposable
{
    /// <summary>
    /// 50 ms. Short enough that an ordinary key tap (80–150 ms) cannot fall
    /// between two samples, long enough that the poll is free. The low bit of
    /// <c>GetAsyncKeyState</c> would make edge detection interval-independent,
    /// but Microsoft documents it as unreliable when more than one process is
    /// calling it, so the high bit plus a short interval is used instead.
    /// </summary>
    public const int PollIntervalMs = 50;

    private const int VkShift = 0x10;
    private const int VkControl = 0x11;
    private const int VkMenu = 0x12;

    private readonly ResolvedShopBinds _binds;
    private readonly Func<uint, bool> _isKeyDown;
    private readonly Func<bool> _leagueIsForeground;
    private readonly ShopVisibilityLatch _latch = new();
    private readonly object _gate = new();

    // A SECOND lock, held only across sample-and-observe.
    //
    // Tick() has two callers: the 50 ms timer thread and SetInGame, which runs
    // on whichever thread noticed the phase change (in production, the WPF
    // dispatcher). ShopVisibilityLatch is a plain mutable state machine, so two
    // concurrent Observe calls can interleave their edge bookkeeping and lose or
    // invent a press. It is deliberately not _gate: _gate is also held while
    // Dispose runs, and event handlers must never be invoked under it.
    private readonly object _tickGate = new();
    private ThreadingTimer? _timer;
    private bool _inGame;
    private bool _disposed;

    public ShopKeyWatcher(
        ResolvedShopBinds binds,
        Func<uint, bool>? isKeyDown = null,
        Func<bool>? leagueIsForeground = null)
    {
        _binds = binds ?? throw new ArgumentNullException(nameof(binds));
        _isKeyDown = isKeyDown ?? IsKeyDownNative;
        _leagueIsForeground = leagueIsForeground ?? (() => false);
    }

    /// <summary>Raised whenever the latch's verdict CHANGES. Not raised per tick.</summary>
    public event Action<ShopLatchState>? ShopVisibilityChanged;

    /// <summary>One line per change, for <c>companion.log</c>.</summary>
    public Action<string>? Diagnostics { get; set; }

    public bool IsShopOpen => _latch.IsOpen;

    public ShopVisibilityLatch Latch => _latch;

    public ResolvedShopBinds Binds => _binds;

    public void Start()
    {
        lock (_gate)
        {
            if (_disposed || _timer is not null) return;
            _timer = new ThreadingTimer(_ => Tick(), null, PollIntervalMs, PollIntervalMs);
        }
    }

    /// <summary>
    /// Tells the watcher whether a live game is running. Leaving a game resets
    /// the latch outright rather than merely closing it, so nothing about one
    /// match can survive into the next.
    /// </summary>
    public void SetInGame(bool inGame)
    {
        lock (_gate)
        {
            if (_inGame == inGame) return;
            _inGame = inGame;
        }

        Tick();
    }

    /// <summary>
    /// One poll, synchronously, exactly as the timer would run it.
    ///
    /// <para>The test seam for the whole watcher. Driving it by toggling
    /// <see cref="SetInGame"/> does not work and is worse than useless: leaving
    /// a game RESETS the latch, so a test that forces ticks that way silently
    /// erases the chat and key state it is trying to assert about, and passes
    /// or fails for the wrong reason. The alternative is sleeping past the
    /// 50 ms timer, and a sleeping test is a flaky one.</para>
    /// </summary>
    public void Poll() => Tick();

    /// <summary>
    /// Reads the current keyboard and foreground state. Separated from
    /// <see cref="Tick"/> so the composition — which keys, which modifiers,
    /// which gate — is testable without a timer, a keyboard, or a game.
    /// </summary>
    public ShopObservation Sample(bool inGame)
    {
        var foreground = false;
        try { foreground = _leagueIsForeground(); }
        catch { foreground = false; }

        return new ShopObservation(
            InGame: inGame,
            LeagueForeground: foreground,
            ShopKeyDown: _binds.Shop.Any(IsBindDown),
            CloseKeyDown: IsBindDown(_binds.Close),
            ChatKeyDown: IsBindDown(_binds.Chat));
    }

    /// <summary>
    /// Whether one accelerator is held, modifiers included.
    ///
    /// <para>Modifiers are matched EXACTLY, not as a minimum. League treats
    /// <c>[1]</c> and <c>[Shift][1]</c> as two different binds — its own
    /// <c>input.ini</c> carries both — so an unmodified shop bind must not fire
    /// while Shift is held, or every smart-cast press would toggle the
    /// latch.</para>
    /// </summary>
    public bool IsBindDown(LeagueKeybind bind)
    {
        if (!bind.IsResolved) return false;
        if (!_isKeyDown(bind.VirtualKey)) return false;
        return _isKeyDown(VkControl) == bind.Ctrl
            && _isKeyDown(VkShift) == bind.Shift
            && _isKeyDown(VkMenu) == bind.Alt;
    }

    private void Tick()
    {
        bool inGame;
        lock (_gate)
        {
            if (_disposed) return;
            inGame = _inGame;
        }

        ShopLatchState state;
        int toggles;
        int suppressed;
        lock (_tickGate)
        {
            try { state = _latch.Observe(Sample(inGame)); }
            catch { return; }
            toggles = _latch.Toggles;
            suppressed = _latch.SuppressedByChat;
        }

        // A suppressed edge is reported even though the verdict did not change.
        // Without this the chat gate is a branch that can never appear in a log:
        // suppression means "the latch did NOT flip", so a Changed-only report
        // is silent on exactly the case the gate exists for, and the player who
        // says "I press my key and nothing happens" gets an empty log either
        // way.
        if (state.SuppressedByChatNow)
        {
            Diagnostics?.Invoke(
                $"shop: your shop key was ignored - League's chat looks open"
                + $" ({suppressed} so far this game; press Enter or Esc to leave chat,"
                + $" or use the tray item to show the numbers)");
        }

        if (!state.Changed) return;
        Diagnostics?.Invoke(
            $"shop: {(state.Open ? "open" : "closed")} ({state.Reason};"
            + $" {toggles} toggle(s), {suppressed} ignored while chatting)");
        ShopVisibilityChanged?.Invoke(state);
    }

    public void Dispose()
    {
        ThreadingTimer? timer;
        lock (_gate)
        {
            if (_disposed) return;
            _disposed = true;
            timer = _timer;
            _timer = null;
        }

        timer?.Dispose();
    }

    private static bool IsKeyDownNative(uint virtualKey) => (GetAsyncKeyState((int)virtualKey) & 0x8000) != 0;

    [DllImport("user32.dll")]
    private static extern short GetAsyncKeyState(int vKey);
}

/// <summary>
/// "Is League the window the player is currently looking at?" — the gate that
/// stops a key pressed in any other application from reaching the latch.
///
/// <para>Compared by PROCESS, not by window handle: League can own more than
/// one top-level window, and a handle comparison would read a legitimate
/// in-game foreground as "not League".</para>
/// </summary>
public sealed class LeagueForegroundProbe
{
    private readonly IGameWindowLocator _gameWindows;

    public LeagueForegroundProbe(IGameWindowLocator gameWindows)
    {
        _gameWindows = gameWindows ?? throw new ArgumentNullException(nameof(gameWindows));
    }

    public bool IsLeagueForeground()
    {
        try
        {
            var gameHandle = _gameWindows.FindGameWindow();
            if (gameHandle == 0) return false;
            var foreground = GetForegroundWindow();
            if (foreground == 0) return false;
            if (foreground == gameHandle) return true;
            GetWindowThreadProcessId(gameHandle, out var gamePid);
            GetWindowThreadProcessId(foreground, out var foregroundPid);
            return gamePid != 0 && gamePid == foregroundPid;
        }
        catch
        {
            return false;
        }
    }

    [DllImport("user32.dll")]
    private static extern nint GetForegroundWindow();

    [DllImport("user32.dll")]
    private static extern int GetWindowThreadProcessId(nint hWnd, out int processId);
}
