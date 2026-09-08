using System.Text.RegularExpressions;
using Xunit;

namespace CoachBuild.Desktop.Tests;

/// <summary>
/// "We only render these sites" is a claim about code, and it stops being true
/// the first time someone adds a convenient little script call. These are the
/// assertions that make it fail loudly instead.
///
/// <para>Since 1.3.0 the claim has a sanctioned exception, and these tests pin
/// its exact shape rather than pretending it does not exist: the runes button
/// reads the visible u.gg page once per click, and the automatic item import
/// extracts (visible page or background/hidden worker) on champ-select lock.
/// Scripts remain extractor steps ONLY, and automated navigation reaches
/// exactly one call site whose target must satisfy the deep-link allowlist.
/// Every absence assertion here carries a control group, and that
/// is not decoration. The desktop 1.0.23 shipped-bytes check passed on its
/// first run and was vacuous — the tool it used did not exist on the machine,
/// so every symbol read absent. A source test that cannot find its source file
/// fails the same way: silently, green. The control asserts a string that MUST
/// be present, so a bad path fails the test rather than passing it.</para>
/// </summary>
public sealed class SiteTabComplianceTests
{
    private const string WindowSource = "Web/WebView2Window.xaml.cs";
    private const string WindowMarkup = "Web/WebView2Window.xaml";
    private const string TabsSource = "Web/CompanionTabs.cs";
    private const string AutoImportSource = "Web/SiteAutoImport.cs";

    [Fact]
    public void The_source_files_these_tests_read_actually_exist()
    {
        // The control group for every assertion below. Without it a moved file
        // turns all of them into vacuous passes.
        Assert.Contains("class WebView2Window", ReadSource(WindowSource), StringComparison.Ordinal);
        Assert.Contains("class SiteNavigationPolicy", ReadSource(TabsSource), StringComparison.Ordinal);
        Assert.Contains("class AutoImportCoordinator", ReadSource(AutoImportSource), StringComparison.Ordinal);
        Assert.Contains("OpGgTabButton", ReadSource(WindowMarkup), StringComparison.Ordinal);
    }

    [Fact]
    public void Opgg_is_a_profile_tab_not_an_offer_or_auto_import_site()
    {
        var markup = ReadSource(WindowMarkup);
        var autoImport = ReadSource(AutoImportSource);

        Assert.Contains("OpGgTabButton", markup, StringComparison.Ordinal);
        Assert.DoesNotContain("OpGgOfferButton", markup, StringComparison.Ordinal);
        Assert.Contains(
            "BothSites = [CompanionTab.UGg, CompanionTab.Coachless]",
            autoImport,
            StringComparison.Ordinal);
        Assert.DoesNotContain("CompanionTab.OpGg", autoImport, StringComparison.Ordinal);
    }

    /// <summary>
    /// The window runs a script in exactly FIVE call sites: the hosted page's
    /// own version meta read, the user-initiated runes import, the Coachless
    /// walk both auto paths share, and the u.gg single-shot in each of the
    /// two auto fetch paths (visible extract, worker fetch). The Coachless
    /// walk may LOOP (inspect, click-next-slot, final read until the walk
    /// converges), so what is pinned is the SITES, not the invocation count:
    /// every <c>ExecuteScriptAsync</c> in the file must sit inside one of the
    /// five, and every one must run an extractor step and nothing else. A
    /// script call anywhere else — a navigation hook, a poll tick, a new
    /// helper nobody owns — is how a background scrape of a third-party site
    /// would arrive.
    /// </summary>
    [Fact]
    public void The_window_scripts_only_version_read_runes_click_and_auto_fetch_sites()
    {
        var source = ReadSource(WindowSource);

        // Controls: every call family this app is allowed to make must be
        // present, or the site assertions below are measuring nothing.
        Assert.Contains("coachbuild-version", source, StringComparison.Ordinal);
        Assert.Contains("RunRunesImportAsync", source, StringComparison.Ordinal);
        Assert.Contains("RunCoachlessWalkAsync", source, StringComparison.Ordinal);
        Assert.Contains("ExtractVisibleOnUiAsync", source, StringComparison.Ordinal);
        Assert.Contains("FetchViaWorkerOnUiAsync", source, StringComparison.Ordinal);
        // Invocations only. The names also appear in prose; counting comments
        // would make this assertion fail for a documentation edit.
        var invocations = Regex.Matches(source, @"\.\s*ExecuteScriptAsync\s*\(");
        Assert.True(invocations.Count >= 5, "control: all five script families must exist");
        var allowedSites = new HashSet<string>(
            [
                "QueryLoadedWebVersionAsync",
                "RunRunesImportAsync",
                "RunCoachlessWalkAsync",
                "ExtractVisibleOnUiAsync",
                "FetchViaWorkerOnUiAsync",
            ],
            StringComparer.Ordinal);
        foreach (Match invocation in invocations)
            Assert.Contains(EnclosingMethod(source, invocation.Index), allowedSites);
        // Control the other way: each site must still hold at least one
        // call, so a deleted fetch does not pass as "no third call".
        var sites = invocations
            .Select(invocation => EnclosingMethod(source, invocation.Index))
            .ToHashSet(StringComparer.Ordinal);
        Assert.Equal(allowedSites.Count, sites.Count);
        Assert.Subset(allowedSites, sites);
        // Extractor steps only: every invocation runs one of the three
        // shipped scripts (or the version meta read), never a hand-rolled
        // DOM query smuggled in at the call site.
        foreach (Match invocation in invocations)
        {
            var callText = source.Substring(
                invocation.Index, Math.Min(600, source.Length - invocation.Index));
            Assert.True(
                callText.Contains("UGgScript", StringComparison.Ordinal) ||
                callText.Contains("CoachlessStepScript(", StringComparison.Ordinal) ||
                callText.Contains("CoachlessInspectScript", StringComparison.Ordinal) ||
                callText.Contains("coachbuild-version", StringComparison.Ordinal),
                "every script call must run an extractor step");
        }
    }

    /// <summary>
    /// The version read is reached only for the Companion tab. Without the
    /// guard, a site tab completing a navigation would run a script against
    /// u.gg or coachless.gg — harmless in intent, still a DOM read of someone
    /// else's page.
    /// </summary>
    [Fact]
    public void The_version_read_is_gated_on_the_companion_tab()
    {
        var source = ReadSource(WindowSource);
        var index = source.IndexOf("ExecuteScriptAsync", StringComparison.Ordinal);
        Assert.True(index > 0, "control: the scripted call must exist to be gated");

        // The tab guard has to appear between the navigation-completed handler
        // and the script call, not merely somewhere in a 1,000-line file.
        var preceding = source[..index];
        var lastGuard = preceding.LastIndexOf(
            "state.Tab != CompanionTab.Companion",
            StringComparison.Ordinal);
        var lastHandler = preceding.LastIndexOf(
            "private async Task ReadLoadedWebVersionAsync",
            StringComparison.Ordinal);
        Assert.True(
            lastGuard > 0 && lastGuard < index,
            "the version read must sit behind a Companion-tab guard");
        Assert.True(lastHandler > 0, "control: the version read helper must exist");
    }

    /// <summary>
    /// The runes button's script call sits inside its click handler and
    /// nothing else: no navigation-completed hook, no poll tick, no event
    /// may reach it. The handler also cannot Navigate or Reload — the import
    /// READS the page the user is on; moving it would turn a read into a
    /// redirect. It writes runes only (ImportRunesAsync, never the full
    /// build path): items arrive via the automatic import.
    /// </summary>
    [Fact]
    public void The_runes_script_is_reachable_only_from_its_click_handler()
    {
        var source = ReadSource(WindowSource);
        var start = source.IndexOf(
            "private async Task RunRunesImportAsync",
            StringComparison.Ordinal);
        Assert.True(start > 0, "control: the runes handler must exist");

        var end = source.IndexOf("private void OnZoomOutClick", start, StringComparison.Ordinal);
        Assert.True(end > start, "control: the member after it must exist");

        var body = source[start..end];
        Assert.Contains("ExecuteScriptAsync", body, StringComparison.Ordinal);
        // Control: the handler must still hand the scrape to the host --
        // through the RUNES path, never the full build path.
        Assert.Contains("ImportRunesAsync", body, StringComparison.Ordinal);
        Assert.DoesNotContain("ImportBuildAsync", body, StringComparison.Ordinal);
        Assert.DoesNotContain("Navigate(", body, StringComparison.Ordinal);
        Assert.DoesNotContain("Reload(", body, StringComparison.Ordinal);
    }

    /// <summary>
    /// The Coachless step loop is shared by exactly the two auto-import fetch
    /// paths: the visible extract and the worker fetch. The helper that
    /// re-invokes the per-step scripts has exactly two callers plus its own
    /// definition — the runes button must never reach it (u.gg needs no
    /// walk), nor may a timer tick or a navigation hook. This is the control
    /// group for the loop the sites test above permits: the fetch may
    /// re-invoke, but only from the auto-import.
    /// </summary>
    [Fact]
    public void The_coachless_step_loop_is_reachable_only_from_the_auto_fetch_paths()
    {
        var source = ReadSource(WindowSource);

        // Controls: the helper and both callers must exist, or the count
        // below is measuring nothing.
        Assert.Contains(
            "private async Task<string> RunCoachlessWalkAsync",
            source,
            StringComparison.Ordinal);
        Assert.Contains(
            "private async Task<string?> ExtractVisibleOnUiAsync",
            source,
            StringComparison.Ordinal);
        Assert.Contains(
            "private async Task<string?> FetchViaWorkerOnUiAsync",
            source,
            StringComparison.Ordinal);
        // Definition + exactly two calls. The name appears nowhere else in
        // the window — not in prose, not in a third call site — so any new
        // reachability fails this count.
        var uses = Regex.Matches(source, @"RunCoachlessWalkAsync");
        Assert.Equal(3, uses.Count);

        foreach (var caller in new[]
            {
                "private async Task<string?> ExtractVisibleOnUiAsync",
                "private async Task<string?> FetchViaWorkerOnUiAsync",
            })
        {
            var start = source.IndexOf(caller, StringComparison.Ordinal);
            var end = source.IndexOf("private ", start + caller.Length, StringComparison.Ordinal);
            Assert.True(end > start, $"control: the member after {caller} must exist");
            Assert.Contains(
                "RunCoachlessWalkAsync(core, cancellationToken)",
                source[start..end],
                StringComparison.Ordinal);
        }
    }

    /// <summary>
    /// Automated navigation reaches exactly ONE call site — the auto-import
    /// worker fetch — and that site asserts the deep-link allowlist before
    /// moving anything. Every other Navigate in the file is a user-initiated
    /// or chrome-initiated move (offer chip, popup, home, hosted policy).
    /// The snapshot trigger (<c>NotifySnapshotForAutoImport</c>) only starts
    /// the service and contains no navigation itself.
    /// </summary>
    [Fact]
    public void Automated_navigation_reaches_only_the_allowlisted_worker_call_site()
    {
        var source = ReadSource(WindowSource);

        // Controls: every navigation family must exist, or the enumeration
        // below is measuring nothing.
        Assert.Contains("OpenSiteOfferAsync", source, StringComparison.Ordinal);
        Assert.Contains("NavigateSiteHome", source, StringComparison.Ordinal);
        Assert.Contains("NavigateHosted", source, StringComparison.Ordinal);
        Assert.Contains("NavigateWorkerAndWaitAsync", source, StringComparison.Ordinal);
        Assert.Contains("NotifySnapshotForAutoImport", source, StringComparison.Ordinal);

        // Sibling calls (Navigate(state, ...)): user/chrome moves only.
        var siblingCalls = Regex.Matches(source, @"(?<![\w.])Navigate\(state,");
        Assert.True(siblingCalls.Count >= 4, "control: the chrome navigation calls must exist");
        var allowedSiblings = new HashSet<string>(
            ["OnNewWindowRequested", "NavigateHosted", "NavigateSiteHome", "OpenSiteOfferAsync"],
            StringComparer.Ordinal);
        foreach (Match call in siblingCalls)
            Assert.Contains(EnclosingMethod(source, call.Index), allowedSiblings);
        var siblingSites = siblingCalls
            .Select(call => EnclosingMethod(source, call.Index))
            .ToHashSet(StringComparer.Ordinal);
        Assert.Equal(allowedSiblings.Count, siblingSites.Count);
        Assert.Subset(allowedSiblings, siblingSites);

        // Dotted calls (the primitive plus the worker): the worker is the
        // only automated one, and it asserts the allowlist in the same body.
        var dottedCalls = Regex.Matches(source, @"\.Navigate\(");
        Assert.True(dottedCalls.Count >= 2, "control: the primitive and the worker navigate must exist");
        var allowedDotted = new HashSet<string>(
            ["Navigate", "NavigateWorkerAndWaitAsync"],
            StringComparer.Ordinal);
        foreach (Match call in dottedCalls)
            Assert.Contains(EnclosingMethod(source, call.Index), allowedDotted);
        var dottedSites = dottedCalls
            .Select(call => EnclosingMethod(source, call.Index))
            .ToHashSet(StringComparer.Ordinal);
        Assert.Equal(allowedDotted.Count, dottedSites.Count);
        Assert.Subset(allowedDotted, dottedSites);

        var workerStart = source.IndexOf(
            "private async Task<bool> NavigateWorkerAndWaitAsync",
            StringComparison.Ordinal);
        var workerEnd = source.IndexOf("private ", workerStart + 10, StringComparison.Ordinal);
        Assert.True(workerEnd > workerStart, "control: the member after the worker navigate must exist");
        Assert.Contains(
            "IsAllowedAutoImportTarget",
            source[workerStart..workerEnd],
            StringComparison.Ordinal);

        // The trigger starts work; it does not move pages.
        var triggerStart = source.IndexOf(
            "public void NotifySnapshotForAutoImport",
            StringComparison.Ordinal);
        Assert.True(triggerStart > 0, "control: the auto-import trigger must exist");
        var triggerEnd = source.IndexOf("private ", triggerStart + 10, StringComparison.Ordinal);
        Assert.True(triggerEnd > triggerStart, "control: the member after the trigger must exist");
        Assert.DoesNotContain("Navigate(", source[triggerStart..triggerEnd], StringComparison.Ordinal);
        Assert.Contains("OnSnapshotAsync", source[triggerStart..triggerEnd], StringComparison.Ordinal);
    }

    /// <summary>
    /// No timer, no looper, no render hook in the window may trigger a
    /// scrape: the runes import runs once per user click, and the automatic
    /// import rides the EXISTING 750 ms snapshot poll (it is offered the
    /// snapshot; it single-flights and fetches in the background). The
    /// window owns no timer of its own, so the absence is pinned outright;
    /// the sibling sites test is what ties "no trigger" to "no third-party
    /// script call". (The Coachless settle pause and the worker load wait
    /// are plain awaited delays inside their handlers, not timers — no
    /// looper may REACH the fetch, but the fetch itself may await the page.)
    /// </summary>
    [Fact]
    public void No_timer_or_background_trigger_exists_for_a_scrape()
    {
        var source = ReadSource(WindowSource);

        // Control: this is the window file and both entry points exist, or
        // the absences below are measuring nothing.
        Assert.Contains("class WebView2Window", source, StringComparison.Ordinal);
        Assert.Contains("OnImportRunesClick", source, StringComparison.Ordinal);
        Assert.Contains("NotifySnapshotForAutoImport", source, StringComparison.Ordinal);
        Assert.DoesNotContain("DispatcherTimer", source, StringComparison.Ordinal);
        Assert.DoesNotContain("System.Timers", source, StringComparison.Ordinal);
        Assert.DoesNotContain("System.Threading.Timer", source, StringComparison.Ordinal);
        Assert.DoesNotContain("CompositionTarget", source, StringComparison.Ordinal);
        Assert.DoesNotContain("Tick +=", source, StringComparison.Ordinal);
    }

    /// <summary>
    /// The champ-select context entry point updates the chip and cannot
    /// navigate; the auto-import trigger it sits next to only starts the
    /// service (pinned above to contain no navigation).
    /// </summary>
    [Fact]
    public void Champ_select_context_updates_the_chip_and_cannot_navigate()
    {
        var source = ReadSource(WindowSource);
        var start = source.IndexOf(
            "public void UpdateChampSelectContext",
            StringComparison.Ordinal);
        Assert.True(start > 0, "control: the context entry point must exist");

        var end = source.IndexOf("public void GoBack", start, StringComparison.Ordinal);
        Assert.True(end > start, "control: the method after it must exist");

        var body = source[start..end];
        Assert.DoesNotContain("Navigate", body, StringComparison.Ordinal);
        Assert.DoesNotContain("Reload", body, StringComparison.Ordinal);
        // Control: the method must still do the one thing it is for.
        Assert.Contains("UpdateOfferBar", body, StringComparison.Ordinal);
    }

    private static string EnclosingMethod(string source, int index)
    {
        // The nearest preceding member declaration: window members each start
        // their own line at one indent level, so continuations and call sites
        // cannot match.
        var preceding = source[..index];
        var declarations = Regex.Matches(
            preceding,
            @"\n    (?:private|public|internal)[^\n{]*?\b(\w+)\s*\(");
        Assert.NotEmpty(declarations);
        return declarations[^1].Groups[1].Value;
    }

    private static string ReadSource(string relativePath)
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null)
        {
            var candidate = Path.Combine(
                directory.FullName,
                "src",
                "CoachBuild.Desktop",
                relativePath.Replace('/', Path.DirectorySeparatorChar));
            if (File.Exists(candidate)) return File.ReadAllText(candidate);
            directory = directory.Parent;
        }

        // Never silently return empty: an unreadable source is a broken probe,
        // not a compliant codebase.
        throw new FileNotFoundException(
            $"Could not locate {relativePath} above {AppContext.BaseDirectory}.");
    }
}
