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
    private bool _interactive;
    private bool _adjusting;
    private bool _disposed;

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

        EnsureDisplay();
        _workingCalibration = _settingsStore.LoadCalibration(_display!.Resolution);
        _adjusting = true;
        SetInteractive(true);
        RenderAdjustment();
    }

    public void ShowInactive()
    {
        if (!Dispatcher.CheckAccess())
        {
            Dispatcher.BeginInvoke(ShowInactive);
            return;
        }

        EnsureDisplay();
        if (!IsVisible) Show();
        SetBoundsToDisplay();
        SetNativeClickThrough(!_interactive);
        if (_interactive) Focus();
    }

    private void OnSourceInitialized(object? sender, EventArgs e)
    {
        SetNativeClickThrough(clickThrough: true);
        EnsureDisplay();
        SetBoundsToDisplay();
    }

    private void EnsureDisplay()
    {
        if (_display is not null) return;
        var handle = new WindowInteropHelper(this).Handle;
        _display = _displayDpi.GetDisplayForWindow(handle);
    }

    private void SetBoundsToDisplay()
    {
        if (_display is null) return;
        var scaleX = Math.Max(0.1d, _display.DpiX / 96d);
        var scaleY = Math.Max(0.1d, _display.DpiY / 96d);
        Left = _display.Left / scaleX;
        Top = _display.Top / scaleY;
        Width = _display.Width / scaleX;
        Height = _display.Height / scaleY;
        var handle = new WindowInteropHelper(this).Handle;
        if (handle == 0) return;
        SetWindowPos(handle, HWndTopMost, _display.Left, _display.Top, _display.Width, _display.Height,
            SwpNoActivate | SwpShowWindow | SwpNoSendChanging);
    }

    private void RenderCurrentState()
    {
        EnsureDisplay();
        if (_display is null || _adjusting) return;
        _settings = _settingsStore.Read();
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
            var handle = new WindowInteropHelper(this).Handle;
            _display = _displayDpi.GetDisplayForWindow(handle);
            SetBoundsToDisplay();
            if (_adjusting)
            {
                _workingCalibration = _settingsStore.LoadCalibration(_display.Resolution);
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
        SetInteractive(false);
        RenderCurrentState();
    }

    private void CancelAdjustment()
    {
        if (!_adjusting) return;
        _adjusting = false;
        _workingCalibration = null;
        SetInteractive(false);
        RenderCurrentState();
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
        var style = GetWindowLongPtr(handle, GwlExStyle).ToInt64();
        style |= WsExNoActivate | WsExToolWindow;
        if (clickThrough) style |= WsExTransparent;
        else style &= ~WsExTransparent;
        SetWindowLongPtr(handle, GwlExStyle, new nint(style));
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
        _displayDpi.Dispose();
        GC.SuppressFinalize(this);
    }

    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")]
    private static extern nint GetWindowLongPtr(nint hWnd, int nIndex);

    [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")]
    private static extern nint SetWindowLongPtr(nint hWnd, int nIndex, nint dwNewLong);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetWindowPos(nint hWnd, int hWndInsertAfter, int x, int y, int cx, int cy, uint flags);
}
