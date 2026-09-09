using System.Text.Json;
using CoachBuild.Core;
using Xunit;

namespace CoachBuild.Core.Tests;

/// <summary>
/// The user-initiated site import: scrape JSON parsing, pre-write validation
/// (the ported 0.127.0 rune-page check), and the apply orchestration against
/// the services' existing <see cref="ILcuApi"/> seam.
/// </summary>
public sealed class SiteImportTests
{
    // ── PerkIconMap (ddragon runesReforged 16.17.1) ──────────────────────────

    [Fact]
    public void The_icon_table_covers_every_current_perk_exactly_once_per_alias()
    {
        // 77 aliases. If ddragon renames a rune, refresh the table from
        // runesReforged.json rather than editing the count: the aliases are
        // data, and a count edit without new data is how a fallback dies.
        Assert.Equal(77, PerkIconMap.ByName.Count);
        Assert.Equal(PerkIconMap.ByName.Keys.Distinct(StringComparer.Ordinal).Count(), PerkIconMap.ByName.Count);
    }

    [Theory]
    [InlineData("Electrocute", 8112)]
    [InlineData("GreenTerror_TasteOfBlood.png", 8139)]
    [InlineData("Triumph.png", 9111)]
    [InlineData("6361.png", 8275)]
    [InlineData("VeteranAftershock.png", 8439)]
    [InlineData("MirrorShell.png", 8401)]
    [InlineData("AlchemistCabinet.png", 8313)]
    [InlineData("Triple Tonic", 8313)]
    [InlineData("Perfect Timing", 8313)]
    [InlineData("Axiom Arcanist", 8224)]
    [InlineData("Nullifying Orb", 8224)]
    [InlineData("Stormraider's Surge", 8230)]
    [InlineData("Phase Rush", 8230)]
    [InlineData("DEATHFIRE_TOUCH_KEYSTONE.png", 8992)]
    [InlineData("Deathfire Touch", 8992)]
    [InlineData("perk-images/Styles/Sorcery/Celerity/CelerityTemp.png", 8234)]
    [InlineData("perk-images/Styles/Domination/Electrocute/Electrocute.png", 8112)]
    public void Treacherous_icon_aliases_resolve_to_their_perk_id(string alias, int expected)
    {
        Assert.True(PerkIconMap.TryResolve(alias, out var id), $"alias '{alias}' resolved to nothing");
        Assert.Equal(expected, id);
    }

    [Fact]
    public void Unknown_icon_text_resolves_to_nothing_rather_than_a_guess()
    {
        Assert.False(PerkIconMap.TryResolve("SomeNewRune", out _));
        Assert.False(PerkIconMap.TryResolve(null, out _));
        Assert.False(PerkIconMap.TryResolve(string.Empty, out _));
    }

    [Fact]
    public void The_current_sorcery_keystone_is_a_keystone_or_pages_using_it_are_rejected()
    {
        // ddragon 16.17.1 added 8992 Deathfire Touch as a fourth Sorcery
        // keystone; the web's perkSlots snapshot predates it. If this ever
        // fails, the catalog fell behind the client again.
        Assert.True(PerkTreeCatalog.IsKeystoneOf(8200, 8992));
        Assert.Equal(5, PerkTreeCatalog.Trees.Count);
    }

    // ── Payload parsing ──────────────────────────────────────────────────────

    [Fact]
    public void A_string_wrapped_extractor_result_parses()
    {
        var inner = JsonSerializer.Serialize(new
        {
            source = "u.gg",
            championSlug = "jhin",
            role = "adc",
            runes = new { primaryStyleId = 8000, subStyleId = 8200, perkIds = new[] { 8021, 9111, 9104, 8014, 8233, 8237 }, shardIds = new[] { 5005, 5008, 5011 } },
            itemBlocks = new[] { new { title = "Core", itemIds = new[] { 3031, 3033 } } },
        });
        var raw = JsonSerializer.Serialize(inner);

        Assert.True(SiteImportPayload.TryParse(raw, out var payload, out var failure), failure);
        Assert.Equal(SiteImportSource.UGg, payload!.Source);
        Assert.Equal("jhin", payload.ChampionSlug);
        Assert.Equal("adc", payload.Role);
        Assert.Equal(6, payload.Runes.PerkIds.Count);
        Assert.Single(payload.ItemBlocks);
    }

    [Fact]
    public void A_bare_extractor_object_parses_too()
    {
        const string raw = """
            {"source":"coachless","championSlug":"ahri","role":"mid",
             "runes":{"primaryStyleId":8100,"subStyleId":8200,
              "perkIds":[8112,8139,8140,8106,8210,8226],"shardIds":[5008,5008,5001]},
             "itemBlocks":[]}
            """;

        Assert.True(SiteImportPayload.TryParse(raw, out var payload, out _));
        Assert.Equal(SiteImportSource.Coachless, payload!.Source);
        Assert.Empty(payload.ItemBlocks);
    }

    [Theory]
    [InlineData(null, "site page not recognized")]
    [InlineData("", "site page not recognized")]
    [InlineData("not json", "site page not recognized")]
    [InlineData("{\"source\":\"u.gg\"}", "site page not recognized")]
    [InlineData("{\"source\":\"op.gg\",\"championSlug\":\"ahri\"}", "site page not recognized")]
    [InlineData("{\"error\":\"not a build page\"}", "site page not recognized")]
    [InlineData("{\"error\":\"no build on this page\"}", "no build on page")]
    [InlineData("{\"source\":\"u.gg\",\"championSlug\":\"ahri\",\"itemBlocks\":[]}", "no build on page")]
    [InlineData("{\"source\":\"coachless\",\"championSlug\":\"jhin\",\"runes\":null,\"itemBlocks\":[]}", "no build on page")]
    public void Typed_failures_never_parse_silently(string? raw, string expected)
    {
        Assert.False(SiteImportPayload.TryParse(raw, out var payload, out var failure));
        Assert.Null(payload);
        Assert.Equal(expected, failure);
    }

    // ── meta.stage (the SPA-fallback signal, 2.1.1) ──────────────────────────

    /// <summary>
    /// <c>meta.stage</c> reaches the payload. It is the one signal that
    /// separates "u.gg has no build for this" from "this document never
    /// embedded one" — the SPA case a hidden-worker direct load recovers.
    /// </summary>
    [Fact]
    public void The_extractor_stage_reaches_the_payload()
    {
        const string raw = """
            {"source":"u.gg","championSlug":"jhin","role":"adc","runes":null,
             "itemBlocks":[{"title":"Core Items","itemIds":[3006]}],
             "meta":{"stage":"url-recognized","notes":["u.gg items: no script on the page embeds a build blob"]}}
            """;

        Assert.True(SiteImportPayload.TryParse(raw, out var payload, out _));
        Assert.Equal(SiteImportPayload.StageUrlRecognized, payload!.Stage);
        Assert.Equal("url-recognized", SiteImportPayload.StageUrlRecognized);
        Assert.Single(payload.Notes);
    }

    /// <summary>
    /// A payload with no stage reports an EMPTY one, never null and never a
    /// guess — the Coachless walk emits no stage and must not be mistaken for
    /// a u.gg page that failed to embed a blob.
    /// </summary>
    [Fact]
    public void A_payload_without_a_stage_reports_an_empty_one()
    {
        const string raw = """
            {"source":"coachless","championSlug":"jhin","role":"adc","runes":null,
             "itemBlocks":[{"title":"Boots","itemIds":[3006]}]}
            """;

        Assert.True(SiteImportPayload.TryParse(raw, out var payload, out _));
        Assert.Equal(string.Empty, payload!.Stage);
    }

    /// <summary>
    /// The stage is COMPARED AGAINST, not merely logged, so a page-derived
    /// string may not masquerade as one. Anything outside a short lowercase
    /// token is dropped to empty rather than carried.
    /// </summary>
    [Theory]
    [InlineData("\"Blocks-Built\"")]
    [InlineData("\"blocks built\"")]
    [InlineData("\"blocks_built\"")]
    [InlineData("\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"")]
    [InlineData("42")]
    [InlineData("null")]
    public void A_stage_that_is_not_a_plain_token_is_dropped(string stageJson)
    {
        var raw =
            "{\"source\":\"u.gg\",\"championSlug\":\"jhin\",\"role\":\"adc\",\"runes\":null," +
            "\"itemBlocks\":[{\"title\":\"Boots\",\"itemIds\":[3006]}]," +
            "\"meta\":{\"stage\":" + stageJson + "}}";

        Assert.True(SiteImportPayload.TryParse(raw, out var payload, out _));
        Assert.Equal(string.Empty, payload!.Stage);
    }

    // ── Rune page validation (the ported 0.127.0 gate) ───────────────────────

    private static SiteImportRunes ElectrocuteSorcery() => new(
        8100, 8200,
        [8112, 8139, 8140, 8106, 8210, 8226],
        [5008, 5008, 5001]);

    [Fact]
    public void A_coherent_scraped_page_passes()
    {
        var runes = ElectrocuteSorcery();
        Assert.Null(PerkTreeCatalog.ValidatePage(
            runes.PrimaryStyleId, runes.SubStyleId, runes.PerkIds, runes.ShardIds));
        Assert.Null(SiteImportValidator.ValidateRunes(runes));
    }

    [Fact]
    public void The_new_sorcery_keystone_validates()
    {
        Assert.Null(PerkTreeCatalog.ValidatePage(
            8200, 8300,
            [8992, 8226, 8210, 8237, 8306, 8347],
            [5008, 5008, 5011]));
    }

    [Theory]
    [InlineData(8100, 8100, "one tree")]
    [InlineData(8100, 9999, "unknown rune tree")]
    [InlineData(8200, 8100, "keystone does not belong")]
    public void Tree_and_keystone_mismatches_are_precise(int primary, int sub, string fragment)
    {
        var runes = ElectrocuteSorcery() with { PrimaryStyleId = primary, SubStyleId = sub };
        var error = PerkTreeCatalog.ValidatePage(primary, sub, runes.PerkIds, runes.ShardIds);
        Assert.NotNull(error);
        Assert.Contains(fragment, error, StringComparison.Ordinal);
    }

    [Fact]
    public void Primary_minors_out_of_row_order_fail()
    {
        // Taste of Blood (row 0) and Sixth Sense (row 1) swapped.
        Assert.Contains("one per row", PerkTreeCatalog.ValidatePage(
            8100, 8200, [8112, 8137, 8139, 8106, 8210, 8226], [5008, 5008, 5001]),
            StringComparison.Ordinal);
    }

    [Fact]
    public void Secondaries_from_one_row_or_a_foreign_tree_fail()
    {
        Assert.Contains("share one row", PerkTreeCatalog.ValidatePage(
            8100, 8200, [8112, 8139, 8140, 8106, 8210, 8234], [5008, 5008, 5001]),
            StringComparison.Ordinal);
        Assert.Contains("secondary tree", PerkTreeCatalog.ValidatePage(
            8100, 8200, [8112, 8139, 8140, 8106, 8210, 8306], [5008, 5008, 5001]),
            StringComparison.Ordinal);
    }

    [Fact]
    public void A_shard_outside_its_row_fails()
    {
        Assert.Contains("shard", PerkTreeCatalog.ValidatePage(
            8100, 8200, [8112, 8139, 8140, 8106, 8210, 8226], [5001, 5008, 5011]),
            StringComparison.Ordinal);
    }

    [Fact]
    public void Short_or_empty_pages_fail_before_any_slot_check()
    {
        Assert.Contains("incomplete", PerkTreeCatalog.ValidatePage(8100, 8200, [8112], [5008, 5008, 5001]),
            StringComparison.Ordinal);
        Assert.Contains("incomplete", PerkTreeCatalog.ValidatePage(8100, 8200, null, null),
            StringComparison.Ordinal);
        Assert.Contains("empty rune slot", PerkTreeCatalog.ValidatePage(
            8100, 8200, [8112, 8139, 8140, 8106, 8210, 0], [5008, 5008, 5001]),
            StringComparison.Ordinal);
        Assert.Equal("the page yielded no rune build to import", SiteImportValidator.ValidateRunes(null));
    }

    // ── Item validation ──────────────────────────────────────────────────────

    [Fact]
    public void A_sane_item_build_passes()
    {
        Assert.Null(SiteImportValidator.ValidateItems([
            new("Starting", [1055, 2003]),
            new("Core", [3031, 3033, 3006]),
        ]));
    }

    [Fact]
    public void Absent_item_builds_fail_as_no_build()
    {
        const string fragment = "the page yielded no item build";
        Assert.Contains(fragment, SiteImportValidator.ValidateItems([]), StringComparison.Ordinal);
        Assert.Contains(fragment, SiteImportValidator.ValidateItems(null), StringComparison.Ordinal);
    }

    [Fact]
    public void Empty_blocks_and_slots_fail()
    {
        Assert.Contains("no items", SiteImportValidator.ValidateItems([new("Core", [])]),
            StringComparison.Ordinal);
        Assert.Contains("empty item slot", SiteImportValidator.ValidateItems([new("Core", [3031, 0])]),
            StringComparison.Ordinal);
        Assert.Contains("without a title", SiteImportValidator.ValidateItems([new("  ", [3031])]),
            StringComparison.Ordinal);
    }

    [Fact]
    public void Absurd_sizes_fail_before_they_reach_the_whole_object_put()
    {
        var wide = new SiteImportItemBlock("Core", Enumerable.Range(1001, 11).ToArray());
        Assert.Contains("more items", SiteImportValidator.ValidateItems([wide]), StringComparison.Ordinal);
        var many = Enumerable.Range(0, 9).Select(i => new SiteImportItemBlock($"B{i}", new[] { 1001 })).ToArray();
        Assert.Contains("more sections", SiteImportValidator.ValidateItems(many), StringComparison.Ordinal);
    }

    // ── Titles and labels ────────────────────────────────────────────────────

    [Theory]
    [InlineData("adc", "ADC")]
    [InlineData("mid", "Mid")]
    [InlineData("jungle", "Jungle")]
    [InlineData("top", "Top")]
    [InlineData("support", "Support")]
    public void Role_tokens_render_for_titles(string token, string label)
    {
        Assert.Equal(label, SiteImportValidator.RoleLabel(token));
    }

    [Fact]
    public void Titles_are_coachbuild_prefixed_and_site_suffixed()
    {
        var title = SiteImportValidator.PageTitle("Jhin", "adc", SiteImportSource.UGg);
        Assert.Equal("CoachBuild import: Jhin ADC (u.gg)", title);
        Assert.Equal(
            "CoachBuild import: Ahri Mid (Coachless)",
            SiteImportValidator.PageTitle("Ahri", "mid", SiteImportSource.Coachless));
    }

    [Theory]
    [InlineData("adc", "u.gg Jhin (ADC)", "Coachless Jhin (ADC)")]
    [InlineData(null, "u.gg Jhin", "Coachless Jhin")]
    public void Automatic_rune_titles_are_short_source_named_and_use_only_the_assigned_role(
        string? assignedRole,
        string expectedUgg,
        string expectedCoachless)
    {
        Assert.Equal(expectedUgg,
            SiteImportValidator.RunePageTitle("Jhin", assignedRole, SiteImportSource.UGg));
        Assert.Equal(expectedCoachless,
            SiteImportValidator.RunePageTitle("Jhin", assignedRole, SiteImportSource.Coachless));
    }

    // A practice tool / custom lobby assigns no position, so champ select
    // hands the import an empty role. 2.0.1 stamped the literal word into the
    // client ("CoachBuild import: Nasus Unknown (u.gg)", field-tested
    // 2026-09-08). The role must be OMITTED, never named.
    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    public void Unknown_role_is_omitted_from_the_page_title(string? role)
    {
        var title = SiteImportValidator.PageTitle("Nasus", role, SiteImportSource.UGg);

        Assert.Equal("CoachBuild import: Nasus (u.gg)", title);
        Assert.DoesNotContain("Unknown", title, StringComparison.OrdinalIgnoreCase);
        Assert.Null(SiteImportValidator.RoleLabel(role));
        Assert.Equal("Nasus", SiteImportValidator.ChampionLabel("Nasus", role));
    }

    [Fact]
    public void Known_role_still_rides_in_the_title_and_the_status_label()
    {
        Assert.Equal(
            "CoachBuild import: Nasus Top (u.gg)",
            SiteImportValidator.PageTitle("Nasus", "top", SiteImportSource.UGg));
        Assert.Equal("Nasus (Top)", SiteImportValidator.ChampionLabel("Nasus", "top"));
    }

    // The two shapes must not collide: exact-title reuse means a roleless
    // import would otherwise edit the roled page.
    [Fact]
    public void Roleless_and_roled_titles_are_distinct_pages()
    {
        Assert.NotEqual(
            SiteImportValidator.PageTitle("Nasus", null, SiteImportSource.UGg),
            SiteImportValidator.PageTitle("Nasus", "top", SiteImportSource.UGg));
    }

    // ── Extractor reasons survive the parse ──────────────────────────────────

    /// <summary>
    /// The brief for the Coachless runes page asks for an honest typed
    /// failure PER MISSING PART. That only works if the reason the script
    /// authored survives the parser, which before 2.1.0 it did not — every
    /// reason but "no build" was flattened to "site page not recognized".
    /// </summary>
    [Fact]
    public void A_precise_extractor_reason_reaches_the_caller()
    {
        Assert.False(SiteImportPayload.TryParse(
            """{"error":"primary rune row 2 carried no WPA reading"}""",
            out var payload,
            out var failure));

        Assert.Null(payload);
        Assert.Equal("primary rune row 2 carried no WPA reading", failure);
    }

    // The two canned reasons still normalize: callers match on them by name.
    [Theory]
    [InlineData("""{"error":"no build on page"}""", SiteImportFailures.NoBuild)]
    [InlineData("""{"error":"not a champion build page"}""", SiteImportFailures.NotRecognized)]
    [InlineData("""{"error":"not a champion runes page"}""", SiteImportFailures.NotRecognized)]
    [InlineData("""{"error":"not a build page"}""", SiteImportFailures.NotRecognized)]
    public void The_canned_extractor_reasons_still_normalize(string raw, string expected)
    {
        Assert.False(SiteImportPayload.TryParse(raw, out _, out var failure));
        Assert.Equal(expected, failure);
    }

    /// <summary>
    /// A passed-through reason reaches a status line and a log file, and some
    /// reasons interpolate page-derived text (a slot title). So it is
    /// sanitized: no control characters, no newlines, bounded length.
    /// </summary>
    [Fact]
    public void A_passed_through_reason_is_sanitized()
    {
        Assert.False(SiteImportPayload.TryParse(
            "{\"error\":\"slot \\\"1st\\r\\nItem\\\"  \\t had\\u0000 no rows\"}",
            out _,
            out var failure));

        Assert.DoesNotContain('\n', failure);
        Assert.DoesNotContain('\r', failure);
        Assert.DoesNotContain('\0', failure);
        Assert.DoesNotContain("  ", failure, StringComparison.Ordinal);
        Assert.Contains("had no rows", failure, StringComparison.Ordinal);
    }

    [Fact]
    public void A_very_long_reason_is_capped_to_one_line()
    {
        var shouted = new string('x', 500);
        Assert.False(SiteImportPayload.TryParse(
            $$"""{"error":"{{shouted}}"}""", out _, out var failure));

        Assert.True(failure.Length < 200, $"reason was {failure.Length} chars");
        Assert.EndsWith("…", failure, StringComparison.Ordinal);
    }

    [Fact]
    public void A_blank_reason_falls_back_to_the_canned_one()
    {
        Assert.False(SiteImportPayload.TryParse("""{"error":"   "}""", out _, out var failure));
        Assert.Equal(SiteImportFailures.NotRecognized, failure);
    }

    // ── Coachless runes page: the tables its extractor needs ─────────────────

    [Theory]
    [InlineData("precision", 8000)]
    [InlineData("domination", 8100)]
    [InlineData("sorcery", 8200)]
    [InlineData("inspiration", 8300)]
    [InlineData("resolve", 8400)]
    [InlineData("Precision", 8000)]
    public void Tree_names_resolve_to_the_catalog_style_ids(string name, int styleId)
    {
        Assert.Equal(styleId, PerkTreeNames.Resolve(name));
        // Control: the name column must not drift from the slot catalog.
        Assert.True(PerkTreeCatalog.Trees.ContainsKey(styleId));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("preciseness")]
    public void An_unknown_tree_name_resolves_to_zero_not_a_guess(string? name)
    {
        Assert.Equal(0, PerkTreeNames.Resolve(name));
    }

    /// <summary>
    /// Coachless serves its own short stat icons, so the shared ddragon table
    /// alone cannot read its shard rows. The oracle is the WHOLE ROW: resolving
    /// the nine cards the page actually renders, in the page's own DOM order,
    /// must reproduce <see cref="PerkTreeCatalog.ShardRows"/> exactly.
    ///
    /// <para>THIS REPLACES A CHECK THAT COULD NOT FAIL (2.1.1). The previous
    /// test asserted only that each alias landed on an id valid in SOME row,
    /// which is why it stayed green over a real defect: <c>health</c> resolved
    /// to 5001, and 5001 is legal in row 1 AND row 2, so a flat-health card
    /// mapped to the scaling shard passed. Live consequence on 2026-09-08:
    /// Jhin refused with "a scraped shard does not belong to its shard row"
    /// (the Flex row's winner, <c>healthscaling</c>, resolved to 5011, which is
    /// not a Flex shard), and — worse — a Defense row won by <c>health</c>
    /// passed the row check on the WRONG id and silently wrote Health Scaling
    /// where the page said Health. Membership in a row is not identity;
    /// pinning the row as a sequence is.</para>
    ///
    /// <para>The card list is read off the six 2026-09-08 sweep runes captures
    /// (jhin/ahri/leona/leesin/garen/ornn), which carry an IDENTICAL shard grid
    /// — so the row layout is champion-independent and the fault was never
    /// about "some tree layouts".</para>
    /// </summary>
    [Fact]
    public void Coachless_shard_rows_resolve_to_exactly_the_client_shard_rows()
    {
        string[][] pageRows =
        [
            ["adaptiveforce", "as", "ah"],
            ["adaptiveforce", "ms", "healthscaling"],
            ["health", "tenacity", "healthscaling"],
        ];
        // The exact table the Coachless runes script is handed: shared entries
        // first, aliases last, aliases winning — see ToCoachlessJson.
        var merged = new Dictionary<string, int>(ShardIconMap.ByName, StringComparer.Ordinal);
        foreach (var (name, id) in ShardIconMap.CoachlessAliases) merged[name] = id;

        for (var row = 0; row < pageRows.Length; row++)
        {
            var resolved = pageRows[row].Select(card =>
            {
                Assert.True(merged.TryGetValue(card, out var id), $"row {row} card '{card}' resolved to nothing");
                return id;
            }).ToArray();
            Assert.Equal(PerkTreeCatalog.ShardRows[row], resolved);
        }
    }

    /// <summary>
    /// The mutant that proves the row oracle above bites: the pre-2.1.1
    /// mapping (<c>health</c>→5001, <c>healthscaling</c>→5011) must NOT
    /// reproduce the client's rows. Without this, a future edit that reverts
    /// the alias table would only be caught by a live champ select.
    /// </summary>
    [Fact]
    public void The_pre_2_1_1_health_mapping_does_not_reproduce_the_client_rows()
    {
        var broken = new Dictionary<string, int>(StringComparer.Ordinal)
        {
            ["adaptiveforce"] = 5008, ["as"] = 5005, ["ah"] = 5007,
            ["ms"] = 5010, ["tenacity"] = 5013,
            ["health"] = 5001, ["healthscaling"] = 5011,
        };
        // The Flex row is where it shows: the page's third Flex card is
        // healthscaling, and 5011 is not a Flex shard.
        int[] flex = [broken["adaptiveforce"], broken["ms"], broken["healthscaling"]];
        Assert.NotEqual(PerkTreeCatalog.ShardRows[1], flex);
        Assert.DoesNotContain(broken["healthscaling"], PerkTreeCatalog.ShardRows[1]);
    }

    [Fact]
    public void The_coachless_shard_table_extends_the_shared_one_without_editing_it()
    {
        var merged = ShardIconMap.ToCoachlessJson();
        var shared = ShardIconMap.ToJson();

        // Every shared entry survives, EXCEPT the ones an alias deliberately
        // shadows. Since 2.1.1 "healthscaling" is such a key: Riot's filename
        // and Coachless's word for it denote different shards, so the merged
        // table must carry Coachless's meaning while u.gg's keeps Riot's.
        foreach (var (name, id) in ShardIconMap.ByName)
        {
            if (ShardIconMap.CoachlessAliases.ContainsKey(name)) continue;
            Assert.Contains($"\"{name}\":{id}", merged, StringComparison.Ordinal);
        }
        // Every alias wins in the merged table...
        foreach (var (name, id) in ShardIconMap.CoachlessAliases)
            Assert.Contains($"\"{name}\":{id}", merged, StringComparison.Ordinal);

        // ...and NOTHING an alias did leaked into u.gg's table, which must stay
        // byte-identical to what it was before Coachless needed aliases. A key
        // the shared table never had must still be absent; a key it did have
        // must still hold the SHARED value, not the alias's.
        foreach (var (name, id) in ShardIconMap.CoachlessAliases)
        {
            if (ShardIconMap.ByName.TryGetValue(name, out var sharedId))
                Assert.Contains($"\"{name}\":{sharedId}", shared, StringComparison.Ordinal);
            else
                Assert.DoesNotContain($"\"{name}\":", shared, StringComparison.Ordinal);
            _ = id;
        }
        // The control that keeps the loop above from being vacuous: at least
        // one alias must actually be a shadow, and at least one must be new.
        Assert.Contains(ShardIconMap.CoachlessAliases, pair => ShardIconMap.ByName.ContainsKey(pair.Key));
        Assert.Contains(ShardIconMap.CoachlessAliases, pair => !ShardIconMap.ByName.ContainsKey(pair.Key));
        Assert.Equal(5011, ShardIconMap.ByName["healthscaling"]);
        Assert.Equal(5001, ShardIconMap.CoachlessAliases["healthscaling"]);
    }

    /// <summary>
    /// The rune page the Coachless runes extractor must produce for the
    /// captured fixture, checked against the SAME 0.127.0 validator the write
    /// path uses.
    ///
    /// <para>The ids are not invented here: they are read off
    /// <c>_research/site-import/coachless-nasus-runes.html</c> (Nasus top,
    /// captured 2026-09-08) by applying the extractor's documented rule —
    /// top WPA per slot row — to the rendered cards. Keystone row:
    /// PressTheAttack -1.74, LethalTempo -4.22, <b>FleetFootwork +0.59</b>,
    /// Conqueror -1.36. Primary rows: (AbsorbLife -2.46, Triumph -0.01,
    /// <b>PresenceOfMind +0.78</b>), (LegendAlacrity -4.60,
    /// <b>LegendHaste +0.05</b>, LegendBloodline -0.63),
    /// (CoupDeGrace -1.41, <b>CutDown +0.59</b>, LastStand +0.02). Secondary
    /// rows win at Demolish -0.26, <b>BonePlating +0.46</b> and
    /// <b>Overgrowth +0.43</b> — the best TWO rows, so Demolish is dropped.
    /// Shard rows win at <b>ah +0.27</b>, <b>ms +0.82</b>,
    /// <b>tenacity +1.32</b>.</para>
    ///
    /// <para>If this page validates, the ids, the tree pair, the row
    /// assignments and the two-different-rows secondary rule all agree with
    /// the client's own rules. What it does NOT prove is that the JS reads
    /// those cards — that needs the live page.</para>
    /// </summary>
    [Fact]
    public void The_nasus_runes_fixture_page_passes_the_client_validator()
    {
        const int precision = 8000;
        const int resolve = 8400;
        int[] perks =
        [
            8021, // FleetFootwork  (keystone, +0.59)
            8009, // PresenceOfMind (primary row 1, +0.78)
            9105, // LegendHaste    (primary row 2, +0.05)
            8017, // CutDown        (primary row 3, +0.59)
            8473, // BonePlating    (secondary row 2, +0.46)
            8451, // Overgrowth     (secondary row 3, +0.43)
        ];
        int[] shards = [5007, 5010, 5013]; // ah, ms, tenacity

        Assert.Null(PerkTreeCatalog.ValidatePage(precision, resolve, perks, shards));

        // The parts the pick rule depends on, asserted individually so a
        // failure names which one moved.
        Assert.True(PerkTreeCatalog.IsKeystoneOf(precision, 8021));
        Assert.Equal(0, PerkTreeCatalog.MinorRow(precision, 8009));
        Assert.Equal(1, PerkTreeCatalog.MinorRow(precision, 9105));
        Assert.Equal(2, PerkTreeCatalog.MinorRow(precision, 8017));
        // Two secondaries, two DIFFERENT rows -- that is why the walk keeps
        // the best two rows rather than the best two runes.
        Assert.Equal(1, PerkTreeCatalog.MinorRow(resolve, 8473));
        Assert.Equal(2, PerkTreeCatalog.MinorRow(resolve, 8451));
    }

    /// <summary>
    /// The mutant for the test above: taking the best two RUNES instead of
    /// the best two ROWS would pick BonePlating (+0.46) and Overgrowth
    /// (+0.43) here too — so the discriminating case is a page whose two best
    /// runes share a row. That page must be REJECTED, which is what makes
    /// the row rule load-bearing rather than incidental.
    /// </summary>
    [Fact]
    public void Two_secondaries_from_one_row_are_rejected()
    {
        // Overgrowth and Revitalize are both Resolve minor row 2.
        int[] sameRow = [8021, 8009, 9105, 8017, 8451, 8453];
        Assert.Equal(2, PerkTreeCatalog.MinorRow(8400, 8451));
        Assert.Equal(2, PerkTreeCatalog.MinorRow(8400, 8453));

        Assert.NotNull(PerkTreeCatalog.ValidatePage(8000, 8400, sameRow, [5007, 5010, 5013]));
    }

    // ── Applier orchestration at the LCU seam ────────────────────────────────

    private static SiteImportPayload JhinUgg() => new(
        SiteImportSource.UGg, "jhin", "adc",
        new SiteImportRunes(8000, 8200, [8021, 9111, 9104, 8014, 8233, 8237], [5005, 5008, 5011]),
        [new SiteImportItemBlock("Core", [3031, 3033, 3006])]);

    private static void EnqueueRuneCreate(MockLcuApi api, string title)
    {
        api.Enqueue(HttpMethod.Get, "/lol-perks/v1/pages", Ok("[]"));
        api.Enqueue(HttpMethod.Get, "/lol-perks/v1/inventory", Ok("{\"ownedPageCount\":5}"));
        api.Enqueue(HttpMethod.Post, "/lol-perks/v1/pages", Ok("{\"id\":7}"));
        api.Enqueue(HttpMethod.Put, "/lol-perks/v1/currentpage", Ok("7"));
        api.Enqueue(HttpMethod.Get, "/lol-perks/v1/currentpage", Ok(
            "{\"id\":7,\"name\":\"" + title + "\",\"isDeletable\":true,\"primaryStyleId\":8000,\"subStyleId\":8200," +
            "\"selectedPerkIds\":[8021,9111,9104,8014,8233,8237,5005,5008,5011],\"current\":true}"));
    }

    private static void EnqueueItemWrite(MockLcuApi api, long summonerId = 77)
    {
        api.Enqueue(HttpMethod.Get, "/lol-summoner/v1/current-summoner",
            Ok("{\"summonerId\":" + summonerId + "}"));
        api.Enqueue(HttpMethod.Get, $"/lol-item-sets/v1/item-sets/{summonerId}/sets",
            Ok("{\"accountId\":" + summonerId + ",\"timestamp\":1,\"itemSets\":[]}"));
        api.Enqueue(HttpMethod.Put, $"/lol-item-sets/v1/item-sets/{summonerId}/sets", Ok("{}"));
    }

    [Fact]
    public async Task A_valid_scrape_writes_the_rune_page_and_the_item_set()
    {
        var api = new MockLcuApi();
        var title = "CoachBuild import: Jhin ADC (u.gg)";
        EnqueueRuneCreate(api, title);
        EnqueueItemWrite(api);
        var result = await SiteImportApplier.ApplyAsync(
            JhinUgg(), "Jhin", 202,
            new RuneApplyService(api), new ItemSetApplyService(api));

        var success = Assert.IsType<SiteImportSuccess>(result);
        Assert.Equal("Imported runes + 3-item set for Jhin (ADC) from u.gg", success.Message);
        var runePost = api.Calls.Single(call =>
            call.Method == HttpMethod.Post && call.Path == "/lol-perks/v1/pages");
        Assert.Equal(title, runePost.Body!.Value.GetProperty("name").GetString());
        var itemPut = api.Calls.Single(call => call.Method == HttpMethod.Put && call.Path.Contains("item-sets", StringComparison.Ordinal));
        var sets = itemPut.Body!.Value.GetProperty("itemSets");
        Assert.Equal(1, sets.GetArrayLength());
        var set = sets[0];
        Assert.Equal(title, set.GetProperty("title").GetString());
        Assert.Equal("custom", set.GetProperty("type").GetString());
        Assert.Equal(202, set.GetProperty("associatedChampions")[0].GetInt32());
        var items = set.GetProperty("blocks")[0].GetProperty("items");
        // Item ids are STRINGS in item sets, ints in rune pages.
        Assert.Equal("3031", items[0].GetProperty("id").GetString());
    }

    [Fact]
    public async Task The_built_requests_survive_both_write_gates()
    {
        var payload = JhinUgg();
        var title = SiteImportValidator.PageTitle("Jhin", payload.Role, payload.Source);
        Assert.True(ApplyPayloadValidation.TryValidateRunes(
            SiteImportValidator.BuildRuneRequest(title, payload.Runes), out _));
        Assert.True(ApplyPayloadValidation.TryValidateItemSets(
            SiteImportValidator.BuildItemSetRequest(202, title, payload.ChampionSlug, payload.Role, payload.ItemBlocks),
            out _));
    }

    [Fact]
    public async Task Bad_scraped_data_writes_nothing_not_even_a_rune_page()
    {
        // Control first: the bad payload must be bad for the reason claimed,
        // or the zero-call assertion below measures nothing.
        var bad = JhinUgg() with
        {
            Runes = JhinUgg().Runes with { PerkIds = [8021, 9104, 9111, 8014, 8233, 8237] },
        };
        Assert.Contains("one per row", SiteImportValidator.ValidateRunes(bad.Runes), StringComparison.Ordinal);

        var api = new MockLcuApi();
        var result = await SiteImportApplier.ApplyAsync(
            bad, "Jhin", 202, new RuneApplyService(api), new ItemSetApplyService(api));

        var failure = Assert.IsType<SiteImportFailure>(result);
        Assert.Equal("bad-runes", failure.Reason);
        Assert.Contains("nothing was imported", failure.Message, StringComparison.Ordinal);
        Assert.Empty(api.Calls);
    }

    [Fact]
    public async Task An_unresolvable_champion_writes_nothing()
    {
        var api = new MockLcuApi();
        var result = await SiteImportApplier.ApplyAsync(
            JhinUgg(), "Jhin", 0, new RuneApplyService(api), new ItemSetApplyService(api));

        Assert.IsType<SiteImportFailure>(result);
        Assert.Empty(api.Calls);
    }

    [Fact]
    public async Task A_rune_write_refusal_stops_before_the_item_set()
    {
        var api = new MockLcuApi();
        api.Enqueue(HttpMethod.Get, "/lol-perks/v1/pages", new LcuResponse(false, 401));
        var result = await SiteImportApplier.ApplyAsync(
            JhinUgg(), "Jhin", 202, new RuneApplyService(api), new ItemSetApplyService(api));

        var failure = Assert.IsType<SiteImportFailure>(result);
        Assert.Contains("nothing was imported", failure.Message, StringComparison.Ordinal);
        Assert.DoesNotContain(api.Calls,
            call => call.Path.Contains("item-sets", StringComparison.Ordinal));
    }

    [Fact]
    public async Task An_item_write_refusal_reports_the_half_that_landed()
    {
        var api = new MockLcuApi();
        var title = "CoachBuild import: Jhin ADC (u.gg)";
        EnqueueRuneCreate(api, title);
        api.Enqueue(HttpMethod.Get, "/lol-summoner/v1/current-summoner", Ok("{\"summonerId\":77}"));
        api.Enqueue(HttpMethod.Get, "/lol-item-sets/v1/item-sets/77/sets", Ok("{\"accountId\":77,\"itemSets\":[]}"));
        api.Enqueue(HttpMethod.Put, "/lol-item-sets/v1/item-sets/77/sets", new LcuResponse(false, 413));

        var result = await SiteImportApplier.ApplyAsync(
            JhinUgg(), "Jhin", 202, new RuneApplyService(api), new ItemSetApplyService(api));

        var failure = Assert.IsType<SiteImportFailure>(result);
        Assert.Contains("runes applied", failure.Message, StringComparison.Ordinal);
        Assert.Contains(title, failure.Message, StringComparison.Ordinal);
    }

    // ── Items-only imports (runes: null, the Coachless overview shape) ───────

    private const string JhinCoachlessItemsOnlyJson = """
        {"source":"coachless","championSlug":"jhin","role":"adc","runes":null,
         "itemBlocks":[
          {"title":"Starter","itemIds":[1120],"selected":true},
          {"title":"1st Item","itemIds":[6697],"selected":true},
          {"title":"2nd Item","itemIds":[3046],"selected":true},
          {"title":"3rd Item","itemIds":[3031],"selected":false},
          {"title":"4th+ Item","itemIds":[3033],"selected":false},
          {"title":"Boots","itemIds":[3006],"selected":false}]}
        """;

    [Fact]
    public async Task Runes_null_with_items_writes_only_the_item_set()
    {
        // End to end through the fake LCU services: the extractor's own
        // selected/top-row provenance flags ride along untouched, the rune
        // service is NEVER called, and the item set write happens.
        Assert.True(
            SiteImportPayload.TryParse(JhinCoachlessItemsOnlyJson, out var payload, out var failure),
            failure);
        Assert.NotNull(payload);
        Assert.Null(payload.Runes);
        Assert.Equal(6, payload.ItemBlocks.Count);

        var api = new MockLcuApi();
        EnqueueItemWrite(api);
        var result = await SiteImportApplier.ApplyAsync(
            payload, "Jhin", 202, new RuneApplyService(api), new ItemSetApplyService(api));

        var success = Assert.IsType<SiteImportSuccess>(result);
        Assert.Equal("Imported 6-item set (no rune page on this site) from Coachless", success.Message);
        Assert.DoesNotContain(api.Calls,
            call => call.Path.StartsWith("/lol-perks/", StringComparison.Ordinal));
        var itemPut = api.Calls.Single(call =>
            call.Method == HttpMethod.Put && call.Path.Contains("item-sets", StringComparison.Ordinal));
        var sets = itemPut.Body!.Value.GetProperty("itemSets");
        Assert.Equal(1, sets.GetArrayLength());
        var set = sets[0];
        Assert.Equal("CoachBuild import: Jhin ADC (Coachless)", set.GetProperty("title").GetString());
        Assert.Equal(202, set.GetProperty("associatedChampions")[0].GetInt32());
        Assert.Equal(1, set.GetProperty("blocks").GetArrayLength());
        Assert.Equal(6, set.GetProperty("blocks")[0].GetProperty("items").GetArrayLength());
        Assert.Equal("1120", set.GetProperty("blocks")[0].GetProperty("items")[0].GetProperty("id").GetString());
    }

    [Fact]
    public async Task An_item_write_refusal_on_the_items_only_path_imports_nothing()
    {
        // Unlike the both-halves path there is no landed half to report:
        // the runes were never touched, so the failure says nothing was
        // imported.
        Assert.True(
            SiteImportPayload.TryParse(JhinCoachlessItemsOnlyJson, out var payload, out _));
        var api = new MockLcuApi();
        api.Enqueue(HttpMethod.Get, "/lol-summoner/v1/current-summoner", Ok("{\"summonerId\":77}"));
        api.Enqueue(HttpMethod.Get, "/lol-item-sets/v1/item-sets/77/sets", Ok("{\"accountId\":77,\"itemSets\":[]}"));
        api.Enqueue(HttpMethod.Put, "/lol-item-sets/v1/item-sets/77/sets", new LcuResponse(false, 413));

        var result = await SiteImportApplier.ApplyAsync(
            payload!, "Jhin", 202, new RuneApplyService(api), new ItemSetApplyService(api));

        var failure = Assert.IsType<SiteImportFailure>(result);
        Assert.Contains("nothing was imported", failure.Message, StringComparison.Ordinal);
        Assert.DoesNotContain(api.Calls,
            call => call.Path.StartsWith("/lol-perks/", StringComparison.Ordinal));
    }

    [Fact]
    public async Task Items_only_with_no_blocks_stays_a_typed_no_build_failure()
    {
        Assert.True(
            SiteImportPayload.TryParse(JhinCoachlessItemsOnlyJson, out var payload, out _));
        var empty = payload! with { ItemBlocks = Array.Empty<SiteImportItemBlock>() };

        var api = new MockLcuApi();
        var result = await SiteImportApplier.ApplyAsync(
            empty, "Jhin", 202, new RuneApplyService(api), new ItemSetApplyService(api));

        var failure = Assert.IsType<SiteImportFailure>(result);
        Assert.Equal("bad-items", failure.Reason);
        Assert.Contains("nothing was imported", failure.Message, StringComparison.Ordinal);
        Assert.Empty(api.Calls);
    }

    // ── ShardIconMap (fixture-verified u.gg StatMods names) ──────────────────

    [Fact]
    public void The_shard_table_covers_every_current_statmod()
    {
        // 9 aliases: the 7 icons the current client offers, plus armor and
        // magic resist as ddragon-canonical aliases for older page shapes.
        // The shard-row check still rejects the two retirees, so a wrong
        // alias here fails loudly at validation, never in the client.
        Assert.Equal(9, ShardIconMap.ByName.Count);
    }

    [Theory]
    [InlineData("StatModsAdaptiveForceIcon.webp", 5008)]
    [InlineData("StatModsAttackSpeedIcon.webp", 5005)]
    [InlineData("StatModsCDRScalingIcon.webp", 5007)]
    [InlineData("StatModsMovementSpeedIcon.webp", 5010)]
    [InlineData("StatModsTenacityIcon.webp", 5013)]
    [InlineData("StatModsHealthPlusIcon.webp", 5001)]
    // The treacherous pair: Riot's icon FILENAMES are crossed against the
    // shards' DISPLAY NAMES, so the SCALING-named file is the FLAT-health
    // shard. Pinned because every reader's first instinct is to "fix" it.
    // Ground truth is Riot's own patch data, embedded verbatim in the
    // 2026-09-08 u.gg fixture as stat-shards-v2.json (patch 14.2):
    //   {"id":5011,"img":"StatModsHealthScalingIcon.png","name":"Health",
    //    "tooltip_desc":"+65 Health"}
    //   {"id":5001,"img":"StatModsHealthPlusIcon.png","name":"Health Scaling",
    //    "tooltip_desc":"+10-180 Health (based on level)"}
    // This table is keyed by FILENAME, so it is correct as written and must
    // NOT be aligned to the display names. Coachless keys by MEANING instead,
    // which is why ShardIconMap.CoachlessAliases overrides both.
    [InlineData("StatModsHealthScalingIcon.webp", 5011)]
    [InlineData("https://static.bigbrain.gg/assets/lol/riot_static/14.2.1/img/perk-images/StatMods/StatModsAdaptiveForceIcon.webp", 5008)]
    public void Shard_icon_filenames_resolve_to_their_shard_id(string alias, int expected)
    {
        Assert.True(ShardIconMap.TryResolve(alias, out var id), $"alias '{alias}' resolved to nothing");
        Assert.Equal(expected, id);
    }

    [Fact]
    public void Unknown_shard_text_resolves_to_nothing_rather_than_a_guess()
    {
        Assert.False(ShardIconMap.TryResolve("SomeNewShard", out _));
        Assert.False(ShardIconMap.TryResolve(null, out _));
    }

    // ── The real extractor output, end to end ────────────────────────────────

    /// <summary>
    /// The byte-exact payload the u.gg extractor produced from the real
    /// captured Jhin ADC fixture (verified by the _research harness): it must
    /// parse, validate clean, and apply. This is the contract between the
    /// Desktop JS and this parser — if the extractor's shape drifts, this is
    /// the test that names the drift.
    /// </summary>
    [Fact]
    public async Task The_verified_u_gg_fixture_payload_parses_validates_and_applies()
    {
        const string raw = """
            {"source":"u.gg","championSlug":"jhin","role":"adc",
             "runes":{"primaryStyleId":8000,"subStyleId":8300,
              "perkIds":[8021,8009,9103,8017,8321,8316],"shardIds":[5008,5008,5011]},
             "itemBlocks":[
              {"title":"Starting Items","itemIds":[1120,2003]},
              {"title":"Core Items","itemIds":[6697,3009,3046]},
              {"title":"Fourth Item","itemIds":[3031,3094]},
              {"title":"Fifth Item","itemIds":[3036,3094,3031]},
              {"title":"Sixth Item","itemIds":[3036,3094,3072]},
              {"title":"Seventh Item","itemIds":[3072,3142,3139]},
              {"title":"Consumables","itemIds":[2055,2003,2140]}]}
            """;

        Assert.True(SiteImportPayload.TryParse(raw, out var payload, out var failure), failure);
        Assert.Null(SiteImportValidator.ValidateRunes(payload!.Runes));
        Assert.Null(SiteImportValidator.ValidateItems(payload.ItemBlocks));
        Assert.Equal(
            "CoachBuild import: Jhin ADC (u.gg)",
            SiteImportValidator.PageTitle("Jhin", payload.Role, payload.Source));

        var api = new MockLcuApi();
        api.Enqueue(HttpMethod.Get, "/lol-perks/v1/pages", Ok("[]"));
        api.Enqueue(HttpMethod.Get, "/lol-perks/v1/inventory", Ok("{\"ownedPageCount\":5}"));
        api.Enqueue(HttpMethod.Post, "/lol-perks/v1/pages", Ok("{\"id\":7}"));
        api.Enqueue(HttpMethod.Put, "/lol-perks/v1/currentpage", Ok("7"));
        api.Enqueue(HttpMethod.Get, "/lol-perks/v1/currentpage", Ok(
            "{\"id\":7,\"name\":\"CoachBuild import: Jhin ADC (u.gg)\",\"isDeletable\":true," +
            "\"primaryStyleId\":8000,\"subStyleId\":8300," +
            "\"selectedPerkIds\":[8021,8009,9103,8017,8321,8316,5008,5008,5011],\"current\":true}"));
        EnqueueItemWrite(api);

        var result = await SiteImportApplier.ApplyAsync(
            payload, "Jhin", 202, new RuneApplyService(api), new ItemSetApplyService(api));

        var success = Assert.IsType<SiteImportSuccess>(result);
        Assert.Equal("Imported runes + 19-item set for Jhin (ADC) from u.gg", success.Message);
    }

    // -- Runes-only imports (the offer-bar "Import runes" button) ----------

    [Fact]
    public async Task Runes_only_writes_the_rune_page_and_no_item_set()
    {
        // Items never flow through the button even when the payload carries
        // them: the rune service is called, the item-set endpoints are not.
        var api = new MockLcuApi();
        var title = "CoachBuild import: Jhin ADC (u.gg)";
        EnqueueRuneCreate(api, title);

        var result = await SiteImportApplier.ApplyRunesOnlyAsync(
            JhinUgg(), "Jhin", 202, new RuneApplyService(api));

        var success = Assert.IsType<SiteImportSuccess>(result);
        Assert.Equal("Imported runes for Jhin (ADC) from u.gg", success.Message);
        Assert.Contains(api.Calls, call => call.Path == "/lol-perks/v1/pages");
        Assert.DoesNotContain(api.Calls,
            call => call.Path.Contains("item-sets", StringComparison.Ordinal));
        var runePost = api.Calls.Single(call =>
            call.Method == HttpMethod.Post && call.Path == "/lol-perks/v1/pages");
        Assert.Equal(title, runePost.Body!.Value.GetProperty("name").GetString());
    }

    [Fact]
    public async Task Runes_only_with_no_rune_build_fails_without_touching_the_lcu()
    {
        // The Coachless items-only shape through the runes path: a typed
        // failure, zero calls -- the button is hidden on Coachless for
        // exactly this reason.
        Assert.True(
            SiteImportPayload.TryParse(JhinCoachlessItemsOnlyJson, out var payload, out _));
        Assert.Null(payload!.Runes);

        var api = new MockLcuApi();
        var result = await SiteImportApplier.ApplyRunesOnlyAsync(
            payload, "Jhin", 202, new RuneApplyService(api));

        var failure = Assert.IsType<SiteImportFailure>(result);
        Assert.Equal("bad-runes", failure.Reason);
        Assert.Contains("nothing was imported", failure.Message, StringComparison.Ordinal);
        Assert.Empty(api.Calls);
    }

    [Fact]
    public async Task Runes_only_with_bad_runes_writes_nothing()
    {
        var bad = JhinUgg() with
        {
            Runes = JhinUgg().Runes with { PerkIds = [8021, 9104, 9111, 8014, 8233, 8237] },
        };
        Assert.Contains("one per row", SiteImportValidator.ValidateRunes(bad.Runes), StringComparison.Ordinal);

        var api = new MockLcuApi();
        var result = await SiteImportApplier.ApplyRunesOnlyAsync(
            bad, "Jhin", 202, new RuneApplyService(api));

        Assert.IsType<SiteImportFailure>(result);
        Assert.Empty(api.Calls);
    }

    // -- Batched items-only imports (the automatic import) -----------------

    private static SiteImportPayload JhinCoachlessItemsOnly()
    {
        Assert.True(
            SiteImportPayload.TryParse(JhinCoachlessItemsOnlyJson, out var payload, out var failure),
            failure);
        return payload!;
    }

    [Fact]
    public async Task Batch_writes_both_sites_sets_in_one_put_and_never_touches_runes()
    {
        // The coexistence contract: one read-modify-write carrying both
        // per-site titles. Two sequential single-set writes would NOT
        // coexist (the merge drops every CoachBuild* set it reads), so the
        // batch is what keeps u.gg and Coachless on the client together.
        // The u.gg payload carries a rune page; the batch must ignore it --
        // this path cannot reach the rune service (it does not even take
        // one), proved by zero perk calls.
        var api = new MockLcuApi();
        EnqueueItemWrite(api);

        var results = await SiteImportApplier.ApplyItemsBatchAsync(
            [
                new SiteImportItemsContribution(JhinUgg(), "Jhin", 202),
                new SiteImportItemsContribution(JhinCoachlessItemsOnly(), "Jhin", 202),
            ],
            new ItemSetApplyService(api));

        Assert.Equal(2, results.Count);
        Assert.Equal(
            "Auto-imported 3-item set for Jhin (ADC) from u.gg",
            Assert.IsType<SiteImportSuccess>(results[0]).Message);
        Assert.Equal(
            "Auto-imported 6-item set for Jhin (ADC) from Coachless",
            Assert.IsType<SiteImportSuccess>(results[1]).Message);
        Assert.DoesNotContain(api.Calls,
            call => call.Path.StartsWith("/lol-perks/", StringComparison.Ordinal));
        var put = Assert.Single(api.Calls, call =>
            call.Method == HttpMethod.Put && call.Path.Contains("item-sets", StringComparison.Ordinal));
        var sets = put.Body!.Value.GetProperty("itemSets");
        Assert.Equal(2, sets.GetArrayLength());
        Assert.Equal("CoachBuild import: Jhin ADC (u.gg)", sets[0].GetProperty("title").GetString());
        Assert.Equal("CoachBuild import: Jhin ADC (Coachless)", sets[1].GetProperty("title").GetString());
        Assert.Equal(1, sets[1].GetProperty("blocks").GetArrayLength());
        Assert.Equal(6, sets[1].GetProperty("blocks")[0].GetProperty("items").GetArrayLength());
    }

    [Fact]
    public async Task Batch_writes_the_valid_contribution_and_fails_the_bad_one_in_place()
    {
        var empty = JhinCoachlessItemsOnly() with { ItemBlocks = Array.Empty<SiteImportItemBlock>() };
        var api = new MockLcuApi();
        EnqueueItemWrite(api);

        var results = await SiteImportApplier.ApplyItemsBatchAsync(
            [
                new SiteImportItemsContribution(empty, "Jhin", 202),
                new SiteImportItemsContribution(JhinUgg(), "Jhin", 202),
            ],
            new ItemSetApplyService(api));

        Assert.Equal(2, results.Count);
        var failure = Assert.IsType<SiteImportFailure>(results[0]);
        Assert.Equal("bad-items", failure.Reason);
        Assert.IsType<SiteImportSuccess>(results[1]);
        var put = Assert.Single(api.Calls, call =>
            call.Method == HttpMethod.Put && call.Path.Contains("item-sets", StringComparison.Ordinal));
        Assert.Equal(1, put.Body!.Value.GetProperty("itemSets").GetArrayLength());
    }

    [Fact]
    public async Task Batch_with_nothing_valid_touches_no_lcu()
    {
        var empty = JhinCoachlessItemsOnly() with { ItemBlocks = Array.Empty<SiteImportItemBlock>() };
        var api = new MockLcuApi();

        var results = await SiteImportApplier.ApplyItemsBatchAsync(
            [new SiteImportItemsContribution(empty, "Jhin", 202)],
            new ItemSetApplyService(api));

        var failure = Assert.Single(results);
        Assert.IsType<SiteImportFailure>(failure);
        Assert.Empty(api.Calls);
    }

    [Fact]
    public async Task Empty_batch_writes_nothing()
    {
        var api = new MockLcuApi();
        var results = await SiteImportApplier.ApplyItemsBatchAsync(
            [], new ItemSetApplyService(api));

        Assert.Empty(results);
        Assert.Empty(api.Calls);
    }

    [Fact]
    public async Task Batch_write_refusal_fails_every_contribution_with_nothing_landed()
    {
        // Unlike the both-halves path there is no landed half to report:
        // the single PUT either wrote every set or none.
        var api = new MockLcuApi();
        api.Enqueue(HttpMethod.Get, "/lol-summoner/v1/current-summoner", Ok("{\"summonerId\":77}"));
        api.Enqueue(HttpMethod.Get, "/lol-item-sets/v1/item-sets/77/sets", Ok("{\"accountId\":77,\"itemSets\":[]}"));
        api.Enqueue(HttpMethod.Put, "/lol-item-sets/v1/item-sets/77/sets", new LcuResponse(false, 413));

        var results = await SiteImportApplier.ApplyItemsBatchAsync(
            [
                new SiteImportItemsContribution(JhinUgg(), "Jhin", 202),
                new SiteImportItemsContribution(JhinCoachlessItemsOnly(), "Jhin", 202),
            ],
            new ItemSetApplyService(api));

        Assert.Equal(2, results.Count);
        foreach (var result in results)
        {
            var failure = Assert.IsType<SiteImportFailure>(result);
            Assert.Contains("nothing was imported", failure.Message, StringComparison.Ordinal);
        }
        Assert.DoesNotContain(api.Calls,
            call => call.Path.StartsWith("/lol-perks/", StringComparison.Ordinal));
    }

    [Fact]
    public void The_batch_element_matches_the_single_request_shape()
    {
        // The batch must build byte-identical sets to the long-standing
        // single-write path: same uid, title, champion association, blocks.
        var payload = JhinUgg();
        var title = SiteImportValidator.PageTitle("Jhin", payload.Role, payload.Source);
        var element = SiteImportValidator.BuildItemSetElement(
            202, title, payload.ChampionSlug, payload.Role, payload.ItemBlocks);
        var request = SiteImportValidator.BuildItemSetRequest(
            202, title, payload.ChampionSlug, payload.Role, payload.ItemBlocks);

        Assert.Equal(
            request.Sets![0].GetRawText(),
            element.GetRawText());
        Assert.Equal($"coachbuild-import-jhin-adc", element.GetProperty("uid").GetString());
        Assert.Equal(202, element.GetProperty("associatedChampions")[0].GetInt32());
    }

    [Theory]
    [InlineData(SiteImportSource.Coachless, 1)]
    [InlineData(SiteImportSource.UGg, 4)]
    public void Coachless_purchase_order_is_one_shop_row_while_ugg_sections_are_preserved(
        SiteImportSource source, int expectedRows)
    {
        SiteImportItemBlock[] blocks =
        [
            new("Starter", [1055]),
            new("1st Item", [6676]),
            new("Boots", [3009]),
            new("2nd Item", [3031]),
        ];
        var request = SiteImportValidator.BuildItemSetRequest(
            202, "test", "jhin", "adc", blocks, source);
        var rows = request.Sets![0].GetProperty("blocks");
        Assert.Equal(expectedRows, rows.GetArrayLength());
        Assert.Equal(new[] { "1055", "6676", "3009", "3031" }, rows.EnumerateArray()
            .SelectMany(row => row.GetProperty("items").EnumerateArray())
            .Select(item => item.GetProperty("id").GetString()));
    }

    /// <summary>
    /// 2.1.0: <c>meta.notes</c> reaches C#.
    ///
    /// <para>Before this, the Coachless walk merged its settle notes into the
    /// payload JSON and this parser dropped them, so a degraded import and a
    /// clean one produced identical logs. Both extractors now emit per-stage
    /// and per-slot notes and this is the only channel that delivers them.</para>
    /// </summary>
    [Fact]
    public void Payload_parsing_carries_the_extractor_notes_and_sanitizes_them()
    {
        var raw = """
            {
              "source": "coachless", "championSlug": "nasus", "role": "top", "runes": null,
              "itemBlocks": [ { "title": "1st Item", "itemIds": [3065] } ],
              "meta": { "notes": [
                "coachless: slot \"Starter\" yielded no\titems -- omitted",
                "   ",
                42,
                "u.gg items: stage blocks-built"
              ] }
            }
            """;

        Assert.True(SiteImportPayload.TryParse(raw, out var payload, out var failure));
        Assert.Equal(string.Empty, failure);
        Assert.Equal(
            [
                "coachless: slot \"Starter\" yielded no items -- omitted",
                "u.gg items: stage blocks-built",
            ],
            payload!.Notes);
    }

    [Fact]
    public void A_payload_without_meta_carries_no_notes()
    {
        var raw = """
            {
              "source": "u.gg", "championSlug": "jhin", "role": "adc", "runes": null,
              "itemBlocks": [ { "title": "Core Items", "itemIds": [6697] } ]
            }
            """;

        Assert.True(SiteImportPayload.TryParse(raw, out var payload, out _));
        Assert.Empty(payload!.Notes);
        // A shared empty default, so two note-less payloads stay equal to each
        // other: adding diagnostics must not change payload identity.
        Assert.True(SiteImportPayload.TryParse(raw, out var twin, out _));
        Assert.Same(payload.Notes, twin!.Notes);
    }

    private static LcuResponse Ok(string raw) => new(true, 200, MockLcuApi.Json(raw), raw);
}
