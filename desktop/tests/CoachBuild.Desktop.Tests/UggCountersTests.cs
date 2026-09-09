using CoachBuild.Desktop.Web;
using Xunit;

namespace CoachBuild.Desktop.Tests;

public sealed class UggCountersTests
{
    [Theory]
    [InlineData("ahri", "mid")]
    [InlineData("jhin", "adc")]
    [InlineData("monkeyking", "jungle")]
    public void Builds_only_the_requested_ugg_counter_page(string slug, string lane)
    {
        Assert.Equal($"https://u.gg/lol/champions/{slug}/counter?role={lane}&rank=emerald_plus&region=world",
            UggCounters.BuildUrl(slug, lane)?.AbsoluteUri);
    }

    [Theory]
    [InlineData("../ahri", "mid")]
    [InlineData("https://evil.test", "mid")]
    [InlineData("ahri", "middle")]
    [InlineData("ahri", "mid&rank=iron")]
    [InlineData(null, "mid")]
    public void Rejects_arbitrary_destinations_and_filters(string? slug, string lane) =>
        Assert.Null(UggCounters.BuildUrl(slug, lane));
}
