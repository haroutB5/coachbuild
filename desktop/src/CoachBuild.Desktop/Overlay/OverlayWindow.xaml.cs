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
    private OverlayState _state = OverlayState.Empty;
    private OverlaySettings _settings;
    private DisplayInfo? _display;
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

    // App projects snapshots every 750 ms. Reassert topmost only occasionally
    // so ordinary overlay ticks stay cheap while still recovering if another
    // window (notably exclusive fullscreen) pushes this HWND down the stack.
    private const int TopmostReassertEveryTicks = 10;

    public OverlayWindow(OverlaySettingsStore settingsStore)
    {
        _settingsStore = settingsStore ?? throw new ArgumentNullException(nameof(settingsStore));
        _settings = _settingsStore.Read();
        InitializeComponent();
        SourceInitialized += OnSourceInitialized;
        KeyDown += OnKeyDown;
        Closed += OnClosed;
        _displayDpi.DisplayChanged += OnDisplayChanged;
    }

    public OverlayRenderer Renderer => _renderer;

    public OverlayState State => _state;

    public bool IsInteractive => _interactive;

    public bool IsAdjusting => _adjusting;

    public event Action<bool>? AdjustmentStateChanged;

    public bool OverlayVisibleSetting => _settings.OverlayVisible;

    public bool ShowSkillTableSetting => _settings.ShowSkillTable;

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

    public void SetShowSkillTable(bool visible)
    {
        if (!Dispatcher.CheckAccess())
        {
            Dispatcher.BeginInvoke(() => SetShowSkillTable(visible));
            return;
        }

        _settings.ShowSkillTable = visible;
        _settingsStore.SetShowSkillTable(visible);
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

    private bool EnsureDisplay()
    {
        if (_display is not null) return true;
        var handle = new WindowInteropHelper(this).Handle;
        if (handle == 0) return false;
        _display = _displayDpi.GetDisplayForWindow(handle);
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
        if (_display is null || _adjusting) return;
        var renderState = _state with
        {
            Lane = _settings.LaneOverride ?? _state.Lane,
            IsLaneAuto = _settings.LaneOverride is null && _state.IsLaneAuto,
        };
        var physicalCalibration = _settingsStore.LoadCalibration(_display.Resolution);
        var dipCalibration = CalibrationGeometry.ForDpi(physicalCalibration, _display.DpiX, 96);
        _renderer.Render(RootCanvas, renderState, _settings, _display.Resolution, _interactive, dipCalibration);
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
