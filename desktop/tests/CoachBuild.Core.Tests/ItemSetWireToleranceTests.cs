using System.Text.Json;
using CoachBuild.Core;
using Xunit;

namespace CoachBuild.Core.Tests;

/// <summary>
/// The web still sends <c>situational</c>, and this desktop no longer reads it.
///
/// <para><b>Why this file exists.</b> 1.0.23 removed the WPA item-number
/// overlay from the desktop and deliberately did NOT touch the web: the
/// Situational block still ships in the item set, so
/// <c>itemSetsApply.ts</c> still posts a <c>situational</c> array on every
/// apply. That makes "a field the desktop does not model" the SHIPPED
/// configuration rather than a hypothetical future one, and the whole apply —
/// the write that changes the player's League config — now depends on
/// <c>JsonOptions.Wire</c> leaving <c>UnmappedMemberHandling</c> at its default
/// of Skip.</para>
///
/// <para>The tests that used to cover this went with the feature. Losing them
/// would leave the removal one <c>UnmappedMemberHandling.Disallow</c> away from
/// failing every item-set write in the field, with nothing red on the way
/// there.</para>
/// </summary>
public sealed class ItemSetWireToleranceTests
{
    private const string LiveSituational = """
    [ {"id":3158,"wpa":4.27,"text":"+4.27"}, {"id":3068,"wpa":-0.06,"text":"-0.06"} ]
    """;

    [Fact]
    public void The_situational_field_the_web_still_sends_is_skipped_not_rejected()
    {
        var request = JsonSerializer.Deserialize<ApplyItemSetsRequest>($$"""
        {"championId":3,"sets":[{"title":"CoachBuild Galio Mid","blocks":[]}],
         "replacePrefix":"CoachBuild",
         "situational":{{LiveSituational}}}
        """, JsonOptions.Wire);

        Assert.NotNull(request);
        Assert.Equal(3, request!.ChampionId);
        Assert.Single(request.Sets!);
        Assert.True(ApplyPayloadValidation.TryValidateItemSets(request, out _));
    }

    [Theory]
    [InlineData("""{"championId":3,"sets":[{"title":"CoachBuild X","blocks":[]}],"situational":"nonsense"}""")]
    [InlineData("""{"championId":3,"sets":[{"title":"CoachBuild X","blocks":[]}],"situational":[{"id":null}]}""")]
    [InlineData("""{"championId":3,"sets":[{"title":"CoachBuild X","blocks":[]}],"situational":42}""")]
    [InlineData("""{"championId":3,"sets":[{"title":"CoachBuild X","blocks":[]}],"anythingElse":{"nested":[1,2,3]}}""")]
    public void No_shape_of_an_unmodelled_member_can_cost_the_caller_their_item_set(string body)
    {
        var request = JsonSerializer.Deserialize<ApplyItemSetsRequest>(body, JsonOptions.Wire);

        Assert.NotNull(request);
        Assert.Equal(3, request!.ChampionId);
        Assert.Single(request.Sets!);
        Assert.True(ApplyPayloadValidation.TryValidateItemSets(request, out _));
    }

    [Fact]
    public async Task A_live_web_payload_still_writes_the_set_and_logs_nothing_about_numbers()
    {
        // End to end, through the real service: the PUT goes out, the count
        // line is written, and no line claims anything about numbers on screen.
        // A leftover `situational:` line would be the app describing a feature
        // it no longer has, in the one file the user is asked to send us.
        var root = Path.Combine(Path.GetTempPath(), $"cb-wire-{Guid.NewGuid():N}");
        try
        {
            var log = new RedactedLog(root);
            var api = SuccessfulLcu();

            var result = await new ItemSetApplyService(api, Connected(), log).ApplyAsync(LiveRequest());

            Assert.IsType<ApplyItemSetsSuccess>(result);
            Assert.Contains(api.Calls, call => call.Method == HttpMethod.Put);

            var text = File.ReadAllText(log.FilePath);
            Assert.Contains("apply-itemsets: count=1", text, StringComparison.Ordinal);
            Assert.DoesNotContain("situational", text, StringComparison.OrdinalIgnoreCase);
        }
        finally
        {
            try { Directory.Delete(root, recursive: true); } catch { }
        }
    }

    /// <summary>The body the shipped web actually posts, situational field and all.</summary>
    private static ApplyItemSetsRequest LiveRequest()
    {
        var body = $$"""
        {"championId":3,
         "sets":[{"title":"CoachBuild Galio Mid","blocks":[
           {"type":"Starting","items":[{"id":"1055","count":1}]},
           {"type":"Situational","items":[{"id":"3158","count":1},{"id":"3068","count":1}]}]}],
         "replacePrefix":"CoachBuild",
         "situational":{{LiveSituational}}}
        """;
        return JsonSerializer.Deserialize<ApplyItemSetsRequest>(body, JsonOptions.Wire)!;
    }

    private static CompanionState Connected()
    {
        var state = new CompanionState();
        state.SetCredentials(new LcuCredentials(1234, "test-token", "fixture"));
        return state;
    }

    private static MockLcuApi SuccessfulLcu()
    {
        var api = new MockLcuApi();
        api.Enqueue(HttpMethod.Get, "/lol-summoner/v1/current-summoner",
            new LcuResponse(true, 200, MockLcuApi.Json("{\"summonerId\":77}")));
        api.Enqueue(HttpMethod.Get, "/lol-item-sets/v1/item-sets/77/sets",
            new LcuResponse(true, 200, MockLcuApi.Json("{\"accountId\":77,\"itemSets\":[]}")));
        api.Enqueue(HttpMethod.Put, "/lol-item-sets/v1/item-sets/77/sets",
            new LcuResponse(true, 200, MockLcuApi.Json("{}")));
        return api;
    }
}
