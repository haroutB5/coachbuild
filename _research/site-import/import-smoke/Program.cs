using System.Reflection;
using System.Windows;
using System.Windows.Threading;
using CoachBuild.Core;
using CoachBuild.Desktop.Web;

// Explicit live-site diagnostic only. No LCU connection or item/rune writes.
internal static class ImportSmoke
{
    [STAThread]
    private static void Main()
    {
        var app = new Application { ShutdownMode = ShutdownMode.OnExplicitShutdown };
        app.Startup += async (_, _) =>
        {
            WebView2Window? window = null;
            DispatcherTimer? sweepTimer = null;
            try
            {
                var profile = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "coachbuild-import-smoke-" + Guid.NewGuid().ToString("N"));
                window = new WebView2Window(new WebView2EnvironmentService(profile),
                    "https://coachbuild.local", new string('a', 64), profile);
                window.Opacity = 0;
                window.ShowInTaskbar = false;
                window.ShowActivated = false;
                window.Show();
                var flags = BindingFlags.NonPublic | BindingFlags.Instance;
                var sweep = typeof(WebView2Window).GetMethod("SweepIdleTabs", flags)!;
                var seen = (Dictionary<CompanionTab, DateTimeOffset>)typeof(WebView2Window)
                    .GetField("_lastVisible", flags)!.GetValue(window)!;
                sweepTimer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(200) };
                sweepTimer.Tick += (_, _) => sweep.Invoke(window, [DateTimeOffset.UtcNow]);
                sweepTimer.Start();
                foreach (var champion in new[] { "Viktor", "Volibear" })
                {
                    using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(100));
                    foreach (var site in new[] { CompanionTab.UGg, CompanionTab.Coachless })
                    {
                        if (seen.ContainsKey(site)) seen[site] = DateTimeOffset.UtcNow.AddMinutes(-11);
                        sweep.Invoke(window, [DateTimeOffset.UtcNow]);
                        var raw = await window.FetchViaWorkerAsync(site, SiteDeepLink.Build(site, champion, 0)!, champion, 0, timeout.Token);
                        if (!SiteImportPayload.TryParse(raw, out var payload, out var failure) || payload is null)
                        {
                            await Task.Delay(8500);
                            Console.WriteLine("Delayed items=" + await window.ExtractVisibleAsync(site, timeout.Token));
                            var state = typeof(WebView2Window).GetMethod("GetState", flags)!.Invoke(window, [site])!;
                            var core = (Microsoft.Web.WebView2.Core.CoreWebView2)state.GetType().GetProperty("Core")!.GetValue(state)!;
                            Console.WriteLine("Item row DOM=" + await core.ExecuteScriptAsync("JSON.stringify(Array.from(document.querySelectorAll('tr.data-row')).slice(0,3).map(x=>x.outerHTML))"));
                            throw new Exception($"{champion} {site}: {failure}; raw={raw}");
                        }
                        Console.WriteLine($"LIVE {champion} {site}: items={payload.ItemBlocks.Sum(b => b.ItemIds.Count)} runes={payload.Runes is not null}");
                        if (payload.ItemBlocks.Count == 0) throw new Exception("No items");
                        if (site == CompanionTab.UGg && payload.Runes is null)
                        {
                            await Task.Delay(8500);
                            var retry = await window.ExtractVisibleAsync(site, timeout.Token);
                            Console.WriteLine("UGG delayed read=" + retry);
                            var state = typeof(WebView2Window).GetMethod("GetState", flags)!.Invoke(window, [site])!;
                            var core = (Microsoft.Web.WebView2.Core.CoreWebView2)state.GetType().GetProperty("Core")!.GetValue(state)!;
                            Console.WriteLine("UGG rune DOM=" + await core.ExecuteScriptAsync("JSON.stringify(Array.from(document.querySelectorAll('.rune-trees-container')).map(x=>x.outerHTML))"));
                            throw new Exception("No u.gg runes on initial read");
                        }
                    }
                    var runeRaw = await window.FetchCoachlessRunesAsync(SiteDeepLink.CoachlessRunesUrl(champion, 0)!, champion, 0, timeout.Token);
                    if (!SiteImportPayload.TryParse(runeRaw, out var runes, out var runeFailure) || runes?.Runes is null)
                        throw new Exception($"{champion} Coachless runes: {runeFailure}");
                    Console.WriteLine($"LIVE {champion} Coachless runes: complete");
                }
                Console.WriteLine("LIVE IMPORT PASS: both champions survived idle recreation; no League writes performed.");
                app.Shutdown(0);
            }
            catch (Exception error)
            {
                Console.WriteLine("LIVE IMPORT FAIL " + error);
                app.Shutdown(1);
            }
            finally { sweepTimer?.Stop(); window?.Close(); }
        };
        app.Run();
    }
}
