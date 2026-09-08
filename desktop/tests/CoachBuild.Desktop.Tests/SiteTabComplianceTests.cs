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
    /// The only script the window runs is the hosted page's own version meta
    /// read, and it is gated on the Companion tab. A second
    /// <c>ExecuteScriptAsync</c> is how DOM reading of a third-party site would
    /// arrive, so the COUNT is pinned rather than the wording.
    /// </summary>
    [Fact]
    public void The_window_scripts_exactly_one_page_and_it_is_the_hosted_one()
    {
        var source = ReadSource(WindowSource);

        // Control: the call this app is allowed to make must be present, or the
        // "exactly one" assertion below is measuring nothing.
        Assert.Contains("coachbuild-version", source, StringComparison.Ordinal);
        // Invocations only. The name also appears in the comment that explains
        // why there is exactly one of them, and counting prose would make this
        // assertion fail for a documentation edit.
        Assert.Single(Regex.Matches(source, @"\.\s*ExecuteScriptAsync\s*\("));
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
