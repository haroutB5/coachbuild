using System.Net;
using System.Net.Http;
using System.Net.Sockets;
using CoachBuild.Core;
using Xunit;

namespace CoachBuild.Desktop.Tests;

public sealed class CoreDesktopHostServicesTests
{
    [Fact]
    public async Task Self_test_runner_passes_end_to_end()
    {
        var exitCode = await SelfTestRunner.RunAsync();

        Assert.Equal(0, exitCode);
    }

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

    /// <summary>
    /// Spec §5's FIRST moment: app start. The other two (champ select entry,
    /// game end) are phase transitions and are proven in
    /// <c>RankCaptureTests</c> against the gameflow poller. App start is not a
    /// transition — the poller sees None -> None and has nothing to compare — so
    /// the host raises it, and this is the only place that can say it did.
    ///
    /// <para>Two claims, and the second is the important one. That a capture was
    /// STARTED: <c>PendingRankCapture</c> is non-null the moment StartAsync
    /// returns. That starting it COST STARTUP NOTHING: there is no League client
    /// on a test agent, so the capture necessarily fails, and StartAsync still
    /// returns and the host still serves. A capture that could delay or fail a
    /// startup would fail here by hanging or throwing.</para>
    /// </summary>
    [Fact]
    public async Task App_start_fires_a_rank_capture_without_delaying_startup()
    {
        var root = Path.Combine(Path.GetTempPath(), "CoachBuild-HostTests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        var token = new string('a', 64);
        var sink = new NeverCalledRankSink();

        try
        {
            await using var host = new CoreDesktopHostServices(
                token,
                root,
                bridgePorts: [FindFreePort()],
                rankSampleSecret: () => "test-secret",
                rankSampleSink: sink,
                rankCaptureOptions: new RankCaptureOptions(GameEndSettleAttempts: 0));

            Assert.Null(host.PendingRankCapture);

            await host.StartAsync(CancellationToken.None).WaitAsync(TimeSpan.FromSeconds(10));

            var capture = host.PendingRankCapture;
            Assert.NotNull(capture);

            // Completes, and completes without faulting. CaptureAsync has no
            // throw path; if one is ever added, this is where it surfaces.
            await capture!.WaitAsync(TimeSpan.FromSeconds(10));
            Assert.Equal(TaskStatus.RanToCompletion, capture.Status);

            // Whether anything POSTED is not asserted, deliberately: on an agent
            // with no League client the capture stops at identity, while on a
            // developer box with one running it can go all the way. Both are
            // correct. The sink is injected so that the second case cannot put a
            // real developer's ladder position on the production origin from a
            // test run; if it did fire, all it may claim is `companion`.
            Assert.All(sink.Sources, source => Assert.Equal("companion", source));
        }
        finally
        {
            try { Directory.Delete(root, recursive: true); } catch { }
        }
    }

    /// <summary>
    /// STARTING THE HOST UPLOADS NOTHING, and the click does.
    ///
    /// <para>The behavioural half of the user-triggered-only rule. The Core-side
    /// test pins that the service exposes no automatic trigger; this one pins
    /// that the production host does not call the one trigger it has behind the
    /// user's back. Silent background log shipping is a different product with a
    /// different consent conversation, and this is where it would arrive by
    /// accident -- StartAsync already fires an LP capture two lines away.</para>
    /// </summary>
    [Fact]
    public async Task Starting_the_host_never_uploads_diagnostics_but_a_click_does()
    {
        var root = Path.Combine(Path.GetTempPath(), "CoachBuild-HostTests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        var token = new string('a', 64);
        var diagnostics = new NeverCalledDiagnosticsSink();

        try
        {
            await using var host = new CoreDesktopHostServices(
                token,
                root,
                bridgePorts: [FindFreePort()],
                rankSampleSecret: () => "test-secret",
                rankSampleSink: new NeverCalledRankSink(),
                diagnosticsSink: diagnostics,
                rankCaptureOptions: new RankCaptureOptions(GameEndSettleAttempts: 0));

            Assert.Null(host.PendingDiagnosticsUpload);
            await host.StartAsync(CancellationToken.None).WaitAsync(TimeSpan.FromSeconds(10));
            Assert.Null(host.PendingDiagnosticsUpload);

            host.SendDiagnostics();
            var upload = host.PendingDiagnosticsUpload;
            Assert.NotNull(upload);
            await upload!.WaitAsync(TimeSpan.FromSeconds(10));
            Assert.Equal(TaskStatus.RanToCompletion, upload.Status);

            // Whether it POSTED is deliberately not asserted: on an agent with no
            // League client it stops at identity, on a box with one it can go all
            // the way. Both are correct. What it may never be is `source` anything
            // other than the one value the server's closed vocabulary admits.
            Assert.All(diagnostics.Sources, source => Assert.Equal("companion", source));
        }
        finally
        {
            try { Directory.Delete(root, recursive: true); } catch { }
        }
    }

    /// <summary>The diagnostics equivalent of <see cref="NeverCalledRankSink"/>.</summary>
    private sealed class NeverCalledDiagnosticsSink : IDiagnosticsSink
    {
        private readonly object _gate = new();
        private readonly List<string> _sources = [];

        public IReadOnlyList<string> Sources { get { lock (_gate) return [.. _sources]; } }

        public Task<RankSamplePostResult> PostAsync(
            DiagnosticsBody body,
            string secret,
            CancellationToken cancellationToken)
        {
            lock (_gate) _sources.Add(body.Source);
            return Task.FromResult(RankSamplePostResult.Posted);
        }
    }

    /// <summary>
    /// Swallows samples so a test run can never post to the production origin,
    /// and records what it saw.
    /// </summary>
    private sealed class NeverCalledRankSink : IRankSampleSink
    {
        private readonly object _gate = new();
        private readonly List<string> _sources = [];

        public IReadOnlyList<string> Sources { get { lock (_gate) return [.. _sources]; } }

        public Task<RankSamplePostResult> PostAsync(
            RankSampleBody body,
            string secret,
            CancellationToken cancellationToken)
        {
            lock (_gate) _sources.Add(body.Source);
            return Task.FromResult(RankSamplePostResult.Posted);
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
