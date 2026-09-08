using CoachBuild.Core;
using CoachBuild.Desktop.Web;
using Xunit;

namespace CoachBuild.Desktop.Tests;

/// <summary>
/// The 2.1.0 field-test fixes that are decidable without a browser: the
/// Coachless runes deep link and its allowlist, the consent-step parse, and
/// the idle-teardown policy.
///
/// <para>What these CANNOT prove is stated once here rather than implied:
/// none of them runs the extractor JS against a page. The DOM anchors are
/// asserted as anchors (they must be the ones the captured fixture shows),
/// and the pick rule is proven against the client validator in the Core
/// suite — but that the browser reads those cards needs the live site.</para>
/// </summary>
public sealed class SiteTabLifecycleTests
{
    // ── The Coachless runes deep link ────────────────────────────────────────

    [Theory]
    [InlineData("Nasus", 0, "https://coachless.gg/runes/tree/nasus/precision/domination?role=top")]
    [InlineData("Ahri", 2, "https://coachless.gg/runes/tree/ahri/precision/domination?role=mid")]
    // Wukong folds to the ddragon key exactly as the build links do.
    [InlineData("MonkeyKing", 1, "https://coachless.gg/runes/tree/monkeyking/precision/domination?role=jungle")]
    public void The_runes_link_is_the_slug_role_shape(string champion, int roleId, string expected)
    {
        Assert.Equal(expected, SiteDeepLink.CoachlessRunesUrl(champion, roleId)?.AbsoluteUri);
    }

    [Fact]
    public void An_unknown_role_drops_the_role_rather_than_guessing_one()
    {
        Assert.Equal(
            "https://coachless.gg/runes/tree/nasus/precision/domination",
            SiteDeepLink.CoachlessRunesUrl("Nasus", null)?.AbsoluteUri);
    }

    [Fact]
    public void An_unaddressable_champion_yields_no_runes_link()
    {
        Assert.Null(SiteDeepLink.CoachlessRunesUrl(null, 0));
        Assert.Null(SiteDeepLink.CoachlessRunesUrl("   ", 0));
    }

    /// <summary>
    /// The probe pair must be two DIFFERENT trees: a same-tree pair is not a
    /// valid rune page, and the site would have nothing to snap it to.
    /// </summary>
    [Fact]
    public void The_probe_tree_pair_is_two_real_and_different_trees()
    {
        Assert.NotEqual(SiteDeepLink.RunesProbePrimary, SiteDeepLink.RunesProbeSecondary);
        Assert.True(PerkTreeNames.Resolve(SiteDeepLink.RunesProbePrimary) > 0);
        Assert.True(PerkTreeNames.Resolve(SiteDeepLink.RunesProbeSecondary) > 0);
    }

    /// <summary>
    /// The site REDIRECTS a probe pair to the pair it recommends (verified
    /// live 2026-09-08: nasus/precision/domination landed on
    /// nasus/precision/resolve). So the recognizer must accept the page we
    /// land on, not only the one we asked for.
    /// </summary>
    [Theory]
    [InlineData("https://coachless.gg/runes/tree/nasus/precision/domination?role=top", true)]
    [InlineData("https://coachless.gg/runes/tree/nasus/precision/resolve?role=top", true)]
    [InlineData("https://www.coachless.gg/runes/tree/ahri/sorcery/inspiration", true)]
    // Not a runes page shape.
    [InlineData("https://coachless.gg/builds/nasus?role=top", false)]
    [InlineData("https://coachless.gg/runes/tree/nasus/precision", false)]
    [InlineData("https://coachless.gg/runes/tree/nasus/precision/domination/extra", false)]
    // A tree name the catalog does not know is refused, not guessed.
    [InlineData("https://coachless.gg/runes/tree/nasus/precision/nonsense", false)]
    // Another host wearing the same path.
    [InlineData("https://evil.example/runes/tree/nasus/precision/resolve", false)]
    public void The_runes_url_recognizer_accepts_the_landed_pair(string url, bool expected)
    {
        Assert.Equal(expected, SiteImportExtractors.IsCoachlessRunesUrl(new Uri(url)));
    }

    // ── The runes allowlist ──────────────────────────────────────────────────

    [Fact]
    public void The_runes_allowlist_accepts_only_this_apps_own_link()
    {
        var allowed = SiteDeepLink.CoachlessRunesUrl("Nasus", 0)!;
        Assert.True(AutoImportCoordinator.IsAllowedRunesTarget(allowed, "Nasus", 0));

        // A different champion, a different role, or a hand-built shape --
        // all refused before anything navigates.
        Assert.False(AutoImportCoordinator.IsAllowedRunesTarget(allowed, "Ahri", 0));
        Assert.False(AutoImportCoordinator.IsAllowedRunesTarget(allowed, "Nasus", 2));
        Assert.False(AutoImportCoordinator.IsAllowedRunesTarget(
            new Uri("https://coachless.gg/runes/tree/nasus/precision/resolve?role=top"), "Nasus", 0));
        Assert.False(AutoImportCoordinator.IsAllowedRunesTarget(null, "Nasus", 0));
        Assert.False(AutoImportCoordinator.IsAllowedRunesTarget(allowed, null, 0));
    }

    // ── The consent step ─────────────────────────────────────────────────────

    [Fact]
    public void A_dismissed_wall_parses_and_names_the_site()
    {
        // The envelope ExecuteScriptAsync really returns: a JSON-encoded
        // string wrapping the object.
        var outcome = ConsentDismissal.Parse("\"{\\\"dismissed\\\":true,\\\"reason\\\":\\\"coachless\\\"}\"");

        Assert.True(outcome.Dismissed);
        Assert.Equal("coachless", outcome.Reason);
        Assert.Equal("Coachless: dismissed consent dialog", outcome.LogLine("Coachless"));
    }

    [Fact]
    public void The_ordinary_no_wall_case_is_quiet()
    {
        var outcome = ConsentDismissal.Parse("""{"dismissed":false,"reason":"none"}""");

        Assert.False(outcome.Dismissed);
        // Nothing to say: a log line per import tick for "no wall today" is
        // noise that would bury the line that matters.
        Assert.Null(outcome.LogLine("Coachless"));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("not json at all")]
    [InlineData("[1,2,3]")]
    [InlineData("""{"dismissed":"yes"}""")]
    public void An_unreadable_consent_answer_degrades_to_nothing_dismissed(string? raw)
    {
        var outcome = ConsentDismissal.Parse(raw);

        Assert.False(outcome.Dismissed);
        Assert.Equal("none", outcome.Reason);
    }

    // ── The idle teardown policy ─────────────────────────────────────────────

    private static readonly DateTimeOffset Now =
        new(2026, 9, 8, 18, 0, 0, TimeSpan.Zero);

    private static TabIdleSnapshot Tab(
        CompanionTab tab,
        double idleMinutes,
        bool visible = false,
        bool hasBrowser = true) =>
        new(tab, visible, hasBrowser, Now.AddMinutes(-idleMinutes));

    [Fact]
    public void A_site_tab_idle_past_the_timeout_is_disposed()
    {
        Assert.Equal(
            TabIdleDecision.Dispose,
            SiteTabIdlePolicy.Decide(Tab(CompanionTab.UGg, 11), Now));
    }

    [Theory]
    [InlineData(0)]
    [InlineData(5)]
    [InlineData(9.9)]
    // Exactly the timeout survives one more sweep: a strict comparison keeps
    // the boundary off clock granularity.
    [InlineData(10)]
    public void A_site_tab_inside_the_timeout_is_kept(double idleMinutes)
    {
        Assert.Equal(
            TabIdleDecision.Keep,
            SiteTabIdlePolicy.Decide(Tab(CompanionTab.Coachless, idleMinutes), Now));
    }

    [Fact]
    public void The_visible_tab_is_never_disposed_however_long_it_has_been_open()
    {
        Assert.Equal(
            TabIdleDecision.Keep,
            SiteTabIdlePolicy.Decide(Tab(CompanionTab.UGg, 600, visible: true), Now));
    }

    [Fact]
    public void The_draft_tab_is_never_disposed()
    {
        // Not even invisible and long idle: it is the app's own surface and
        // must be instant when champ select starts.
        Assert.Equal(
            TabIdleDecision.Keep,
            SiteTabIdlePolicy.Decide(Tab(CompanionTab.Companion, 600), Now));
    }

    [Fact]
    public void A_tab_with_no_browser_is_already_free()
    {
        // Otherwise the sweep would log a teardown per tick for a tab that
        // has nothing to tear down.
        Assert.Equal(
            TabIdleDecision.Keep,
            SiteTabIdlePolicy.Decide(Tab(CompanionTab.OpGg, 600, hasBrowser: false), Now));
    }

    [Fact]
    public void The_sweep_returns_exactly_the_due_tabs()
    {
        var due = SiteTabIdlePolicy.Sweep(
            [
                Tab(CompanionTab.Companion, 600),                 // draft: kept
                Tab(CompanionTab.UGg, 600, visible: true),        // visible: kept
                Tab(CompanionTab.Coachless, 11),                  // due
                Tab(CompanionTab.OpGg, 60),                       // due
            ],
            Now);

        Assert.Equal([CompanionTab.Coachless, CompanionTab.OpGg], due);
    }

    [Fact]
    public void The_teardown_lines_name_the_tab_and_the_reason()
    {
        var down = SiteTabIdlePolicy.TeardownLine(CompanionTab.Coachless);
        var up = SiteTabIdlePolicy.RecreateLine(CompanionTab.Coachless);

        Assert.Contains("Coachless", down, StringComparison.Ordinal);
        Assert.Contains("10", down, StringComparison.Ordinal);
        Assert.Contains("Coachless", up, StringComparison.Ordinal);
        Assert.NotEqual(down, up);
    }

    /// <summary>
    /// The timeout is one constant, per the brief. If someone inlines a
    /// second copy this stays green — so this asserts the value AND that the
    /// policy actually reads it, by driving the boundary from the constant
    /// itself rather than from a hardcoded 10.
    /// </summary>
    [Fact]
    public void The_timeout_lives_in_one_place_and_the_policy_uses_it()
    {
        Assert.Equal(TimeSpan.FromMinutes(10), SiteTabIdlePolicy.IdleTimeout);

        var justInside = new TabIdleSnapshot(
            CompanionTab.UGg, false, true, Now - SiteTabIdlePolicy.IdleTimeout);
        var justOutside = new TabIdleSnapshot(
            CompanionTab.UGg, false, true,
            Now - SiteTabIdlePolicy.IdleTimeout - TimeSpan.FromSeconds(1));

        Assert.Equal(TabIdleDecision.Keep, SiteTabIdlePolicy.Decide(justInside, Now));
        Assert.Equal(TabIdleDecision.Dispose, SiteTabIdlePolicy.Decide(justOutside, Now));
    }

    // ── The op.gg home check ─────────────────────────────────────────────────

    [Theory]
    [InlineData("https://op.gg/", true)]
    [InlineData("https://op.gg", true)]
    [InlineData("https://www.op.gg/", true)]
    // A tracking query must not make home look like a chosen destination.
    [InlineData("https://op.gg/?utm_source=x", true)]
    // A profile the user is reading is NOT home, so the retry leaves it alone.
    [InlineData("https://op.gg/summoners/euw/Someone-EUW", false)]
    [InlineData("https://op.gg/lol/champions", false)]
    [InlineData("https://u.gg/", false)]
    [InlineData("not a url", false)]
    public void Only_op_gg_landing_counts_as_home(string url, bool expected)
    {
        Assert.Equal(expected, WebView2Window.IsOpGgHome(url));
    }

    // ── The runes extractor's anchors ────────────────────────────────────────

    /// <summary>
    /// The runes script must read the anchors the captured fixture actually
    /// shows. This is a source assertion, not a behavioural one: it cannot
    /// prove the script runs, but it fails loudly if someone edits an anchor
    /// away from the evidence.
    /// </summary>
    [Fact]
    public void The_runes_script_reads_the_fixtures_own_anchors()
    {
        var script = SiteImportExtractors.CoachlessRunesScript;

        // The four slot-row containers, exactly as coachless-nasus-runes.html
        // groups them (one container per row -- no chunking by threes).
        Assert.Contains(".primary-runes", script, StringComparison.Ordinal);
        Assert.Contains(".secondary-runes", script, StringComparison.Ordinal);
        Assert.Contains(".modifier-shards", script, StringComparison.Ordinal);
        Assert.Contains("keystone-selector", script, StringComparison.Ordinal);
        Assert.Contains("secondary-selector", script, StringComparison.Ordinal);
        Assert.Contains("shard-selector", script, StringComparison.Ordinal);
        Assert.Contains("cl-rune-card", script, StringComparison.Ordinal);
        Assert.Contains("cl-rune-shard-icon", script, StringComparison.Ordinal);
        Assert.Contains(".rune-delta", script, StringComparison.Ordinal);
        // Cards the site has no sample for are skipped, never read as zero.
        Assert.Contains("is-empty", script, StringComparison.Ordinal);

        // All three id tables are injected, or every lookup silently yields 0.
        Assert.DoesNotContain("__PERK_MAP_JSON__", script, StringComparison.Ordinal);
        Assert.DoesNotContain("__SHARD_MAP_JSON__", script, StringComparison.Ordinal);
        Assert.DoesNotContain("__TREE_MAP_JSON__", script, StringComparison.Ordinal);
        Assert.Contains("\"fleetfootwork\":8021", script, StringComparison.Ordinal);
        Assert.Contains("\"ah\":5007", script, StringComparison.Ordinal);
        Assert.Contains("\"precision\":8000", script, StringComparison.Ordinal);

        // Read-only: this page is never clicked and never navigated.
        Assert.DoesNotContain("dispatchEvent", script, StringComparison.Ordinal);
        Assert.DoesNotContain("location.href =", script, StringComparison.Ordinal);
        Assert.DoesNotContain("fetch(", script, StringComparison.Ordinal);

        // The trees come from the rendered icons, never from the URL -- the
        // URL may still name the pair we ASKED for.
        // Escaped, because it is a JS regex literal in the script.
        Assert.Contains(@"perk-images\/Styles\/", script, StringComparison.Ordinal);
    }

    /// <summary>
    /// The u.gg script must NOT have picked up the Coachless shard aliases:
    /// the two tables were split precisely so u.gg's injected map stays what
    /// it was.
    /// </summary>
    [Fact]
    public void The_ugg_script_keeps_the_shared_shard_table()
    {
        var ugg = SiteImportExtractors.UGgScript;

        foreach (var alias in ShardIconMap.CoachlessAliases.Keys)
            Assert.DoesNotContain($"\"{alias}\":", ugg, StringComparison.Ordinal);
        // Control: it does carry the shared table.
        Assert.Contains("\"adaptiveforce\":5008", ugg, StringComparison.Ordinal);
    }
}
