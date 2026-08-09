using System.Runtime.InteropServices;
using System.Windows.Interop;
using Microsoft.Win32;
using Forms = System.Windows.Forms;

namespace CoachBuild.Desktop.Overlay;

public sealed record DisplayInfo(
    string DeviceName,
    int Left,
    int Top,
    int Width,
    int Height,
    int DpiX,
    int DpiY)
{
    public DisplayResolution Resolution => new(Width, Height, DpiX, DpiY, DeviceName);
}

/// <summary>
/// Owns the small amount of Win32 needed to keep a borderless overlay aligned
/// when the primary display, monitor, or per-monitor DPI changes.
/// </summary>
public sealed class DisplayDpiService : IDisposable
{
    private bool _disposed;

    public DisplayDpiService()
    {
        SystemEvents.DisplaySettingsChanged += OnDisplaySettingsChanged;
    }

    public event EventHandler? DisplayChanged;

    public DisplayInfo GetPrimaryDisplay(nint windowHandle = default)
    {
        var screen = Forms.Screen.PrimaryScreen ?? throw new InvalidOperationException("No primary display is available.");
        return ToDisplayInfo(screen, windowHandle);
    }

    public DisplayInfo GetDisplayForWindow(nint windowHandle)
    {
        var screen = windowHandle == 0
            ? Forms.Screen.PrimaryScreen
            : Forms.Screen.FromHandle(windowHandle);
        screen ??= Forms.Screen.PrimaryScreen;
        return ToDisplayInfo(screen!, windowHandle);
    }

    public static int GetDpiForWindow(nint windowHandle)
    {
        if (windowHandle == 0) return 96;
        try
        {
            var dpi = NativeGetDpiForWindow(windowHandle);
            return dpi == 0 ? 96 : (int)dpi;
        }
        catch
        {
            return 96;
        }
    }

    private static DisplayInfo ToDisplayInfo(Forms.Screen screen, nint windowHandle)
    {
        var bounds = screen.Bounds;
        var dpi = GetDpiForWindow(windowHandle);
        return new DisplayInfo(screen.DeviceName, bounds.Left, bounds.Top, bounds.Width, bounds.Height, dpi, dpi);
    }

    private void OnDisplaySettingsChanged(object? sender, EventArgs e)
    {
        if (!_disposed) DisplayChanged?.Invoke(this, EventArgs.Empty);
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        SystemEvents.DisplaySettingsChanged -= OnDisplaySettingsChanged;
        GC.SuppressFinalize(this);
    }

    [DllImport("user32.dll", EntryPoint = "GetDpiForWindow")]
    private static extern uint GetDpiForWindowNative(nint hwnd);

    private static uint NativeGetDpiForWindow(nint hwnd) => GetDpiForWindowNative(hwnd);
}
