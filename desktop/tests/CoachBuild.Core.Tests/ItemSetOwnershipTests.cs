using System.Text.Json;
using System.Text.Json.Nodes;
using CoachBuild.Core;
using Xunit;

namespace CoachBuild.Core.Tests;

/// <summary>
/// 2.4.3: item sets are titled plainly ("Galio Mid (Pro)"), so ownership is the
/// "coachbuild-" uid (or the legacy CoachBuild title). The user's own sets and
/// other apps' sets must survive every write untouched.
/// </summary>
public sealed class ItemSetOwnershipTests
{
    private static JsonElement Json(string raw) => JsonDocument.Parse(raw).RootElement.Clone();

    [Fact]
    public void Item_set_titles_are_plain_and_rune_page_titles_are_unchanged()
    {
        Assert.Equal("Galio Mid (Pro)", SiteImportValidator.ItemSetTitle("Galio", "mid", SiteImportSource.Pro));
        Assert.Equal("Nasus (u.gg)", SiteImportValidator.ItemSetTitle("Nasus", null, SiteImportSource.UGg));
        Assert.Equal("CoachBuild import: Jhin ADC (u.gg)",
            SiteImportValidator.PageTitle("Jhin", "adc", SiteImportSource.UGg));
    }

    [Fact]
    public void Written_sets_carry_a_per_source_coachbuild_uid()
    {
        var set = SiteImportValidator.BuildItemSetElement(
            3, "Galio Mid (Pro)", "galio", "mid",
            [new SiteImportItemBlock("Core Items", [3020])], SiteImportSource.Pro);

        Assert.Equal("coachbuild-import-galio-mid-pro", set.GetProperty("uid").GetString());
        Assert.Equal("Galio Mid (Pro)", set.GetProperty("title").GetString());
    }

    [Fact]
    public void A_plain_titled_set_with_a_coachbuild_uid_passes_the_write_gate_and_a_plain_foreign_one_does_not()
    {
        var ours = Json("""{"title":"Galio Mid (Pro)","uid":"coachbuild-import-galio-mid-pro","blocks":[]}""");
        var foreign = Json("""{"title":"Galio Mid (Pro)","uid":"dbe88b89-b5e6-124f","blocks":[]}""");

        Assert.True(ApplyPayloadValidation.TryValidateItemSets(new ApplyItemSetsRequest(3, [ours]), out _));
        Assert.False(ApplyPayloadValidation.TryValidateItemSets(new ApplyItemSetsRequest(3, [foreign]), out _));
    }

    [Fact]
    public void Merge_replaces_uid_owned_and_legacy_titled_sets_and_keeps_everyone_elses()
    {
        var existing = (JsonObject)JsonNode.Parse("""
            {"accountId":7,"itemSets":[
              {"title":"Galio Mid (Pro)","uid":"coachbuild-import-galio-mid-pro"},
              {"title":"CoachBuild import: Galio Mid (u.gg)","uid":"coachbuild-import-galio-mid"},
              {"title":"My Galio build","uid":"user-1"},
              {"title":"U.GG - Galio","uid":"dbe88b89-b5e6-124f"},
              {"uid":"no-title"}
            ]}
            """)!;
        var fresh = Json("""{"title":"Galio Mid (Coachless)","uid":"coachbuild-import-galio-mid-coachless"}""");

        var merged = ItemSetMergeService.Merge(existing, [fresh]);

        var titles = merged["itemSets"]!.AsArray()
            .Select(set => set?["title"]?.GetValue<string>())
            .ToArray();
        Assert.Equal(["My Galio build", "U.GG - Galio", null, "Galio Mid (Coachless)"], titles);
    }
}
