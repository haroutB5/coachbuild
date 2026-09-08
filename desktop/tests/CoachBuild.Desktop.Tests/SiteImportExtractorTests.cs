using CoachBuild.Desktop.Web;
using Xunit;

namespace CoachBuild.Desktop.Tests;

/// <summary>
/// The extractor scripts' static contract: what MUST be in the shipped JS
/// (anchors, injected maps, failure strings) and what MUST NOT (any network
/// or navigation primitive — these scripts run against third-party pages, so
/// "read-only DOM" is a test, not a comment).
/// </summary>
public sealed class SiteImportExtractorTests
{
    [Fact]
    public void The_ugg_template_ships_with_the_icon_tables_injected()
    {
        // Controls: the template and the tables it is injected from.
        Assert.Contains("__PERK_MAP_JSON__", SiteImportExtractors.UGgTemplate, StringComparison.Ordinal);
        Assert.DoesNotContain("__PERK_MAP_JSON__", SiteImportExtractors.UGgScript, StringComparison.Ordinal);
        Assert.DoesNotContain("__SHARD_MAP_JSON__", SiteImportExtractors.UGgScript, StringComparison.Ordinal);

        // Spot entries, including the treacherous shard alias: the
        // SCALING-named icon is the flat-health shard (fixture-proved).
        Assert.Contains("\"electrocute\":8112", SiteImportExtractors.UGgScript, StringComparison.Ordinal);
        Assert.Contains("\"adaptiveforce\":5008", SiteImportExtractors.UGgScript, StringComparison.Ordinal);
        Assert.Contains("\"healthscaling\":5011", SiteImportExtractors.UGgScript, StringComparison.Ordinal);
    }

    [Fact]
    public void The_coachless_step_template_needs_no_icon_tables()
    {
        // The walk reads item ids numerically off /img/item/{id} and never
        // resolves the clicked keystone to an id, so there is nothing to
        // inject: the template carries the step token and every built step
        // must carry no leftover token.
        Assert.Contains(
            "__COACHLESS_STEP_JSON__", SiteImportExtractors.CoachlessStepTemplate, StringComparison.Ordinal);
        foreach (var step in new[]
            {
                SiteImportSteps.Inspect(),
                SiteImportSteps.Click("1st Item"),
                SiteImportSteps.Read(),
            })
            Assert.DoesNotContain(
                "__COACHLESS_STEP_JSON__",
                SiteImportExtractors.CoachlessStepScript(step),
                StringComparison.Ordinal);
    }

    [Fact]
    public void The_scripts_use_the_fixture_derived_anchors()
    {
        Assert.Contains(".rune-trees-container", SiteImportExtractors.UGgScript, StringComparison.Ordinal);
        Assert.Contains(".perk.perk-active", SiteImportExtractors.UGgScript, StringComparison.Ordinal);
        Assert.Contains(".stat-shard-row", SiteImportExtractors.UGgScript, StringComparison.Ordinal);
        Assert.Contains(".rank-img", SiteImportExtractors.UGgScript, StringComparison.Ordinal);
        Assert.Contains("rec_core_items", SiteImportExtractors.UGgScript, StringComparison.Ordinal);
        // Escaped in the JS regex literal (\/runes\/(\d+)\.png): the style-id anchor.
        Assert.Contains("\\/runes\\/", SiteImportExtractors.UGgScript, StringComparison.Ordinal);

        Assert.Contains("data-row", SiteImportExtractors.CoachlessStepTemplate, StringComparison.Ordinal);
        Assert.Contains("entry-name", SiteImportExtractors.CoachlessStepTemplate, StringComparison.Ordinal);
        // Escaped in the JS regex literal (\/img\/item\/(\d+)\.): the item-id anchor.
        Assert.Contains("\\/img\\/item\\/", SiteImportExtractors.CoachlessStepTemplate, StringComparison.Ordinal);
        // The walk's two new anchors: the site's own selection marker and
        // the top-row click that drives the conditioned recompute.
        Assert.Contains("'active'", SiteImportExtractors.CoachlessStepTemplate, StringComparison.Ordinal);
        Assert.Contains("dispatchEvent", SiteImportExtractors.CoachlessStepTemplate, StringComparison.Ordinal);
        Assert.Contains("already-selected", SiteImportExtractors.CoachlessStepTemplate, StringComparison.Ordinal);
    }

    [Fact]
    public void Only_the_coachless_walk_clicks_the_page()
    {
        // Control: both scripts under test are non-empty real scripts.
        Assert.Contains("JSON.stringify", SiteImportExtractors.UGgScript, StringComparison.Ordinal);
        Assert.Contains("JSON.stringify", SiteImportExtractors.CoachlessInspectScript, StringComparison.Ordinal);
        // The u.gg import is a read; the click is the Coachless import's
        // approved scope and must never leak into the static extractor.
        Assert.DoesNotContain("dispatchEvent", SiteImportExtractors.UGgScript, StringComparison.Ordinal);
        Assert.DoesNotContain(".click(", SiteImportExtractors.UGgScript, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("fetch(")]
    [InlineData("XMLHttpRequest")]
    [InlineData("WebSocket")]
    [InlineData("EventSource")]
    [InlineData(".navigate(")]
    [InlineData("location.assign")]
    [InlineData("location.replace")]
    [InlineData("location.href =")]
    [InlineData("location.href=")]
    [InlineData("ExecuteScriptAsync")]
    public void The_scripts_cannot_reach_the_network_or_move_the_page(string forbidden)
    {
        // Control: the scripts under test are non-empty real scripts.
        Assert.Contains("JSON.stringify", SiteImportExtractors.UGgScript, StringComparison.Ordinal);
        Assert.Contains("JSON.stringify", SiteImportExtractors.CoachlessInspectScript, StringComparison.Ordinal);
        Assert.DoesNotContain(forbidden, SiteImportExtractors.UGgScript, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain(forbidden, SiteImportExtractors.CoachlessInspectScript, StringComparison.OrdinalIgnoreCase);
        // Every Coachless step — inspect, click, and final read alike —
        // runs against the third-party page, so the ban covers all three.
        // (The click step's dispatchEvent is the approved scope, not a
        // navigation primitive, and is pinned by its own test above.)
        Assert.DoesNotContain(
            forbidden,
            SiteImportExtractors.CoachlessStepScript(SiteImportSteps.Click("1st Item")),
            StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain(
            forbidden,
            SiteImportExtractors.CoachlessStepScript(SiteImportSteps.Read()),
            StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void Scripts_resolve_per_site_tab_and_never_for_the_hosted_one()
    {
        Assert.Same(SiteImportExtractors.UGgScript, SiteImportExtractors.ScriptFor(CompanionTab.UGg));
        Assert.Same(SiteImportExtractors.CoachlessInspectScript, SiteImportExtractors.ScriptFor(CompanionTab.Coachless));
        Assert.Null(SiteImportExtractors.ScriptFor(CompanionTab.Companion));
    }

    [Theory]
    [InlineData(CompanionTab.UGg, "https://u.gg/lol/champions/jhin/build/adc", true)]
    [InlineData(CompanionTab.UGg, "https://u.gg/lol/champions/jhin/build", true)]
    [InlineData(CompanionTab.UGg, "https://www.u.gg/lol/champions/ahri/build/mid?foo=1", true)]
    [InlineData(CompanionTab.UGg, "https://u.gg/lol/champions/jhin", false)]
    [InlineData(CompanionTab.UGg, "https://u.gg/", false)]
    [InlineData(CompanionTab.UGg, "https://coachless.gg/builds/jhin?role=adc", false)]
    [InlineData(CompanionTab.Coachless, "https://coachless.gg/builds/jhin?role=adc", true)]
    [InlineData(CompanionTab.Coachless, "https://coachless.gg/builds/wukong", true)]
    [InlineData(CompanionTab.Coachless, "https://coachless.gg/", false)]
    [InlineData(CompanionTab.Coachless, "https://coachless.gg/builds/creator", false)]
    [InlineData(CompanionTab.Coachless, "https://u.gg/lol/champions/jhin/build/adc", false)]
    [InlineData(CompanionTab.Companion, "https://u.gg/lol/champions/jhin/build/adc", false)]
    [InlineData(CompanionTab.UGg, null, false)]
    [InlineData(CompanionTab.UGg, "not a url", false)]
    public void Build_page_shape_gates_each_site(CompanionTab tab, string? url, bool expected)
    {
        Assert.Equal(expected, SiteImportExtractors.CanImportFromUrl(tab, url));
    }

    [Theory]
    [InlineData(CompanionTab.UGg, "https://u.gg/lol/champions/jhin/build/adc", true)]
    [InlineData(CompanionTab.UGg, "https://u.gg/", false)]
    [InlineData(CompanionTab.Coachless, "https://coachless.gg/builds/jhin?role=adc", true)]
    [InlineData(CompanionTab.Companion, "https://u.gg/lol/champions/jhin/build/adc", false)]
    public void The_offer_bar_import_visibility_follows_the_url_shape(
        CompanionTab tab, string? url, bool expected)
    {
        Assert.Equal(expected, WebView2Window.ShouldShowImport(tab, url));
    }
}
