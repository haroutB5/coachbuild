using CoachBuild.Desktop.Updates;
using Xunit;

namespace CoachBuild.Desktop.Tests;

public sealed class UpdateBootstrapperTests
{
    [Fact]
    public void ReleaseFeedUsesTheVelopackLatestDownloadEndpoint()
    {
        Assert.EndsWith(
            "/releases/latest/download",
            UpdateBootstrapper.ReleaseFeed,
            StringComparison.Ordinal);
    }
}
