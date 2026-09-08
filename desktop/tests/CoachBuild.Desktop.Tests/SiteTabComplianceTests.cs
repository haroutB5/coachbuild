using System.Text.RegularExpressions;
using CoachBuild.Desktop.Web;
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
    /// The window runs a script in exactly SEVEN call sites: the hosted page's
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
    public void The_window_scripts_only_runes_click_and_auto_fetch_sites()
    {
        var source = ReadSource(WindowSource);

        // Controls: every call family this app is allowed to make must be
        // present, or the site assertions below are measuring nothing.
        Assert.DoesNotContain("coachbuild-version", source, StringComparison.Ordinal);
        Assert.Contains("RunRunesImportAsync", source, StringComparison.Ordinal);
        Assert.Contains("RunCoachlessWalkAsync", source, StringComparison.Ordinal);
        Assert.Contains("ExtractVisibleOnUiAsync", source, StringComparison.Ordinal);
        Assert.Contains("FetchViaWorkerOnUiAsync", source, StringComparison.Ordinal);
        // 2.1.0 adds two sanctioned sites, both named here rather than left
        // to widen the net silently: the Coachless RUNES page read, and the
        // consent-wall dismissal every import path runs first.
        Assert.Contains("FetchCoachlessRunesOnUiAsync", source, StringComparison.Ordinal);
        Assert.Contains("DismissConsentAsync", source, StringComparison.Ordinal);
        // 2.1.0 round 2 adds ONE more, and only one: the MyStats tab's consent
        // dismissal. MyStats is still never scraped and never read -- the only
        // script it may run is the recognized-accept-control click, which is
        // pinned by name here and by shape in the consent test below.
        Assert.Contains("DismissMyStatsConsentAsync", source, StringComparison.Ordinal);
        // Invocations only. The names also appear in prose; counting comments
        // would make this assertion fail for a documentation edit.
        var invocations = Regex.Matches(source, @"\.\s*ExecuteScriptAsync\s*\(");
        Assert.True(invocations.Count >= 7, "control: all seven script families must exist");
        var allowedSites = new HashSet<string>(
            [
                "RunRunesImportAsync",
                "RunCoachlessWalkAsync",
                "ExtractVisibleOnUiAsync",
                "FetchViaWorkerOnUiAsync",
                "FetchCoachlessRunesOnUiAsync",
                "DismissConsentAsync",
                "DismissMyStatsConsentAsync",
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
        // Extractor steps only: every invocation runs one of the shipped
        // scripts, never a hand-rolled DOM query smuggled in at the call site.
        foreach (Match invocation in invocations)
        {
            var callText = source.Substring(
                invocation.Index, Math.Min(600, source.Length - invocation.Index));
            Assert.True(
                callText.Contains("UGgScript", StringComparison.Ordinal) ||
                callText.Contains("CoachlessStepScript(", StringComparison.Ordinal) ||
                callText.Contains("CoachlessInspectScript", StringComparison.Ordinal) ||
                callText.Contains("CoachlessRunesScript", StringComparison.Ordinal) ||
                callText.Contains("ConsentDismissScript", StringComparison.Ordinal),
                "every script call must run an extractor step");
        }
    }

    /// <summary>
    /// The consent-wall click is the ONE interaction the import performs
    /// outside the Coachless slot walk, and it must stay exactly that: a
    /// click on a recognized accept control, never a navigation, never a
    /// reload, never a text-matched "looks like a cookie button" sweep.
    /// </summary>
    [Fact]
    public void The_consent_step_clicks_two_named_accept_controls_and_nothing_else()
    {
        var script = SiteImportExtractors.ConsentDismissScript;

        // The two walls, by the anchors captured in the 2026-09-08 fixtures.
        Assert.Contains("#qc-cmp2-container", script, StringComparison.Ordinal);
        Assert.Contains("#accept-btn", script, StringComparison.Ordinal);
        Assert.Contains(".fc-consent-root", script, StringComparison.Ordinal);
        Assert.Contains("button.fc-cta-consent", script, StringComparison.Ordinal);

        // It must not reach for the reject/more-options siblings that sit in
        // the same footer, nor move the page.
        Assert.DoesNotContain("disagree", script, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("more-options", script, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("do-not-consent", script, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("location.href =", script, StringComparison.Ordinal);
        Assert.DoesNotContain("location.assign", script, StringComparison.Ordinal);
        Assert.DoesNotContain("location.reload", script, StringComparison.Ordinal);
        Assert.DoesNotContain("fetch(", script, StringComparison.Ordinal);
        Assert.DoesNotContain("XMLHttpRequest", script, StringComparison.Ordinal);

        // And it must not guess a button by its words -- an unrecognized wall
        // stays up and the import fails honestly.
        Assert.DoesNotContain("textContent", script, StringComparison.Ordinal);
        Assert.DoesNotContain("innerText", script, StringComparison.Ordinal);
    }

    /// <summary>
    /// MyStats gains a script call site in 2.1.0 round 2 and must gain
    /// NOTHING else. The op.gg consent modal covered the whole tab on first
    /// visit with no way past it (_evidence/live-2.1.0/02-mystats-tab.png), so
    /// this tab now runs the same recognized-accept-control click the import
    /// paths run. It still never extracts, never navigates, never reads the
    /// page: the handler's whole body is the consent script, and the attempt
    /// is armed once per navigation rather than once per completion event
    /// (op.gg is a SPA and fires several).
    /// </summary>
    [Fact]
    public void The_mystats_tab_runs_the_consent_step_and_nothing_else()
    {
        var source = ReadSource(WindowSource);
        var start = source.IndexOf(
            "private async Task DismissMyStatsConsentAsync",
            StringComparison.Ordinal);
        Assert.True(start > 0, "control: the MyStats consent handler must exist");
        var end = source.IndexOf(
            "/// The executor's Coachless RUNES fetch", start, StringComparison.Ordinal);
        Assert.True(end > start, "control: the member after it must exist");

        var body = source[start..end];
        // Control: it must actually run the consent step.
        Assert.Contains("ConsentDismissScript", body, StringComparison.Ordinal);
        // ...and nothing that would turn a dismissal into a scrape or a move.
        Assert.DoesNotContain("UGgScript", body, StringComparison.Ordinal);
        Assert.DoesNotContain("CoachlessRunesScript", body, StringComparison.Ordinal);
        Assert.DoesNotContain("CoachlessStepScript", body, StringComparison.Ordinal);
        Assert.DoesNotContain("CoachlessInspectScript", body, StringComparison.Ordinal);
        Assert.DoesNotContain("Navigate(", body, StringComparison.Ordinal);
        Assert.DoesNotContain("Reload(", body, StringComparison.Ordinal);
        Assert.DoesNotContain("ImportRunesAsync", body, StringComparison.Ordinal);
        Assert.DoesNotContain("ImportBuildAsync", body, StringComparison.Ordinal);

        // One attempt per NAVIGATION: the flag is set before the call and
        // re-armed on NavigationStarting, never in the completed handler.
        Assert.Contains("ConsentAttempted = true", source, StringComparison.Ordinal);
        Assert.Contains(
            "else if (state.Tab == CompanionTab.OpGg) state.ConsentAttempted = false;",
            source,
            StringComparison.Ordinal);
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

        // 2.1.0 removed the zoom chrome buttons, so the member after the
        // handler is the zoom SHORTCUT handler that replaced them.
        var end = source.IndexOf(
            "protected override void OnKeyDown", start, StringComparison.Ordinal);
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
        Assert.Contains("NavigateRunesWorkerAndWaitAsync", source, StringComparison.Ordinal);
        Assert.Contains("NotifySnapshotForAutoImport", source, StringComparison.Ordinal);

        // Sibling calls (Navigate(state, ...)): user/chrome moves only. The
        // op.gg retry joins them in 2.1.0 -- it corrects the MyStats tab to
        // the user's own profile once the client connects, which is the same
        // move NavigateSiteHome would have made had the client been up.
        var siblingCalls = Regex.Matches(source, @"(?<![\w.])Navigate\((?:state|current),");
        Assert.True(siblingCalls.Count >= 5, "control: the chrome navigation calls must exist");
        var allowedSiblings = new HashSet<string>(
            [
                "OnNewWindowRequested",
                "NavigateHosted",
                "NavigateSiteHome",
                "OpenSiteOfferAsync",
                "RetryOpGgProfileAsync",
            ],
            StringComparer.Ordinal);
        foreach (Match call in siblingCalls)
            Assert.Contains(EnclosingMethod(source, call.Index), allowedSiblings);
        var siblingSites = siblingCalls
            .Select(call => EnclosingMethod(source, call.Index))
            .ToHashSet(StringComparer.Ordinal);
        Assert.Equal(allowedSiblings.Count, siblingSites.Count);
        Assert.Subset(allowedSiblings, siblingSites);

        // Dotted calls: the chrome primitive plus the ONE shared
        // navigate-and-wait the two automated paths funnel through.
        var dottedCalls = Regex.Matches(source, @"\.Navigate\(");
        Assert.True(dottedCalls.Count >= 2, "control: the primitive and the worker navigate must exist");
        var allowedDotted = new HashSet<string>(
            ["Navigate", "NavigateAndWaitCoreAsync"],
            StringComparer.Ordinal);
        foreach (Match call in dottedCalls)
            Assert.Contains(EnclosingMethod(source, call.Index), allowedDotted);
        var dottedSites = dottedCalls
            .Select(call => EnclosingMethod(source, call.Index))
            .ToHashSet(StringComparer.Ordinal);
        Assert.Equal(allowedDotted.Count, dottedSites.Count);
        Assert.Subset(allowedDotted, dottedSites);

        // Both automated entries assert their OWN allowlist before reaching
        // the shared primitive -- build pages and runes pages have different
        // allowed shapes, so one shared check would have to be the looser of
        // the two.
        AssertGuards(
            source,
            "private async Task<bool> NavigateWorkerAndWaitAsync",
            "IsAllowedAutoImportTarget");
        AssertGuards(
            source,
            "private async Task<bool> NavigateRunesWorkerAndWaitAsync",
            "IsAllowedRunesTarget");

        // ...and the shared primitive is reachable from exactly those two.
        var coreCalls = Regex.Matches(source, @"NavigateAndWaitCoreAsync\(");
        var coreCallers = coreCalls
            .Select(call => EnclosingMethod(source, call.Index))
            .ToHashSet(StringComparer.Ordinal);
        // Exactly the two allowlisted entries. (The definition's own
        // signature does not count as a caller: EnclosingMethod resolves a
        // match at the signature to the member BEFORE it.)
        Assert.Equal(
            new HashSet<string>(
                ["NavigateWorkerAndWaitAsync", "NavigateRunesWorkerAndWaitAsync"],
                StringComparer.Ordinal),
            coreCallers);

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
    /// A method must assert the named allowlist inside its own body, before
    /// the member that follows it.
    /// </summary>
    private static void AssertGuards(string source, string signature, string guard)
    {
        var start = source.IndexOf(signature, StringComparison.Ordinal);
        Assert.True(start > 0, $"control: {signature} must exist");
        var end = source.IndexOf("private ", start + 10, StringComparison.Ordinal);
        Assert.True(end > start, $"control: the member after {signature} must exist");
        Assert.Contains(guard, source[start..end], StringComparison.Ordinal);
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

        // The member IMMEDIATELY after it. Widening this to a later member
        // (it used to run to GoBack) would sweep unrelated methods into the
        // body and make the assertion below about them instead -- 2.1.0's
        // op.gg retry sits in that gap and legitimately navigates.
        var end = source.IndexOf(
            "public void UpdateSiteImportAvailability", start, StringComparison.Ordinal);
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
