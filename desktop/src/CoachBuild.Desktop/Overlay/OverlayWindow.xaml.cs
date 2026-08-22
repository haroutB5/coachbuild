using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Shapes;
using CoachBuild.Core;
using WpfBrushes = System.Windows.Media.Brushes;
using WpfColor = System.Windows.Media.Color;
using WpfKeyEventArgs = System.Windows.Input.KeyEventArgs;

namespace CoachBuild.Desktop.Overlay;

public partial class OverlayWindow : Window
{
    private const int GwlExStyle = -20;
    private const int WsExTransparent = 0x20;
    private const int WsExNoActivate = 0x08000000;
    private const int WsExToolWindow = 0x80;
    private const int HWndTopMost = -1;
    private const int WmDpiChanged = 0x02E0;
    private const uint SwpNoActivate = 0x0010;
    private const uint SwpShowWindow = 0x0040;
    private const uint SwpNoSendChanging = 0x0400;

    private readonly OverlaySettingsStore _settingsStore;
    private readonly OverlayRenderer _renderer = new();
    private readonly DisplayDpiService _displayDpi = new();
    private readonly IGameWindowLocator _gameWindows;
    private OverlayState _state = OverlayState.Empty;
    private OverlaySettings _settings;
    private DisplayInfo? _display;
    private string _displaySource = OverlayDisplayResolver.SelfSource;
    private long _nextDisplayRecheckTicks;
    private CalibrationGeometry? _workingCalibration;

    // Whether the player actually MOVED the box this visit, as opposed to
    // merely opening adjust mode and pressing Enter.
    //
    // Not a cosmetic distinction, and it is kept from 1.0.19 deliberately: an
    // untouched default is a guess, not a calibration, and writing one as
    // though it were a measurement is what put the (now removed) item numbers
    // 210 px below their row in the field. The same rule is cheap here and
    // means "saved" in the log always describes a decision the player made.
    private bool _adjustMoved;

    private HwndSource? _hwndSource;
    private NativeBounds? _lastNativeBounds;
    private bool? _lastClickThrough;
    private bool _nativeWindowShown;
    private bool _interactive;
    private bool _adjusting;
    private bool _wasVisibleBeforeAdjustment;
    private int _topmostReassertTicks;
    private bool _disposed;
    private string? _lastOverlayReason;
    private string? _lastKitAnomaly;
    // Why the last clear happened, so `not-in-game` says whether the game
    // ended or the live feed died instead of being the same word for both.
    private string? _clearReason;

    /// <summary>
    /// Optional sink for one-line overlay render diagnostics (wired to the
    /// app's redacted log). Carries no player-identifying data — only the
    /// render decision, the ability letter and the on-screen rectangle.
    /// </summary>
    public Action<string>? Diagnostics { get; set; }

    /// <summary>
    /// Which game this is, when the host knows it. Pulled rather than pushed:
    /// the value is captured on the live-poll thread and read here on the
    /// render thread, so the host owns the lock.
    ///
    /// <para>Read only by <see cref="ReportKitAnomaly"/>, and only in the log.
    /// Nothing on screen depends on it and nothing player-identifying is in
    /// it.</para>
    /// </summary>
    public Func<LiveGameMode?>? GameMode { get; set; }

    // App projects snapshots every 750 ms. Reassert topmost only occasionally
    // so ordinary overlay ticks stay cheap while still recovering if another
    // window (notably exclusive fullscreen) pushes this HWND down the stack.
    private const int TopmostReassertEveryTicks = 10;

    // League can be alt-tabbed to another monitor mid-game, so the display has
    // to be re-derived periodically rather than latched at first Show(). This
    // is a process-table scan behind a cache, not a per-tick cost.
    private const long DisplayRecheckMs = 3000;

    public OverlayWindow(OverlaySettingsStore settingsStore, IGameWindowLocator? gameWindows = null)
    {
        _settingsStore = settingsStore ?? throw new ArgumentNullException(nameof(settingsStore));
        // Deferred, not LeagueGameWindowLocator: the scan behind this seam is a
        // full process-table walk and EnsureDisplay reaches it from the render
        // tick. Measured at 197.3 ms of UI-thread time per minute in 1.0.9
        // against 15.0 ms here, for the same answer.
        _gameWindows = gameWindows ?? new DeferredGameWindowLocator();
        _settings = _settingsStore.Read();
        InitializeComponent();
        SourceInitialized += OnSourceInitialized;
        KeyDown += OnKeyDown;
        Closed += OnClosed;
        _displayDpi.DisplayChanged += OnDisplayChanged;
    }

    public OverlayRenderer Renderer => _renderer;

    /// <summary>
    /// True when the last render decision was to draw a highlight. Read by the
    /// fullscreen advisor: a "you cannot see this" hint is only honest when
    /// there is something the user should be seeing.
    /// </summary>
    public bool IsDrawingHighlight { get; private set; }

    /// <summary>
    /// True when everything needed to draw a highlight is present for this
    /// game — in game, champion known, an order fetched, a monitor resolved and
    /// the overlay switched on — whether or not a point happens to be banked at
    /// this instant.
    ///
    /// <para>Split from <see cref="IsDrawingHighlight"/> in 1.0.12 because the
    /// two answer different questions and only one of them changed. The
    /// exclusive-fullscreen hint asks "should this user be seeing pixels from us
    /// at some point in this game"; the renderer asks "are there pixels on
    /// screen right now". Once the highlight became a brief per-level-up event,
    /// keeping the hint on the second question would have made it fire
    /// essentially never — the user would lose the one line that explains a
    /// permanently invisible overlay.</para>
    /// </summary>
    public bool HasRenderableSkillOrder { get; private set; }

    /// <summary>The monitor the overlay last resolved, for diagnostics.</summary>
    public DisplayInfo? CurrentDisplay => _display;

    /// <summary><c>league</c> when the monitor came from the game window, else <c>self</c>.</summary>
    public string DisplaySource => _displaySource;

    public OverlayState State => _state;

    public bool IsInteractive => _interactive;

    public bool IsAdjusting => _adjusting;

    /// <summary>
    /// The geometry adjust mode last drew at, in DIPs — the value
    /// <see cref="RenderAdjustment"/> actually used, not a re-derivation of it.
    ///
    /// <para>Exposed so a test can assert what the player was shown against a
    /// value the window actually used, rather than against a second copy of the
    /// same arithmetic.</para>
    /// </summary>
    public CalibrationGeometry? LastAdjustGeometry { get; private set; }

    public event Action<bool>? AdjustmentStateChanged;

    public bool OverlayVisibleSetting => _settings.OverlayVisible;

    public string? LaneOverrideSetting => _settings.LaneOverride;

    public void ApplyState(OverlayState state)
    {
        ArgumentNullException.ThrowIfNull(state);
        if (!Dispatcher.CheckAccess())
        {
            Dispatcher.BeginInvoke(() => ApplyState(state));
            return;
        }

        _state = state.Normalize();
        _clearReason = null;
        if (_adjusting) return;
        RenderCurrentState();
    }

    /// <summary>
    /// Drops the retained in-game state and hides. The ONLY correct response to
    /// "there is no live game any more", and stronger than
    /// <see cref="HideOverlay"/> on purpose.
    ///
    /// <para>ROOT CAUSE of the 1.0.11 field report "the pink box came back two
    /// minutes after the game ended". Hiding the window left <c>_state</c>
    /// holding the last in-game snapshot, and several paths re-render it
    /// later — a monitor change, and above all leaving adjust mode, which
    /// restored the pre-adjust visibility and repainted the stale highlight
    /// against a League that was no longer running (the user's log shows the
    /// give-away <c>source=self</c> on that line). Clearing the state means
    /// there is nothing left to resurrect no matter which path runs.</para>
    ///
    /// <para>Safe during adjustment: the state is cleared but the canvas is not
    /// touched, so the four alignment boxes the user is working with stay put.
    /// See <see cref="HideOverlay"/> for why that matters.</para>
    /// </summary>
    public void ClearForNoGame(string reason)
    {
        if (!Dispatcher.CheckAccess())
        {
            Dispatcher.BeginInvoke(() => ClearForNoGame(reason));
            return;
        }

        _state = OverlayState.Empty;
        _clearReason = string.IsNullOrWhiteSpace(reason) ? "no-game" : reason;
        _lastKitAnomaly = null;
        if (_adjusting) return;
        RenderCurrentState();
        Hide();
    }

    public void SetInteractive(bool interactive)
    {
        if (!Dispatcher.CheckAccess())
        {
            Dispatcher.BeginInvoke(() => SetInteractive(interactive));
            return;
        }

        _interactive = interactive;
        SetNativeClickThrough(!interactive);
        RootCanvas.IsHitTestVisible = interactive;
        IsHitTestVisible = interactive;
        Focusable = interactive;
        if (interactive) Focus();
        RenderCurrentState();
    }

    public void SetOverlayVisible(bool visible)
    {
        if (!Dispatcher.CheckAccess())
        {
            Dispatcher.BeginInvoke(() => SetOverlayVisible(visible));
            return;
        }

        _settings.OverlayVisible = visible;
        _settingsStore.SetOverlayVisible(visible);
        RenderCurrentState();
    }

    /// <summary>
    /// The ONLY hide path the 750 ms snapshot poll may use.
    ///
    /// ROOT CAUSE of "the pink boxes never show out of a game" (fixed here):
    /// adjust/calibrate mode shows this window and paints four pink alignment
    /// boxes, but the poll in App.ApplySnapshot called the raw
    /// <see cref="Window.Hide"/> on every tick where the phase was not
    /// InProgress. Out of a game that is EVERY tick, so the boxes the user had
    /// just opened were hidden again within at most 750 ms — reliably reading
    /// as "calibration does nothing". `_adjusting` was already honoured by
    /// ApplyState, RenderCurrentState, OnDisplayChanged and the DPI hook; the
    /// hide path was the single place that ignored it.
    ///
    /// The guard lives HERE, next to the `_adjusting` flag that owns it, rather
    /// than at the call site, so a future caller cannot reintroduce the bug by
    /// forgetting to re-derive the precondition.
    /// </summary>
    public void HideOverlay()
    {
        if (!Dispatcher.CheckAccess())
        {
            Dispatcher.BeginInvoke(HideOverlay);
            return;
        }

        if (_adjusting) return;
        Hide();
    }

    public void SetLaneOverride(string? lane)
    {
        if (!Dispatcher.CheckAccess())
        {
            Dispatcher.BeginInvoke(() => SetLaneOverride(lane));
            return;
        }

        _settings.LaneOverride = NormalizeLane(lane);
        _settingsStore.SetLaneOverride(_settings.LaneOverride);
        RenderCurrentState();
    }

    public void BeginCalibration() => BeginAdjustment();

    public void BeginAdjustment()
    {
        if (!Dispatcher.CheckAccess())
        {
            Dispatcher.BeginInvoke(BeginAdjustment);
            return;
        }

        if (_adjusting) return;

        _wasVisibleBeforeAdjustment = IsVisible;
        ShowInactive();
        if (_display is null)
        {
            // 1.0.15 §5.2: this exit used to be silent, which made "adjust mode
            // does nothing" indistinguishable from "adjust mode is broken".
            Diagnostics?.Invoke("overlay: adjust mode could not start — no monitor resolved (no-display)");
            if (!_wasVisibleBeforeAdjustment) Hide();
            _wasVisibleBeforeAdjustment = false;
            return;
        }

        _adjustMoved = false;
        _workingCalibration = _display is null
            ? CalibrationGeometry.Reference
            : _settingsStore.LoadCalibration(_display.Resolution);
        _adjusting = true;
        AdjustmentStateChanged?.Invoke(true);
        SetInteractive(true);
        Activate();
        Focus();
        Diagnostics?.Invoke($"overlay: adjust mode entered for {AdjustTargetName}");
        RenderAdjustment();
    }

    /// <summary>
    /// What the arrow keys are moving, in one place so the entry line, the save
    /// line and the on-screen heading cannot come to disagree.
    /// </summary>
    private const string AdjustTargetName = "the skill-order box";

    public void ShowInactive()
    {
        if (!Dispatcher.CheckAccess())
        {
            Dispatcher.BeginInvoke(ShowInactive);
            return;
        }

        if (!IsVisible) Show();
        if (!EnsureDisplay()) return;
        SetBoundsToDisplay();
        SetNativeClickThrough(!_interactive);
        if (_adjusting)
        {
            Activate();
            Focus();
        }
        else
        {
            RenderCurrentState();
        }
    }

    private void OnSourceInitialized(object? sender, EventArgs e)
    {
        var handle = new WindowInteropHelper(this).Handle;
        if (handle != 0)
        {
            _hwndSource = HwndSource.FromHwnd(handle);
            _hwndSource?.AddHook(WindowMessageHook);
        }

        // Do not resolve a display from a null HWND. The first real handle is
        // the first point at which Windows can report the monitor's DPI.
        _display = null;
        SetNativeClickThrough(clickThrough: true);
        EnsureDisplay();
        SetBoundsToDisplay();
    }

    /// <summary>
    /// Resolves the monitor the overlay must cover.
    ///
    /// <para>1.0.7 resolved it from the overlay's OWN handle and latched it
    /// forever. Windows puts a first-shown tool window on the primary monitor,
    /// so on a two-monitor desk with League on the secondary the overlay drew
    /// a correct highlight on the wrong screen and logged
    /// <c>highlight Q at … visible=True</c> while it did — the most
    /// deceptively healthy-looking failure in the whole matrix. Nothing ever
    /// asked where League was.</para>
    ///
    /// <para>The HWND requirement is unchanged: with no handle there is no
    /// monitor and no DPI, and the honest answer stays <c>no-display</c>.</para>
    /// </summary>
    private bool EnsureDisplay()
    {
        var handle = new WindowInteropHelper(this).Handle;
        if (handle == 0) return false;

        // Never move the ground out from under an in-progress adjustment: the
        // working calibration is keyed to the display it was opened against.
        if (_adjusting && _display is not null) return true;

        var now = Environment.TickCount64;
        if (_display is not null && now < _nextDisplayRecheckTicks) return true;
        _nextDisplayRecheckTicks = now + DisplayRecheckMs;

        nint gameHandle;
        try
        {
            gameHandle = _gameWindows.FindGameWindow();
        }
        catch
        {
            gameHandle = 0;
        }

        var (target, source) = OverlayDisplayResolver.ChooseHandle(handle, gameHandle);
        var resolved = _displayDpi.GetDisplayForWindow(target);
        var changed = OverlayDisplayResolver.DescribeChange(_display, resolved, source);
        var sourceChanged = !string.Equals(_displaySource, source, StringComparison.Ordinal);
        if (changed is not null || sourceChanged)
        {
            Diagnostics?.Invoke(
                $"overlay: {changed ?? $"display {OverlayDisplayResolver.Describe(resolved, source)}"}");
        }

        _display = resolved;
        _displaySource = source;
        return true;
    }

    private void SetBoundsToDisplay()
    {
        if (!EnsureDisplay() || _display is null) return;
        var scaleX = Math.Max(0.1d, _display.DpiX / 96d);
        var scaleY = Math.Max(0.1d, _display.DpiY / 96d);
        var left = _display.Left / scaleX;
        var top = _display.Top / scaleY;
        var width = _display.Width / scaleX;
        var height = _display.Height / scaleY;
        if (Math.Abs(Left - left) > 0.01d) Left = left;
        if (Math.Abs(Top - top) > 0.01d) Top = top;
        if (Math.Abs(Width - width) > 0.01d) Width = width;
        if (Math.Abs(Height - height) > 0.01d) Height = height;

        var handle = new WindowInteropHelper(this).Handle;
        if (handle == 0) return;
        var bounds = new NativeBounds(_display.Left, _display.Top, _display.Width, _display.Height);
        var sameBounds = _nativeWindowShown && _lastNativeBounds == bounds;
        var reassertTopmost = sameBounds && ++_topmostReassertTicks >= TopmostReassertEveryTicks;
        if (sameBounds && !reassertTopmost) return;
        if (reassertTopmost) _topmostReassertTicks = 0;

        var flags = SwpNoActivate | SwpNoSendChanging;
        if (!_nativeWindowShown && IsVisible) flags |= SwpShowWindow;
        if (SetWindowPos(handle, HWndTopMost, bounds.Left, bounds.Top, bounds.Width, bounds.Height, flags))
        {
            _lastNativeBounds = bounds;
            _nativeWindowShown = IsVisible;
            _topmostReassertTicks = 0;
        }
    }

    private void RenderCurrentState()
    {
        EnsureDisplay();
        if (!_settings.OverlayVisible)
        {
            // Split out of `no-display`, which used to mean BOTH "the tray has
            // the overlay switched off" and "the monitor could not be
            // resolved". The window is never shown when it is switched off, so
            // it has no HWND, so it reported a monitor failure — and the user
            // reading the log was hunting a display bug that did not exist.
            IsDrawingHighlight = false;
            HasRenderableSkillOrder = false;
            ReportOverlayReason("overlay-hidden (tray: Show overlay)");
            return;
        }
        if (_display is null)
        {
            IsDrawingHighlight = false;
            HasRenderableSkillOrder = false;
            ReportOverlayReason("no-display");
            return;
        }
        if (_adjusting) return;
        var renderState = _state with
        {
            Lane = _settings.LaneOverride ?? _state.Lane,
            IsLaneAuto = _settings.LaneOverride is null && _state.IsLaneAuto,
        };
        var physicalCalibration = _settingsStore.LoadCalibration(_display.Resolution);
        var dipCalibration = CalibrationGeometry.ForDpi(physicalCalibration, _display.DpiX, 96);
        _renderer.Render(RootCanvas, renderState, _settings, _display.Resolution, dipCalibration);
        var outcome = DescribeRenderOutcome(renderState, dipCalibration, _display);
        IsDrawingHighlight = outcome.StartsWith("highlight ", StringComparison.Ordinal);
        HasRenderableSkillOrder = renderState.HasRenderableData;
        ReportKitAnomaly(renderState);
        ReportOverlayReason(outcome);
    }

    /// <summary>
    /// Names a champion whose ranks do not add up against its level, once.
    ///
    /// <para>The highlight deliberately keeps drawing in that case (see
    /// <c>OverlayState.HasPointToSpend</c>), so nothing on screen would ever
    /// reveal the gap — this line is the only trace the defect leaves.</para>
    ///
    /// <para>The wording, and everything the line carries, lives in
    /// <see cref="KitAnomalyLine"/> so it can be pinned by a test without a
    /// message pump. It used to be built here, printed only the SUM of the
    /// ranks, and asserted a cause that turned out to be disproven; five of
    /// those lines from a real game could not be told apart from three
    /// different bugs. Read that type's remarks before changing this.</para>
    /// </summary>
    private void ReportKitAnomaly(OverlayState state)
    {
        if (!state.InGame || state.Points.Coherent)
        {
            _lastKitAnomaly = null;
            return;
        }

        var line = KitAnomalyLine.Format(
            state.ChampionName,
            state.ChampionId,
            state.Points,
            [
                state.Rank(OverlayAbility.Q),
                state.Rank(OverlayAbility.W),
                state.Rank(OverlayAbility.E),
                state.Rank(OverlayAbility.R),
            ],
            state.Kit,
            GameMode?.Invoke());
        if (string.Equals(_lastKitAnomaly, line, StringComparison.Ordinal)) return;
        _lastKitAnomaly = line;
        Diagnostics?.Invoke(line);
    }

    /// <summary>
    /// Why the highlight is or is not on screen, in one short token.
    ///
    /// Since v1.0.6 stripped the table, the disclaimer and every message
    /// surface, an overlay that decides to draw nothing is visually identical
    /// to an overlay that is broken — and it left no trace anywhere, so the
    /// only field report possible was "it does not work". This is the whole
    /// diagnostic surface for that decision; keep it cheap and keep it honest.
    /// </summary>
    private string DescribeRenderOutcome(
        OverlayState state,
        CalibrationGeometry geometry,
        DisplayInfo display)
    {
        if (!state.InGame) return _clearReason is { } why ? $"not-in-game ({why})" : "not-in-game";
        if (string.IsNullOrWhiteSpace(state.ChampionName)) return "no-champion";
        if (state.SkillOrder.Order.Count == 0) return "no-skill-order";
        // 1.0.12: the highlight is a prompt to spend a point, so it exists only
        // while there is one to spend. Levels and points spent are both on the
        // line because "waiting" with level 7 and 7 spent is normal, while
        // "waiting" with level 7 and 9 spent is a kit this build cannot count.
        var points = state.Points;
        if (!state.HasPointToSpend)
            return $"waiting-level-up (level {points.Level}, {points.Purchased} spent, 0 banked)";
        if (state.NextAbility() is not { } next)
            return $"no-next-ability (level {points.Level}, {points.Unspent} banked, order exhausted or capped)";
        var rect = geometry.GetAbilityRects()[(int)next];
        // The monitor identity is on this line because without it a healthy
        // render, a wrong-monitor render and an exclusive-fullscreen render are
        // character-for-character identical in the log.
        return $"highlight {next} at {rect.Left:0}x{rect.Top:0} size {rect.Width:0} visible={IsVisible}"
            + $" on {OverlayDisplayResolver.Describe(display, _displaySource)}";
    }

    /// <summary>
    /// Deduped to one line per transition.
    ///
    /// <para>Every hide is now an explicit <c>highlight hidden (…)</c> line.
    /// Through 1.0.11 the log had show events and no hide events at all, which
    /// is precisely why a highlight that outlived its game by two minutes left
    /// no trace: the last thing the file ever said was that it was on screen.</para>
    /// </summary>
    private void ReportOverlayReason(string reason)
    {
        if (string.Equals(reason, _lastOverlayReason, StringComparison.Ordinal)) return;
        var wasHighlighting = _lastOverlayReason?.StartsWith("highlight ", StringComparison.Ordinal) == true;
        var isHighlighting = reason.StartsWith("highlight ", StringComparison.Ordinal);
        _lastOverlayReason = reason;
        Diagnostics?.Invoke(wasHighlighting && !isHighlighting
            ? $"overlay: highlight hidden ({reason})"
            : $"overlay: {reason}");
    }

    private void OnDisplayChanged(object? sender, EventArgs e)
    {
        if (_disposed) return;
        Dispatcher.BeginInvoke(() =>
        {
            if (_disposed) return;
            _display = null;
            EnsureDisplay();
            SetBoundsToDisplay();
            if (_adjusting)
            {
                if (_display is not { } display)
                {
                    return;
                }

                // Re-derive, and drop the working copy: it was keyed to the
                // display that has just gone away.
                _adjustMoved = false;
                _workingCalibration = _settingsStore.LoadCalibration(display.Resolution);
                RenderAdjustment();
            }
            else
            {
                RenderCurrentState();
            }
        });
    }

    private void OnKeyDown(object sender, WpfKeyEventArgs e)
    {
        var step = Keyboard.Modifiers.HasFlag(ModifierKeys.Shift) ? 10 : 1;
        if (HandleAdjustKey(e.Key, step)) e.Handled = true;
    }

    /// <summary>
    /// One adjust-mode keypress, without a keyboard.
    ///
    /// <para>Split out of the WPF handler so the rule that decides what gets
    /// SAVED is testable. It is not a cosmetic rule: through 1.0.18 an adjust
    /// session that moved nothing still persisted an invented default as though
    /// it were a measurement. A guarantee about which keypresses count cannot
    /// be pinned by a test that has to synthesise <c>KeyEventArgs</c> against a
    /// live <c>PresentationSource</c>.</para>
    /// </summary>
    /// <returns>True when the key belonged to adjust mode and was consumed.</returns>
    public bool HandleAdjustKey(Key key, int step = 1)
    {
        if (!_adjusting || _workingCalibration is null) return false;
        var geometry = _workingCalibration;
        var handled = true;
        // Distinct from `handled`: Enter and Esc are handled and move nothing,
        // and a target that was never moved must never be saved.
        var moved = true;
        switch (key)
        {
            case Key.Left:
                geometry = geometry with { FirstBoxCenterX = geometry.FirstBoxCenterX - step };
                break;
            case Key.Right:
                geometry = geometry with { FirstBoxCenterX = geometry.FirstBoxCenterX + step };
                break;
            case Key.Up:
                geometry = geometry with { CenterY = geometry.CenterY - step };
                break;
            case Key.Down:
                geometry = geometry with { CenterY = geometry.CenterY + step };
                break;
            case Key.Add:
            case Key.OemPlus:
                geometry = geometry with { BoxSize = geometry.BoxSize + step };
                break;
            case Key.Subtract:
            case Key.OemMinus:
                geometry = geometry with { BoxSize = geometry.BoxSize - step };
                break;
            case Key.OemOpenBrackets:
                geometry = geometry with { Spacing = geometry.Spacing - step };
                break;
            case Key.OemCloseBrackets:
                geometry = geometry with { Spacing = geometry.Spacing + step };
                break;
            case Key.Enter:
            case Key.Escape:
                moved = false;
                break;
            default:
                handled = false;
                moved = false;
                break;
        }

        // The move is applied BEFORE Enter and Esc are dispatched, and `moved`
        // is the only thing standing between them. Leaving SaveAdjustment
        // inside the switch made this rule accidentally true — Enter turned
        // `_adjusting` off before the touch could be recorded — and a rule that
        // holds by accident is a rule the next edit silently removes. A
        // mutation that made Enter count as a move survived the whole suite for
        // exactly that reason.
        if (handled && moved)
        {
            _adjustMoved = true;
            _workingCalibration = geometry.Normalize();
            RenderAdjustment();
            return true;
        }

        if (key == Key.Enter) SaveAdjustment();
        else if (key == Key.Escape) CancelAdjustment();
        return handled;
    }

    private void SaveAdjustment()
    {
        if (!_adjusting || _display is null || _workingCalibration is null) return;

        // MOVED, not merely visited. Saving nothing is the honest outcome of
        // an adjust session in which nothing was adjusted: an untouched default
        // is a guess, and writing one as though the player had measured it is
        // exactly how the removed item-number row ended up 210 px below its
        // target in the field. The ability HUD's default is a real measurement,
        // so the cost of the rule here is nil and the meaning of "saved" in the
        // log stays honest.
        if (_adjustMoved)
        {
            var geometry = _workingCalibration;
            _settingsStore.SaveCalibration(_display.Resolution, geometry);
            Diagnostics?.Invoke(
                $"overlay: saved {AdjustTargetName} at {geometry.FirstBoxCenterX:0}x{geometry.CenterY:0}"
                + $" size {geometry.BoxSize:0} pitch {geometry.Spacing:0}"
                + $" for {_display.Resolution.Key}");
        }
        else
        {
            Diagnostics?.Invoke(
                "overlay: adjust mode saved nothing - the overlay was not moved."
                + " An untouched default is a guess, not a calibration, so it is not written."
                + " Use the arrow keys (Shift for x10), +/- for size and [/] for spacing,"
                + " then press Enter.");
        }

        _settings = _settingsStore.Read();
        _adjusting = false;
        _workingCalibration = null;
        _adjustMoved = false;
        AdjustmentStateChanged?.Invoke(false);
        SetInteractive(false);
        RestoreVisibilityAfterAdjustment();
    }

    public void CancelAdjustment()
    {
        if (!_adjusting) return;
        _adjusting = false;
        _workingCalibration = null;
        _adjustMoved = false;
        AdjustmentStateChanged?.Invoke(false);
        SetInteractive(false);
        RestoreVisibilityAfterAdjustment();
    }

    private void RestoreVisibilityAfterAdjustment()
    {
        // `_wasVisibleBeforeAdjustment` is a fact about the PAST. Adjust mode
        // has no time limit, and the user's 1.0.11 log has an adjust session
        // that outlived the game by two minutes: restoring on that flag alone
        // re-showed a highlight for a match that had already ended, on a
        // monitor League no longer occupied. Re-derive from the state as it is
        // NOW — App clears it the moment the game stops.
        var wasVisible = _wasVisibleBeforeAdjustment && _state.InGame;
        _wasVisibleBeforeAdjustment = false;
        // Adjust mode painted the canvas behind the renderer's back, so its
        // memoised signature no longer describes what is on screen. Without
        // this, cancelling an adjustment (which changes no state and no
        // calibration) left the four alignment boxes and the legend stranded
        // over the game. See OverlayRenderer.Invalidate.
        _renderer.Invalidate();
        if (!wasVisible)
        {
            Hide();
            return;
        }

        if (!IsVisible) ShowInactive();
        else RenderCurrentState();
    }

    private void RenderAdjustment()
    {
        if (_workingCalibration is null) return;
        RootCanvas.Children.Clear();
        var geometry = CalibrationGeometry.ForDpi(
            _workingCalibration.Normalize(),
            _display?.DpiX ?? 96,
            96);
        LastAdjustGeometry = geometry;

        foreach (var (rect, index) in geometry.GetAbilityRects().Select((rect, index) => (rect, index)))
        {
            var box = new Border
            {
                Width = rect.Width,
                Height = rect.Height,
                Background = new SolidColorBrush(WpfColor.FromArgb(55, 255, 47, 158)),
                BorderBrush = new SolidColorBrush(WpfColor.FromRgb(255, 47, 158)),
                BorderThickness = new Thickness(3),
                CornerRadius = new CornerRadius(8),
                Child = new TextBlock
                {
                    Text = ((OverlayAbility)index).ToString(),
                    Foreground = WpfBrushes.White,
                    FontWeight = FontWeights.Bold,
                    FontSize = 12,
                },
            };
            Canvas.SetLeft(box, rect.Left);
            Canvas.SetTop(box, rect.Top);
            RootCanvas.Children.Add(box);
        }

        var legend = new Border
        {
            Background = new SolidColorBrush(WpfColor.FromArgb(236, 8, 13, 28)),
            BorderBrush = new SolidColorBrush(WpfColor.FromRgb(79, 176, 224)),
            BorderThickness = new Thickness(1.5),
            CornerRadius = new CornerRadius(8),
            Padding = new Thickness(10, 7, 10, 7),
            Child = new TextBlock
            {
                Text = "Adjusting the skill-order box"
                    + "\nLine these up with your ability bar"
                    + "\nNothing is saved unless you actually move them"
                    + "\nEnter: save \u00b7 Esc: cancel"
                    + "\nArrow keys: move \u00b7 Shift: \u00d710 \u00b7 +/-: size \u00b7 [/]: spacing",
                Foreground = WpfBrushes.White,
                FontSize = 11,
            },
        };
        Canvas.SetLeft(legend, geometry.FirstBoxCenterX + 1.5 * geometry.Spacing);
        Canvas.SetTop(legend, Math.Max(4, geometry.CenterY - geometry.BoxSize / 2 - 80));
        RootCanvas.Children.Add(legend);
    }

    private void SetNativeClickThrough(bool clickThrough)
    {
        var handle = new WindowInteropHelper(this).Handle;
        if (handle == 0) return;
        if (_lastClickThrough == clickThrough) return;

        var style = GetWindowLongPtr(handle, GwlExStyle).ToInt64();
        var nextStyle = style | WsExToolWindow;
        if (clickThrough)
        {
            nextStyle |= WsExNoActivate | WsExTransparent;
        }
        else
        {
            nextStyle &= ~(WsExNoActivate | WsExTransparent);
        }

        if (nextStyle != style) SetWindowLongPtr(handle, GwlExStyle, new nint(nextStyle));
        _lastClickThrough = clickThrough;
    }

    private static string? NormalizeLane(string? lane)
    {
        if (string.IsNullOrWhiteSpace(lane)) return null;
        var value = lane.Trim().ToUpperInvariant();
        return value is "TOP" or "JUNGLE" or "MID" or "BOT" or "SUPPORT" ? value : null;
    }

    private void OnClosed(object? sender, EventArgs e)
    {
        if (_disposed) return;
        _disposed = true;
        _hwndSource?.RemoveHook(WindowMessageHook);
        _hwndSource = null;
        _displayDpi.Dispose();
        GC.SuppressFinalize(this);
    }

    private nint WindowMessageHook(
        nint hwnd,
        int message,
        nint wParam,
        nint lParam,
        ref bool handled)
    {
        if (message == WmDpiChanged && !_disposed)
        {
            _display = null;
            Dispatcher.BeginInvoke(() =>
            {
                if (_disposed) return;
                EnsureDisplay();
                SetBoundsToDisplay();
                if (_adjusting)
                {
                    _adjustMoved = false;
                    _workingCalibration = _display is null
                        ? null
                        : _settingsStore.LoadCalibration(_display.Resolution);
                    RenderAdjustment();
                }
                else
                {
                    RenderCurrentState();
                }
            });
        }

        return 0;
    }

    private readonly record struct NativeBounds(int Left, int Top, int Width, int Height);

    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")]
    private static extern nint GetWindowLongPtr(nint hWnd, int nIndex);

    [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")]
    private static extern nint SetWindowLongPtr(nint hWnd, int nIndex, nint dwNewLong);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetWindowPos(nint hWnd, int hWndInsertAfter, int x, int y, int cx, int cy, uint flags);
}
