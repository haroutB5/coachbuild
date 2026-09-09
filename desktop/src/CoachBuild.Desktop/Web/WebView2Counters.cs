using System.Text.Json;
using System.Windows;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;

namespace CoachBuild.Desktop.Web;

public partial class WebView2Window
{
    private CancellationTokenSource? _counterRequest;
    private string? _counterRequestId;
    private readonly SemaphoreSlim _counterGate = new(1, 1);

    private async void OnCounterMessage(object? sender, CoreWebView2WebMessageReceivedEventArgs args)
    {
        // Only the local mapped app can ask. Third-party frames/sites cannot
        // turn this into an arbitrary navigation or script execution bridge.
        if (_disposed || sender is not CoreWebView2 host ||
            !Uri.TryCreate(args.Source, UriKind.Absolute, out var source) ||
            source.GetLeftPart(UriPartial.Authority) != _policy.Origin.GetLeftPart(UriPartial.Authority)) return;
        string? id = null;
        CancellationTokenSource? request = null;
        try
        {
            using var message = JsonDocument.Parse(args.WebMessageAsJson);
            var root = message.RootElement;
            if (!root.TryGetProperty("type", out var typeValue) || !root.TryGetProperty("id", out var idValue)) return;
            var type = typeValue.GetString();
            id = idValue.GetString();
            if (id is null || id.Length > 80) return;
            if (type == "ugg-counters-cancel")
            {
                if (_counterRequestId == id) _counterRequest?.Cancel();
                return;
            }
            if (type != "ugg-counters") return;
            var slug = root.GetProperty("slug").GetString();
            var lane = root.GetProperty("lane").GetString();
            var enemy = root.GetProperty("enemy").GetInt32();
            var url = UggCounters.BuildUrl(slug, lane);
            if (url is null || enemy <= 0) return;
            _counterRequest?.Cancel();
            request = new CancellationTokenSource(TimeSpan.FromSeconds(30));
            _counterRequest = request;
            _counterRequestId = id;
            await _counterGate.WaitAsync(request.Token);
            try
            {
                var data = await ReadUggCountersAsync(url, enemy, lane!, request.Token);
                request.Token.ThrowIfCancellationRequested();
                if (!_disposed) host.PostWebMessageAsJson(JsonSerializer.Serialize(new {
                    type = "ugg-counters-result", id, sourceUrl = url.AbsoluteUri,
                    patch = data.GetProperty("patch").GetString(), rows = data.GetProperty("rows")
                }));
            }
            finally { _counterGate.Release(); }
        }
        catch (Exception error)
        {
            if (!_disposed && id is not null && _counterRequestId == id)
            {
                LogLifecycle($"u.gg counters: {error.GetType().Name}");
                try { host.PostWebMessageAsJson(JsonSerializer.Serialize(new {
                    type = "ugg-counters-result", id, error = "u.gg counters unavailable"
                })); } catch { }
            }
        }
        finally
        {
            if (ReferenceEquals(_counterRequest, request)) { _counterRequest = null; _counterRequestId = null; }
            request?.Dispose();
        }
    }

    private async Task<JsonElement> ReadUggCountersAsync(Uri url, int enemy, string lane, CancellationToken token)
    {
        // A separate worker prevents counter requests interrupting rune/item
        // navigations. The bounded request always releases its WebView.
        var browser = new WebView2 { Width = 0, Height = 0, Visibility = Visibility.Collapsed,
            Focusable = false, IsHitTestVisible = false, AllowExternalDrop = false };
        AutoImportHost.Children.Add(browser);
        try
        {
            var environment = GetState(CompanionTab.UGg)?.Environment ??
                await _environmentService.CreateAsync(CompanionTabs.ProfileFolder(_userDataFolder, CompanionTab.UGg), token);
            token.ThrowIfCancellationRequested();
            await browser.EnsureCoreWebView2Async(environment);
            token.ThrowIfCancellationRequested();
            var core = browser.CoreWebView2;
            core.NewWindowRequested += (_, e) => e.Handled = true;
            core.PermissionRequested += (_, e) => e.State = CoreWebView2PermissionState.Deny;
            core.LaunchingExternalUriScheme += (_, e) => e.Cancel = true;
            core.NavigationStarting += (_, e) => {
                if (!Uri.TryCreate(e.Uri, UriKind.Absolute, out var next) ||
                    next.Scheme != "https" || next.Host != "u.gg" || next.AbsolutePath != url.AbsolutePath)
                    e.Cancel = true;
            };
            ConfigureAdBlocking(core);
            var ready = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            core.DOMContentLoaded += (_, _) => ready.TrySetResult();
            core.Navigate(url.AbsoluteUri);
            await ready.Task.WaitAsync(token);
            var script = UggCounters.Script(enemy, lane);
            while (true)
            {
                token.ThrowIfCancellationRequested();
                if (_disposed) throw new OperationCanceledException();
                if (Uri.TryCreate(core.Source, UriKind.Absolute, out var current) &&
                    current.Host == url.Host && current.AbsolutePath == url.AbsolutePath)
                {
                    var json = await core.ExecuteScriptAsync(script);
                    if (json != "null")
                    {
                        using var parsed = JsonDocument.Parse(json);
                        if (parsed.RootElement.ValueKind == JsonValueKind.Object)
                            return parsed.RootElement.Clone();
                    }
                }
                await Task.Delay(250, token);
            }
        }
        finally
        {
            AutoImportHost.Children.Remove(browser);
            browser.Dispose();
        }
    }
}
