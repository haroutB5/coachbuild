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

    /// <summary>
    /// Every script this app runs on a third-party page is one of the shipped
    /// consts, run from one of the named automatic reads. Nothing else.
    ///
    /// <para>2.2.2 added ONE indirection: <c>ReadWithSettleAsync</c>, the
    /// re-read loop the runes leg has used since 2.1.0 and the items leg now
    /// uses too, takes its script as a parameter. So the pin is in two halves —
    /// the loop may only ever execute its own <c>script</c> argument, and every
    /// caller of the loop must name a shipped const. An unnamed script cannot
    /// reach a page through either half.</para>
    /// </summary>
    [Fact]
    public void Site_scripts_are_limited_to_automatic_reads_and_consent()
    {
        var source = ReadSource(WindowSource);
        var namedReads = new HashSet<string>(
            [
                "ExtractVisibleOnUiAsync", "FetchViaWorkerOnUiAsync",
                "FetchCoachlessRunesOnUiAsync", "DismissConsentAsync",
                "DismissMyStatsConsentAsync", "ReadItemsWithSettleAsync",
            ],
            StringComparer.Ordinal);
        foreach (var method in namedReads) Assert.Contains(method, source, StringComparison.Ordinal);
        Assert.DoesNotContain("RunCoachlessWalkAsync", source, StringComparison.Ordinal);
        Assert.DoesNotContain("CoachlessStepScript", source, StringComparison.Ordinal);

        // Half one: who may call ExecuteScriptAsync at all, and with what.
        var runners = new HashSet<string>(
            ["ReadWithSettleAsync", "DismissConsentAsync", "DismissMyStatsConsentAsync"],
            StringComparer.Ordinal);
        var invocations = Regex.Matches(source, @"\.\s*ExecuteScriptAsync\s*\(");
        Assert.True(invocations.Count >= runners.Count, $"{invocations.Count} ExecuteScriptAsync calls");
        foreach (Match invocation in invocations)
        {
            var method = EnclosingMethod(source, invocation.Index);
            Assert.Contains(method, runners);
            var callText = source.Substring(invocation.Index, Math.Min(600, source.Length - invocation.Index));
            // The settle loop runs the script it was HANDED and never picks one.
            var allowed = method == "ReadWithSettleAsync"
                ? callText.Contains("ExecuteScriptAsync(script)", StringComparison.Ordinal)
                : callText.Contains("ConsentDismissScript", StringComparison.Ordinal);
            Assert.True(allowed, method + " :: " + callText[..Math.Min(80, callText.Length)]);
        }

        // Half two: every hand-off into the settle loop names a shipped const,
        // and every such call site is one of the named automatic reads.
        var settleCalls = Regex.Matches(source, @"ReadWithSettleAsync\s*\(\s*\n?\s*core,");
        Assert.True(settleCalls.Count >= 2, $"{settleCalls.Count} settle hand-offs");
        foreach (Match call in settleCalls)
        {
            Assert.Contains(EnclosingMethod(source, call.Index), namedReads);
            var callText = source.Substring(call.Index, Math.Min(600, source.Length - call.Index));
            Assert.True(
                callText.Contains("UGgScript", StringComparison.Ordinal) ||
                callText.Contains("CoachlessItemsScript", StringComparison.Ordinal) ||
                callText.Contains("CoachlessRunesScript", StringComparison.Ordinal),
                callText[..Math.Min(120, callText.Length)]);
        }
    }

    /// <summary>
    /// 2.2.2. BOTH item reads settle, not just the runes one. Field log
    /// 2026-09-09 13:11:17: the worker's one-shot Coachless items read returned
    /// <c>0 tables on the page</c> off a page that renders six, while the runes
    /// leg of the same run settled over 4 reads and succeeded. Neither items
    /// read may execute a script on its own any more.
    /// </summary>
    [Fact]
    public void Both_item_reads_go_through_the_settle_loop()
    {
        var source = ReadSource(WindowSource);
        foreach (var reader in new[] { "ExtractVisibleOnUiAsync", "FetchViaWorkerOnUiAsync" })
        {
            var start = source.IndexOf("private async Task<string?> " + reader, StringComparison.Ordinal);
            Assert.True(start > 0, reader + " not found");
            var end = source.IndexOf("\n    }", start, StringComparison.Ordinal);
            Assert.True(end > start, reader + " body not bounded");
            var body = source[start..end];
            Assert.Contains("ReadItemsWithSettleAsync(", body, StringComparison.Ordinal);
            Assert.DoesNotContain("ExecuteScriptAsync", body, StringComparison.Ordinal);
        }
        // The runes read keeps the loop it has had since 2.1.0 — one loop now.
        Assert.Contains("ReadWithSettleAsync(", source, StringComparison.Ordinal);
        Assert.Equal(1, Regex.Matches(source, @"private async Task<string\?> ReadWithSettleAsync").Count);
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
