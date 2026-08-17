using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Shapes;
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

    /// <summary>
    /// Optional sink for one-line overlay render diagnostics (wired to the
    /// app's redacted log). Carries no player-identifying data — only the
    /// render decision, the ability letter and the on-screen rectangle.
    /// </summary>
    public Action<string>? Diagnostics { get; set; }

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

    /// <summary>The monitor the overlay last resolved, for diagnostics.</summary>
    public DisplayInfo? CurrentDisplay => _display;

    /// <summary><c>league</c> when the monitor came from the game window, else <c>self</c>.</summary>
    public string DisplaySource => _displaySource;

    public OverlayState State => _state;

    public bool IsInteractive => _interactive;

    public bool IsAdjusting => _adjusting;

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
        if (_adjusting) return;
        RenderCurrentState();
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
            if (!_wasVisibleBeforeAdjustment) Hide();
            _wasVisibleBeforeAdjustment = false;
            return;
        }
        _workingCalibration = _settingsStore.LoadCalibration(_display!.Resolution);
        _adjusting = true;
        AdjustmentStateChanged?.Invoke(true);
        SetInteractive(true);
        Activate();
        Focus();
        RenderAdjustment();
    }

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
            ReportOverlayReason("overlay-hidden (tray: Show overlay)");
            return;
        }
        if (_display is null)
        {
            IsDrawingHighlight = false;
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
        ReportOverlayReason(outcome);
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
        if (!state.InGame) return "not-in-game";
        if (string.IsNullOrWhiteSpace(state.ChampionName)) return "no-champion";
        if (state.SkillOrder.Order.Count == 0) return "no-skill-order";
        if (state.NextAbility() is not { } next) return "no-next-ability";
        var rect = geometry.GetAbilityRects()[(int)next];
        // The monitor identity is on this line because without it a healthy
        // render, a wrong-monitor render and an exclusive-fullscreen render are
        // character-for-character identical in the log.
        return $"highlight {next} at {rect.Left:0}x{rect.Top:0} size {rect.Width:0} visible={IsVisible}"
            + $" on {OverlayDisplayResolver.Describe(display, _displaySource)}";
    }

    /// <summary>Deduped to one line per transition — this runs every 750 ms.</summary>
    private void ReportOverlayReason(string reason)
    {
        if (string.Equals(reason, _lastOverlayReason, StringComparison.Ordinal)) return;
        _lastOverlayReason = reason;
        Diagnostics?.Invoke($"overlay: {reason}");
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
        if (!_adjusting || _workingCalibration is null) return;
        var step = Keyboard.Modifiers.HasFlag(ModifierKeys.Shift) ? 10 : 1;
        var geometry = _workingCalibration;
        var handled = true;
        switch (e.Key)
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
                SaveAdjustment();
                break;
            case Key.Escape:
                CancelAdjustment();
                break;
            default:
                handled = false;
                break;
        }

        if (handled)
        {
            e.Handled = true;
            if (_adjusting)
            {
                _workingCalibration = geometry.Normalize();
                RenderAdjustment();
            }
        }
    }

    private void SaveAdjustment()
    {
        if (!_adjusting || _display is null || _workingCalibration is null) return;
        _settingsStore.SaveCalibration(_display.Resolution, _workingCalibration);
        _settings = _settingsStore.Read();
        _adjusting = false;
        _workingCalibration = null;
        AdjustmentStateChanged?.Invoke(false);
        SetInteractive(false);
        RestoreVisibilityAfterAdjustment();
    }

    public void CancelAdjustment()
    {
        if (!_adjusting) return;
        _adjusting = false;
        _workingCalibration = null;
        AdjustmentStateChanged?.Invoke(false);
        SetInteractive(false);
        RestoreVisibilityAfterAdjustment();
    }

    private void RestoreVisibilityAfterAdjustment()
    {
        var wasVisible = _wasVisibleBeforeAdjustment;
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
                Text = "Adjusting overlay\nEnter: save · Esc: cancel\nArrow keys: move · Shift: ×10 · +/-: size · [/]: spacing",
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
