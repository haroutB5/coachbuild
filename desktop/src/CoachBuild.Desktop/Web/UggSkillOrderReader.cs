using System.Text.Json;
using System.Windows;
using System.Windows.Threading;
using CoachBuild.Core;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;

namespace CoachBuild.Desktop.Web;

/// <summary>u.gg supplies data only; the existing provider owns caching and retries.</summary>
public sealed class UggSkillOrderReader(
    Dispatcher dispatcher,
    string profileRoot,
    Func<IChampionDirectory?> champions,
    Action<string>? log = null)
{
    private readonly SemaphoreSlim _gate = new(1, 1);

    public async Task<SkillOrderResult> FetchAsync(int championId, int roleId, CancellationToken token)
    {
        if (roleId is < 0 or > 4 || championId <= 0)
            return new(SkillOrderStatus.NoData, OverlaySkillOrder.Empty, championId);
        var directory = champions();
        var roster = directory is null ? null : await directory.LoadAsync(token).ConfigureAwait(false);
        var champion = roster?.FirstOrDefault(c => c.Id == championId);
        if (champion is null) return new(SkillOrderStatus.Error, OverlaySkillOrder.Empty, championId);
        var url = SiteDeepLink.Build(CompanionTab.UGg, champion.Key, roleId);
        if (url is null) return new(SkillOrderStatus.NoData, OverlaySkillOrder.Empty, championId);
        await _gate.WaitAsync(token).ConfigureAwait(false);
        try
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(token);
            timeout.CancelAfter(TimeSpan.FromSeconds(30));
            var result = await dispatcher.InvokeAsync(() => ReadAsync(url, championId,
                SiteDeepLink.RoleToken(roleId)!, timeout.Token)).Task.Unwrap().ConfigureAwait(false);
            log?.Invoke($"skill-order: u.gg {champion.Key} {SiteDeepLink.RoleToken(roleId)} {result.Status}; {result.Order.Order.Count} levels, {result.SampleSize} games");
            return result;
        }
        finally { _gate.Release(); }
    }

    private async Task<SkillOrderResult> ReadAsync(Uri url, int championId, string lane, CancellationToken token)
    {
        // This temporary hidden host survives Research-window closure at game
        // start and cannot navigate or evict the user's item/rune browsers.
        var browser = new WebView2 { Focusable = false, IsHitTestVisible = false, AllowExternalDrop = false };
        var host = new Window { Width = 1, Height = 1, Opacity = 0, ShowActivated = false,
            ShowInTaskbar = false, WindowStyle = WindowStyle.None, Content = browser };
        try
        {
            host.Show();
            var environment = await new WebView2EnvironmentService(profileRoot).CreateAsync(
                CompanionTabs.ProfileFolder(profileRoot, CompanionTab.UGg), token);
            token.ThrowIfCancellationRequested();
            await browser.EnsureCoreWebView2Async(environment);
            token.ThrowIfCancellationRequested();
            var core = browser.CoreWebView2;
            core.NewWindowRequested += (_, e) => e.Handled = true;
            core.PermissionRequested += (_, e) => e.State = CoreWebView2PermissionState.Deny;
            core.LaunchingExternalUriScheme += (_, e) => e.Cancel = true;
            core.DownloadStarting += (_, e) => e.Cancel = true;
            core.AddWebResourceRequestedFilter("*", CoreWebView2WebResourceContext.All);
            core.WebResourceRequested += (_, e) => {
                if (SiteAdBlockingPolicy.TryGetBlockedDomain(e.Request.Uri, out var blockedDomain))
                    e.Response = core.Environment.CreateWebResourceResponse(Stream.Null, 403, "Blocked", "Content-Length: 0");
            };
            core.NavigationStarting += (_, e) => {
                if (!Uri.TryCreate(e.Uri, UriKind.Absolute, out var next) ||
                    next.Scheme != "https" || next.Host != "u.gg" || next.AbsolutePath != url.AbsolutePath)
                    e.Cancel = true;
            };
            var ready = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            core.DOMContentLoaded += (_, _) => ready.TrySetResult();
            core.Navigate(url.AbsoluteUri);
            await ready.Task.WaitAsync(token);
            while (true)
            {
                token.ThrowIfCancellationRequested();
                var raw = await core.ExecuteScriptAsync(Script(championId, lane)).WaitAsync(token);
                if (raw != "null")
                {
                    using var document = JsonDocument.Parse(raw);
                    return Parse(document.RootElement, championId);
                }
                await Task.Delay(250, token);
            }
        }
        finally { browser.Dispose(); host.Close(); }
    }

    public static string Script(int championId, string lane) => """
        (() => {
          const text = document.getElementById('reactn-preloaded-state')?.textContent || '';
          const marker = 'window.__SSR_DATA__ = ';
          const start = text.indexOf(marker), end = text.indexOf('window.__APOLLO_STATE__', start);
          if (start < 0 || end < 0) return null;
          try {
            const state = JSON.parse(text.slice(start + marker.length, end).trim().replace(/;$/, ''));
            const entries = Object.entries(state).filter(([key]) =>
              key.startsWith('overview_emerald_plus_world_recommended::https://stats2.u.gg/lol/') &&
              key.includes('/overview/') && key.includes('/ranked_solo_5x5/__CHAMP__/'));
            if (entries.length !== 1) return null;
            const bucket = entries[0][1].data?.['world_emerald_plus_' + __LANE__];
            return { path: bucket?.rec_skill_path ?? null };
          } catch { return null; }
        })()
        """.Replace("__CHAMP__", championId.ToString(System.Globalization.CultureInfo.InvariantCulture))
        .Replace("__LANE__", JsonSerializer.Serialize(lane));

    public static SkillOrderResult Parse(JsonElement root, int championId)
    {
        SkillOrderResult Error() => new(SkillOrderStatus.Error, OverlaySkillOrder.Empty, championId);
        if (root.ValueKind != JsonValueKind.Object || !root.TryGetProperty("path", out var path)) return Error();
        if (path.ValueKind == JsonValueKind.Null) return new(SkillOrderStatus.NoData, OverlaySkillOrder.Empty, championId);
        if (path.ValueKind != JsonValueKind.Object || !path.TryGetProperty("slots", out var slots) ||
            slots.ValueKind != JsonValueKind.Array || slots.GetArrayLength() is < 1 or > 18 ||
            !path.TryGetProperty("matches", out var matches) || !matches.TryGetInt32(out var sample) || sample <= 0)
            return Error();
        var order = new List<OverlayAbility>();
        foreach (var slot in slots.EnumerateArray())
        {
            if (slot.ValueKind != JsonValueKind.String || slot.GetString() is not ("Q" or "W" or "E" or "R")) return Error();
            order.Add(Enum.Parse<OverlayAbility>(slot.GetString()!));
        }
        return new(SkillOrderStatus.Ok, new(order, order.Count, order.Count == 18, "published"), championId, sample);
    }
}
