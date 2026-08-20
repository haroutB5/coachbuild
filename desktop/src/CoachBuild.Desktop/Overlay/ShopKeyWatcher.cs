using System.Diagnostics;
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

    // NOT readonly. The binds are resolved from League's config, and that
    // resolution can fail at app start for reasons that stop being true later:
    // the app autostarts at login, and this tray app then runs for days. A
    // resolution that fell back to League's default P at 07:00 used to mean the
    // watcher polled P until the machine was rebooted, however many games were
    // played on the player's real bind in between. See UpdateBinds.
    private ResolvedShopBinds _binds;
    private readonly Func<uint, bool> _isKeyDown;
    private readonly Func<bool> _leagueIsForeground;

    /// <summary>
    /// MONOTONIC, not wall-clock. The latch expires a stale chat belief off
    /// this, and a clock that can step backwards (NTP, DST, the user setting
    /// the time) would either expire a belief the instant it was formed or
    /// never expire one at all.
    /// </summary>
    private readonly Func<TimeSpan> _uptime;

    private readonly ShopVisibilityLatch _latch;
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

    /// <param name="chatGateEnabled">
    /// Whether a shop-key press may be swallowed because League's chat input
    /// looks focused. Positional and required, not an optional trailing flag:
    /// the shipped default is OFF, and an optional one would let every fixture
    /// keep testing the configuration nobody runs.
    /// </param>
    public ShopKeyWatcher(
        ResolvedShopBinds binds,
        bool chatGateEnabled,
        Func<uint, bool>? isKeyDown = null,
        Func<bool>? leagueIsForeground = null,
        Func<TimeSpan>? uptime = null)
    {
        _latch = new ShopVisibilityLatch(chatGateEnabled);
        _binds = binds ?? throw new ArgumentNullException(nameof(binds));
        _isKeyDown = isKeyDown ?? IsKeyDownNative;
        _leagueIsForeground = leagueIsForeground ?? (() => false);
        var started = Stopwatch.StartNew();
        _uptime = uptime ?? (() => started.Elapsed);
    }

    /// <summary>
    /// League's ALL-CHAT accelerator, derived from the chat bind rather than
    /// resolved separately: it is the SAME key with Shift held, and
    /// <c>input.ini</c> carries no entry for either (see
    /// <see cref="ShopBindResolver"/>'s "Escape and Enter are constants").
    ///
    /// <para>It has to be watched explicitly because
    /// <see cref="IsBindDown"/> matches modifiers EXACTLY, which is right for
    /// Alt+Enter (League's fullscreen toggle, which opens no chat) and wrong
    /// for Shift+Enter (which opens the same chat input the plain bind does).
    /// Seeing only one of the two is what let the belief invert and strand a
    /// player for a whole game.</para>
    /// </summary>
    public static LeagueKeybind AllChatBind(LeagueKeybind chat) =>
        chat with { Shift = true, Display = $"Shift+{chat.Display}" };

    /// <summary>Raised whenever the latch's verdict CHANGES. Not raised per tick.</summary>
    public event Action<ShopLatchState>? ShopVisibilityChanged;

    /// <summary>One line per change, for <c>companion.log</c>.</summary>
    public Action<string>? Diagnostics { get; set; }

    public bool IsShopOpen => _latch.IsOpen;

    public ShopVisibilityLatch Latch => _latch;

    public ResolvedShopBinds Binds
    {
        get { lock (_tickGate) return _binds; }
    }

    /// <summary>
    /// Replaces the keys being polled, mid-session.
    ///
    /// <para>Taken under <c>_tickGate</c> so a swap cannot land between the two
    /// halves of one <see cref="Sample"/> and produce an observation that is
    /// half one bind and half the other — which the latch would read as a key
    /// edge and act on.</para>
    /// </summary>
    public void UpdateBinds(ResolvedShopBinds binds)
    {
        ArgumentNullException.ThrowIfNull(binds);
        lock (_tickGate) _binds = binds;
    }

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
            ChatKeyDown: IsBindDown(_binds.Chat),
            ChatAllKeyDown: IsBindDown(AllChatBind(_binds.Chat)),
            At: _uptime());
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
        int bypassed;
        lock (_tickGate)
        {
            try { state = _latch.Observe(Sample(inGame)); }
            catch { return; }
            toggles = _latch.Toggles;
            suppressed = _latch.SuppressedByChat;
            bypassed = _latch.ChatGateBypassed;
        }

        // A suppressed edge is reported even though the verdict did not change.
        // Without this the chat gate is a branch that can never appear in a log:
        // suppression means "the latch did NOT flip", so a Changed-only report
        // is silent on exactly the case the gate exists for, and the player who
        // says "I press my key and nothing happens" gets an empty log either
        // way.
        // The belief itself, one line per transition. Four identical
        // "your key was ignored" lines and NOTHING about when the watcher came
        // to believe chat was open is what made the 2026-08-19 incident
        // undiagnosable from the log alone.
        if (state.ChatNote is { } note) Diagnostics?.Invoke($"shop: {note}");

        if (state.SuppressedByChatNow)
        {
            Diagnostics?.Invoke(
                $"shop: your shop key was ignored - League's chat looks open"
                + $" ({suppressed} so far this game; press your shop key again to override,"
                + $" or Enter/Esc to leave chat)");
        }

        if (!state.Changed) return;

        // THE HONOURED-PRESS LINE, and it is the one this feature is read
        // through. A press that WORKS always changes the verdict, so it always
        // lands here - but until 1.0.18 it said nothing about the gate, so a
        // log full of nothing was equally consistent with "the gate ate them
        // all" and "the watcher never saw the key". The gate's state is on
        // every line now, and so is the count of presses honoured while chat
        // looked open, which is the number that says whether the gate would
        // have been right.
        Diagnostics?.Invoke(
            $"shop: {(state.Open ? "open" : "closed")} ({state.Reason};"
            + $" {toggles} toggle(s), {suppressed} ignored while chatting,"
            + $" {bypassed} honoured while chat looked open,"
            + $" chat gate {(_latch.ChatGateEnabled ? "on" : "off")})");
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
