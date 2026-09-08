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
        // 76 aliases. If ddragon renames a rune, refresh the table from
        // runesReforged.json rather than editing the count: the aliases are
        // data, and a count edit without new data is how a fallback dies.
        Assert.Equal(76, PerkIconMap.ByName.Count);
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
        Assert.Equal(6, set.GetProperty("blocks").GetArrayLength());
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
    // The treacherous one: the SCALING-named icon is the FLAT-health shard.
    // Pinned because every reader's first instinct is to "fix" it — the
    // 2026-09-08 u.gg fixture proves it (embedded active_shards [5008,5008,
    // 5011] against a Defense row showing this icon active).
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

    private static LcuResponse Ok(string raw) => new(true, 200, MockLcuApi.Json(raw), raw);
}
