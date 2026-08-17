using CoachBuild.Desktop.Updates;
using Xunit;

namespace CoachBuild.Desktop.Tests;

/// <summary>
/// Covers the self-update path that 1.0.6, 1.0.7 and 1.0.8 all shipped broken.
/// The defect reproduced on the real released 1.0.7 installer: the app
/// downloaded and staged the newer release, then never applied it while its own
/// window was on screen, and said nothing anywhere about any of it.
/// </summary>
public sealed class UpdateDeliveryTests
{
    // ---------------------------------------------------------------- version

    [Theory]
    [InlineData("1.0.9", "1.0.8", true)]
    [InlineData("1.0.10", "1.0.9", true)]
    [InlineData("1.1.0", "1.0.99", true)]
    [InlineData("1.0.8", "1.0.8", false)]
    [InlineData("1.0.7", "1.0.8", false)]
    [InlineData("1.0.9.1", "1.0.9", true)]
    [InlineData("1.0.9", "1.0.9.1", false)]
    [InlineData("1.0.9+abc123", "1.0.8", true)]
    [InlineData("1.0.9", "1.0.9+c73581a", false)]
    [InlineData("1.0.9-pre", "1.0.9", false)]
    [InlineData("1.0.9", "1.0.9-pre", true)]
    public void Version_ordering(string candidate, string current, bool expected)
    {
        Assert.Equal(expected, UpdateVersion.IsNewer(candidate, current));
    }

    [Theory]
    [InlineData(null, "1.0.8")]
    [InlineData("", "1.0.8")]
    [InlineData("latest", "1.0.8")]
    [InlineData("1.0.9", null)]
    [InlineData("1.0.9", "unknown")]
    [InlineData("1.0.-9", "1.0.8")]
    [InlineData("1.2.3.4.5", "1.0.8")]
    public void An_unreadable_version_never_authorises_an_apply(string? candidate, string? current)
    {
        // Fails closed on purpose. A malformed feed entry that read as "newer"
        // would apply-and-restart on every launch forever.
        Assert.False(UpdateVersion.IsNewer(candidate, current));
    }

    // ------------------------------------------------------------------- feed

    [Fact]
    public void The_feed_is_the_static_release_asset_endpoint_not_the_github_api()
    {
        Assert.Equal(
            "https://github.com/haroutB5/coachbuild-desktop-releases/releases/latest/download/releases.win.json",
            UpdateBootstrapper.ReleaseMetadataUrl);
        Assert.Equal(
            "https://github.com/haroutB5/coachbuild-desktop-releases/releases/latest/download/RELEASES",
            UpdateBootstrapper.LegacyReleaseMetadataUrl);

        // Unauthenticated GitHub API callers get 60 requests/hour/IP. The
        // static asset endpoints are not rate limited, which is why the feed
        // must stay on them.
        Assert.False(UpdateBootstrapper.UsesRateLimitedApi(UpdateBootstrapper.ReleaseFeed));
        Assert.True(UpdateBootstrapper.UsesRateLimitedApi(
            "https://api.github.com/repos/haroutB5/coachbuild-desktop-releases/releases/latest"));
    }

    [Fact]
    public void The_channel_matches_the_metadata_document_velopack_requests()
    {
        Assert.Equal("win", UpdateBootstrapper.ReleaseChannel);
        Assert.EndsWith($"/releases.{UpdateBootstrapper.ReleaseChannel}.json", UpdateBootstrapper.ReleaseMetadataUrl, StringComparison.Ordinal);
    }

    [Fact]
    public void The_install_root_is_where_velopack_actually_puts_the_package()
    {
        // Velopack installs a per-user pack to %LOCALAPPDATA%\<packId>. The old
        // value "CoachBuild\Desktop" named a directory that has never existed
        // on any install, and docs/verification.md repeated it; the real
        // %LOCALAPPDATA%\CoachBuild is the data directory (companion.log).
        Assert.Equal("CoachBuild.Desktop", UpdateBootstrapper.PackId);
        var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        Assert.Equal(Path.Combine(local, "CoachBuild.Desktop"), UpdateBootstrapper.InstallRoot);
        Assert.Equal(Path.Combine(local, "CoachBuild.Desktop", "packages"), UpdateBootstrapper.StagedPackageDirectory);
        Assert.NotEqual(Path.Combine(local, "CoachBuild", "Desktop"), UpdateBootstrapper.InstallRoot);
    }

    // ------------------------------------------------------- the reproduction

    [Fact]
    public async Task An_open_window_stages_the_update_and_still_offers_the_restart()
    {
        var client = new FakeUpdateClient("1.0.8", "1.0.9");
        var log = new List<string>();
        var windowOpen = true;
        await using var service = new VelopackUpdateService(
            client,
            isCompanionBusy: () => false,
            checkInterval: TimeSpan.FromDays(1),
            isRestartDisruptive: () => windowOpen,
            diagnostics: log.Add);

        await service.CheckNowAsync();

        // 1.0.8's outcome for this exact input was: downloaded, no apply, no
        // log line, and a disabled tray row reading "waiting for game".
        Assert.Equal(1, client.DownloadCount);
        Assert.Equal(0, client.ApplyCount);
        Assert.Equal(UpdateStatus.Staged, service.Current.Status);
        Assert.True(service.Current.CanRestartToUpdate);
        Assert.Equal("1.0.9 ready · restart to update", service.Current.ToDisplayString());
        Assert.Contains(log, line => line.StartsWith("update: 1.0.9 downloaded and staged", StringComparison.Ordinal));
        Assert.Contains(log, line => line.Contains("not restarting under the open CoachBuild window", StringComparison.Ordinal));
    }

    [Fact]
    public async Task A_staged_update_is_retried_without_any_busy_transition()
    {
        // This is the specific hole. Before 1.0.9 the only thing that could
        // apply a staged update was a busy-to-idle edge through
        // SetCompanionBusyAsync. Closing the window did not raise one, and
        // quitting from the tray detached the handler that would have.
        var client = new FakeUpdateClient("1.0.8", "1.0.9");
        var windowOpen = true;
        await using var service = new VelopackUpdateService(
            client,
            isCompanionBusy: () => false,
            checkInterval: TimeSpan.FromDays(1),
            isRestartDisruptive: () => windowOpen);

        await service.CheckNowAsync();
        Assert.Equal(0, client.ApplyCount);

        windowOpen = false;
        await service.RetryPendingApplyAsync();

        Assert.Equal(1, client.ApplyCount);
        Assert.Null(service.PendingUpdate);
    }

    [Fact]
    public async Task A_release_a_previous_run_left_staged_is_applied_at_startup()
    {
        // "Quit from the tray and relaunch" was advice that did nothing:
        // VelopackApp.Run only dispatches install hooks and nothing read
        // UpdateManager.UpdatePendingRestart, so the package sat there.
        var client = new FakeUpdateClient("1.0.8", nextVersion: null) { PendingOnDisk = "1.0.9" };
        var log = new List<string>();
        await using var service = new VelopackUpdateService(
            client,
            isCompanionBusy: () => false,
            checkInterval: TimeSpan.FromDays(1),
            diagnostics: log.Add);

        await service.ApplyStagedFromDiskAsync();

        Assert.Equal(1, client.ApplyCount);
        Assert.Equal(0, client.CheckCount);
        Assert.Equal(0, client.DownloadCount);
        Assert.Contains(log, line => line.Contains("already downloaded by an earlier run", StringComparison.Ordinal));
    }

    [Fact]
    public async Task A_staged_release_that_is_not_newer_is_never_applied()
    {
        // Restart-loop guard: applying an equal or older staged asset on every
        // launch would relaunch the app forever.
        var client = new FakeUpdateClient("1.0.9", nextVersion: null) { PendingOnDisk = "1.0.9" };
        var log = new List<string>();
        await using var service = new VelopackUpdateService(
            client,
            isCompanionBusy: () => false,
            checkInterval: TimeSpan.FromDays(1),
            diagnostics: log.Add);

        await service.ApplyStagedFromDiskAsync();

        Assert.Equal(0, client.ApplyCount);
        Assert.Contains(log, line => line.Contains("is not newer than the installed 1.0.9", StringComparison.Ordinal));
    }

    [Fact]
    public async Task The_startup_apply_runs_before_anything_else_in_the_loop()
    {
        var client = new FakeUpdateClient("1.0.8", nextVersion: null) { PendingOnDisk = "1.0.9" };
        await using var service = new VelopackUpdateService(
            client,
            isCompanionBusy: () => false,
            checkInterval: TimeSpan.FromDays(1),
            applyRetryInterval: TimeSpan.FromMilliseconds(20));

        await service.StartAsync();
        await WaitFor(() => client.ApplyCount > 0);

        Assert.Equal(1, client.ApplyCount);
        Assert.Equal("apply", client.Calls[0]);
    }

    // ------------------------------------------------------------ user intent

    [Fact]
    public async Task The_tray_restart_overrides_the_window_gate()
    {
        var client = new FakeUpdateClient("1.0.8", "1.0.9");
        await using var service = new VelopackUpdateService(
            client,
            isCompanionBusy: () => false,
            checkInterval: TimeSpan.FromDays(1),
            isRestartDisruptive: () => true);

        await service.CheckNowAsync();
        Assert.Equal(0, client.ApplyCount);

        await service.ApplyPendingNowAsync();

        Assert.Equal(1, client.ApplyCount);
    }

    [Fact]
    public async Task The_tray_restart_does_not_override_an_in_flight_lcu_write()
    {
        var client = new FakeUpdateClient("1.0.8", "1.0.9");
        var log = new List<string>();
        var busy = false;
        await using var service = new VelopackUpdateService(
            client,
            isCompanionBusy: () => busy,
            checkInterval: TimeSpan.FromDays(1),
            isRestartDisruptive: () => true,
            diagnostics: log.Add);

        await service.CheckNowAsync();
        busy = true;
        await service.ApplyPendingNowAsync();

        Assert.Equal(0, client.ApplyCount);
        Assert.Equal(UpdateStatus.DeferredBusy, service.Current.Status);
        Assert.Contains(log, line => line.Contains("mid-write", StringComparison.Ordinal));

        // The deferral message promises "as soon as that clears", so the
        // request must be latched: the window is still open, and without the
        // latch the ordinary retry would go straight back to Staged.
        busy = false;
        await service.RetryPendingApplyAsync();
        Assert.Equal(1, client.ApplyCount);
    }

    // ------------------------------------------------------------ diagnostics

    [Theory]
    [InlineData("check")]
    [InlineData("download")]
    [InlineData("apply")]
    public async Task Every_failure_reaches_the_log_with_an_update_prefix(string failing)
    {
        var client = new FakeUpdateClient("1.0.8", "1.0.9") { FailOn = failing };
        var log = new List<string>();
        await using var service = new VelopackUpdateService(
            client,
            isCompanionBusy: () => false,
            checkInterval: TimeSpan.FromDays(1),
            diagnostics: log.Add);

        await service.CheckNowAsync();

        Assert.Equal(UpdateStatus.Error, service.Current.Status);
        var failure = Assert.Single(log, line => line.StartsWith("update: FAILED", StringComparison.Ordinal));
        Assert.Contains("InvalidOperationException", failure, StringComparison.Ordinal);
        Assert.Contains($"injected {failing} failure", failure, StringComparison.Ordinal);
        Assert.All(log, line => Assert.StartsWith("update: ", line, StringComparison.Ordinal));
    }

    [Fact]
    public async Task A_healthy_check_still_says_so_out_loud()
    {
        var client = new FakeUpdateClient("1.0.9", nextVersion: null);
        var log = new List<string>();
        await using var service = new VelopackUpdateService(
            client,
            isCompanionBusy: () => false,
            checkInterval: TimeSpan.FromDays(1),
            diagnostics: log.Add);

        await service.CheckNowAsync();

        Assert.Contains(log, line => line.Contains("checking https://github.com/haroutB5/coachbuild-desktop-releases/releases/latest/download/releases.win.json", StringComparison.Ordinal));
        Assert.Contains(log, line => line.Contains("no newer release on the feed (installed 1.0.9)", StringComparison.Ordinal));
    }

    [Fact]
    public async Task A_client_that_cannot_update_says_why_instead_of_reporting_up_to_date()
    {
        // The silent-lie path: a client that cannot reach Velopack used to
        // return null from the check, which is indistinguishable from "you are
        // on the latest version".
        var client = new FakeUpdateClient("1.0.8", "1.0.9") { Unavailable = "UpdateManager could not be created: X" };
        var log = new List<string>();
        await using var service = new VelopackUpdateService(
            client,
            isCompanionBusy: () => false,
            checkInterval: TimeSpan.FromDays(1),
            diagnostics: log.Add);

        await service.CheckNowAsync();

        Assert.Equal(0, client.CheckCount);
        Assert.Equal(UpdateStatus.Error, service.Current.Status);
        Assert.NotEqual(UpdateStatus.None, service.Current.Status);
        Assert.Contains(log, line => line.Contains("cannot check for updates", StringComparison.Ordinal));
    }

    [Fact]
    public void A_deferral_is_logged_once_per_version_not_once_per_tick()
    {
        // The retry runs every 60s for the life of the process. One line per
        // tick would bury companion.log.
        var client = new FakeUpdateClient("1.0.8", "1.0.9");
        var log = new List<string>();
        var service = new VelopackUpdateService(
            client,
            isCompanionBusy: () => false,
            checkInterval: TimeSpan.FromDays(1),
            isRestartDisruptive: () => true,
            diagnostics: log.Add);

        service.CheckNowAsync().GetAwaiter().GetResult();
        for (var i = 0; i < 20; i++) service.RetryPendingApplyAsync().GetAwaiter().GetResult();

        Assert.Single(log, line => line.Contains("not restarting under the open CoachBuild window", StringComparison.Ordinal));
        Assert.Equal(0, client.ApplyCount);
        service.DisposeAsync().AsTask().GetAwaiter().GetResult();
    }

    // ---------------------------------------------------------------- schedule

    [Fact]
    public void The_loop_retries_a_staged_apply_between_network_checks()
    {
        var now = new DateTimeOffset(2026, 8, 17, 12, 0, 0, TimeSpan.Zero);
        var due = now.AddHours(2);

        Assert.Equal(UpdateLoopAction.Check, VelopackUpdateService.NextAction(now, now, hasPending: false));
        Assert.Equal(UpdateLoopAction.Check, VelopackUpdateService.NextAction(due, due, hasPending: true));
        Assert.Equal(UpdateLoopAction.RetryPendingApply, VelopackUpdateService.NextAction(now, due, hasPending: true));
        Assert.Equal(UpdateLoopAction.Idle, VelopackUpdateService.NextAction(now, due, hasPending: false));
    }

    [Fact]
    public void The_shipped_intervals_check_on_launch_and_keep_checking()
    {
        Assert.Equal(TimeSpan.FromHours(2), VelopackUpdateService.DefaultCheckInterval);
        Assert.Equal(TimeSpan.FromSeconds(60), VelopackUpdateService.DefaultApplyRetryInterval);
    }

    // -------------------------------------------------------------- tray model

    [Fact]
    public void Only_a_downloaded_release_offers_a_restart()
    {
        Assert.False(UpdateTrayModel.For(UpdateStatus.None).CanRestartToUpdate);
        Assert.False(UpdateTrayModel.For(UpdateStatus.Checking).CanRestartToUpdate);
        Assert.False(UpdateTrayModel.For(UpdateStatus.Downloading, "1.0.9").CanRestartToUpdate);
        Assert.False(UpdateTrayModel.For(UpdateStatus.Error, null, "boom").CanRestartToUpdate);
        Assert.False(UpdateTrayModel.For(UpdateStatus.Staged).CanRestartToUpdate);
        Assert.True(UpdateTrayModel.For(UpdateStatus.Staged, "1.0.9").CanRestartToUpdate);
        Assert.True(UpdateTrayModel.For(UpdateStatus.DeferredBusy, "1.0.9").CanRestartToUpdate);
        Assert.True(UpdateTrayModel.For(UpdateStatus.Ready, "1.0.9").CanRestartToUpdate);
    }

    // ------------------------------------------------------------------ helper

    private static async Task WaitFor(Func<bool> condition)
    {
        for (var i = 0; i < 200 && !condition(); i++)
        {
            await Task.Delay(10);
        }
        Assert.True(condition(), "condition was not reached in time");
    }

    private sealed class FakeUpdateClient : IUpdateClient
    {
        private readonly string? _nextVersion;

        public FakeUpdateClient(string currentVersion, string? nextVersion)
        {
            CurrentVersion = currentVersion;
            _nextVersion = nextVersion;
        }

        public string? CurrentVersion { get; }

        public string? PendingOnDisk { get; init; }

        public string? Unavailable { get; init; }

        public string? UnavailableReason => Unavailable;

        public string? FailOn { get; init; }

        public int CheckCount { get; private set; }

        public int DownloadCount { get; private set; }

        public int ApplyCount { get; private set; }

        public List<string> Calls { get; } = [];

        public AvailableUpdate? GetPendingRestartUpdate()
        {
            return PendingOnDisk is null ? null : new AvailableUpdate(PendingOnDisk, new object());
        }

        public Task<AvailableUpdate?> CheckForUpdatesAsync(CancellationToken cancellationToken)
        {
            CheckCount++;
            Calls.Add("check");
            if (FailOn == "check") throw new InvalidOperationException("injected check failure");
            return Task.FromResult(_nextVersion is null ? null : new AvailableUpdate(_nextVersion, new object()));
        }

        public Task DownloadUpdatesAsync(AvailableUpdate update, CancellationToken cancellationToken)
        {
            DownloadCount++;
            Calls.Add("download");
            if (FailOn == "download") throw new InvalidOperationException("injected download failure");
            return Task.CompletedTask;
        }

        public Task ApplyUpdatesAndRestartAsync(AvailableUpdate update, CancellationToken cancellationToken)
        {
            ApplyCount++;
            Calls.Add("apply");
            if (FailOn == "apply") throw new InvalidOperationException("injected apply failure");
            return Task.CompletedTask;
        }
    }
}
