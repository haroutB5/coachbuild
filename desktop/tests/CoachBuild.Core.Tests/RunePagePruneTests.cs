using System.Net.Http;
using CoachBuild.Core;
using Xunit;

namespace CoachBuild.Core.Tests;

/// <summary>
/// Rune pages must not accumulate the way they did.
///
/// <para>WHY. Field evidence 2026-09-08: the item-set write prunes —
/// <see cref="ItemSetMergeService.Merge"/> drops every existing
/// <c>CoachBuild</c>-titled set and re-adds only the current ones — but the
/// rune write had no bound at all, because the import deliberately sends a null
/// <c>replacePrefix</c> and that was the only thing that ever deleted a stale
/// page. The client was still holding <c>CoachBuild Mordekaiser Top</c> long
/// after that champion's item set had been pruned. The cap now lives in
/// <see cref="RuneApplyService.MaxOwnedPages"/>, and every assertion here is
/// about what the cap must REFUSE to touch.</para>
/// </summary>
public sealed class RunePagePruneTests
{
    private static LcuPage Page(int id, string? name, bool deletable = true) =>
        new(id, name, deletable, 8000, 8400, [], false);

    [Fact]
    public void Under_the_cap_nothing_is_pruned()
    {
        var pages = new[] { Page(9, "CoachBuild import: Nasus Top (u.gg)") };
        Assert.Empty(RuneApplyService.PagesToPrune(pages, keepId: 9));
    }

    [Fact]
    public void The_page_just_written_is_never_pruned()
    {
        // Even when it is not the newest id: keepId wins outright.
        var pages = new[]
        {
            Page(3, "CoachBuild A"), Page(7, "CoachBuild B"), Page(9, "CoachBuild C"),
        };
        var doomed = RuneApplyService.PagesToPrune(pages, keepId: 3);
        Assert.DoesNotContain(3, doomed);
    }

    [Fact]
    public void Beyond_the_cap_the_oldest_go_and_the_newest_survive()
    {
        var pages = new[]
        {
            Page(2, "CoachBuild oldest"),
            Page(5, "CoachBuild middle"),
            Page(8, "CoachBuild newer"),
            Page(11, "CoachBuild just written"),
        };

        var doomed = RuneApplyService.PagesToPrune(pages, keepId: 11);

        // MaxOwnedPages = 2 counts the written page, so exactly one other
        // survives: the newest of the rest.
        Assert.Equal(RuneApplyService.MaxOwnedPages - 1, 4 - 1 - doomed.Count);
        Assert.Equal([5, 2], doomed);
        Assert.DoesNotContain(11, doomed);
        Assert.DoesNotContain(8, doomed);
    }

    [Fact]
    public void A_page_the_user_owns_is_never_pruned_however_far_over_the_cap()
    {
        var pages = new[]
        {
            Page(1, "My Nasus page"),
            Page(2, null),
            Page(3, "coachbuild lower case"),
            Page(4, "Not CoachBuild but mentions CoachBuild"),
            Page(5, "CoachBuild import: A"),
            Page(6, "CoachBuild import: B"),
            Page(7, "CoachBuild import: C"),
        };

        var doomed = RuneApplyService.PagesToPrune(pages, keepId: 7);

        // Only ours, only over the cap: 6 survives as the one other slot, 5 goes.
        Assert.Equal([5], doomed);
        foreach (var id in new[] { 1, 2, 3, 4 })
            Assert.DoesNotContain(id, doomed);
    }

    [Fact]
    public void An_undeletable_page_is_never_returned()
    {
        var pages = new[]
        {
            Page(1, "CoachBuild import: A", deletable: false),
            Page(2, "CoachBuild import: B", deletable: false),
            Page(3, "CoachBuild import: C"),
        };
        Assert.Empty(RuneApplyService.PagesToPrune(pages, keepId: 3));
    }

    [Fact]
    public void Null_input_prunes_nothing()
    {
        Assert.Empty(RuneApplyService.PagesToPrune(null, keepId: 1));
        Assert.Empty(RuneApplyService.PagesToPrune([], keepId: 1));
    }

    /// <summary>
    /// The wire proof, not just the predicate: a write with three of our pages
    /// already in the client issues the DELETE for the oldest and for nothing
    /// else, and the import still reports success.
    /// </summary>
    [Fact]
    public async Task A_rune_write_deletes_the_oldest_of_our_pages_over_the_cap()
    {
        var api = new StubLcu();
        const string title = "CoachBuild import: Nasus Top (Coachless)";
        // 1. read pages (no page by this title yet)
        api.Enqueue("[" + Wire(1, "Mine, not yours") + "," + Wire(4, "CoachBuild import: A") + "," +
            Wire(6, "CoachBuild import: B") + "]");
        // 2. inventory  3. create -> id 9  4. select 9
        api.Enqueue("{\"ownedPageCount\":9}");
        api.Enqueue("{\"id\":9}");
        api.Enqueue("9");
        // 5. the prune's re-read, now including the page just written
        api.Enqueue("[" + Wire(1, "Mine, not yours") + "," + Wire(4, "CoachBuild import: A") + "," +
            Wire(6, "CoachBuild import: B") + "," + Wire(9, title) + "]");
        // 6. the delete  7. the verification read
        api.Enqueue("{}");
        api.Enqueue(Wire(9, title));

        var runes = new RuneApplyService(api);
        var result = await runes.ApplyAsync(new ApplyRunesRequest(
            title, 8000, 8400, [8021, 8009, 9105, 8017, 8473, 8451, 5007, 5010, 5013], true, "manual"));

        Assert.True(result.Ok);
        var deletes = api.Calls
            .Where(call => call.Method == HttpMethod.Delete)
            .Select(call => call.Path)
            .ToArray();
        Assert.Equal(["/lol-perks/v1/pages/4"], deletes);
    }

    /// <summary>
    /// And the cleanup can never cost the user the import: a client that
    /// refuses the pages re-read still leaves a successful write successful.
    /// </summary>
    [Fact]
    public async Task A_failed_prune_does_not_fail_the_write()
    {
        var api = new StubLcu();
        const string title = "CoachBuild import: Nasus Top (Coachless)";
        api.Enqueue("[]");
        api.Enqueue("{\"ownedPageCount\":9}");
        api.Enqueue("{\"id\":9}");
        api.Enqueue("9");
        api.Fail();               // the prune's re-read
        api.Enqueue(Wire(9, title));

        var runes = new RuneApplyService(api);
        var result = await runes.ApplyAsync(new ApplyRunesRequest(
            title, 8000, 8400, [8021, 8009, 9105, 8017, 8473, 8451, 5007, 5010, 5013], true, "manual"));

        Assert.True(result.Ok);
        Assert.DoesNotContain(api.Calls, call => call.Method == HttpMethod.Delete);
    }

    [Fact]
    public async Task Automatic_write_creates_both_source_pages_without_selecting_a_foreign_current_page()
    {
        var api = new StubLcu();
        api.Enqueue("[" + Wire(1, "My ranked page") + "]");
        api.Enqueue(Wire(1, "My ranked page"));
        api.Enqueue("{\"ownedPageCount\":5}");
        api.Enqueue("{\"id\":10}");
        api.Enqueue("{\"id\":11}");
        api.Enqueue("[" + Wire(1, "My ranked page") + "," + Wire(10, "u.gg Nasus (Top)") + "," +
            Wire(11, "Coachless Nasus (Top)") + "]");

        var result = await new RuneApplyService(api).ApplyOwnedPagesAsync(TwoRequests());

        Assert.Equal(2, result.Pages.Count);
        Assert.All(result.Pages, page => Assert.True(page.Result.Ok));
        var creates = api.Calls.Where(call => call.Method == HttpMethod.Post).ToArray();
        Assert.Equal(2, creates.Length);
        Assert.Contains(creates, call => Body(call).Contains("u.gg Nasus (Top)", StringComparison.Ordinal));
        Assert.Contains(creates, call => Body(call).Contains("Coachless Nasus (Top)", StringComparison.Ordinal));
        Assert.All(creates, call => Assert.Contains("\"current\":false", Body(call), StringComparison.OrdinalIgnoreCase));
        Assert.DoesNotContain(api.Calls, call => call.Path == "/lol-perks/v1/currentpage" && call.Method == HttpMethod.Put);
        Assert.DoesNotContain(api.Calls, call => call.Method == HttpMethod.Delete);
    }

    [Fact]
    public async Task One_editable_slot_writes_only_ugg_and_never_touches_foreign_pages()
    {
        var api = new StubLcu();
        api.Enqueue("[" + Wire(1, "My first page") + "," + Wire(2, "My second page") + "]");
        api.Enqueue(Wire(1, "My first page"));
        api.Enqueue("{\"ownedPageCount\":3}");
        api.Enqueue("{\"id\":10}");
        api.Enqueue("[" + Wire(1, "My first page") + "," + Wire(2, "My second page") + "," +
            Wire(10, "u.gg Nasus (Top)") + "]");

        var result = await new RuneApplyService(api).ApplyOwnedPagesAsync(TwoRequests());

        Assert.True(result.OnlyOneEditableSlot);
        Assert.True(result.Pages[0].Result.Ok);
        Assert.Equal("slots-full", Assert.IsType<ApplyRunesFailure>(result.Pages[1].Result).Reason);
        var create = Assert.Single(api.Calls, call => call.Method == HttpMethod.Post);
        Assert.Contains("u.gg Nasus (Top)", Body(create), StringComparison.Ordinal);
        Assert.DoesNotContain(api.Calls, call => call.Method is { } method &&
            (method == HttpMethod.Put || method == HttpMethod.Delete) &&
            (call.Path.EndsWith("/1", StringComparison.Ordinal) || call.Path.EndsWith("/2", StringComparison.Ordinal)));
    }

    [Fact]
    public async Task An_owned_current_page_makes_the_matching_ugg_page_current_after_both_are_reused()
    {
        var pages = "[" + Wire(10, "u.gg Nasus (Top)") + "," + Wire(11, "Coachless Nasus (Top)") + "]";
        var api = new StubLcu();
        api.Enqueue(pages);
        api.Enqueue("{\"id\":11}");
        api.Enqueue("{\"ownedPageCount\":2}");
        api.Enqueue("{}");
        api.Enqueue(pages);

        var result = await new RuneApplyService(api).ApplyOwnedPagesAsync(TwoRequests());

        Assert.All(result.Pages, page => Assert.IsType<ApplyRunesSuccess>(page.Result));
        var select = Assert.Single(api.Calls, call =>
            call.Method == HttpMethod.Put && call.Path == "/lol-perks/v1/currentpage");
        Assert.Equal("10", Body(select));
        Assert.DoesNotContain(api.Calls, call => call.Method == HttpMethod.Post ||
            call.Path.StartsWith("/lol-perks/v1/pages/", StringComparison.Ordinal));
    }

    // ---- 2.2.2: the pair must survive its own sibling's write ---------------
    // Field log 2026-09-09 13:11:22, Viktor hovered: `runes: wrote Coachless
    // Viktor` and, in the same breath, `apply-runes: pruned 1 superseded
    // CoachBuild rune page(s), keeping 1`. 2.2.1 imports on stable hover, so a
    // single run can carry only one site's rune build; the second site's write
    // then pruned the first site's FRESH page for the same champion. The pair
    // is the product. These are the assertions that the halves cannot eat each
    // other and that other champions are still cleaned up.

    [Fact]
    public void The_champion_is_read_out_of_every_title_shape_we_have_ever_written()
    {
        // The pair, 2.2.0 shapes, with and without an assigned role.
        Assert.Equal("Viktor", RuneApplyService.ChampionOfOwnedPage("u.gg Viktor"));
        Assert.Equal("Viktor", RuneApplyService.ChampionOfOwnedPage("Coachless Viktor"));
        Assert.Equal("Viktor", RuneApplyService.ChampionOfOwnedPage("u.gg Viktor (Mid)"));
        Assert.Equal("Viktor", RuneApplyService.ChampionOfOwnedPage("Coachless Viktor (Mid)"));
        // Legacy titles: role bare, source parenthesised.
        Assert.Equal("Viktor", RuneApplyService.ChampionOfOwnedPage("CoachBuild import: Viktor Mid (u.gg)"));
        Assert.Equal("Nasus", RuneApplyService.ChampionOfOwnedPage("CoachBuild import: Nasus (Coachless)"));
        // Two-word champions keep both words.
        Assert.Equal("Lee Sin", RuneApplyService.ChampionOfOwnedPage("u.gg Lee Sin (Jungle)"));
        Assert.Equal("Lee Sin", RuneApplyService.ChampionOfOwnedPage("CoachBuild import: Lee Sin Jungle (u.gg)"));
        // A page that is not ours has no champion, so it can never be a sibling.
        Assert.Null(RuneApplyService.ChampionOfOwnedPage("My Viktor page"));
        Assert.Null(RuneApplyService.ChampionOfOwnedPage(null));
        Assert.Null(RuneApplyService.ChampionOfOwnedPage(""));
    }

    [Fact]
    public void A_sibling_site_page_for_the_same_champion_is_never_pruned()
    {
        var pages = new[]
        {
            Page(10, "u.gg Viktor"),
            Page(11, "Coachless Viktor"),
        };

        // The batch wrote only the Coachless half this run (hover import).
        var doomed = RuneApplyService.PagesToPruneAfterBatch(pages, [11], ["Coachless Viktor"]);

        Assert.Empty(doomed);
    }

    [Fact]
    public void The_sibling_survives_even_when_this_run_never_asked_for_it()
    {
        // The u.gg fetch failed, so its name is not in writtenNames either. The
        // page still belongs to the champion in hand, so it stays.
        var pages = new[] { Page(10, "u.gg Viktor (Mid)"), Page(11, "Coachless Viktor (Mid)") };
        Assert.Empty(RuneApplyService.PagesToPruneAfterBatch(pages, [11], ["Coachless Viktor (Mid)"]));
    }

    [Fact]
    public void Other_champions_pages_are_still_pruned_by_a_batch_write()
    {
        var pages = new[]
        {
            Page(4, "CoachBuild import: Nasus Top (u.gg)"),
            Page(5, "u.gg Jhin (ADC)"),
            Page(10, "u.gg Viktor (Mid)"),
            Page(11, "Coachless Viktor (Mid)"),
        };

        var doomed = RuneApplyService.PagesToPruneAfterBatch(pages, [11], ["Coachless Viktor (Mid)"]);

        Assert.Equal([5, 4], doomed);
        Assert.DoesNotContain(10, doomed);
    }

    [Fact]
    public void The_pair_takes_the_survivor_slot_ahead_of_a_newer_stranger()
    {
        // The single-write path. Id order says 12 is the newest, but 10 is the
        // other half of the champion in hand, so 10 survives and 12 goes.
        var pages = new[]
        {
            Page(10, "u.gg Viktor"),
            Page(11, "Coachless Viktor"),
            Page(12, "u.gg Jhin (ADC)"),
        };

        var doomed = RuneApplyService.PagesToPrune(pages, keepId: 11);

        Assert.Equal([12], doomed);
    }

    [Fact]
    public void A_batch_never_keeps_more_than_the_cap_even_with_stale_siblings()
    {
        // Three pages for the same champion (a roleless title left over from an
        // earlier run). Both halves just written fill the cap, so the stale one
        // is still pruned -- sparing siblings is not a licence to accumulate.
        var pages = new[]
        {
            Page(9, "u.gg Viktor"),
            Page(10, "u.gg Viktor (Mid)"),
            Page(11, "Coachless Viktor (Mid)"),
        };

        var doomed = RuneApplyService.PagesToPruneAfterBatch(
            pages, [10, 11], ["u.gg Viktor (Mid)", "Coachless Viktor (Mid)"]);

        Assert.Equal([9], doomed);
    }

    [Fact]
    public void A_foreign_page_for_the_same_champion_is_still_never_touched()
    {
        var pages = new[]
        {
            Page(1, "My Viktor page"),
            Page(2, "u.gg Viktor", deletable: false),
            Page(10, "u.gg Viktor"),
            Page(11, "Coachless Viktor"),
        };

        var doomed = RuneApplyService.PagesToPruneAfterBatch(pages, [11], ["Coachless Viktor"]);

        Assert.Empty(doomed);
    }

    /// <summary>
    /// The wire proof of the field bug. The 2.2.1 hover import means a single
    /// run can carry ONE site's rune build; here the u.gg half is already in
    /// the client from the previous run and the Coachless half is written now.
    /// The u.gg page must be neither overwritten nor deleted.
    /// </summary>
    [Fact]
    public async Task A_coachless_only_run_leaves_the_ugg_half_of_the_pair_alone()
    {
        var api = new StubLcu();
        api.Enqueue("[" + Wire(10, "u.gg Viktor (Mid)") + "]");   // 1. read pages
        api.Enqueue("{}");                                        // 2. currentpage (foreign)
        api.Enqueue("{\"ownedPageCount\":5}");                    // 3. inventory
        api.Enqueue("{\"id\":11}");                               // 4. create
        api.Enqueue("[" + Wire(10, "u.gg Viktor (Mid)") + "," +   // 5. the prune's re-read
            Wire(11, "Coachless Viktor (Mid)") + "]");

        var result = await new RuneApplyService(api).ApplyOwnedPagesAsync([CoachlessViktor()]);

        Assert.True(Assert.Single(result.Pages).Result.Ok);
        // Not deleted...
        Assert.DoesNotContain(api.Calls, call => call.Method == HttpMethod.Delete);
        // ...and not cannibalised for reuse either: the write CREATED.
        Assert.Single(api.Calls, call => call.Method == HttpMethod.Post);
        Assert.DoesNotContain(api.Calls, call =>
            call.Method == HttpMethod.Put && call.Path == "/lol-perks/v1/pages/10");
    }

    /// <summary>
    /// And the prune still does its job: the champion BEFORE this one is
    /// cleaned up in the same write that spares the current pair.
    /// </summary>
    [Fact]
    public async Task The_same_write_still_prunes_the_previous_champion()
    {
        var api = new StubLcu();
        api.Enqueue("[" + Wire(4, "u.gg Jhin (ADC)") + "," + Wire(5, "Coachless Jhin (ADC)") + "," +
            Wire(10, "u.gg Viktor (Mid)") + "]");                 // 1. read pages
        api.Enqueue("{}");                                        // 2. currentpage
        api.Enqueue("{\"ownedPageCount\":5}");                    // 3. inventory
        api.Enqueue("{}");                                        // 4. edit (reuses the Coachless-family page 5)
        api.Enqueue("[" + Wire(4, "u.gg Jhin (ADC)") + "," +      // 5. the prune's re-read
            Wire(5, "Coachless Viktor (Mid)") + "," + Wire(10, "u.gg Viktor (Mid)") + "]");
        api.Enqueue("{}");                                        // 6. the delete

        var result = await new RuneApplyService(api).ApplyOwnedPagesAsync([CoachlessViktor()]);

        Assert.True(Assert.Single(result.Pages).Result.Ok);
        var deletes = api.Calls
            .Where(call => call.Method == HttpMethod.Delete)
            .Select(call => call.Path)
            .ToArray();
        // Jhin's leftover goes; the Viktor pair survives whole.
        Assert.Equal(["/lol-perks/v1/pages/4"], deletes);
    }

    private static ApplyRunesRequest CoachlessViktor() =>
        new("Coachless Viktor (Mid)", 8000, 8400,
            [8021, 8009, 9105, 8017, 8473, 8451, 5007, 5010, 5013], false, "auto");

    private static IReadOnlyList<ApplyRunesRequest> TwoRequests() =>
    [
        new("u.gg Nasus (Top)", 8000, 8400,
            [8021, 8009, 9105, 8017, 8473, 8451, 5007, 5010, 5013], false, "auto"),
        new("Coachless Nasus (Top)", 8000, 8400,
            [8021, 8009, 9105, 8017, 8473, 8451, 5007, 5010, 5013], false, "auto"),
    ];

    private static string Body((HttpMethod Method, string Path, object? Body) call) =>
        System.Text.Json.JsonSerializer.Serialize(call.Body);

    private static string Wire(int id, string name) =>
        $"{{\"id\":{id},\"name\":\"{name}\",\"isDeletable\":true,\"primaryStyleId\":8000," +
        "\"subStyleId\":8400,\"selectedPerkIds\":[8021,8009,9105,8017,8473,8451,5007,5010,5013]," +
        "\"current\":false}";

    private sealed class StubLcu : ILcuApi
    {
        private readonly Queue<LcuResponse> _responses = new();

        public List<(HttpMethod Method, string Path, object? Body)> Calls { get; } = [];

        public void Enqueue(string json) =>
            _responses.Enqueue(new LcuResponse(true, 200, System.Text.Json.JsonDocument.Parse(json).RootElement.Clone()));

        public void Fail() => _responses.Enqueue(new LcuResponse(false, 500));

        public Task<LcuResponse> SendAsync(
            HttpMethod method, string path, object? body = null, CancellationToken cancellationToken = default)
        {
            Calls.Add((method, path, body));
            return Task.FromResult(
                _responses.Count > 0 ? _responses.Dequeue() : new LcuResponse(false, 404));
        }
    }
}
