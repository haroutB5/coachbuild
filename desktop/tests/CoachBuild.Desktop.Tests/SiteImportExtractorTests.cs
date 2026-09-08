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
    public void Both_templates_ship_with_the_icon_tables_injected()
    {
        // Controls: the templates and the tables they are injected from.
        Assert.Contains("__PERK_MAP_JSON__", SiteImportExtractors.UGgTemplate, StringComparison.Ordinal);
        Assert.DoesNotContain("__PERK_MAP_JSON__", SiteImportExtractors.UGgScript, StringComparison.Ordinal);
        Assert.DoesNotContain("__SHARD_MAP_JSON__", SiteImportExtractors.UGgScript, StringComparison.Ordinal);
        Assert.DoesNotContain("__PERK_MAP_JSON__", SiteImportExtractors.CoachlessScript, StringComparison.Ordinal);
        Assert.DoesNotContain("__SHARD_MAP_JSON__", SiteImportExtractors.CoachlessScript, StringComparison.Ordinal);

        // Spot entries, including the treacherous shard alias: the
        // SCALING-named icon is the flat-health shard (fixture-proved).
        Assert.Contains("\"electrocute\":8112", SiteImportExtractors.UGgScript, StringComparison.Ordinal);
        Assert.Contains("\"adaptiveforce\":5008", SiteImportExtractors.UGgScript, StringComparison.Ordinal);
        Assert.Contains("\"healthscaling\":5011", SiteImportExtractors.UGgScript, StringComparison.Ordinal);
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

        Assert.Contains("data-row", SiteImportExtractors.CoachlessScript, StringComparison.Ordinal);
        Assert.Contains("entry-name", SiteImportExtractors.CoachlessScript, StringComparison.Ordinal);
        // Escaped in the JS regex literal (\/img\/item\/(\d+)\.): the item-id anchor.
        Assert.Contains("\\/img\\/item\\/", SiteImportExtractors.CoachlessScript, StringComparison.Ordinal);
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
        Assert.Contains("JSON.stringify", SiteImportExtractors.CoachlessScript, StringComparison.Ordinal);
        Assert.DoesNotContain(forbidden, SiteImportExtractors.UGgScript, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain(forbidden, SiteImportExtractors.CoachlessScript, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void Scripts_resolve_per_site_tab_and_never_for_the_hosted_one()
    {
        Assert.Same(SiteImportExtractors.UGgScript, SiteImportExtractors.ScriptFor(CompanionTab.UGg));
        Assert.Same(SiteImportExtractors.CoachlessScript, SiteImportExtractors.ScriptFor(CompanionTab.Coachless));
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
