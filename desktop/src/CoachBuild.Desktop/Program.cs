using System.Runtime.InteropServices;
using CoachBuild.Desktop.Web;
using Velopack;

namespace CoachBuild.Desktop;

public static class Program
{
    [STAThread]
    public static int Main(string[] args)
    {
        VelopackApp.Build().Run();
        EnablePerMonitorDpiAwareness();
        var options = CommandLineOptions.Parse(args);
        if (options.SelfTest)
        {
            return SelfTestRunner.RunAsync().GetAwaiter().GetResult();
        }

        if (options.RepairWebView2)
        {
            var paths = DesktopPaths.Create();
            paths.EnsureCreated();
            var service = new WebView2EnvironmentService(paths.WebView2UserDataFolder);
            return service.RepairAsync().GetAwaiter().GetResult() ? 0 : 1;
        }

        var app = new App();
        app.ConfigureOptions(options);
        app.InitializeComponent();
        return app.Run();
    }

    /// <summary>
    /// The FALLBACK path to per-monitor-v2 awareness. The real declaration
    /// lives in <c>app.manifest</c>, and that is load-bearing rather than
    /// tidier: WPF fixes its render target against the process awareness while
    /// it starts up, so setting the awareness from managed code — as this alone
    /// used to do — leaves the composition and the window disagreeing about the
    /// scale factor. At 192 DPI that showed up as a research window whose WPF
    /// chrome painted blank white around a WebView2 that painted fine
    /// (_evidence/live-2.1.0/01-04, 2026-09-08); at 96 DPI the scale is 1 and
    /// nothing looked wrong, which is why it shipped.
    ///
    /// <para>With the manifest present this call finds the awareness already
    /// set and returns false, which is the intended outcome and not an error.
    /// It stays for the case where a host strips or replaces the manifest:
    /// per-monitor-v2 set late still beats system-aware entirely.</para>
    /// </summary>
    private static void EnablePerMonitorDpiAwareness()
    {
        if (!OperatingSystem.IsWindows()) return;
        try
        {
            SetProcessDpiAwarenessContext((nint)(-4)); // PER_MONITOR_AWARE_V2
        }
        catch
        {
            // Older Windows builds keep the normal WPF/system-DPI behavior;
            // the overlay still tags and persists the display DPI.
        }
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetProcessDpiAwarenessContext(nint value);

}
