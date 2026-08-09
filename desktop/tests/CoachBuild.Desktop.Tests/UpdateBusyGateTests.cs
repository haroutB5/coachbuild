using CoachBuild.Desktop.Updates;
using Xunit;

namespace CoachBuild.Desktop.Tests;

public sealed class UpdateBusyGateTests
{
    [Fact]
    public async Task ReadyUpdateDoesNotApplyDuringChampSelectAndAppliesWhenBusyClears()
    {
        var client = new FakeUpdateClient();
        var busy = true;
        var service = new VelopackUpdateService(client, () => busy, TimeSpan.FromDays(1));

        await service.SetCompanionBusyAsync(true);
        await service.CheckNowAsync();

        Assert.Equal(UpdateStatus.DeferredBusy, service.Current.Status);
        Assert.Equal(0, client.ApplyCount);

        busy = false;
        await service.SetCompanionBusyAsync(false);

        Assert.Equal(1, client.ApplyCount);
        Assert.Null(service.PendingUpdate);
        await service.DisposeAsync();
    }

    [Fact]
    public async Task DownloadStatusIsProjectedBeforeBusyGateDefersApply()
    {
        var client = new FakeUpdateClient();
        var service = new VelopackUpdateService(client, () => false, TimeSpan.FromDays(1));

        await service.CheckNowAsync();

        Assert.Equal(1, client.DownloadCount);
        Assert.Equal(1, client.ApplyCount);
        Assert.Equal(UpdateStatus.Applying, client.LastObservedStatus);
        await service.DisposeAsync();
    }

    private sealed class FakeUpdateClient : IUpdateClient
    {
        public int DownloadCount { get; private set; }

        public int ApplyCount { get; private set; }

        public UpdateStatus LastObservedStatus { get; private set; }

        public Task<AvailableUpdate?> CheckForUpdatesAsync(CancellationToken cancellationToken)
        {
            return Task.FromResult<AvailableUpdate?>(new AvailableUpdate("1.2.0", new object()));
        }

        public Task DownloadUpdatesAsync(AvailableUpdate update, CancellationToken cancellationToken)
        {
            DownloadCount++;
            return Task.CompletedTask;
        }

        public Task ApplyUpdatesAndRestartAsync(AvailableUpdate update, CancellationToken cancellationToken)
        {
            ApplyCount++;
            LastObservedStatus = UpdateStatus.Applying;
            return Task.CompletedTask;
        }
    }
}

