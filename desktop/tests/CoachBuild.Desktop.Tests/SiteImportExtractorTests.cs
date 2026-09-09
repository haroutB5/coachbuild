using System.Text.RegularExpressions;
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
    public void The_coachless_items_template_needs_no_injected_tables()
    {
        Assert.Same(
            SiteImportExtractors.CoachlessItemsTemplate,
            SiteImportExtractors.CoachlessItemsScript);
        Assert.DoesNotContain("__COACHLESS_STEP_JSON__", SiteImportExtractors.CoachlessItemsScript, StringComparison.Ordinal);
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

        Assert.Contains("data-row", SiteImportExtractors.CoachlessItemsTemplate, StringComparison.Ordinal);
        Assert.Contains("entry-name", SiteImportExtractors.CoachlessItemsTemplate, StringComparison.Ordinal);
        // Escaped in the JS regex literal (\/img\/item\/(\d+)\.): the item-id anchor.
        Assert.Contains("\\/img\\/item\\/", SiteImportExtractors.CoachlessItemsTemplate, StringComparison.Ordinal);
        Assert.Contains("usedItemIds", SiteImportExtractors.CoachlessItemsTemplate, StringComparison.Ordinal);
        Assert.Contains("cl-role-selection", SiteImportExtractors.CoachlessItemsTemplate, StringComparison.Ordinal);
        Assert.Contains("'active'", SiteImportExtractors.CoachlessItemsTemplate, StringComparison.Ordinal);

        Assert.Contains("is-low-occurrence", SiteImportExtractors.CoachlessRunesTemplate, StringComparison.Ordinal);
    }

    [Fact]
    public void Coachless_items_keep_wpa_order_but_skip_duplicates_and_place_boots_after_first_item()
    {
        var read = SiteImportExtractors.CoachlessItemsTemplate;

        Assert.Contains("var SLOT_PLAN = [", read, StringComparison.Ordinal);
        Assert.Contains("{ title: '1st Item', source: '1st Item' }", read, StringComparison.Ordinal);
        Assert.Contains("var lateSlots = /^(adc|bottom|bot|carry)$/.test(role) ? 3 : 2;", read, StringComparison.Ordinal);
        Assert.Contains("SLOT_PLAN.push({ title: (late + 4) + 'th Item', source: '4th+ Item' });", read, StringComparison.Ordinal);
        Assert.Contains("looked[e].title === plan.source", read, StringComparison.Ordinal);
        Assert.Contains("usedItemIds.indexOf(candidateIds[ci]) >= 0", read, StringComparison.Ordinal);
        Assert.Contains("if (!candidateIds.length || duplicate) continue;", read, StringComparison.Ordinal);
        // The first non-duplicate row is selected, preserving Coachless's
        // existing top-WPA ordering while avoiding repeated item ids.
        Assert.Contains("row = cand[c];", read, StringComparison.Ordinal);
        Assert.Contains("for (var used = 0; used < ids.length; used++) usedItemIds.push(ids[used]);", read, StringComparison.Ordinal);
        Assert.Contains("blocks.push({ title: plan.title, itemIds: ids });", read, StringComparison.Ordinal);
    }

    [Fact]
    public void Coachless_runes_ignore_dark_low_occurrence_cards_before_wpa_ranking()
    {
        var read = SiteImportExtractors.CoachlessRunesTemplate;

        Assert.Contains("if (hasClass(cards[i], 'is-low-occurrence')) continue;", read, StringComparison.Ordinal);
        Assert.Contains("best = { id: id, delta: delta }", read, StringComparison.Ordinal);
        // Secondary rows are still ranked by WPA, but only after each row's
        // low-occurrence candidates have been removed.
        Assert.Contains("ranked.sort(function (a, b) { return b.delta - a.delta || a.row - b.row; });", read, StringComparison.Ordinal);
    }

    /// <summary>
    /// 2.1.0 field fix. The rendered rank badge is a HINT: the script must
    /// discover the rank tokens the page embeds for the role, and must refuse
    /// rather than pick when the rendered one is absent and several exist.
    /// The BEHAVIOUR is proved against the real 2026-09-08 Nasus-top capture
    /// by <c>_research/site-import/verify-extractors.mjs</c>, which runs this
    /// exact const string; this pins that the shipped string is the one that
    /// oracle exercised.
    /// </summary>
    [Fact]
    public void The_ugg_script_discovers_embedded_rank_keys_instead_of_trusting_the_badge()
    {
        var script = SiteImportExtractors.UGgScript;
        Assert.Contains("\"world_([a-z0-9_]+?)_", script, StringComparison.Ordinal);
        Assert.Contains("refused rather than guessed", script, StringComparison.Ordinal);
        foreach (var stage in new[] { "url-recognized", "json-found", "keys-found", "blocks-built" })
            Assert.Contains(stage, script, StringComparison.Ordinal);
        // The notes have to travel on the payload, or the stage is a comment.
        Assert.Contains("meta: { stage: itemStage, notes: notes }", script, StringComparison.Ordinal);
    }

    /// <summary>
    /// 2.1.0 field fix. A per-slot absence omits the block and notes it; only
    /// a page where NO slot yields items is still a typed failure, and that
    /// reason carries a whole-page census.
    /// </summary>
    [Fact]
    public void The_coachless_read_degrades_on_an_empty_slot_instead_of_aborting()
    {
        var read = SiteImportExtractors.CoachlessItemsScript;
        Assert.Contains("-- omitted", read, StringComparison.Ordinal);
        Assert.Contains("every item slot on the page was empty", read, StringComparison.Ordinal);
        Assert.Contains("meta: { notes: notes }", read, StringComparison.Ordinal);
        // The pre-2.1.0 per-slot aborts are gone.
        Assert.DoesNotContain("return fail('slot \"' + SLOT_ORDER[b]", read, StringComparison.Ordinal);
    }

    /// <summary>
    /// 2.2.2 field fix. The items read must be able to say "not yet" as well as
    /// "no": a whole-page emptiness with nothing rendered is retryable, and the
    /// C# settle loop re-reads it. The BEHAVIOUR — which census is retryable and
    /// which is a verdict — is proved against the real fixtures by
    /// <c>_research/site-import/verify-extractors.mjs</c> (including both
    /// mutants: always-fail and always-wait). This pins that the shipped string
    /// is the one that oracle exercised, and that the decision is made on
    /// RENDERED ROWS rather than merely on the absence of blocks.
    /// </summary>
    [Fact]
    public void The_coachless_items_read_can_say_not_yet_as_well_as_no()
    {
        var read = SiteImportExtractors.CoachlessItemsScript;
        // The same envelope the runes read uses, which RunesSettleProbe reads.
        Assert.Contains("retryable: true", read, StringComparison.Ordinal);
        Assert.Contains("function failWait(", read, StringComparison.Ordinal);
        // Rows can precede their icons; both must exist before an empty verdict.
        Assert.Contains("renderedRows() > 0 && hasItemIcon ? fail(barren) : failWait(barren)", read, StringComparison.Ordinal);
        // And the census still travels on the failure either way.
        Assert.Contains("every item slot on the page was empty", read, StringComparison.Ordinal);
        // Only the whole-page branch may wait: a wrong URL can never become a
        // builds page by waiting, and a per-slot absence is a note, not a wait.
        // Two occurrences total: the definition and the single call site.
        Assert.Equal(2, Regex.Matches(read, @"failWait\(").Count);
        Assert.Equal(1, Regex.Matches(read, @"failWait\(barren\)").Count);
        Assert.Contains("return fail('not a champion builds page')", read, StringComparison.Ordinal);
    }

    [Fact]
    public void Both_item_extractors_are_read_only()
    {
        // Control: both scripts under test are non-empty real scripts.
        Assert.Contains("JSON.stringify", SiteImportExtractors.UGgScript, StringComparison.Ordinal);
        Assert.Contains("JSON.stringify", SiteImportExtractors.CoachlessItemsScript, StringComparison.Ordinal);
        Assert.DoesNotContain("dispatchEvent", SiteImportExtractors.UGgScript, StringComparison.Ordinal);
        Assert.DoesNotContain(".click(", SiteImportExtractors.UGgScript, StringComparison.Ordinal);
        Assert.DoesNotContain("dispatchEvent", SiteImportExtractors.CoachlessItemsScript, StringComparison.Ordinal);
        Assert.DoesNotContain(".click(", SiteImportExtractors.CoachlessItemsScript, StringComparison.Ordinal);
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
        Assert.Contains("JSON.stringify", SiteImportExtractors.CoachlessItemsScript, StringComparison.Ordinal);
        Assert.DoesNotContain(forbidden, SiteImportExtractors.UGgScript, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain(forbidden, SiteImportExtractors.CoachlessItemsScript, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void Scripts_resolve_per_site_tab_and_never_for_the_hosted_one()
    {
        Assert.Same(SiteImportExtractors.UGgScript, SiteImportExtractors.ScriptFor(CompanionTab.UGg));
        Assert.Same(SiteImportExtractors.CoachlessItemsScript, SiteImportExtractors.ScriptFor(CompanionTab.Coachless));
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

}
