using CoachBuild.Desktop.Tray;
using CoachBuild.Desktop.Web;
using Xunit;

namespace CoachBuild.Desktop.Tests;

public sealed class WebView2WindowTests
{
    [Fact]
    public void HostedPagePolicyKeepsSessionTokenAndCanonicalRoutes()
    {
        var token = new string('a', 64);
        var policy = new HostedPagePolicy("https://coachbuild.vercel.app");

        var draft = policy.BuildUrl(new ReopenTarget(ReopenDestination.Draft, 103, 2), token);
        var builds = policy.BuildUrl(new ReopenTarget(ReopenDestination.Builds), token);

        Assert.Equal("https://coachbuild.vercel.app/draft?session=" + token, draft.ToString());
        Assert.Equal("https://coachbuild.vercel.app/?session=" + token, builds.ToString());
        Assert.True(policy.IsAllowed(draft));
        Assert.False(policy.IsAllowed("https://example.com/draft?session=" + token));
        Assert.False(policy.IsAllowed("http://coachbuild.vercel.app/"));
    }

    [Fact]
    public async Task MissingRuntimeIsDetectedBeforeEnvironmentCreation()
    {
        var service = new WebView2EnvironmentService(
            Path.Combine(Path.GetTempPath(), "CoachBuild-WebView2Tests"),
            versionProbe: () => null);

        Assert.False(await service.IsRuntimeAvailableAsync());
        await Assert.ThrowsAsync<WebView2RuntimeMissingException>(() => service.CreateAsync());
    }

    [Fact]
    public async Task AvailableRuntimeProbeIsTestableWithoutLaunchingAWindow()
    {
        var service = new WebView2EnvironmentService(
            Path.Combine(Path.GetTempPath(), "CoachBuild-WebView2Tests"),
            versionProbe: () => "125.0.0.0");

        Assert.True(await service.IsRuntimeAvailableAsync());
        Assert.Equal("125.0.0.0", service.AvailableVersion);
    }
}
