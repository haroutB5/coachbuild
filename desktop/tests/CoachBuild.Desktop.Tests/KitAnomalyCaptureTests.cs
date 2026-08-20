using System.Net;
using System.Net.Http;
using System.Net.Sockets;
using System.Runtime.ExceptionServices;
using System.Text;
using CoachBuild.Core;
using CoachBuild.Desktop.Overlay;
using Xunit;
// CoachBuild.Core carries its own OverlayAbility/OverlaySkillOrder; the window
// speaks the Desktop.Overlay ones, and `using` both makes the names ambiguous.
using OverlayAbility = CoachBuild.Desktop.Overlay.OverlayAbility;
using OverlaySkillOrder = CoachBuild.Desktop.Overlay.OverlaySkillOrder;

namespace CoachBuild.Desktop.Tests;

/// <summary>
/// The anomaly line, driven through a real overlay window rather than through
/// its formatter.
///
/// <para><b>Why the end-to-end form and not just KitAnomalyLineTests.</b> The
/// formatter can be perfect and the feature still dead: the line only helps if
/// the window actually passes the RAW ranks and the mode into it. Asserting the
/// formatter alone would pass just as happily against a call site that still
/// hands over a sum and no mode, which is precisely the state this change is
/// fixing. So the state goes in the front door — <c>ApplyState</c> — and the
/// assertion is made on what came out of the <c>Diagnostics</c> sink.</para>
///
/// <para>The replayed state is the 2026-08-19 field occurrence: Kennen (id 85)
/// at level 10 with 11 ranks reported, on Summoner's Rift.</para>
/// </summary>
public sealed class KitAnomalyCaptureTests
{
    private const int Kennen = 85;

    [Fact]
    public void The_emitted_line_carries_the_raw_ranks_and_the_game_mode()
    {
        RunOnSta(() =>
        {
            var settingsPath = Path.Combine(Path.GetTempPath(), $"coachbuild-test-{Guid.NewGuid():N}.json");
            var lines = new List<string>();
            var window = new OverlayWindow(
                new OverlaySettingsStore(settingsPath),
                NullGameWindowLocator.Instance)
            {
                Diagnostics = lines.Add,
                GameMode = () => new LiveGameMode("CLASSIC", 11),
            };
            try
            {
                window.SetOverlayVisible(true);
                window.ShowInactive();
                lines.Clear();
                window.ApplyState(AnomalousKennen(level: 10, q: 5, w: 4, e: 1, r: 1));

                var anomaly = Assert.Single(
                    lines, line => line.Contains("point arithmetic incoherent", StringComparison.Ordinal));

                // The four raw ranks: the number the old line did NOT print, and
                // the reason three hypotheses could not be told apart.
                Assert.Contains("ranks Q/W/E/R=5/4/1/1", anomaly, StringComparison.Ordinal);
                // What they are being measured against.
                Assert.Contains("against caps 5/5/5/3 freeR 0", anomaly, StringComparison.Ordinal);
                // Which game it was.
                Assert.Contains("mode=CLASSIC map=11", anomaly, StringComparison.Ordinal);
                // Still the identifying facts the old line carried.
                Assert.Contains("Kennen (id 85)", anomaly, StringComparison.Ordinal);
                Assert.Contains("level 10, 11 purchased", anomaly, StringComparison.Ordinal);
                // And no longer a cause that ddragon disproves.
                Assert.DoesNotContain("grants a free rank", anomaly, StringComparison.Ordinal);
            }
            finally
            {
                window.Close();
                if (File.Exists(settingsPath)) File.Delete(settingsPath);
            }
        });
    }

    /// <summary>
    /// A host that never set <see cref="OverlayWindow.GameMode"/>, or a client
    /// that published no mode, must still get the ranks. The capture is two
    /// independent facts and losing one must not cost the other.
    /// </summary>
    [Fact]
    public void Without_a_mode_the_line_still_carries_the_ranks_and_says_the_mode_is_unknown()
    {
        RunOnSta(() =>
        {
            var settingsPath = Path.Combine(Path.GetTempPath(), $"coachbuild-test-{Guid.NewGuid():N}.json");
            var lines = new List<string>();
            var window = new OverlayWindow(
                new OverlaySettingsStore(settingsPath),
                NullGameWindowLocator.Instance)
            {
                Diagnostics = lines.Add,
            };
            try
            {
                window.SetOverlayVisible(true);
                window.ShowInactive();
                lines.Clear();
                window.ApplyState(AnomalousKennen(level: 14, q: 5, w: 5, e: 4, r: 1));

                var anomaly = Assert.Single(
                    lines, line => line.Contains("point arithmetic incoherent", StringComparison.Ordinal));
                Assert.Contains("ranks Q/W/E/R=5/5/4/1", anomaly, StringComparison.Ordinal);
                Assert.Contains("mode=unknown map=unknown", anomaly, StringComparison.Ordinal);
            }
            finally
            {
                window.Close();
                if (File.Exists(settingsPath)) File.Delete(settingsPath);
            }
        });
    }

    /// <summary>
    /// The control. A coherent reading must emit NO anomaly line at all — five
    /// of the ten field states were coherent, and a line that fires on those
    /// too would drown the ones that matter.
    /// </summary>
    [Fact]
    public void A_coherent_reading_emits_no_anomaly_line()
    {
        RunOnSta(() =>
        {
            var settingsPath = Path.Combine(Path.GetTempPath(), $"coachbuild-test-{Guid.NewGuid():N}.json");
            var lines = new List<string>();
            var window = new OverlayWindow(
                new OverlaySettingsStore(settingsPath),
                NullGameWindowLocator.Instance)
            {
                Diagnostics = lines.Add,
                GameMode = () => new LiveGameMode("CLASSIC", 11),
            };
            try
            {
                window.SetOverlayVisible(true);
                window.ShowInactive();
                lines.Clear();
                window.ApplyState(AnomalousKennen(level: 11, q: 5, w: 4, e: 1, r: 1));

                Assert.DoesNotContain(
                    lines,
                    line => line.Contains("point arithmetic incoherent", StringComparison.Ordinal));
            }
            finally
            {
                window.Close();
                if (File.Exists(settingsPath)) File.Delete(settingsPath);
            }
        });
    }

    /// <summary>
    /// Every one of the five field occurrences must render distinctly. The
    /// window dedupes on the whole string, so two readings that render the same
    /// silently become one line — and under the old format, which printed only
    /// the sum, that is exactly what a level-flat rank change did.
    /// </summary>
    [Fact]
    public void Each_field_occurrence_produces_its_own_line_rather_than_being_deduped_away()
    {
        RunOnSta(() =>
        {
            var settingsPath = Path.Combine(Path.GetTempPath(), $"coachbuild-test-{Guid.NewGuid():N}.json");
            var lines = new List<string>();
            var window = new OverlayWindow(
                new OverlaySettingsStore(settingsPath),
                NullGameWindowLocator.Instance)
            {
                Diagnostics = lines.Add,
                GameMode = () => new LiveGameMode("CLASSIC", 11),
            };
            try
            {
                window.SetOverlayVisible(true);
                window.ShowInactive();
                lines.Clear();

                // The 2026-08-19 sequence, incoherent states only.
                window.ApplyState(AnomalousKennen(10, 5, 4, 1, 1));
                window.ApplyState(AnomalousKennen(11, 5, 5, 1, 1));
                window.ApplyState(AnomalousKennen(12, 5, 5, 2, 1));
                window.ApplyState(AnomalousKennen(13, 5, 5, 3, 1));
                window.ApplyState(AnomalousKennen(14, 5, 5, 4, 1));

                var anomalies = lines
                    .Where(line => line.Contains("point arithmetic incoherent", StringComparison.Ordinal))
                    .ToList();

                Assert.Equal(5, anomalies.Count);
                Assert.Equal(5, anomalies.Distinct(StringComparer.Ordinal).Count());
            }
            finally
            {
                window.Close();
                if (File.Exists(settingsPath)) File.Delete(settingsPath);
            }
        });
    }

    private static OverlayState AnomalousKennen(int level, int q, int w, int e, int r) => new(
        InGame: true,
        ChampionName: "Kennen",
        ChampionId: Kennen,
        Level: level,
        AbilityRanks: new Dictionary<OverlayAbility, int>
        {
            [OverlayAbility.Q] = q,
            [OverlayAbility.W] = w,
            [OverlayAbility.E] = e,
            [OverlayAbility.R] = r,
        },
        SkillOrder: new OverlaySkillOrder(
            [OverlayAbility.Q, OverlayAbility.W, OverlayAbility.E],
            ObservedLevels: 3,
            Completed: false),
        Lane: "MID",
        IsLaneAuto: false);

    // ------------------------------------------------ the host half of the capture
    //
    // The window can render the mode perfectly and still print `mode=unknown`
    // forever if nothing upstream ever reads it. allgamedata is polled every
    // 3 s and its gameData block was read for NOTHING before this change, so
    // these drive the real host against a real body.

    [Fact]
    public async Task The_host_reads_the_mode_off_allgamedata_and_names_it_once_per_game()
    {
        await using var harness = await LiveHarness.CreateAsync();

        await harness.Host.LivePolling.TickAllGameDataAsync();

        Assert.Equal("mode=CLASSIC map=11", harness.Host.CurrentGameMode?.Describe());
        Assert.Contains("live: mode=CLASSIC map=11", await harness.ReadLogAsync(), StringComparison.Ordinal);
    }

    /// <summary>
    /// This poll fires roughly 300 times in a game. A line per poll is a line
    /// nobody reads to the end of, and the log is the only field surface this
    /// defect has.
    /// </summary>
    [Fact]
    public async Task The_mode_line_is_printed_once_and_not_on_every_poll()
    {
        await using var harness = await LiveHarness.CreateAsync();

        for (var poll = 0; poll < 5; poll++) await harness.Host.LivePolling.TickAllGameDataAsync();

        var occurrences = (await harness.ReadLogAsync())
            .Split('\n')
            .Count(line => line.Contains("live: mode=", StringComparison.Ordinal));
        Assert.Equal(1, occurrences);
    }

    /// <summary>
    /// A body with no gameData at all — an older client build, or a schema move
    /// of the kind Riot has already made on the identity fields — must leave
    /// the mode unknown rather than inventing one.
    /// </summary>
    [Fact]
    public async Task A_body_without_gamedata_leaves_the_mode_unknown()
    {
        await using var harness = await LiveHarness.CreateAsync();
        harness.Live.AllGameDataBody = """{"activePlayer":{"level":1,"riotIdGameName":"MunsterHunter"}}""";

        await harness.Host.LivePolling.TickAllGameDataAsync();

        Assert.Null(harness.Host.CurrentGameMode);
        Assert.DoesNotContain("live: mode=", await harness.ReadLogAsync(), StringComparison.Ordinal);
    }

    /// <summary>
    /// TWO GAMES OF THE SAME MODE, which is the case that makes the per-game
    /// reset load-bearing.
    ///
    /// <para>Written this way deliberately. The obvious version of this test
    /// plays an ARAM after a Summoner's Rift game — and it passes with the
    /// reset deleted, because the two rendered lines differ and the dedupe lets
    /// the second through on its own. It proves nothing. Two Summoner's Rift
    /// games in a row is the real risk: without the reset the second game
    /// prints no mode at all, and anyone reading that half of the log has to
    /// guess.</para>
    /// </summary>
    [Fact]
    public async Task A_second_game_of_the_same_mode_still_prints_its_own_line()
    {
        await using var harness = await LiveHarness.CreateAsync();
        await harness.Host.LivePolling.TickAllGameDataAsync();

        // Out of the game and into the next one: the transition the per-game
        // reset hangs off.
        harness.Host.State.SetPhase("None");
        await harness.Host.ReadSnapshotAsync(CancellationToken.None);
        harness.Host.State.SetPhase("InProgress");
        await harness.Host.ReadSnapshotAsync(CancellationToken.None);

        await harness.Host.LivePolling.TickAllGameDataAsync();

        var occurrences = (await harness.ReadLogAsync())
            .Split('\n')
            .Count(line => line.Contains("live: mode=CLASSIC map=11", StringComparison.Ordinal));
        Assert.Equal(2, occurrences);
    }

    /// <summary>
    /// And a genuinely different mode is reported as itself rather than
    /// inheriting the last game's — the distinction the 2026-08-19 anomaly
    /// turns on, since nothing on Summoner's Rift grants a bonus skill point.
    /// </summary>
    [Fact]
    public async Task A_change_of_mode_is_reported_rather_than_inherited()
    {
        await using var harness = await LiveHarness.CreateAsync();
        await harness.Host.LivePolling.TickAllGameDataAsync();

        harness.Host.State.SetPhase("None");
        await harness.Host.ReadSnapshotAsync(CancellationToken.None);
        harness.Host.State.SetPhase("InProgress");
        await harness.Host.ReadSnapshotAsync(CancellationToken.None);

        harness.Live.AllGameDataBody =
            """{"activePlayer":{"level":1},"gameData":{"gameMode":"ARAM","mapNumber":12}}""";
        await harness.Host.LivePolling.TickAllGameDataAsync();

        Assert.Equal("mode=ARAM map=12", harness.Host.CurrentGameMode?.Describe());
        var log = await harness.ReadLogAsync();
        Assert.Contains("live: mode=CLASSIC map=11", log, StringComparison.Ordinal);
        Assert.Contains("live: mode=ARAM map=12", log, StringComparison.Ordinal);
    }

    /// <summary>
    /// A live host with only the endpoint these tests need. Deliberately
    /// separate from LiveGameLifecycleTests' harness: that one exists to settle
    /// a whole game, this one exists to hand over one allgamedata body.
    /// </summary>
    private sealed class LiveHarness : IAsyncDisposable
    {
        private readonly string _root;

        private LiveHarness(CoreDesktopHostServices host, string root, FakeLive live)
        {
            Host = host;
            _root = root;
            Live = live;
        }

        public CoreDesktopHostServices Host { get; }

        public FakeLive Live { get; }

        public static async Task<LiveHarness> CreateAsync()
        {
            var root = Path.Combine(
                Path.GetTempPath(), "CoachBuild-KitAnomalyTests", Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(root);
            var live = new FakeLive();
            var host = new CoreDesktopHostServices(
                new string('a', 64),
                root,
                bridgePorts: [FindFreePort()],
                liveHandler: live,
                championDirectory: new FakeChampionDirectory());

            var harness = new LiveHarness(host, root, live);
            host.State.SetPhase("InProgress");
            // Production sees the phase transition before the live pollers
            // repopulate; the per-game reset is driven by that observation.
            await host.ReadSnapshotAsync(CancellationToken.None);
            return harness;
        }

        public async Task<string> ReadLogAsync()
        {
            var path = Path.Combine(_root, "companion.log");
            if (!File.Exists(path)) return string.Empty;
            await using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
            using var reader = new StreamReader(stream);
            return await reader.ReadToEndAsync();
        }

        public async ValueTask DisposeAsync()
        {
            await Host.DisposeAsync();
            Live.Dispose();
            try { Directory.Delete(_root, recursive: true); } catch { }
        }
    }

    private sealed class FakeLive : HttpMessageHandler
    {
        public string AllGameDataBody { get; set; } =
            """
            {"activePlayer":{"level":1,"riotId":"MunsterHunter#EUW","riotIdGameName":"MunsterHunter","riotIdTagLine":"EUW","summonerName":""},
             "gameData":{"gameMode":"CLASSIC","gameTime":412.5,"mapName":"Map11","mapNumber":11,"mapTerrain":"Default"}}
            """;

        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            var body = request.RequestUri!.AbsolutePath == "/liveclientdata/allgamedata"
                ? AllGameDataBody
                : null;
            return Task.FromResult(body is null
                ? new HttpResponseMessage(HttpStatusCode.NotFound)
                : new HttpResponseMessage(HttpStatusCode.OK)
                {
                    Content = new StringContent(body, Encoding.UTF8, "application/json"),
                });
        }
    }

    private static int FindFreePort()
    {
        using var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        return ((IPEndPoint)listener.LocalEndpoint).Port;
    }

    private static void RunOnSta(Action action)
    {
        Exception? failure = null;
        var thread = new Thread(() =>
        {
            try { action(); }
            catch (Exception exception) { failure = exception; }
        });
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();
        thread.Join();
        if (failure is not null) ExceptionDispatchInfo.Capture(failure).Throw();
    }
}
