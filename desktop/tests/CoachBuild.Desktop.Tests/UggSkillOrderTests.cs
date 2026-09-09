using System.Text.Json;
using CoachBuild.Core;
using CoachBuild.Desktop.Web;
using Xunit;

namespace CoachBuild.Desktop.Tests;

public sealed class UggSkillOrderTests
{
    [Theory]
    [InlineData("{\"path\":null}", SkillOrderStatus.NoData)]
    [InlineData("{\"path\":{\"slots\":[\"Q\",\"W\",\"E\"],\"matches\":123}}", SkillOrderStatus.Ok)]
    [InlineData("{\"path\":{\"slots\":[\"X\"],\"matches\":123}}", SkillOrderStatus.Error)]
    [InlineData("{\"path\":{\"slots\":[],\"matches\":123}}", SkillOrderStatus.Error)]
    [InlineData("{\"path\":{\"slots\":[\"Q\"],\"matches\":0}}", SkillOrderStatus.Error)]
    public void Validates_published_path_without_inventing_missing_levels(string json, SkillOrderStatus expected)
    {
        using var document = JsonDocument.Parse(json);
        var result = UggSkillOrderReader.Parse(document.RootElement, 106);
        Assert.Equal(expected, result.Status);
        Assert.Equal(106, result.ChampionId);
        if (expected == SkillOrderStatus.Ok)
        {
            Assert.Equal(3, result.Order.ObservedLevels);
            Assert.False(result.Order.Completed);
            Assert.Equal("published", result.Order.CompletionBasis);
            Assert.Equal(123, result.SampleSize);
        }
    }

    [Fact]
    public void Full_jhin_published_order_retains_all_eighteen_levels()
    {
        using var document = JsonDocument.Parse("""
            {"path":{"matches":75819,"slots":["Q","W","Q","E","Q","R","Q","W","Q","W","R","W","W","E","E","R","E","E"]}}
            """);
        var result = UggSkillOrderReader.Parse(document.RootElement, 202);
        Assert.Equal(SkillOrderStatus.Ok, result.Status);
        Assert.True(result.Order.Completed);
        Assert.Equal(18, result.Order.ObservedLevels);
        Assert.Equal(OverlayAbility.R, result.Order.Order[5]);
        Assert.Equal(75819, result.SampleSize);
    }
}
