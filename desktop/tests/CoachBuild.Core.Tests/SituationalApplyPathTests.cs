using System.Text.Json;
using CoachBuild.Core;
using Xunit;

namespace CoachBuild.Core.Tests;

/// <summary>
/// The situational deltas are DECORATION on a write that changes the player's
/// League config. Every test here exists to prove that the decoration can never
/// cost them their item set.
/// </summary>
public sealed class SituationalApplyPathTests
{
    private const string GoodSituational = """
    [ {"id":3158,"wpa":4.27,"text":"+4.27"}, {"id":3068,"wpa":-0.06,"text":"-0.06"} ]
    """;

    [Fact]
    public void An_older_web_build_omits_the_field_and_still_deserializes()
    {
        // The 0.113.x body, byte for byte. The new optional member must not
        // make an old client's request unreadable.
        var request = JsonSerializer.Deserialize<ApplyItemSetsRequest>("""
        {"championId":3,"sets":[{"title":"CoachBuild Galio Mid","blocks":[]}],"replacePrefix":"CoachBuild"}
        """, JsonOptions.Wire);

        Assert.NotNull(request);
        Assert.Equal(3, request!.ChampionId);
        Assert.Single(request.Sets!);
        Assert.Null(request.Situational);
    }

    [Fact]
    public void A_future_web_build_can_add_members_without_breaking_this_one()
    {
        // The other direction of the same contract: UnmappedMemberHandling is
        // left at its default of Skip on purpose.
        var request = JsonSerializer.Deserialize<ApplyItemSetsRequest>("""
        {"championId":3,"sets":[{"title":"CoachBuild Galio Mid","blocks":[]}],
         "situational":[{"id":3158,"wpa":4.27,"text":"+4.27"}],
         "somethingTheDesktopHasNeverHeardOf":{"nested":[1,2,3]}}
        """, JsonOptions.Wire);

        Assert.NotNull(request);
        Assert.Equal(JsonValueKind.Array, request!.Situational!.Value.ValueKind);
    }

    [Theory]
    [InlineData("""{"championId":3,"sets":[{"title":"CoachBuild X","blocks":[]}],"situational":"nonsense"}""")]
    [InlineData("""{"championId":3,"sets":[{"title":"CoachBuild X","blocks":[]}],"situational":[{"id":null}]}""")]
    [InlineData("""{"championId":3,"sets":[{"title":"CoachBuild X","blocks":[]}],"situational":[{"id":3158,"wpa":null,"text":null}]}""")]
    [InlineData("""{"championId":3,"sets":[{"title":"CoachBuild X","blocks":[]}],"situational":42}""")]
    public void A_malformed_situational_field_never_costs_the_caller_their_request(string body)
    {
        // The field is a raw JsonElement precisely so this cannot happen. A
        // typed list throws inside Deserialize on the first malformed member,
        // which turns the WHOLE request into null and fails an item-set write
        // over a decoration.
        var request = JsonSerializer.Deserialize<ApplyItemSetsRequest>(body, JsonOptions.Wire);

        Assert.NotNull(request);
        Assert.Equal(3, request!.ChampionId);
        Assert.Single(request.Sets!);
        Assert.True(ApplyPayloadValidation.TryValidateItemSets(request, out _));
    }

    [Fact]
    public async Task A_successful_write_files_the_numbers_away_for_the_overlay()
    {
        var state = Connected();
        var api = SuccessfulLcu();

        var result = await new ItemSetApplyService(api, state).ApplyAsync(Request(3, GoodSituational));

        Assert.IsType<ApplyItemSetsSuccess>(result);
        Assert.NotNull(state.Situational);
        Assert.Equal(3, state.Situational!.ChampionId);
        Assert.Equal(2, state.Situational.Deltas.Count);
        Assert.Equal("+4.27", state.Situational.Deltas[0].Text);
    }

    [Fact]
    public async Task A_malformed_field_costs_the_numbers_and_nothing_else()
    {
        var state = Connected();
        var api = SuccessfulLcu();

        var result = await new ItemSetApplyService(api, state).ApplyAsync(
            Request(3, """[ {"id":"not a number"}, "garbage", {"id":3158} ]"""));

        // The write still succeeded and the PUT still went out.
        Assert.IsType<ApplyItemSetsSuccess>(result);
        Assert.Contains(api.Calls, call => call.Method == HttpMethod.Put);
        Assert.Null(state.Situational);
    }

    [Fact]
    public async Task A_failed_write_records_nothing()
    {
        // The order matters: RecordSituational runs AFTER the PUT succeeds, so
        // a set that never reached League cannot leave numbers behind that
        // claim it did.
        var state = Connected();
        var api = new MockLcuApi();
        api.Enqueue(HttpMethod.Get, "/lol-summoner/v1/current-summoner",
            new LcuResponse(true, 200, MockLcuApi.Json("{\"summonerId\":77}")));
        api.Enqueue(HttpMethod.Get, "/lol-item-sets/v1/item-sets/77/sets",
            new LcuResponse(true, 200, MockLcuApi.Json("{\"accountId\":77,\"itemSets\":[]}")));
        api.Enqueue(HttpMethod.Put, "/lol-item-sets/v1/item-sets/77/sets",
            new LcuResponse(false, 500, null));

        var result = await new ItemSetApplyService(api, state).ApplyAsync(Request(3, GoodSituational));

        Assert.IsType<ApplyItemSetsFailure>(result);
        Assert.Null(state.Situational);
    }

    [Fact]
    public async Task A_second_write_for_a_different_champion_replaces_the_first()
    {
        var state = Connected();

        await new ItemSetApplyService(SuccessfulLcu(), state).ApplyAsync(Request(3, GoodSituational));
        Assert.Equal(3, state.Situational!.ChampionId);

        // Galio's numbers must not survive into Lee Sin's game.
        await new ItemSetApplyService(SuccessfulLcu(), state).ApplyAsync(Request(64, null));

        Assert.Null(state.Situational);
    }

    private static ApplyItemSetsRequest Request(int championId, string? situational)
    {
        var set = JsonDocument.Parse("{\"title\":\"CoachBuild Set\",\"blocks\":[]}").RootElement.Clone();
        return new ApplyItemSetsRequest(
            championId,
            [set],
            null,
            situational is null ? null : JsonDocument.Parse(situational).RootElement.Clone());
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
