using System.Text.RegularExpressions;
using CoachBuild.Desktop.Tray;
using CoachBuild.Desktop.Web;
using Xunit;

namespace CoachBuild.Desktop.Tests;

public sealed class WebView2WindowTests
{
    [Theory]
    [InlineData(false, false, 0, true)]
    [InlineData(false, false, 1, false)]
    [InlineData(true, false, 0, false)]
    [InlineData(false, true, 0, false)]
    [InlineData(true, true, 1, false)]
    public void Idle_sweep_is_blocked_by_a_lingering_window_or_import_flight(
        bool gameStartLinger,
        bool autoImportRunning,
        int activeBrowserOperations,
        bool expected)
    {
        Assert.Equal(
            expected,
            WebView2Window.ShouldSweepIdleTabs(
                gameStartLinger, autoImportRunning, activeBrowserOperations));
    }

    [Fact]
    public void HostedPagePolicyKeepsSessionTokenAndCanonicalRoutes()
    {
        var token = new string('a', 64);
        var policy = new HostedPagePolicy("https://coachbuild.local");

        var draft = policy.BuildUrl(new ReopenTarget(ReopenDestination.Draft, 103, 2), token);
        var builds = policy.BuildUrl(new ReopenTarget(ReopenDestination.Builds), token);

        // Both legacy destinations resolve to the one packaged document. The
        // file name is explicit because the virtual-host mapping serves no
        // default document for a bare "/".
        Assert.Equal("https://coachbuild.local/index.html?session=" + token, draft.ToString());
        Assert.Equal("https://coachbuild.local/index.html?session=" + token, builds.ToString());
        Assert.True(policy.IsAllowed(draft));
        Assert.False(policy.IsAllowed("https://example.com/draft?session=" + token));
        Assert.False(policy.IsAllowed("http://coachbuild.local/"));
    }

    /// <summary>
    /// The Companion tab is served from <see cref="HostedPagePolicy.LocalAssetFolder"/>
    /// next to the app binary. This is the packaging gate: the static export
    /// reaches the output directory only if the csproj adds its Content items
    /// before AssignTargetPaths; a build that adds them later stays green while
    /// shipping an empty folder. Referencing projects (this one) receive the
    /// same copied items, so asserting here exercises the whole chain.
    /// </summary>
    [Fact]
    public void TheDraftPageIsPackagedNextToTheAppBinary()
    {
        var folder = Path.Combine(AppContext.BaseDirectory, HostedPagePolicy.LocalAssetFolder);
        var entry = Path.Combine(folder, HostedPagePolicy.LocalEntryPoint);

        Assert.True(
            File.Exists(entry),
            $"the packaged draft page is missing at {entry}; the Companion tab would open a dead navigation");

        // Control: the document must carry the app's own script bundle, not
        // merely exist. An empty or placeholder file would satisfy Exists.
        var markup = File.ReadAllText(entry);
        Assert.Contains("/_next/", markup, StringComparison.Ordinal);
        var bundles = Path.Combine(folder, "_next");
        Assert.True(
            Directory.Exists(bundles) &&
            Directory.EnumerateFiles(bundles, "*.js", SearchOption.AllDirectories).Any(),
            "the packaged draft page references a script bundle that was not copied");

        // The stylesheet must carry real Tailwind UTILITIES, not just preflight.
        // Tailwind emits preflight even when its content list resolves to
        // nothing, so a completely unstyled page still produces a
        // plausible-looking stylesheet and a successful build — which is what
        // shipped while the config was passed inline to PostCSS.
        //
        // The sheets are resolved through index.html's own <link> hrefs, NOT by
        // globbing *.css. A glob reads whatever is in the folder, and the copy
        // step does not remove superseded hashes, so a stale good stylesheet
        // from an earlier build satisfies a glob no matter what this build
        // produced. That is not hypothetical: it let a deliberately broken
        // config pass this assertion once.
        var hrefs = Regex
            .Matches(markup, "href=\"(?<href>/_next/[^\"]+?\\.css)\"")
            .Select(match => match.Groups["href"].Value)
            .Distinct(StringComparer.Ordinal)
            .ToArray();
        Assert.True(hrefs.Length > 0, "the packaged draft page links no stylesheet");

        var sheets = hrefs
            .Select(href => Path.Combine(folder, href.TrimStart('/').Replace('/', Path.DirectorySeparatorChar)))
            .ToArray();
        foreach (var sheet in sheets)
            Assert.True(File.Exists(sheet), $"the page links {sheet} but it was not packaged");

        var css = sheets.Select(File.ReadAllText).ToArray();
        foreach (var utility in new[] { ".mx-auto", ".rounded-lg", ".font-semibold" })
        {
            Assert.True(
                css.Any(sheet => sheet.Contains(utility, StringComparison.Ordinal)),
                $"the linked stylesheet has no '{utility}' rule; Tailwind emitted preflight but no utilities, "
                + "so the draft page ships unstyled");
        }
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
