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

    private static string Wire(int id, string name) =>
        $"{{\"id\":{id},\"name\":\"{name}\",\"isDeletable\":true,\"primaryStyleId\":8000," +
        "\"subStyleId\":8400,\"selectedPerkIds\":[8021,8009,9105,8017,8473,8451,5007,5010,5013]," +
        "\"current\":false}";

    private sealed class StubLcu : ILcuApi
    {
        private readonly Queue<LcuResponse> _responses = new();

        public List<(HttpMethod Method, string Path)> Calls { get; } = [];

        public void Enqueue(string json) =>
            _responses.Enqueue(new LcuResponse(true, 200, System.Text.Json.JsonDocument.Parse(json).RootElement.Clone()));

        public void Fail() => _responses.Enqueue(new LcuResponse(false, 500));

        public Task<LcuResponse> SendAsync(
            HttpMethod method, string path, object? body = null, CancellationToken cancellationToken = default)
        {
            Calls.Add((method, path));
            return Task.FromResult(
                _responses.Count > 0 ? _responses.Dequeue() : new LcuResponse(false, 404));
        }
    }
}
