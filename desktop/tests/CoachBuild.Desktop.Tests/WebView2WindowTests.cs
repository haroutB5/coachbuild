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

    [Fact]
    public void RepairFailureMessageExplainsZeroExitRegistrationDelay()
    {
        var message = WebView2Window.RepairFailureMessage(
            new RepairResult(false, 0, true, TimeSpan.FromMinutes(120)),
            "WebView2RuntimeNotFoundException: runtime not installed",
            lastProbeFailureWasRuntimeNotFound: true);
        var lower = message.ToLowerInvariant();

        Assert.Contains("installer finished", lower);
        Assert.Contains("has not registered the runtime yet", lower);
        Assert.Contains("wait a minute and retry", lower);
        Assert.DoesNotContain("installer code", lower);
    }

    [Fact]
    public void RepairFailureMessageExplainsAppSideProbeFault()
    {
        var message = WebView2Window.RepairFailureMessage(
            new RepairResult(false, 0, true, TimeSpan.FromSeconds(1)),
            "InvalidOperationException: loader DLL failed",
            lastProbeFailureWasRuntimeNotFound: false);
        var lower = message.ToLowerInvariant();

        Assert.Contains("app-side", lower);
        Assert.Contains("installing the runtime will not help", lower);
        Assert.Contains("companion.log", lower);
    }

    [Fact]
    public async Task RepairPollsUntilRuntimeAppearsAfterBootstrapperExits()
    {
        var bootstrapper = CreateFakeBootstrapper(TreeCommandPath);
        try
        {
            var probes = 0;
            var service = CreateRepairService(
                bootstrapper,
                () => Interlocked.Increment(ref probes) >= 3 ? "125.0.0.0" : null);

            var result = await service.RepairAsync();

            Assert.True(result.IsSuccess);
            Assert.Equal(0, result.ExitCode);
            Assert.True(result.BootstrapperFound);
            Assert.True(probes >= 3);
        }
        finally
        {
            DeleteFakeBootstrapper(bootstrapper);
        }
    }

    [Fact]
    public async Task RepairTreatsCompletedChildInstallAsSuccessDespiteNonzeroBootstrapperExit()
    {
        var bootstrapper = CreateFakeBootstrapper(WhereCommandPath);
        try
        {
            var probes = 0;
            var service = CreateRepairService(
                bootstrapper,
                () => Interlocked.Increment(ref probes) >= 2 ? "125.0.0.0" : null);

            var result = await service.RepairAsync();

            Assert.True(result.IsSuccess);
            Assert.NotEqual(0, result.ExitCode);
            Assert.True(result.BootstrapperFound);
            Assert.True(probes >= 2);
        }
        finally
        {
            DeleteFakeBootstrapper(bootstrapper);
        }
    }

    [Fact]
    public async Task RepairTimesOutWithBootstrapperDetailsWhenRuntimeNeverAppears()
    {
        var bootstrapper = CreateFakeBootstrapper(TreeCommandPath);
        try
        {
            var service = CreateRepairService(bootstrapper, () => null, timeout: TimeSpan.FromMilliseconds(25));

            var result = await service.RepairAsync();

            Assert.False(result.IsSuccess);
            Assert.Equal(0, result.ExitCode);
            Assert.True(result.BootstrapperFound);
            Assert.True(result.Elapsed >= TimeSpan.Zero);
        }
        finally
        {
            DeleteFakeBootstrapper(bootstrapper);
        }
    }

    [Fact]
    public async Task RepairDoesNotStartAnythingWhenBootstrapperIsAbsent()
    {
        var bootstrapper = Path.Combine(Path.GetTempPath(), $"CoachBuild-missing-webview2-{Guid.NewGuid():N}.exe");
        var probes = 0;
        var service = CreateRepairService(bootstrapper, () =>
        {
            Interlocked.Increment(ref probes);
            return "125.0.0.0";
        });

        var result = await service.RepairAsync();

        Assert.False(result.IsSuccess);
        Assert.Null(result.ExitCode);
        Assert.False(result.BootstrapperFound);
        Assert.Equal(0, probes);
    }

    [Fact]
    public async Task ProbeFailureDetailCapturesUnexpectedLoaderException()
    {
        var service = new WebView2EnvironmentService(
            Path.Combine(Path.GetTempPath(), "CoachBuild-WebView2Tests"),
            versionProbe: () => throw new InvalidOperationException("loader DLL failed"));

        Assert.False(await service.IsRuntimeAvailableAsync());
        Assert.Equal("InvalidOperationException: loader DLL failed", service.LastProbeFailure);
        Assert.False(service.LastProbeFailureWasRuntimeNotFound);
    }

    [Fact]
    public async Task ProbeMissingRuntimeExceptionIsRecordedAsExpectedRuntimeAbsence()
    {
        var service = new WebView2EnvironmentService(
            Path.Combine(Path.GetTempPath(), "CoachBuild-WebView2Tests"),
            versionProbe: () => throw new Microsoft.Web.WebView2.Core.WebView2RuntimeNotFoundException("runtime not installed"));

        Assert.False(await service.IsRuntimeAvailableAsync());
        Assert.Equal("WebView2RuntimeNotFoundException: runtime not installed", service.LastProbeFailure);
        Assert.True(service.LastProbeFailureWasRuntimeNotFound);
    }

    [Fact]
    public async Task SuccessfulProbeClearsPreviousFailureDetail()
    {
        var probes = 0;
        var service = new WebView2EnvironmentService(
            Path.Combine(Path.GetTempPath(), "CoachBuild-WebView2Tests"),
            versionProbe: () =>
            {
                if (Interlocked.Increment(ref probes) == 1)
                    throw new InvalidOperationException("loader DLL failed");
                return "125.0.0.0";
            });

        Assert.False(await service.IsRuntimeAvailableAsync());
        Assert.Equal("InvalidOperationException: loader DLL failed", service.LastProbeFailure);
        Assert.True(await service.IsRuntimeAvailableAsync());
        Assert.Null(service.LastProbeFailure);
        Assert.False(service.LastProbeFailureWasRuntimeNotFound);
    }

    private static WebView2EnvironmentService CreateRepairService(
        string bootstrapper,
        Func<string?> versionProbe,
        TimeSpan? timeout = null)
    {
        return new WebView2EnvironmentService(
            Path.Combine(Path.GetTempPath(), "CoachBuild-WebView2Tests"),
            bootstrapperPath: bootstrapper,
            versionProbe: versionProbe,
            repairPollInterval: TimeSpan.FromMilliseconds(1),
            repairTimeout: timeout ?? TimeSpan.FromSeconds(1));
    }

    private static string CreateFakeBootstrapper(string source)
    {
        Assert.True(File.Exists(source));
        var destination = Path.Combine(
            Path.GetTempPath(),
            $"CoachBuild-fake-webview2-{Guid.NewGuid():N}{Path.GetExtension(source)}");
        File.Copy(source, destination);
        return destination;
    }

    private static void DeleteFakeBootstrapper(string path)
    {
        if (File.Exists(path)) File.Delete(path);
    }

    private static string TreeCommandPath =>
        Path.Combine(Environment.SystemDirectory, "tree.com");

    private static string WhereCommandPath =>
        Path.Combine(Environment.SystemDirectory, "where.exe");
}
