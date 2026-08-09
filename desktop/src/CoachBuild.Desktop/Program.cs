using System.Runtime.InteropServices;
using CoachBuild.Desktop.Updates;
using CoachBuild.Desktop.Web;

namespace CoachBuild.Desktop;

public static class Program
{
    [STAThread]
    public static int Main(string[] args)
    {
        EnablePerMonitorDpiAwareness();
        UpdateBootstrapper.TryRun(args);
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
        app.InitializeComponent();
        return app.Run();
    }

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
