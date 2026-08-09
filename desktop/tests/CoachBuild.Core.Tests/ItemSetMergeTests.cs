using System.Text.Json;
using System.Text.Json.Nodes;
using CoachBuild.Core;
using Xunit;

namespace CoachBuild.Core.Tests;

public sealed class ItemSetMergeTests
{
    [Fact]
    public void Merge_preserves_foreign_sets_and_top_level_fields_while_pruning_ours()
    {
        using var existingDocument = JsonDocument.Parse("""
        {
          "accountId": 77,
          "timestamp": 123,
          "customTopLevel": { "keep": true },
          "itemSets": [
            { "title": "My hand-made page", "type": "custom", "blocks": [{"type":"Item","items":[]}] },
            { "title": "CoachBuild Old Champion", "blocks": [] },
            { "blocks": [], "unknown": "keep" }
          ]
        }
        """);
        using var newDocument = JsonDocument.Parse("""
        { "title": "CoachBuild Current Top", "blocks": [{"type":"Item","items":[{"id":"1001","count":1}]}] }
        """);

        var merged = ItemSetMergeService.Merge(existingDocument.RootElement, [newDocument.RootElement])!;
        Assert.Equal(77, merged["accountId"]!.GetValue<int>());
        Assert.True(merged["customTopLevel"]!["keep"]!.GetValue<bool>());
        var sets = (JsonArray)merged["itemSets"]!;
        Assert.Equal(3, sets.Count);
        Assert.Equal("My hand-made page", sets[0]! ["title"]!.GetValue<string>());
        Assert.Equal("keep", sets[1]! ["unknown"]!.GetValue<string>());
        Assert.Equal("CoachBuild Current Top", sets[2]! ["title"]!.GetValue<string>());
    }

    [Fact]
    public void Payload_validation_rejects_non_CoachBuild_titles_and_bad_counts()
    {
        using var badSet = JsonDocument.Parse("{\"title\":\"Player set\"}");
        var request = new ApplyItemSetsRequest(103, [badSet.RootElement], null);
        Assert.False(ApplyPayloadValidation.TryValidateItemSets(request, out var failure));
        Assert.Equal("invalid-sets", failure.Reason);

        var tooMany = new ApplyItemSetsRequest(103, [
            JsonDocument.Parse("{\"title\":\"CoachBuild 1\"}").RootElement,
            JsonDocument.Parse("{\"title\":\"CoachBuild 2\"}").RootElement,
            JsonDocument.Parse("{\"title\":\"CoachBuild 3\"}").RootElement,
            JsonDocument.Parse("{\"title\":\"CoachBuild 4\"}").RootElement
        ], null);
        Assert.False(ApplyPayloadValidation.TryValidateItemSets(tooMany, out failure));
        Assert.Equal("invalid-sets", failure.Reason);
    }

    [Fact]
    public async Task Apply_reads_before_put_and_bounds_CoachBuild_payloads()
    {
        var api = new MockLcuApi();
        api.Enqueue(HttpMethod.Get, "/lol-summoner/v1/current-summoner", new LcuResponse(true, 200,
            MockLcuApi.Json("{\"summonerId\":77}")));
        api.Enqueue(HttpMethod.Get, "/lol-item-sets/v1/item-sets/77/sets", new LcuResponse(true, 200,
            MockLcuApi.Json("{\"accountId\":77,\"timestamp\":42,\"itemSets\":[{\"title\":\"CoachBuild Old\"},{\"title\":\"Foreign\"}]}")));
        api.Enqueue(HttpMethod.Put, "/lol-item-sets/v1/item-sets/77/sets", new LcuResponse(true, 200, MockLcuApi.Json("{}")));
        using var set = JsonDocument.Parse("{\"title\":\"CoachBuild Current\",\"blocks\":[]}");
        var result = await new ItemSetApplyService(api).ApplyAsync(new ApplyItemSetsRequest(103, [set.RootElement]));

        Assert.IsType<ApplyItemSetsSuccess>(result);
        var put = api.Calls.Single(call => call.Method == HttpMethod.Put);
        var itemSets = put.Body!.Value.GetProperty("itemSets");
        Assert.Equal(2, itemSets.GetArrayLength());
        Assert.Equal("Foreign", itemSets[0].GetProperty("title").GetString());
        Assert.Equal("CoachBuild Current", itemSets[1].GetProperty("title").GetString());
        Assert.True(api.Calls.IndexOf(put) > api.Calls.FindIndex(call => call.Method == HttpMethod.Get && call.Path.Contains("item-sets", StringComparison.Ordinal)));
    }
}

