using System.Reflection;
using System.Text.Json;
using System.Windows;
using System.Windows.Interop;
using CoachBuild.Desktop.Web;

internal static class CounterSmoke
{
    [STAThread]
    private static void Main()
    {
        var app = new Application { ShutdownMode = ShutdownMode.OnExplicitShutdown };
        app.Startup += async (_, _) =>
        {
            WebView2Window? window = null;
            try
            {
                var profile = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "coachbuild-ugg-smoke-" + Guid.NewGuid().ToString("N"));
                window = new WebView2Window(new WebView2EnvironmentService(profile),
                    "https://coachbuild.local", new string('a', 64), profile);
                window.Opacity = 0;
                window.ShowInTaskbar = false;
                window.ShowActivated = false;
                window.Show();
                Console.WriteLine("Native window initialized");
                new WindowInteropHelper(window).EnsureHandle();
                var read = typeof(WebView2Window).GetMethod("ReadUggCountersAsync", BindingFlags.NonPublic | BindingFlags.Instance)!;
                using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(35));
                var task = (Task<JsonElement>)read.Invoke(window, [UggCounters.BuildUrl("ahri", "mid")!, 103, "mid", timeout.Token])!;
                var data = await task.WaitAsync(TimeSpan.FromSeconds(40));
                var rows = data.GetProperty("rows");
                if (rows.GetArrayLength() < 15) throw new Exception("Too few Ahri matchups");
                Console.WriteLine($"NATIVE PASS patch={data.GetProperty("patch")} rows={rows.GetArrayLength()}");
                app.Shutdown(0);
            }
            catch (Exception error)
            {
                Console.WriteLine("NATIVE FAIL " + error);
                app.Shutdown(1);
            }
            finally { window?.Close(); }
        };
        app.Run();
    }
}
