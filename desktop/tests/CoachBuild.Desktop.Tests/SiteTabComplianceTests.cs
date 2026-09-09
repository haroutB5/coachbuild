using System.Text.RegularExpressions;
using CoachBuild.Desktop.Web;
using Xunit;

namespace CoachBuild.Desktop.Tests;

/// <summary>Scope pins for third-party WebView2 scripts, navigation and request blocking.</summary>
public sealed class SiteTabComplianceTests
{
    private const string WindowSource = "Web/WebView2Window.xaml.cs";
    private const string WindowMarkup = "Web/WebView2Window.xaml";
    private const string AutoImportSource = "Web/SiteAutoImport.cs";

    [Fact]
    public void The_source_files_these_tests_read_actually_exist()
    {
        Assert.Contains("class WebView2Window", ReadSource(WindowSource), StringComparison.Ordinal);
        Assert.Contains("class AutoImportCoordinator", ReadSource(AutoImportSource), StringComparison.Ordinal);
        Assert.Contains("OpGgTabButton", ReadSource(WindowMarkup), StringComparison.Ordinal);
    }

    [Fact]
    public void Runes_buttons_and_the_offer_bar_are_removed()
    {
        var source = ReadSource(WindowSource);
        var markup = ReadSource(WindowMarkup);
        Assert.Contains("NotifySnapshotForAutoImport", source, StringComparison.Ordinal);
        foreach (var removed in new[]
        {
            "ImportRunesButton", "OfferBar", "OnImportRunesClick",
            "RunesButtonFor", "ShouldShowRunesImport", "ShouldShowOfferBar",
        })
        {
            Assert.DoesNotContain(removed, source + markup, StringComparison.Ordinal);
        }
    }

    [Fact]
    public void Site_scripts_are_limited_to_automatic_reads_and_consent()
    {
        var source = ReadSource(WindowSource);
        var allowedSites = new HashSet<string>(
            [
                "ExtractVisibleOnUiAsync", "FetchViaWorkerOnUiAsync",
                "FetchCoachlessRunesOnUiAsync", "DismissConsentAsync",
                "DismissMyStatsConsentAsync",
            ],
            StringComparer.Ordinal);
        foreach (var method in allowedSites) Assert.Contains(method, source, StringComparison.Ordinal);
        Assert.DoesNotContain("RunCoachlessWalkAsync", source, StringComparison.Ordinal);
        Assert.DoesNotContain("CoachlessStepScript", source, StringComparison.Ordinal);

        var invocations = Regex.Matches(source, @"\.\s*ExecuteScriptAsync\s*\(");
        Assert.True(invocations.Count >= allowedSites.Count);
        foreach (Match invocation in invocations)
        {
            Assert.Contains(EnclosingMethod(source, invocation.Index), allowedSites);
            var callText = source.Substring(invocation.Index, Math.Min(600, source.Length - invocation.Index));
            Assert.True(
                callText.Contains("UGgScript", StringComparison.Ordinal) ||
                callText.Contains("CoachlessItemsScript", StringComparison.Ordinal) ||
                callText.Contains("CoachlessRunesScript", StringComparison.Ordinal) ||
                callText.Contains("ConsentDismissScript", StringComparison.Ordinal));
        }
    }

    [Fact]
    public void The_mystats_tab_runs_only_the_named_consent_step()
    {
        var source = ReadSource(WindowSource);
        var start = source.IndexOf("private async Task DismissMyStatsConsentAsync", StringComparison.Ordinal);
        var end = source.IndexOf("/// The executor's Coachless RUNES fetch", start, StringComparison.Ordinal);
        Assert.True(start > 0 && end > start);
        var body = source[start..end];
        Assert.Contains("ConsentDismissScript", body, StringComparison.Ordinal);
        Assert.DoesNotContain("UGgScript", body, StringComparison.Ordinal);
        Assert.DoesNotContain("CoachlessItemsScript", body, StringComparison.Ordinal);
        Assert.DoesNotContain("CoachlessRunesScript", body, StringComparison.Ordinal);
        Assert.DoesNotContain("Navigate(", body, StringComparison.Ordinal);
        Assert.DoesNotContain("Reload(", body, StringComparison.Ordinal);
    }

    [Fact]
    public void Automated_navigation_reaches_only_the_two_allowlisted_worker_paths()
    {
        var source = ReadSource(WindowSource);
        AssertGuards(source, "private async Task<bool> NavigateWorkerAndWaitAsync", "IsAllowedAutoImportTarget");
        AssertGuards(source, "private async Task<bool> NavigateRunesWorkerAndWaitAsync", "IsAllowedRunesTarget");
        var coreCalls = Regex.Matches(source, @"NavigateAndWaitCoreAsync\(")
            .Select(call => EnclosingMethod(source, call.Index))
            .ToHashSet(StringComparer.Ordinal);
        Assert.Equal(
            new HashSet<string>(["NavigateWorkerAndWaitAsync", "NavigateRunesWorkerAndWaitAsync"], StringComparer.Ordinal),
            coreCalls);

        var triggerStart = source.IndexOf("public void NotifySnapshotForAutoImport", StringComparison.Ordinal);
        var triggerEnd = source.IndexOf("private ", triggerStart + 10, StringComparison.Ordinal);
        Assert.True(triggerStart > 0 && triggerEnd > triggerStart);
        Assert.Contains("OnSnapshotAsync", source[triggerStart..triggerEnd], StringComparison.Ordinal);
        Assert.DoesNotContain("Navigate(", source[triggerStart..triggerEnd], StringComparison.Ordinal);
    }

    [Fact]
    public void Ad_filter_is_applied_to_site_tabs_and_workers_but_not_draft()
    {
        var source = ReadSource(WindowSource);
        Assert.Contains("AddWebResourceRequestedFilter", source, StringComparison.Ordinal);
        Assert.Contains("WebResourceRequested +=", source, StringComparison.Ordinal);
        Assert.Contains("SiteAdBlockingPolicy.TryGetBlockedDomain", source, StringComparison.Ordinal);
        Assert.Contains("debug: ads: blocked", source, StringComparison.Ordinal);
        Assert.Contains("_blockedAdDomainsLogged.Add(domain)", source, StringComparison.Ordinal);

        var configureStart = source.IndexOf("private void ConfigureBrowser", StringComparison.Ordinal);
        var configureEnd = source.IndexOf("private void ConfigureAdBlocking", configureStart, StringComparison.Ordinal);
        Assert.True(configureStart > 0 && configureEnd > configureStart);
        var configure = source[configureStart..configureEnd];
        Assert.Contains("state.Tab != CompanionTab.Companion", configure, StringComparison.Ordinal);
        Assert.Contains("ConfigureAdBlocking(webView)", configure, StringComparison.Ordinal);

        var workerStart = source.IndexOf("private async Task<CoreWebView2?> EnsureWorkerCoreAsync", StringComparison.Ordinal);
        var workerEnd = source.IndexOf("public void ReleaseImportWorkers", workerStart, StringComparison.Ordinal);
        Assert.True(workerStart > 0 && workerEnd > workerStart);
        Assert.Contains("ConfigureAdBlocking(worker.Core)", source[workerStart..workerEnd], StringComparison.Ordinal);
    }

    [Fact]
    public void No_timer_or_background_looper_triggers_a_scrape()
    {
        var source = ReadSource(WindowSource);
        Assert.Contains("NotifySnapshotForAutoImport", source, StringComparison.Ordinal);
        Assert.DoesNotContain("DispatcherTimer", source, StringComparison.Ordinal);
        Assert.DoesNotContain("System.Timers", source, StringComparison.Ordinal);
        Assert.DoesNotContain("System.Threading.Timer", source, StringComparison.Ordinal);
        Assert.DoesNotContain("CompositionTarget", source, StringComparison.Ordinal);
        Assert.DoesNotContain("Tick +=", source, StringComparison.Ordinal);
    }

    private static void AssertGuards(string source, string signature, string guard)
    {
        var start = source.IndexOf(signature, StringComparison.Ordinal);
        Assert.True(start > 0);
        var end = source.IndexOf("private ", start + 10, StringComparison.Ordinal);
        Assert.True(end > start);
        Assert.Contains(guard, source[start..end], StringComparison.Ordinal);
    }

    private static string EnclosingMethod(string source, int index)
    {
        var declarations = Regex.Matches(
            source[..index], @"\n    (?:private|public|internal)[^\n{]*?\b(\w+)\s*\(");
        Assert.NotEmpty(declarations);
        return declarations[^1].Groups[1].Value;
    }

    private static string ReadSource(string relativePath)
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null)
        {
            var candidate = Path.Combine(
                directory.FullName, "src", "CoachBuild.Desktop",
                relativePath.Replace('/', Path.DirectorySeparatorChar));
            if (File.Exists(candidate)) return File.ReadAllText(candidate);
            directory = directory.Parent;
        }
        throw new FileNotFoundException($"Could not locate {relativePath} above {AppContext.BaseDirectory}.");
    }
}
