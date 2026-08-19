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
/// <para><b>Cost, measured on the reference machine.</b> Four
/// <c>GetAsyncKeyState</c> calls: <b>0.0017 ms</b>.
/// <c>GetForegroundWindow</c> + <c>GetWindowThreadProcessId</c>:
/// <b>0.0001 ms</b>. At the 50 ms tick below that is about 0.04 ms of work per
/// second of play — roughly 0.004% of one core. The alternative that was
/// considered and rejected, one <c>BitBlt</c> from the screen DC, measured
/// <b>16.67 ms</b> per read at ANY size, which is a full 60 Hz frame of
/// blocking per sample.</para>
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
        try { state = _latch.Observe(Sample(inGame)); }
        catch { return; }

        if (!state.Changed) return;
        Diagnostics?.Invoke(
            $"shop: {(state.Open ? "open" : "closed")} ({state.Reason};"
            + $" {_latch.Toggles} toggle(s), {_latch.SuppressedByChat} ignored while chatting)");
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
