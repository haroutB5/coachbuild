using System.Net;
using System.Net.Http;
using System.Text.Json;
using CoachBuild.Core;
using Xunit;

namespace CoachBuild.Core.Tests;

/// <summary>
/// The third import source: probuildstats.com ("Pro"). URL discipline (with
/// the role-4 <c>supp</c> mapping that must never leak into the other
/// builders), the apollo-HTML parse against the captured fixtures, the
/// one-row pick rule, the item blocks, and the trio rune-page budget.
/// </summary>
public sealed class ProBuildsTests
{
    private static string Fixture(string name) =>
        File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Fixtures", name));

    // ── URL discipline ───────────────────────────────────────────────────

    [Theory]
    [InlineData(0, "top")]
    [InlineData(1, "jungle")]
    [InlineData(2, "mid")]
    [InlineData(3, "adc")]
    [InlineData(4, "supp")]
    public void Role_tokens_map_with_supp_for_role_4(int roleId, string token)
    {
        Assert.Equal(token, ProBuildsClient.RoleToken(roleId));
        Assert.Equal(roleId, ProBuildsClient.RoleIdFromToken(token));
    }

    [Fact]
    public void Supp_is_a_support_but_support_stays_support_for_the_other_builders()
    {
        // The alias lives on the Pro side only: "support" resolves here so a
        // page spelling is never a refusal, while SiteDeepLink.RoleToken (the
        // u.gg/Coachless builder, pinned by its own round-trip theory) still
        // emits "support" for role 4 and is untouched by this change.
        Assert.Equal(4, ProBuildsClient.RoleIdFromToken("support"));
        Assert.Equal("Pro build Ahri (Support)", SiteImportValidator.RunePageTitle("Ahri", "supp", SiteImportSource.Pro));
    }

    [Fact]
    public void The_builder_only_ever_produces_champion_urls()
    {
        Assert.Equal(
            new Uri("https://probuildstats.com/champion/ahri?role=mid"),
            ProBuildsClient.BuildUrl("Ahri", 2));
        Assert.Equal(
            new Uri("https://probuildstats.com/champion/leona?role=supp"),
            ProBuildsClient.BuildUrl("Leona", 4));
        Assert.Equal(
            new Uri("https://probuildstats.com/champion/ahri"),
            ProBuildsClient.BuildUrl("ahri", null));
        Assert.Null(ProBuildsClient.BuildUrl("", 2));
        Assert.Null(ProBuildsClient.BuildUrl(null, 2));
        Assert.Null(ProBuildsClient.BuildUrl("   ", 2));
    }

    [Fact]
    public async Task An_invalid_slug_fails_without_a_request()
    {
        var http = new StubHandler(_ => throw new InvalidOperationException("must not request"));
        var client = new ProBuildsClient(new HttpClient(http));

        var fetch = await client.FetchAsync("", 2);

        Assert.Null(fetch.Payload);
        Assert.Contains("unknown champion", fetch.Failure, StringComparison.Ordinal);
        Assert.Empty(http.Requests);
    }

    // ── Fixture parses: Ahri mid and Jhin adc ────────────────────────────

    [Fact]
    public void Ahri_mid_parses_to_the_report_sample()
    {
        var parsed = ProBuildsClient.ParseDocument(Fixture("pbs-ahri.html"));

        Assert.Null(parsed.Failure);
        Assert.NotNull(parsed.Rows);
        Assert.Equal(20, parsed.Rows.Count);

        var (payload, failure) = ProBuildsClient.BuildPayload(parsed.Rows, "ahri", 2);

        Assert.Null(failure);
        Assert.NotNull(payload);
        Assert.Equal(SiteImportSource.Pro, payload.Source);
        Assert.Equal("ahri", payload.ChampionSlug);
        Assert.Equal("mid", payload.Role);
        Assert.Equal(8100, payload.Runes.PrimaryStyleId);
        Assert.Equal(8200, payload.Runes.SubStyleId);
        Assert.Equal([8112, 8143, 8140, 8106, 8226, 8237], payload.Runes.PerkIds);
        Assert.Equal([5005, 5008, 5011], payload.Runes.ShardIds);
        Assert.Null(SiteImportValidator.ValidateRunes(payload.Runes));
        var blocks = payload.ItemBlocks.ToArray();
        Assert.Equal(3, blocks.Length);
        Assert.Equal("Starting Items", blocks[0].Title);
        Assert.Equal([1056, 2003], blocks[0].ItemIds);
        Assert.Equal("Core Items", blocks[1].Title);
        Assert.Equal([3118, 3020, 3100, 3089], blocks[1].ItemIds);
        Assert.Equal("Final Build", blocks[2].Title);
        Assert.Equal([3118, 3100, 3089, 3175, 1082], blocks[2].ItemIds);
        var note = Assert.Single(payload.Notes);
        Assert.Equal(
            "probuildstats: most recent mid game on patch 16.18 " +
            "(on, BILIBILI GAMING DREAMSMART, loss vs champion 245; 1 of 20 games)",
            note);
    }

    [Fact]
    public void Jhin_adc_parses_to_the_report_sample_with_completed_items_in_order()
    {
        var parsed = ProBuildsClient.ParseDocument(Fixture("pbs-jhin.html"));

        Assert.Null(parsed.Failure);
        Assert.NotNull(parsed.Rows);

        var (payload, failure) = ProBuildsClient.BuildPayload(parsed.Rows!, "jhin", 3);

        Assert.Null(failure);
        Assert.NotNull(payload);
        Assert.Equal(8000, payload.Runes.PrimaryStyleId);
        Assert.Equal(8300, payload.Runes.SubStyleId);
        Assert.Equal([8021, 8009, 9103, 8017, 8321, 8316], payload.Runes.PerkIds);
        Assert.Equal([5008, 5008, 5011], payload.Runes.ShardIds);
        var blocks = payload.ItemBlocks.ToArray();
        Assert.Equal(3, blocks.Length);
        Assert.Equal([1120, 2003], blocks[0].ItemIds);
        // The brief's rule is completedItems IN ORDER: boots 3009 stay where
        // the page put them (first), even though the research report's sample
        // shows them second. The rule is asserted, not the sample's order.
        Assert.Equal([3009, 6697, 3046, 3036, 3031, 3095], blocks[1].ItemIds);
        Assert.Equal([6697, 3046, 3036, 3031, 3095, 3140], blocks[2].ItemIds);
        var note = Assert.Single(payload.Notes);
        Assert.Equal(
            "probuildstats: most recent adc game on patch 16.18 " +
            "(gala, Invictus Gaming, win vs champion 81; 1 of 20 games)",
            note);
    }

    // ── Unknown champion and the transient shell ─────────────────────────

    [Fact]
    public void A_bad_slug_is_a_typed_unknown_champion_not_a_retry()
    {
        var parsed = ProBuildsClient.ParseDocument(Fixture("pbs-badslug.html"));

        Assert.Null(parsed.Rows);
        Assert.False(parsed.Retryable);
        Assert.Equal(ProBuildsClient.Failures.UnknownChampion, parsed.Failure);
    }

    [Fact]
    public void The_transient_shell_is_retryable()
    {
        var parsed = ProBuildsClient.ParseDocument(Fixture("pbs-ahri-top.html"));

        Assert.Null(parsed.Rows);
        Assert.True(parsed.Retryable);
    }

    [Fact]
    public async Task The_shell_retries_once_then_reports_transient()
    {
        var shell = Fixture("pbs-ahri-top.html");
        var http = new StubHandler(_ => Ok(shell));
        var client = new ProBuildsClient(new HttpClient(http));

        var fetch = await client.FetchAsync("ahri", 0);

        Assert.Null(fetch.Payload);
        Assert.True(fetch.Retryable);
        Assert.Equal(2, http.Requests.Count);
        Assert.All(http.Requests, url =>
            Assert.Equal("https://probuildstats.com/champion/ahri?role=top", url.ToString()));
    }

    [Fact]
    public async Task A_shell_followed_by_the_page_recovers_on_retry()
    {
        var shell = Fixture("pbs-ahri-top.html");
        var page = Fixture("pbs-ahri.html");
        var first = true;
        var http = new StubHandler(_ =>
        {
            if (first)
            {
                first = false;
                return Ok(shell);
            }
            return Ok(page);
        });
        var client = new ProBuildsClient(new HttpClient(http));

        var fetch = await client.FetchAsync("ahri", 2);

        Assert.NotNull(fetch.Payload);
        Assert.Equal(2, http.Requests.Count);
    }

    [Fact]
    public async Task A_bad_slug_costs_exactly_one_request()
    {
        var http = new StubHandler(_ => Ok(Fixture("pbs-badslug.html")));
        var client = new ProBuildsClient(new HttpClient(http));

        var fetch = await client.FetchAsync("drmundoks", 2);

        Assert.Null(fetch.Payload);
        Assert.Contains("unknown champion", fetch.Failure, StringComparison.Ordinal);
        Assert.False(fetch.Retryable);
        Assert.Single(http.Requests);
    }

    [Fact]
    public void The_fetch_timeout_is_ten_seconds()
    {
        Assert.Equal(TimeSpan.FromSeconds(10), ProBuildsClient.FetchTimeout);
    }

    // ── Pick rule on synthetic rows ──────────────────────────────────────

    private static ProMatchRow Row(
        string role = "mid",
        string version = "16_18",
        long timestamp = 100,
        int keystone = 8112,
        int sub = 8200,
        int primary = 8100,
        int[]? perks = null,
        int[]? shards = null) =>
        new(
            role, version, timestamp, true, 245, "Faker", "T1",
            primary, sub,
            perks ?? [8112, 8143, 8140, 8106, 8226, 8237],
            shards ?? [5005, 5008, 5011],
            [3118, 3020], [3118, 3020, 1082], 0,
            [new ProItemEvent(1056, 2565, 1)]);

    [Fact]
    public void Fewer_than_three_current_patch_rows_uses_every_candidate()
    {
        // Two on 16_18, five (newer) on 16_17, all the same rune set: the
        // patch filter does not fire, so the most recent game overall wins —
        // even off-patch. Never a silent empty pick.
        var rows = new[]
        {
            Row(version: "16_18", timestamp: 10),
            Row(version: "16_18", timestamp: 20),
            Row(version: "16_17", timestamp: 30),
            Row(version: "16_17", timestamp: 40),
            Row(version: "16_17", timestamp: 50),
            Row(version: "16_17", timestamp: 60),
            Row(version: "16_17", timestamp: 70),
        };

        var (row, failure) = ProBuildsPicker.Pick(rows, "mid");

        Assert.Null(failure);
        Assert.NotNull(row);
        Assert.Equal(70, row.MatchTimestamp);
        Assert.Equal("16_17", row.Version);
    }

    [Fact]
    public void Three_current_patch_rows_keep_the_pick_on_patch()
    {
        var rows = new[]
        {
            Row(version: "16_18", timestamp: 10),
            Row(version: "16_18", timestamp: 20),
            Row(version: "16_18", timestamp: 30),
            Row(version: "16_17", timestamp: 90),
            Row(version: "16_17", timestamp: 100),
        };

        var (row, failure) = ProBuildsPicker.Pick(rows, "mid");

        Assert.Null(failure);
        Assert.NotNull(row);
        Assert.Equal("16_18", row.Version);
        Assert.Equal(30, row.MatchTimestamp);
    }

    [Fact]
    public void The_modal_keystone_wins_over_the_most_recent_game()
    {
        // Three Electrocute games (older) beat two Fleet games (newer): one
        // row is one legal page, and the modal set is the signal.
        var fleet = Row(keystone: 8021, sub: 8300, primary: 8000,
            perks: [8021, 8009, 9103, 8017, 8321, 8316],
            shards: [5008, 5008, 5011]);
        var rows = new[]
        {
            Row(timestamp: 10),
            Row(timestamp: 20),
            Row(timestamp: 30),
            fleet with { MatchTimestamp = 90 },
            fleet with { MatchTimestamp = 100 },
        };

        var (row, failure) = ProBuildsPicker.Pick(rows, "mid");

        Assert.Null(failure);
        Assert.NotNull(row);
        Assert.Equal(8112, row.Perks[0]);
        Assert.Equal(30, row.MatchTimestamp);
    }

    [Fact]
    public void A_row_that_fails_validation_yields_to_the_next_row()
    {
        var bad = Row(timestamp: 100, primary: 8000,
            perks: [8112, 8009, 9103, 8017, 8321, 8316]);
        Assert.NotNull(PerkTreeCatalog.ValidatePage(bad.PrimaryStyle, bad.SubStyle, bad.Perks, bad.Shards));
        var rows = new[]
        {
            Row(timestamp: 10),
            bad,
        };

        var (row, failure) = ProBuildsPicker.Pick(rows, "mid");

        Assert.Null(failure);
        Assert.NotNull(row);
        Assert.Equal(10, row.MatchTimestamp);
    }

    [Fact]
    public void No_valid_row_is_a_typed_failure_not_a_pick()
    {
        var bad = Row(timestamp: 100, primary: 8000,
            perks: [8112, 8009, 9103, 8017, 8321, 8316]);
        var (row, failure) = ProBuildsPicker.Pick([bad], "mid");

        Assert.Null(row);
        Assert.NotNull(failure);
    }

    [Fact]
    public void Role_less_considers_every_row_and_reports_the_row_role()
    {
        var rows = new[]
        {
            Row(role: "mid", timestamp: 10),
            Row(role: "top", timestamp: 50),
        };

        var (payload, failure) = ProBuildsClient.BuildPayload(rows, "ahri", null);

        Assert.Null(failure);
        Assert.NotNull(payload);
        Assert.Equal("top", payload.Role);
    }

    [Fact]
    public void Supp_rows_are_picked_for_role_4()
    {
        var rows = new[]
        {
            Row(role: "adc", timestamp: 90),
            Row(role: "supp", timestamp: 50),
        };

        var (payload, failure) = ProBuildsClient.BuildPayload(rows, "leona", 4);

        Assert.Null(failure);
        Assert.NotNull(payload);
        Assert.Equal("supp", payload.Role);
        Assert.Equal("Support", SiteImportValidator.RoleLabel(payload.Role));
    }

    // ── Item rules ───────────────────────────────────────────────────────

    [Fact]
    public void Starting_items_keep_early_buys_only_with_millisecond_timestamps()
    {
        // The page stamps MILLIseconds (fixture: 2565 ms = the opener). An
        // event at 119999 ms is an opener; at 120001 ms it is not.
        var row = Row() with
        {
            ItemPath = new[]
            {
                new ProItemEvent(1056, 2565, 1),
                new ProItemEvent(2003, 2565, 1),
                new ProItemEvent(2003, 3000, 1),
                new ProItemEvent(3340, 1000, 1),
                new ProItemEvent(2055, 1000, 1),
                new ProItemEvent(9999, 1000, 1),
                new ProItemEvent(3157, 119999, 1),
                new ProItemEvent(3089, 120001, 1),
                new ProItemEvent(3118, 2000, 2),
            },
            RoleBoundItem = 9999,
            CompletedItems = [3157],
            FinalBuild = [3157],
        };

        var blocks = ProBuildsItems.BuildBlocks(row).ToArray();

        Assert.Equal([1056, 2003, 3157], blocks[0].ItemIds);
    }

    [Fact]
    public void Final_build_drops_wards_trinkets_consumables_and_the_quest_item_but_keeps_dark_seal()
    {
        var row = Row() with
        {
            FinalBuild = [3118, 2055, 3364, 3340, 3363, 2003, 2031, 2033, 2138, 2139, 2140, 1082, 1206],
            RoleBoundItem = 1206,
        };

        var blocks = ProBuildsItems.BuildBlocks(row).ToArray();
        var final = Assert.Single(blocks, block => block.Title == "Final Build");

        Assert.Equal([3118, 1082], final.ItemIds);
    }

    [Fact]
    public void Empty_blocks_are_dropped_never_written_empty()
    {
        var row = Row() with
        {
            ItemPath = [new ProItemEvent(3340, 1000, 1)],
            CompletedItems = [],
            FinalBuild = [2055],
        };

        Assert.Empty(ProBuildsItems.BuildBlocks(row));
    }

    // ── Source contract ──────────────────────────────────────────────────

    [Fact]
    public void Pro_parses_labels_and_titles_like_the_other_sources()
    {
        Assert.True(SiteImportPayload.TryParse(
            """{"source":"probuildstats","championSlug":"ahri","role":"mid","runes":null,"itemBlocks":[{"title":"Core","itemIds":[3157]}]}""",
            out var payload, out _));
        Assert.Equal(SiteImportSource.Pro, payload!.Source);
        Assert.Equal("Pro", SiteImportValidator.Label(SiteImportSource.Pro));
        Assert.Equal("CoachBuild import: Ahri Mid (Pro)", SiteImportValidator.PageTitle("Ahri", "mid", SiteImportSource.Pro));
        Assert.Equal("Pro build Jhin (ADC)", SiteImportValidator.RunePageTitle("Jhin", "adc", SiteImportSource.Pro));
        Assert.Equal("Pro build Jhin", SiteImportValidator.RunePageTitle("Jhin", null, SiteImportSource.Pro));
    }

    // ── Trio rune-page budget ────────────────────────────────────────────

    private static LcuPage Page(int id, string? name, bool deletable = true) =>
        new(id, name, deletable, 8000, 8400, [], false);

    [Fact]
    public void MaxOwnedPages_is_three_for_the_trio()
    {
        Assert.Equal(3, RuneApplyService.MaxOwnedPages);
    }

    [Fact]
    public void Pro_pages_are_owned_and_group_by_champion()
    {
        Assert.True(RuneApplyService.IsOwnedPageName("Pro build Ahri (Mid)"));
        Assert.Equal("Ahri", RuneApplyService.ChampionOfOwnedPage("Pro build Ahri (Mid)"));
        Assert.Equal("Lee Sin", RuneApplyService.ChampionOfOwnedPage("Pro build Lee Sin (Jungle)"));
    }

    /// <summary>
    /// A user's own page titled like a pro page ("Pro Yasuo") must never
    /// count as CoachBuild's: owned pages get reused and pruned.
    /// </summary>
    [Theory]
    [InlineData("Pro Yasuo")]
    [InlineData("Pro Jungle")]
    [InlineData("Pro builds")]
    public void A_users_own_pro_titled_page_is_not_owned(string title)
    {
        Assert.False(RuneApplyService.IsOwnedPageName(title));
    }

    [Fact]
    public void Under_the_trio_cap_nothing_is_pruned()
    {
        var pages = new[]
        {
            Page(10, "u.gg Viktor (Mid)"),
            Page(11, "Coachless Viktor (Mid)"),
            Page(12, "Pro build Viktor (Mid)"),
        };
        Assert.Empty(RuneApplyService.PagesToPrune(pages, keepId: 12));
        Assert.Empty(RuneApplyService.PagesToPruneAfterBatch(
            pages, [10, 11, 12],
            ["u.gg Viktor (Mid)", "Coachless Viktor (Mid)", "Pro build Viktor (Mid)"]));
    }

    [Fact]
    public void Beyond_the_trio_cap_the_oldest_goes()
    {
        var pages = new[]
        {
            Page(2, "u.gg Jhin (ADC)"),
            Page(5, "Coachless Jhin (ADC)"),
            Page(8, "Pro build Jhin (ADC)"),
            Page(11, "u.gg Viktor (Mid)"),
        };

        var doomed = RuneApplyService.PagesToPrune(pages, keepId: 11);

        Assert.Equal([2], doomed);
    }

    [Fact]
    public void A_sibling_trio_is_never_pruned_by_its_own_batch()
    {
        var pages = new[]
        {
            Page(4, "u.gg Jhin (ADC)"),
            Page(10, "u.gg Viktor (Mid)"),
            Page(11, "Coachless Viktor (Mid)"),
            Page(12, "Pro build Viktor (Mid)"),
        };

        // The batch wrote only the Pro third this run; the pair it joins
        // still counts as ours to keep, and only Jhin goes.
        var doomed = RuneApplyService.PagesToPruneAfterBatch(
            pages, [12], ["Pro build Viktor (Mid)"]);

        Assert.Equal([4], doomed);
    }

    [Fact]
    public void A_batch_never_keeps_more_than_the_trio_cap()
    {
        var pages = new[]
        {
            Page(9, "Pro build Viktor"),
            Page(10, "u.gg Viktor (Mid)"),
            Page(11, "Coachless Viktor (Mid)"),
            Page(12, "Pro build Viktor (Mid)"),
        };

        var doomed = RuneApplyService.PagesToPruneAfterBatch(
            pages, [10, 11, 12],
            ["u.gg Viktor (Mid)", "Coachless Viktor (Mid)", "Pro build Viktor (Mid)"]);

        Assert.Equal([9], doomed);
    }

    /// <summary>
    /// The wire proof for three sources: one batch creates all three pages
    /// and prunes the previous champion in the same write, touching nothing
    /// foreign.
    /// </summary>
    [Fact]
    public async Task A_batch_creates_all_three_pages_and_prunes_the_previous_champion()
    {
        var api = new StubLcu();
        api.Enqueue("[" + Wire(1, "My ranked page") + "]");
        api.Enqueue("{\"id\":1}");
        api.Enqueue("{\"ownedPageCount\":6}");
        api.Enqueue("{\"id\":10}");
        api.Enqueue("{\"id\":11}");
        api.Enqueue("{\"id\":12}");
        api.Enqueue("[" + Wire(1, "My ranked page") + "," + Wire(4, "u.gg Jhin (ADC)") + "," +
            Wire(10, "u.gg Viktor (Mid)") + "," + Wire(11, "Coachless Viktor (Mid)") + "," +
            Wire(12, "Pro build Viktor (Mid)") + "]");
        api.Enqueue("{}");

        var result = await new RuneApplyService(api).ApplyOwnedPagesAsync(ThreeRequests());

        Assert.Equal(3, result.Pages.Count);
        Assert.All(result.Pages, page => Assert.True(page.Result.Ok));
        Assert.False(result.OnlyOneEditableSlot);
        var creates = api.Calls.Where(call => call.Method == HttpMethod.Post).ToArray();
        Assert.Equal(3, creates.Length);
        Assert.Contains(creates, call => Body(call).Contains("u.gg Viktor (Mid)", StringComparison.Ordinal));
        Assert.Contains(creates, call => Body(call).Contains("Coachless Viktor (Mid)", StringComparison.Ordinal));
        Assert.Contains(creates, call => Body(call).Contains("Pro build Viktor (Mid)", StringComparison.Ordinal));
        var deletes = api.Calls
            .Where(call => call.Method == HttpMethod.Delete)
            .Select(call => call.Path)
            .ToArray();
        Assert.Equal(["/lol-perks/v1/pages/4"], deletes);
    }

    [Fact]
    public async Task Two_free_slots_write_ugg_and_coachless_and_leave_pro_slots_full()
    {
        var api = new StubLcu();
        api.Enqueue("[" + Wire(1, "Mine 1") + "," + Wire(2, "Mine 2") + "," + Wire(3, "Mine 3") + "]");
        api.Enqueue(Wire(1, "Mine 1"));
        api.Enqueue("{\"ownedPageCount\":5}");
        api.Enqueue("{\"id\":10}");
        api.Enqueue("{\"id\":11}");
        api.Enqueue("[" + Wire(1, "Mine 1") + "," + Wire(2, "Mine 2") + "," + Wire(3, "Mine 3") + "," +
            Wire(10, "u.gg Viktor (Mid)") + "," + Wire(11, "Coachless Viktor (Mid)") + "]");

        var result = await new RuneApplyService(api).ApplyOwnedPagesAsync(ThreeRequests());

        Assert.False(result.OnlyOneEditableSlot);
        Assert.True(result.Pages[0].Result.Ok);
        Assert.True(result.Pages[1].Result.Ok);
        Assert.Equal("slots-full", Assert.IsType<ApplyRunesFailure>(result.Pages[2].Result).Reason);
        Assert.Equal("Pro build Viktor (Mid)", result.Pages[2].Name);
        var creates = api.Calls.Where(call => call.Method == HttpMethod.Post).ToArray();
        Assert.Equal(2, creates.Length);
        Assert.DoesNotContain(api.Calls, call => call.Method == HttpMethod.Delete);
    }

    private static IReadOnlyList<ApplyRunesRequest> ThreeRequests() =>
    [
        new("u.gg Viktor (Mid)", 8000, 8400,
            [8021, 8009, 9105, 8017, 8473, 8451, 5007, 5010, 5013], false, "auto"),
        new("Coachless Viktor (Mid)", 8000, 8400,
            [8021, 8009, 9105, 8017, 8473, 8451, 5007, 5010, 5013], false, "auto"),
        new("Pro build Viktor (Mid)", 8000, 8400,
            [8021, 8009, 9105, 8017, 8473, 8451, 5007, 5010, 5013], false, "auto"),
    ];

    private static string Body((HttpMethod Method, string Path, object? Body) call) =>
        JsonSerializer.Serialize(call.Body);

    private static string Wire(int id, string name) =>
        $"{{\"id\":{id},\"name\":\"{name}\",\"isDeletable\":true,\"primaryStyleId\":8000," +
        "\"subStyleId\":8400,\"selectedPerkIds\":[8021,8009,9105,8017,8473,8451,5007,5010,5013]," +
        "\"current\":false}";

    private sealed class StubHandler : HttpMessageHandler
    {
        private readonly Func<HttpRequestMessage, HttpResponseMessage> _answer;

        public StubHandler(Func<HttpRequestMessage, HttpResponseMessage> answer) => _answer = answer;

        public List<Uri> Requests { get; } = [];

        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Requests.Add(request.RequestUri!);
            return Task.FromResult(_answer(request));
        }
    }

    private static HttpResponseMessage Ok(string body) =>
        new(HttpStatusCode.OK) { Content = new StringContent(body) };

    private sealed class StubLcu : ILcuApi
    {
        private readonly Queue<LcuResponse> _responses = new();

        public List<(HttpMethod Method, string Path, object? Body)> Calls { get; } = [];

        public void Enqueue(string json) =>
            _responses.Enqueue(new LcuResponse(true, 200, JsonDocument.Parse(json).RootElement.Clone()));

        public Task<LcuResponse> SendAsync(
            HttpMethod method, string path, object? body = null, CancellationToken cancellationToken = default)
        {
            Calls.Add((method, path, body));
            return Task.FromResult(
                _responses.Count > 0 ? _responses.Dequeue() : new LcuResponse(false, 404));
        }
    }
}
