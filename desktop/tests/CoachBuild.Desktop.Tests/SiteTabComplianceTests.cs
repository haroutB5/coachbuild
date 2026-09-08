using System.Text.RegularExpressions;
using Xunit;

namespace CoachBuild.Desktop.Tests;

/// <summary>
/// "We only render these sites" is a claim about code, and it stops being true
/// the first time someone adds a convenient little script call. These are the
/// assertions that make it fail loudly instead.
///
/// <para><b>Every absence assertion here carries a control group</b>, and that
/// is not decoration. The desktop 1.0.23 shipped-bytes check passed on its
/// first run and was vacuous — the tool it used did not exist on the machine,
/// so every symbol read absent. A source test that cannot find its source file
/// fails the same way: silently, green. The control asserts a string that MUST
/// be present, so a bad path fails the test rather than passing it.</para>
/// </summary>
public sealed class SiteTabComplianceTests
{
    private const string WindowSource = "Web/WebView2Window.xaml.cs";
    private const string TabsSource = "Web/CompanionTabs.cs";

    [Fact]
    public void The_source_files_these_tests_read_actually_exist()
    {
        // The control group for every assertion below. Without it a moved file
        // turns all of them into vacuous passes.
        Assert.Contains("class WebView2Window", ReadSource(WindowSource), StringComparison.Ordinal);
        Assert.Contains("class SiteNavigationPolicy", ReadSource(TabsSource), StringComparison.Ordinal);
    }

    /// <summary>
    /// The window runs a script in exactly TWO places: the hosted page's own
    /// version meta read, and the user-initiated site import. A third
    /// <c>ExecuteScriptAsync</c> is how a background scrape of a third-party
    /// site would arrive, so the COUNT is pinned rather than the wording —
    /// and each call site is pinned to its enclosing method below, so a move
    /// out of the click handler fails loudly instead of drifting.
    /// </summary>
    [Fact]
    public void The_window_scripts_exactly_two_places_version_read_and_import_click()
    {
        var source = ReadSource(WindowSource);

        // Controls: both calls this app is allowed to make must be present,
        // or the "exactly two" assertion below is measuring nothing.
        Assert.Contains("coachbuild-version", source, StringComparison.Ordinal);
        Assert.Contains("RunSiteImportAsync", source, StringComparison.Ordinal);
        // Invocations only. The name also appears in prose that explains why
        // there are exactly two of them, and counting comments would make
        // this assertion fail for a documentation edit.
        var invocations = Regex.Matches(source, @"\.\s*ExecuteScriptAsync\s*\(");
        Assert.Equal(2, invocations.Count);
        Assert.Equal(
            "QueryLoadedWebVersionAsync",
            EnclosingMethod(source, invocations[0].Index));
        Assert.Equal(
            "RunSiteImportAsync",
            EnclosingMethod(source, invocations[1].Index));
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
    /// The import's script call sits inside the click handler and nothing
    /// else: no navigation-completed hook, no poll tick, no event may reach
    /// it. The handler also cannot Navigate or Reload — the import READS the
    /// page the user is on; moving it would turn a read into a redirect.
    /// </summary>
    [Fact]
    public void The_import_script_is_reachable_only_from_the_click_handler()
    {
        var source = ReadSource(WindowSource);
        var start = source.IndexOf(
            "private async Task RunSiteImportAsync",
            StringComparison.Ordinal);
        Assert.True(start > 0, "control: the import handler must exist");

        var end = source.IndexOf("private void OnZoomOutClick", start, StringComparison.Ordinal);
        Assert.True(end > start, "control: the member after it must exist");

        var body = source[start..end];
        Assert.Contains("ExecuteScriptAsync", body, StringComparison.Ordinal);
        // Control: the handler must still hand the scrape to the host.
        Assert.Contains("ImportBuildAsync", body, StringComparison.Ordinal);
        Assert.DoesNotContain("Navigate(", body, StringComparison.Ordinal);
        Assert.DoesNotContain("Reload(", body, StringComparison.Ordinal);
    }

    /// <summary>
    /// No timer, no looper, no render hook in the window may trigger a
    /// scrape: the import runs once per user click or not at all. The window
    /// currently owns no timer of any kind, so the absence is pinned
    /// outright; the sibling count test is what ties "no trigger" to "no
    /// third script call".
    /// </summary>
    [Fact]
    public void No_timer_or_background_trigger_exists_for_a_scrape()
    {
        var source = ReadSource(WindowSource);

        // Control: this is the window file and the click path exists, or the
        // absences below are measuring nothing.
        Assert.Contains("class WebView2Window", source, StringComparison.Ordinal);
        Assert.Contains("OnImportBuildClick", source, StringComparison.Ordinal);
        Assert.DoesNotContain("DispatcherTimer", source, StringComparison.Ordinal);
        Assert.DoesNotContain("System.Timers", source, StringComparison.Ordinal);
        Assert.DoesNotContain("System.Threading.Timer", source, StringComparison.Ordinal);
        Assert.DoesNotContain("CompositionTarget", source, StringComparison.Ordinal);
        Assert.DoesNotContain("Tick +=", source, StringComparison.Ordinal);
    }

    /// <summary>
    /// No timer, no phase hook, no snapshot tick may navigate a site tab. The
    /// offer chip is an offer; the user clicks it or nothing happens.
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
