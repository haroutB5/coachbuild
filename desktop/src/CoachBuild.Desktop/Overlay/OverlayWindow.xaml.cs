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
    // One working copy PER target, so Tab can switch between the ability bar
    // and the item row without throwing away edits the player has not saved
    // yet. Enter commits every target that was touched; Esc discards all of
    // them. Anything less makes Tab a trap.
    private readonly Dictionary<CalibrationTarget, CalibrationGeometry> _workingByTarget = [];

    // WHICH targets the player actually MOVED this visit. "Enter commits every
    // target that was touched" was true of the working copies and false of the
    // saves: `_workingByTarget` is seeded from LoadCalibrationOrDefault the
    // instant a target is opened or Tabbed to, so merely LOOKING at the item
    // row and pressing Enter used to persist `ItemRowScaledDefault` as though
    // it were a measurement.
    //
    // That is not a cosmetic distinction. The item row deliberately draws
    // NOTHING until it has been positioned (TryLoadCalibration returns null
    // rather than a default) precisely so an invented constant never paints
    // numbers over the wrong part of the game — and the 2026-08-20 field log
    // shows exactly that guarantee defeated: `badges: 6 shown at 544x904
    // size 59 pitch 69` on a 2560x1440 display is ItemRowScaledDefault to the
    // pixel, roughly 210 px BELOW the shop's Situational row.
    private readonly HashSet<CalibrationTarget> _touchedTargets = [];
    private CalibrationTarget _adjustTarget = CalibrationTarget.SkillOrder;
    private IReadOnlyList<CoachBuild.Core.SituationalDelta> _situational = [];

    /// <summary>
    /// The shop set the current numbers were computed for and where the
    /// Situational block sits inside it, or empty when there are no numbers.
    ///
    /// <para>Adjust mode prints it, and the badge diagnostic line carries it.
    /// The 2026-08-20 round is the reason: the player calibrated the row while
    /// their shop was showing Riot's own "AP" recommended set, so they lined the
    /// boxes up against a row this app never wrote — a different row, with a
    /// different number of blocks above it, in a different place. Nothing on
    /// screen or in the log told them which set to be looking at.</para>
    /// </summary>
    private string _situationalSetLabel = string.Empty;
    private bool _shopOpen;
    private bool _forceBadges;
    private string? _lastBadgeReason;
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

    /// <summary>Which calibration the arrow keys are currently moving.</summary>
    public CalibrationTarget AdjustTarget => _adjustTarget;

    /// <summary>
    /// The rects the item-row PREVIEW pills were last painted at, in order.
    ///
    /// <para>Exists so the WYSIWYG guarantee is assertable rather than merely
    /// intended: for the same calibration and the same deltas these must equal
    /// <see cref="OverlayRenderer.LastBadgeRects"/>, which is what a live game
    /// paints. 1.0.19 shipped with the two disagreeing by a pill-height and
    /// nothing in the suite could see it.</para>
    /// </summary>
    public IReadOnlyList<Rect> LastAdjustBadgeRects { get; private set; } = [];

    /// <summary>
    /// The geometry adjust mode last drew at, in DIPs — the value
    /// <see cref="RenderAdjustment"/> actually used, not a re-derivation of it.
    ///
    /// <para>Exposed so the WYSIWYG pair can be asserted against a REAL live
    /// render rather than against a second copy of the same arithmetic: a test
    /// that re-derived this geometry could agree with a preview that disagrees
    /// with the game, which is precisely the class of bug being fixed.</para>
    /// </summary>
    public CalibrationGeometry? LastAdjustGeometry { get; private set; }

    /// <summary>True while the situational numbers are on screen.</summary>
    public bool IsDrawingBadges { get; private set; }

    /// <summary>
    /// The set label the current numbers arrived with, or empty. Read-only
    /// view of <c>_situationalSetLabel</c> for the tests that assert it reaches
    /// both surfaces that are supposed to show it.
    /// </summary>
    public string SituationalSetLabel => _situationalSetLabel;

    /// <summary>
    /// The situational deltas to draw, for the champion currently in game.
    ///
    /// <para>Supplied already champion-matched by the caller
    /// (<see cref="CoachBuild.Core.SituationalOverlaySet.For"/>), so an empty
    /// list here means "no numbers for THIS champion" and never "some other
    /// champion's numbers are available".</para>
    /// </summary>
    /// <param name="setLabel">
    /// The shop set the numbers were computed for and the Situational block's
    /// position inside it (<see cref="CoachBuild.Core.SituationalBlockInfo.Describe"/>),
    /// or empty when there are no numbers.
    /// REQUIRED, not optional: the badges are mapped positionally and are only
    /// true of that set, and adjust mode has to be able to say which one BEFORE
    /// the player lines anything up. An optional argument here is how the
    /// shipped path ends up as the only uncovered one — round 3's argument for
    /// the layout hook, applied again.
    /// </param>
    public void SetSituationalDeltas(
        IReadOnlyList<CoachBuild.Core.SituationalDelta>? deltas,
        string setLabel)
    {
        if (!Dispatcher.CheckAccess())
        {
            Dispatcher.BeginInvoke(() => SetSituationalDeltas(deltas, setLabel));
            return;
        }

        var next = deltas ?? [];
        var label = setLabel ?? string.Empty;
        // The LABEL is a visual input too — it is printed in adjust mode and in
        // the badge diagnostic line. Folding it into this early-out is the same
        // lesson as `badges.SignatureKey()` in the renderer's memo: a change
        // nothing else in the comparison can see is a change the memo reports
        // as "nothing happened".
        var labelChanged = !string.Equals(_situationalSetLabel, label, StringComparison.Ordinal);
        _situationalSetLabel = label;
        if (!labelChanged && SameDeltas(_situational, next))
        {
            // Identical content arrives every snapshot tick. SituationalDelta is
            // a readonly record struct, so this is a real value comparison and
            // not reference identity — the caller hands us a fresh list each
            // time and a reference check would never match.
            _situational = next;
            return;
        }

        _situational = next;
        if (_adjusting) { RenderAdjustment(); return; }
        RenderCurrentState();
    }

    private static bool SameDeltas(
        IReadOnlyList<CoachBuild.Core.SituationalDelta> left,
        IReadOnlyList<CoachBuild.Core.SituationalDelta> right)
    {
        if (ReferenceEquals(left, right)) return true;
        if (left.Count != right.Count) return false;
        for (var index = 0; index < left.Count; index++)
        {
            if (!left[index].Equals(right[index])) return false;
        }

        return true;
    }

    /// <summary>
    /// The shop-open latch's verdict. Driven off <see cref="ShopKeyWatcher"/>'s
    /// own 50 ms timer rather than the 750 ms snapshot tick, because the whole
    /// point is that the numbers appear as the shop does.
    /// </summary>
    public void SetShopOpen(bool open)
    {
        if (!Dispatcher.CheckAccess())
        {
            Dispatcher.BeginInvoke(() => SetShopOpen(open));
            return;
        }

        if (_shopOpen == open) return;
        _shopOpen = open;

        // 1.0.18: a press that CLOSES the latch means "put them away", and it
        // has to beat the manual override too.
        //
        // Until now it did not. "Show item numbers now" draws the badges
        // regardless of the latch, so a player who used it - and round 1 told
        // this player to use it, as the workaround for the chat gate - had no
        // way to put the numbers back down from inside a fullscreen game. They
        // sat over open terrain until the match ended, and the only control was
        // a tray tick they could not reach. That is the same "no recovery you
        // can find from in-game" defect the chat gate had, in the very feature
        // that was meant to be its escape hatch.
        var droppedOverride = false;
        if (!open && _forceBadges)
        {
            _forceBadges = false;
            droppedOverride = true;
        }

        if (!_adjusting) RenderCurrentState();

        // AFTER the render, and outside the adjusting early-out: the tray's tick
        // must follow the overlay even while the player is mid-calibration, or
        // the menu claims an override that is no longer in force.
        if (droppedOverride) ManualBadgeOverrideCleared?.Invoke();
    }

    /// <summary>
    /// Raised when the overlay drops "Show item numbers now" by itself, so the
    /// tray's tick can follow. The overlay owns the decision because the
    /// overlay owns the flag; the tray only mirrors it.
    /// </summary>
    public event Action? ManualBadgeOverrideCleared;

    /// <summary>
    /// The manual override: show the numbers regardless of what the shop latch
    /// believes.
    ///
    /// <para>It exists because the latch is an inference. A shop closed by
    /// clicking its own button, or a shop bind that could not be read out of
    /// League's config, both leave the latch wrong with nothing on this side
    /// able to notice — so there has to be a way back that does not depend on
    /// the thing that is broken.</para>
    /// </summary>
    public void SetForceBadges(bool force)
    {
        if (!Dispatcher.CheckAccess())
        {
            Dispatcher.BeginInvoke(() => SetForceBadges(force));
            return;
        }

        if (_forceBadges == force) return;
        _forceBadges = force;
        if (_adjusting) return;
        RenderCurrentState();
    }

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

    public void BeginAdjustment() => BeginAdjustment(CalibrationTarget.SkillOrder);

    public void BeginAdjustment(CalibrationTarget target)
    {
        if (!Dispatcher.CheckAccess())
        {
            Dispatcher.BeginInvoke(() => BeginAdjustment(target));
            return;
        }

        if (_adjusting)
        {
            // Already adjusting: treat a second request as "switch to that
            // target" rather than a no-op, so the tray's two items always do
            // what they say even if one is used while the other is open.
            SwitchAdjustTarget(target);
            return;
        }

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

        _workingByTarget.Clear();
        _touchedTargets.Clear();
        _adjustTarget = target;
        _workingCalibration = WorkingFor(target);
        _adjusting = true;
        AdjustmentStateChanged?.Invoke(true);
        SetInteractive(true);
        Activate();
        Focus();
        Diagnostics?.Invoke($"overlay: adjust mode entered for {Describe(target)}");
        RenderAdjustment();
    }

    /// <summary>The working copy for a target: whatever is being edited, else the saved value, else the default.</summary>
    private CalibrationGeometry WorkingFor(CalibrationTarget target)
    {
        if (_workingByTarget.TryGetValue(target, out var inProgress)) return inProgress;
        return _display is null
            ? CalibrationGeometry.Reference
            : _settingsStore.LoadCalibrationOrDefault(target, _display.Resolution);
    }

    private void SwitchAdjustTarget(CalibrationTarget target)
    {
        if (!_adjusting || target == _adjustTarget) return;
        if (_workingCalibration is not null) _workingByTarget[_adjustTarget] = _workingCalibration;
        _adjustTarget = target;
        _workingCalibration = WorkingFor(target);
        Diagnostics?.Invoke($"overlay: adjust mode switched to {Describe(target)}");
        RenderAdjustment();
    }

    private static string Describe(CalibrationTarget target) => target == CalibrationTarget.ItemRow
        ? "the situational item numbers"
        : "the skill-order box";

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
            IsDrawingBadges = false;
            HasRenderableSkillOrder = false;
            ReportOverlayReason("overlay-hidden (tray: Show overlay)");
            return;
        }
        if (_display is null)
        {
            IsDrawingHighlight = false;
            IsDrawingBadges = false;
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
        var badges = BuildBadgeInput();
        _renderer.Render(RootCanvas, renderState, _settings, _display.Resolution, dipCalibration, badges);
        var outcome = DescribeRenderOutcome(renderState, dipCalibration, _display);
        IsDrawingHighlight = outcome.StartsWith("highlight ", StringComparison.Ordinal);
        IsDrawingBadges = badges.WillDraw;
        HasRenderableSkillOrder = renderState.HasRenderableData;
        ReportKitAnomaly(renderState);
        ReportOverlayReason(outcome);
        ReportBadgeReason(badges);
    }

    /// <summary>
    /// The situational numbers' inputs for this frame: where they go, what they
    /// say, and whether the shop is believed open.
    ///
    /// <para><c>TryLoadCalibration</c>, not <c>LoadCalibration</c> — a null here
    /// means the player has never positioned the row on this display and the
    /// numbers must not be drawn at a guessed spot over their game.</para>
    /// </summary>
    private ItemBadgeInput BuildBadgeInput()
    {
        if (_display is null || !_settings.OverlayVisible) return ItemBadgeInput.None;
        var physical = _settingsStore.TryLoadCalibration(CalibrationTarget.ItemRow, _display.Resolution);
        var geometry = physical is null
            ? null
            : CalibrationGeometry.ForDpi(physical, _display.DpiX, 96);
        return new ItemBadgeInput((_shopOpen || _forceBadges) && _state.InGame, _situational, geometry);
    }

    /// <summary>
    /// Why the numbers are or are not on screen, deduped to one line per
    /// transition — the badge twin of <see cref="ReportOverlayReason"/>.
    ///
    /// <para>Every "not drawn" branch names ITSELF. An overlay that draws
    /// nothing looks identical whether the shop is shut, the champion has no
    /// alternatives, the web build is too old to send any, or the row has never
    /// been positioned; those are four different problems with four different
    /// answers, and the log is the only place they can be told apart.</para>
    /// </summary>
    private void ReportBadgeReason(ItemBadgeInput badges)
    {
        string reason;
        if (!_settings.OverlayVisible) reason = "badges: overlay switched off (tray: Show overlay)";
        else if (!_state.InGame) reason = "badges: not in a game";
        else if (_situational.Count == 0)
            reason = "badges: no situational numbers for this champion "
                + "(the web app sends them with the item set; an older web build sends none)";
        else if (badges.Geometry is null)
            reason = $"badges: the item row has never been positioned on {_display?.DeviceName ?? "?"}"
                + $" {_display?.Resolution.Key ?? "?"} — tray → \"{Tray.TrayMenuState.AdjustItemsMenuVerb}\"";
        else if (!_shopOpen && !_forceBadges) reason = "badges: hidden (shop closed)";
        else
        {
            var slots = badges.Geometry.GetSlotRects(_situational.Count);
            var first = slots.Count > 0 ? slots[0] : default;
            reason = $"badges: {_situational.Count} shown at {first.Left:0}x{first.Top:0}"
                + $" size {first.Width:0} pitch {badges.Geometry.Spacing:0}"
                + $" on {OverlayDisplayResolver.Describe(_display!, _displaySource)}"
                // WHAT THE ROW IS AIMED AT, on the same line as where it is
                // aimed. This position is FIXED by the saved calibration and
                // has no term for the set's shape — proven in
                // BadgePlacementTests — while the shop's Situational row moves
                // down by one block-pitch for every block above it. So the two
                // 2026-08-20 screenshots, taken at one calibration, showed the
                // pills below the icons on a 3-block set and above them on a
                // 5-block set, and this line was identical in both. It is not
                // any more, and the difference is the diagnosis.
                + (_situationalSetLabel.Length > 0 ? $" for {_situationalSetLabel}" : string.Empty);
        }

        if (string.Equals(reason, _lastBadgeReason, StringComparison.Ordinal)) return;
        _lastBadgeReason = reason;
        Diagnostics?.Invoke($"overlay: {reason}");
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

                // Re-derive for the target currently being adjusted, and drop
                // every working copy: they were keyed to the display that has
                // just gone away.
                _workingByTarget.Clear();
                _touchedTargets.Clear();
                _workingCalibration = _settingsStore.LoadCalibrationOrDefault(_adjustTarget, display.Resolution);
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
    /// session that moved nothing still persisted the item row's invented
    /// default, and that is what put the badges 210 px below the shop row in
    /// the field. A guarantee about which keypresses count cannot be pinned by
    /// a test that has to synthesise <c>KeyEventArgs</c> against a live
    /// <c>PresentationSource</c>.</para>
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
            case Key.Tab:
                // Switches which overlay the arrow keys move. Handled here
                // rather than on a second global accelerator: 1.0.13 removed
                // Ctrl+Shift+S because a global hotkey is taken from every
                // other application for as long as this app runs, and that
                // argument did not stop being true for a second one.
                SwitchAdjustTarget(_adjustTarget == CalibrationTarget.SkillOrder
                    ? CalibrationTarget.ItemRow
                    : CalibrationTarget.SkillOrder);
                return true;
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
            _touchedTargets.Add(_adjustTarget);
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

        // EVERY target touched this session, not just the one on screen. Tab
        // lets the player move both overlays in one visit, and saving only the
        // visible one would silently drop the other half of their work.
        //
        // TOUCHED, and that word now means MOVED. Until 1.0.19 it meant
        // "visited": `_workingByTarget` is seeded the moment a target is opened
        // or Tabbed to, so tray -> "Adjust item numbers" -> Enter persisted
        // `ItemRowScaledDefault` — a constant the model itself documents as "a
        // starting position, not a measurement" — as though the player had
        // measured it. That is how the field log came to read `badges: 6 shown
        // at 544x904 size 59 pitch 69`, which is that default to the pixel on a
        // 2560x1440 screen, about 210 px below the row it is meant to sit on.
        // Saving nothing is the honest outcome of an adjust session in which
        // nothing was adjusted.
        _workingByTarget[_adjustTarget] = _workingCalibration;
        var saved = 0;
        foreach (var (target, geometry) in _workingByTarget)
        {
            if (!_touchedTargets.Contains(target)) continue;
            _settingsStore.SaveCalibration(target, _display.Resolution, geometry);
            saved++;
            Diagnostics?.Invoke(
                $"overlay: saved {Describe(target)} at {geometry.FirstBoxCenterX:0}x{geometry.CenterY:0}"
                + $" size {geometry.BoxSize:0} pitch {geometry.Spacing:0}"
                + $" for {_display.Resolution.Key}");
        }

        if (saved == 0)
        {
            Diagnostics?.Invoke(
                "overlay: adjust mode saved nothing - neither overlay was moved."
                + " An untouched default is a guess, not a calibration, so it is not written."
                + " Use the arrow keys (Shift for x10), +/- for size and [/] for spacing,"
                + " then press Enter.");
        }

        _settings = _settingsStore.Read();
        _adjusting = false;
        _workingCalibration = null;
        _workingByTarget.Clear();
        _touchedTargets.Clear();
        _lastBadgeReason = null;
        AdjustmentStateChanged?.Invoke(false);
        SetInteractive(false);
        RestoreVisibilityAfterAdjustment();
    }

    public void CancelAdjustment()
    {
        if (!_adjusting) return;
        _adjusting = false;
        _workingCalibration = null;
        _workingByTarget.Clear();
        _touchedTargets.Clear();
        _lastBadgeReason = null;
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
        // The item row is as long as the champion's own situational list, so
        // the boxes the player lines up are the boxes that will be drawn. With
        // no numbers to hand (out of a game, or an older web build) a
        // placeholder row of the maximum length is shown instead, labelled as
        // such, rather than a single box that would calibrate the pitch wrong.
        LastAdjustGeometry = geometry;
        var isItemRow = _adjustTarget == CalibrationTarget.ItemRow;
        var slotCount = isItemRow
            ? Math.Max(1, _situational.Count > 0 ? _situational.Count : CoachBuild.Core.SituationalOverlayParser.MaxDeltas)
            : 4;
        var usingPlaceholders = isItemRow && _situational.Count == 0;

        var previewRects = new List<Rect>(slotCount);
        foreach (var (rect, index) in geometry.GetSlotRects(slotCount).Select((rect, index) => (rect, index)))
        {
            var box = new Border
            {
                Width = rect.Width,
                Height = rect.Height,
                // The item row's frame is a THIN GUIDE, not the thing being
                // aligned. Adjust mode used to draw a solid pink block here and
                // the live render then drew the number somewhere else entirely
                // (above it), so the player lined up the block and the numbers
                // landed on the shop's section header. The pill below is now the
                // dominant element for exactly that reason; the frame survives
                // only so +/- (size) and [ / ] (pitch) have something visible to
                // act on. The skill-order target keeps the solid box: there IS
                // nothing else to draw there, and its highlight is painted at
                // the slot in play too.
                Background = new SolidColorBrush(WpfColor.FromArgb(isItemRow ? (byte)18 : (byte)55, 255, 47, 158)),
                BorderBrush = new SolidColorBrush(WpfColor.FromRgb(255, 47, 158)),
                BorderThickness = new Thickness(isItemRow ? 1.5 : 3),
                CornerRadius = new CornerRadius(8),
                Child = isItemRow ? null : new TextBlock
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

            if (!isItemRow) continue;

            // WHAT YOU ALIGN IS WHAT YOU GET. The pill is built and placed by
            // the SAME two calls the live render makes (OverlayRenderer
            // .CreateBadgePill / .PlaceBadgeOnCanvas), so the preview cannot
            // describe a position the game will not use. Placeholder slots
            // carry "#N" and a neutral sign, which is still the real pill.
            var known = index < _situational.Count;
            var pill = OverlayRenderer.CreateBadgePill(
                known ? _situational[index].Text : $"#{index + 1}",
                known ? Math.Sign(_situational[index].Wpa) : 0,
                rect);
            previewRects.Add(OverlayRenderer.PlaceBadgeOnCanvas(RootCanvas, pill, rect));
        }

        LastAdjustBadgeRects = previewRects;

        var heading = isItemRow ? "Adjusting the situational item numbers" : "Adjusting the skill-order box";
        var switchTo = isItemRow ? "the skill-order box" : "the situational item numbers";
        // The item row is the only target with no honest default, so it is the
        // only one where the instruction has to be on screen every time rather
        // than only when there are no numbers to hand. A player who opens this,
        // sees six boxes and presses Enter no longer saves anything (see
        // SaveAdjustment) — so they need to be told what the boxes are for.
        // NAME THE SET ON SCREEN. Defect E: the app writes an item set but
        // cannot see which one the player has SELECTED in the shop's dropdown,
        // so it cannot detect that they are aiming at the wrong row — and on
        // 2026-08-20 they were, at Riot's own "AP" recommended set. Printing
        // the set the numbers belong to, and the block position inside it, is
        // the whole of what the app can honestly do about that, and it has to
        // be here rather than only in the log because here is where the player
        // is looking while they decide which row to aim at.
        var setNote = isItemRow && _situationalSetLabel.Length > 0
            ? $"\nThese numbers are for {_situationalSetLabel}"
              + "\nSelect that set in the shop's dropdown before you line anything up"
            : string.Empty;
        var placeholderNote = isItemRow
            ? setNote
              + (usingPlaceholders
                ? "\nShowing 6 placeholder slots — line them up with your Situational row in the shop"
                : "\nLine these up with the Situational row in your shop")
              + "\nOpen your shop before entering adjust mode so you can see that row"
              + "\nNothing is saved unless you actually move them"
            : string.Empty;
        var legend = new Border
        {
            Background = new SolidColorBrush(WpfColor.FromArgb(236, 8, 13, 28)),
            BorderBrush = new SolidColorBrush(WpfColor.FromRgb(79, 176, 224)),
            BorderThickness = new Thickness(1.5),
            CornerRadius = new CornerRadius(8),
            Padding = new Thickness(10, 7, 10, 7),
            Child = new TextBlock
            {
                Text = heading
                    + placeholderNote
                    + "\nEnter: save · Esc: cancel"
                    + "\nArrow keys: move · Shift: ×10 · +/-: size · [/]: spacing"
                    + $"\nTab: switch to {switchTo}",
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
                    _workingByTarget.Clear();
                    _touchedTargets.Clear();
                    _workingCalibration = _display is null
                        ? null
                        : _settingsStore.LoadCalibrationOrDefault(_adjustTarget, _display.Resolution);
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
