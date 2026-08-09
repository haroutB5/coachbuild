using System.Net.Http;
using CoachBuild.Core;
using Xunit;

namespace CoachBuild.Core.Tests;

public sealed class RuneOwnershipTests
{
    [Fact]
    public async Task Auto_full_five_foreign_pages_emits_zero_deletes()
    {
        var api = new MockLcuApi();
        api.Enqueue(HttpMethod.Get, "/lol-perks/v1/pages", Ok("[" + string.Join(',', Enumerable.Range(1, 5).Select(i => Page(i, $"Player {i}", 1, 1))) + "]"));
        api.Enqueue(HttpMethod.Get, "/lol-perks/v1/inventory", Ok("{\"ownedPageCount\":5}"));
        var service = new RuneApplyService(api);
        var result = await service.ApplyAsync(Request("CoachBuild Ahri Top", "auto"));

        var failure = Assert.IsType<ApplyRunesFailure>(result);
        Assert.Equal("slots-full", failure.Reason);
        Assert.Equal(0, api.Count(HttpMethod.Delete, "/lol-perks/v1/pages/1"));
        Assert.DoesNotContain(api.Calls, call => call.Method == HttpMethod.Delete);
    }

    [Fact]
    public async Task Auto_refuses_a_page_modified_after_this_companion_wrote_it()
    {
        var api = new MockLcuApi();
        var desired = Request("CoachBuild Ahri Top", "auto");
        api.Enqueue(HttpMethod.Get, "/lol-perks/v1/pages", Ok("[" + Page(1, desired.Name!, 1, 1) + "]"));
        api.Enqueue(HttpMethod.Get, "/lol-perks/v1/inventory", Ok("{\"ownedPageCount\":5}"));
        api.Enqueue(HttpMethod.Post, "/lol-perks/v1/pages", Ok("{\"id\":2}"));
        api.Enqueue(HttpMethod.Put, "/lol-perks/v1/currentpage", Ok("2"));
        api.Enqueue(HttpMethod.Get, "/lol-perks/v1/currentpage", Ok(Page(2, desired.Name!, 2, 2)));
        // The first page was not an exact desired fingerprint, so the create
        // path records the ownership fingerprint for title 2? The request
        // title is the same and the exact page remains target on the second
        // call; replace the queued sequence with the direct edit path below.
        api = new MockLcuApi();
        api.Enqueue(HttpMethod.Get, "/lol-perks/v1/pages", Ok("[" + Page(1, desired.Name!, 1, 1) + "]"));
        api.Enqueue(HttpMethod.Put, "/lol-perks/v1/pages/1", Ok("{}"));
        api.Enqueue(HttpMethod.Put, "/lol-perks/v1/currentpage", Ok("1"));
        api.Enqueue(HttpMethod.Get, "/lol-perks/v1/currentpage", Ok(Page(1, desired.Name!, 1, 2)));
        var first = new RuneApplyService(api);
        var firstResult = await first.ApplyAsync(desired);
        Assert.True(firstResult.Ok);

        api.Enqueue(HttpMethod.Get, "/lol-perks/v1/pages", Ok("[" + Page(1, desired.Name!, 2, 2) + "]"));
        var secondResult = await first.ApplyAsync(desired);
        var failure = Assert.IsType<ApplyRunesFailure>(secondResult);
        Assert.Equal("user-modified", failure.Reason);
    }

    [Fact]
    public async Task Exact_WPA_and_Pro_titles_edit_their_own_pages_only()
    {
        var api = new MockLcuApi();
        var wpa = "CoachBuild Ahri Top";
        var pro = "CoachBuild Ahri Top Pro";
        api.Enqueue(HttpMethod.Get, "/lol-perks/v1/pages", Ok($"[{Page(3, wpa, 1, 1)},{Page(4, pro, 2, 2)}]"));
        api.Enqueue(HttpMethod.Put, "/lol-perks/v1/pages/4", Ok("{}"));
        api.Enqueue(HttpMethod.Put, "/lol-perks/v1/currentpage", Ok("4"));
        api.Enqueue(HttpMethod.Get, "/lol-perks/v1/currentpage", Ok(Page(4, pro, 2, 3)));
        var result = await new RuneApplyService(api).ApplyAsync(Request(pro, "manual", primary: 2, sub: 3));

        Assert.True(result.Ok);
        Assert.Equal(1, api.Count(HttpMethod.Put, "/lol-perks/v1/pages/4"));
        Assert.Equal(0, api.Count(HttpMethod.Put, "/lol-perks/v1/pages/3"));
    }

    [Fact]
    public async Task Stale_cleanup_is_champ_scoped_and_fail_soft()
    {
        var api = new MockLcuApi();
        api.Enqueue(HttpMethod.Get, "/lol-perks/v1/pages", Ok($"[{Page(1, "CoachBuild Ahri Top", 1, 1)},{Page(2, "CoachBuild Lux Mid", 1, 1)}]"));
        api.Enqueue(HttpMethod.Delete, "/lol-perks/v1/pages/2", new LcuResponse(false, 409));
        api.Enqueue(HttpMethod.Get, "/lol-perks/v1/pages", Ok($"[{Page(1, "CoachBuild Ahri Top", 1, 1)},{Page(2, "CoachBuild Lux Mid", 1, 1)}]"));
        api.Enqueue(HttpMethod.Put, "/lol-perks/v1/pages/1", Ok("{}"));
        api.Enqueue(HttpMethod.Put, "/lol-perks/v1/currentpage", Ok("1"));
        api.Enqueue(HttpMethod.Get, "/lol-perks/v1/currentpage", Ok(Page(1, "CoachBuild Ahri Top", 2, 2)));
        var result = await new RuneApplyService(api).ApplyAsync(Request("CoachBuild Ahri Top", "manual", replacePrefix: "CoachBuild Ahri ", primary: 2, sub: 2));
        Assert.True(result.Ok);
        Assert.Equal(1, api.Count(HttpMethod.Delete, "/lol-perks/v1/pages/2"));
        Assert.Equal(0, api.Count(HttpMethod.Delete, "/lol-perks/v1/pages/1"));
    }

    [Fact]
    public async Task Manual_full_slot_replacement_keeps_the_explicit_consent_path()
    {
        var api = new MockLcuApi();
        api.Enqueue(HttpMethod.Get, "/lol-perks/v1/pages", Ok("[" + string.Join(',', Enumerable.Range(1, 5).Select(i => Page(i, $"Player {i}", 1, 1))) + "]"));
        api.Enqueue(HttpMethod.Get, "/lol-perks/v1/inventory", Ok("{\"ownedPageCount\":5}"));
        api.Enqueue(HttpMethod.Get, "/lol-perks/v1/currentpage", Ok(Page(1, "Player 1", 1, 1)));
        api.Enqueue(HttpMethod.Delete, "/lol-perks/v1/pages/1", Ok("{}"));
        api.Enqueue(HttpMethod.Post, "/lol-perks/v1/pages", Ok("{\"id\":7}"));
        api.Enqueue(HttpMethod.Put, "/lol-perks/v1/currentpage", Ok("7"));
        api.Enqueue(HttpMethod.Get, "/lol-perks/v1/currentpage", Ok(Page(7, "CoachBuild Ahri Top", 2, 2)));
        var result = await new RuneApplyService(api).ApplyAsync(Request("CoachBuild Ahri Top", "manual", primary: 2, sub: 2));

        Assert.True(result.Ok);
        Assert.Equal(1, api.Count(HttpMethod.Delete, "/lol-perks/v1/pages/1"));
    }

    private static ApplyRunesRequest Request(string name, string mode, string? replacePrefix = null, int primary = 1, int sub = 1) =>
        new(name, primary, sub, Enumerable.Range(1, 9).ToArray(), true, mode, replacePrefix);

    private static string Page(int id, string name, int primary, int sub) =>
        $"{{\"id\":{id},\"name\":\"{name}\",\"isDeletable\":true,\"primaryStyleId\":{primary},\"subStyleId\":{sub},\"selectedPerkIds\":[1,2,3,4,5,6,7,8,9],\"current\":false}}";

    private static LcuResponse Ok(string raw) => new(true, 200, MockLcuApi.Json(raw), raw);
}

