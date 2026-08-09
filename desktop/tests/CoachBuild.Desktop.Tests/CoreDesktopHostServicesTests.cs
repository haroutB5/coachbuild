using System.Net;
using System.Net.Http;
using System.Net.Sockets;
using CoachBuild.Core;
using Xunit;

namespace CoachBuild.Desktop.Tests;

public sealed class CoreDesktopHostServicesTests
{
    [Fact]
    public async Task Built_host_shares_follow_tracker_between_decider_and_http_state_past_open_grace()
    {
        var root = Path.Combine(Path.GetTempPath(), "CoachBuild-HostTests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        var token = new string('a', 64);
        var port = FindFreePort();

        try
        {
            await using var host = new CoreDesktopHostServices(token, root, bridgePorts: [port]);

            Assert.Same(host.State.FollowAttachments, host.WindowDecisions.Attachments);

            await host.StartAsync(CancellationToken.None);
            var openedAt = DateTimeOffset.UtcNow.AddSeconds(-(CompanionWire.OpenGraceSeconds + 1));
            var entry = host.WindowDecisions.OnChampSelectEntry(
                Resolution(103, 2),
                openedAt);
            Assert.Equal(WindowDecisionKind.OpenDraft, entry.Kind);

            using var client = new HttpClient
            {
                BaseAddress = new Uri($"http://127.0.0.1:{host.BridgePort}")
            };
            using var request = new HttpRequestMessage(
                HttpMethod.Get,
                $"/status?session={token}&follow=builds");
            request.Headers.TryAddWithoutValidation("Origin", CompanionWire.AppOrigin);
            using var response = await client.SendAsync(request);
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);

            var followAt = host.State.FollowAttachments.GetSnapshot(FollowKind.Builds).FollowAt;
            Assert.NotNull(followAt);
            Assert.True(followAt.Value - openedAt > TimeSpan.FromSeconds(CompanionWire.OpenGraceSeconds));

            var decision = host.WindowDecisions.OnChampSelectPoll(
                Resolution(22, 3),
                followAt.Value.AddSeconds(1));

            Assert.Equal(WindowDecisionKind.None, decision.Kind);
            Assert.Equal(22, decision.ChampionId);
        }
        finally
        {
            try { Directory.Delete(root, recursive: true); } catch { }
        }
    }

    private static ChampSelectResolution Resolution(int championId, int roleId) => new(
        LocalPlayerCellId: 1,
        ChampionId: championId,
        CellChampionId: championId,
        PickIntent: championId,
        ActionChampionId: championId,
        RoleId: roleId,
        TheirTeam: [],
        TimerPhase: "PLANNING");

    private static int FindFreePort()
    {
        using var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        return ((IPEndPoint)listener.LocalEndpoint).Port;
    }
}
