using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using CoachBuild.Core;
using Xunit;

namespace CoachBuild.Core.Tests;

/// <summary>
/// The three bridge endpoints, over a real socket.
///
/// <para>Two things are being pinned here. The obvious one is the contract the
/// packaged UI codes against. The one that matters more is that these endpoints
/// sit BEHIND the same origin and session gates as every other bridge route —
/// they read and write a file of the user's own judgements, and an unauthenticated
/// write to that file would be the worst bug this feature could have.</para>
/// </summary>
public sealed class LaneScoreBridgeTests : IDisposable
{
    private readonly string _directory;
    private readonly LaneScoreStore _store;

    public LaneScoreBridgeTests()
    {
        _directory = Path.Combine(Path.GetTempPath(), "cb-lane-bridge-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(_directory);
        _store = new LaneScoreStore(Path.Combine(_directory, LaneScoreStore.FileName));
    }

    public void Dispose()
    {
        try { Directory.Delete(_directory, recursive: true); } catch { }
    }

    private LaneScoreService Service(bool demo = false) =>
        new(new MockLcuApi(), _store, demo: demo);

    private static LaneScoreGame Game(int? opponent = 887) => new()
    {
        MatchId = "7351234567",
        QueueId = RankedQueues.SoloDuo,
        MyChampionId = 106,
        MyChampionName = "Volibear",
        RoleId = LaneRoles.Top,
        OpponentChampionId = opponent,
        OpponentChampionName = opponent is null ? null : "Gwen",
        EnemyChampionIds = [887, 24, 86, 122, 875],
        PositionSource = "teamPosition",
    };

    [Fact]
    public async Task PendingReportsTheUnscoredGameAndNullWhenThereIsNone()
    {
        await using var server = new CompanionHttpServer("token", ports: [FreePort()], laneScores: Service());
        await server.StartAsync();
        using var client = Client(server.Port);

        using var empty = JsonDocument.Parse(
            await client.GetStringAsync($"{CompanionRoutes.LaneScoresPending}?session=token"));
        // An envelope, not a bare null: "nothing to score" and "this bridge is
        // too old to know about the feature" have to stay distinguishable.
        Assert.Equal(JsonValueKind.Null, empty.RootElement.GetProperty("pending").ValueKind);

        _store.Capture(Game());

        using var filled = JsonDocument.Parse(
            await client.GetStringAsync($"{CompanionRoutes.LaneScoresPending}?session=token"));
        var pending = filled.RootElement.GetProperty("pending");
        Assert.Equal("7351234567", pending.GetProperty("matchId").GetString());
        Assert.Equal(106, pending.GetProperty("myChampionId").GetInt32());
        Assert.Equal(887, pending.GetProperty("opponentChampionId").GetInt32());
        Assert.Equal(LaneRoles.Top, pending.GetProperty("roleId").GetInt32());
        Assert.Equal(5, pending.GetProperty("enemyChampionIds").GetArrayLength());
    }

    [Fact]
    public async Task AScoreIsPersistedAndThenSurfacesAsARecommendation()
    {
        await using var server = new CompanionHttpServer("token", ports: [FreePort()], laneScores: Service());
        await server.StartAsync();
        using var client = Client(server.Port);
        _store.Capture(Game());

        using var posted = await client.PostAsync(
            $"{CompanionRoutes.LaneScoresSubmit}?session=token",
            Body("""{"matchId":"7351234567","score":9,"note":"free lane"}"""));
        using var result = JsonDocument.Parse(await posted.Content.ReadAsStringAsync());
        Assert.True(result.RootElement.GetProperty("ok").GetBoolean());

        using var recommended = JsonDocument.Parse(await client.GetStringAsync(
            $"{CompanionRoutes.LaneScoresRecommendations}?enemy=887&role={LaneRoles.Top}&session=token"));
        var root = recommended.RootElement;
        Assert.Equal(1, root.GetProperty("totalGames").GetInt32());
        var best = root.GetProperty("best").EnumerateArray().Single();
        Assert.Equal(106, best.GetProperty("championId").GetInt32());
        Assert.Equal(9.0, best.GetProperty("mean").GetDouble());
        // The sample count travels with the mean on the wire, so the UI is never
        // in a position where it CANNOT show n.
        Assert.Equal(1, best.GetProperty("games").GetInt32());
        Assert.Empty(root.GetProperty("worst").EnumerateArray());
    }

    [Fact]
    public async Task ARejectedSubmissionExplainsItselfAndChangesNothing()
    {
        await using var server = new CompanionHttpServer("token", ports: [FreePort()], laneScores: Service());
        await server.StartAsync();
        using var client = Client(server.Port);
        _store.Capture(Game(opponent: null));

        foreach (var (body, reason) in new[]
        {
            ("""{"matchId":"7351234567","score":11}""", "bad-score"),
            ("""{"matchId":"7351234567","score":0}""", "bad-score"),
            ("""{"matchId":"7351234567","score":9}""", "opponent-required"),
            ("""{"matchId":"7351234567","score":9,"opponentChampionId":99999}""", "bad-opponent"),
            ("""{"matchId":"nope","score":9}""", "unknown-match"),
            ("""{"score":9}""", "bad-request"),
        })
        {
            using var response = await client.PostAsync(
                $"{CompanionRoutes.LaneScoresSubmit}?session=token", Body(body));
            using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
            Assert.False(document.RootElement.GetProperty("ok").GetBoolean());
            Assert.Equal(reason, document.RootElement.GetProperty("reason").GetString());
        }

        Assert.Empty(_store.Read().Scores);
        Assert.Single(_store.Read().Pending);
    }

    /// <summary>
    /// The role is REQUIRED, not defaulted. Aggregating "any role" would pool a
    /// Volibear top game with a Volibear jungle game into one mean and the user
    /// would have no way to see that it happened.
    /// </summary>
    [Theory]
    [InlineData("enemy=887&role=0", 200)]
    [InlineData("enemy=887&role=4", 200)]
    [InlineData("enemy=887", 400)]
    [InlineData("enemy=887&role=9", 400)]
    [InlineData("enemy=887&role=-1", 400)]
    [InlineData("enemy=887&role=top", 400)]
    [InlineData("role=0", 400)]
    [InlineData("enemy=0&role=0", 400)]
    [InlineData("enemy=abc&role=0", 400)]
    public async Task RecommendationParametersAreValidated(string query, int status)
    {
        await using var server = new CompanionHttpServer("token", ports: [FreePort()], laneScores: Service());
        await server.StartAsync();
        using var client = Client(server.Port);

        using var response = await client.GetAsync(
            $"{CompanionRoutes.LaneScoresRecommendations}?{query}&session=token");

        Assert.Equal(status, (int)response.StatusCode);
    }

    /// <summary>
    /// The gate that matters. All three routes are behind the shared session
    /// check, so nothing on the machine can read or write the user's history
    /// without the token the app generated.
    /// </summary>
    [Fact]
    public async Task EveryLaneScoreRouteIsSessionGated()
    {
        await using var server = new CompanionHttpServer("token", ports: [FreePort()], laneScores: Service());
        await server.StartAsync();
        using var client = Client(server.Port);
        _store.Capture(Game());

        Assert.Equal(403, (int)(await client.GetAsync(
            $"{CompanionRoutes.LaneScoresPending}?session=wrong")).StatusCode);
        Assert.Equal(403, (int)(await client.GetAsync(
            $"{CompanionRoutes.LaneScoresRecommendations}?enemy=887&role=0&session=wrong")).StatusCode);
        Assert.Equal(403, (int)(await client.PostAsync(
            $"{CompanionRoutes.LaneScoresSubmit}?session=wrong",
            Body("""{"matchId":"7351234567","score":9}"""))).StatusCode);

        // And the rejected write really did not happen.
        Assert.Empty(_store.Read().Scores);
        Assert.Single(_store.Read().Pending);
    }

    /// <summary>A page from anywhere but the app's own origin is refused before routing.</summary>
    [Fact]
    public async Task AForeignOriginIsRefused()
    {
        await using var server = new CompanionHttpServer("token", ports: [FreePort()], laneScores: Service());
        await server.StartAsync();
        using var client = new HttpClient { BaseAddress = new Uri($"http://127.0.0.1:{server.Port}") };
        client.DefaultRequestHeaders.Add("Origin", "https://evil.test");

        Assert.Equal(403, (int)(await client.GetAsync(
            $"{CompanionRoutes.LaneScoresPending}?session=token")).StatusCode);
    }

    /// <summary>
    /// Demo mode: the card is served, and the real store is not touched at all —
    /// not read, not written. There is no path by which fabricated output can be
    /// mistaken for the user's history.
    /// </summary>
    [Fact]
    public async Task DemoModeServesAFabricatedCardAndWritesNothing()
    {
        _store.Capture(Game());
        var before = File.ReadAllText(Path.Combine(_directory, LaneScoreStore.FileName));

        await using var server = new CompanionHttpServer("token", ports: [FreePort()], laneScores: Service(demo: true));
        await server.StartAsync();
        using var client = Client(server.Port);

        using var pending = JsonDocument.Parse(
            await client.GetStringAsync($"{CompanionRoutes.LaneScoresPending}?session=token"));
        var card = pending.RootElement.GetProperty("pending");
        // The DEMO game, not the real captured one.
        Assert.StartsWith(LaneScoreService.DemoMatchIdPrefix, card.GetProperty("matchId").GetString());
        // And it deliberately ships the unknown-opponent branch, which is the one
        // a developer cannot otherwise reach on purpose.
        Assert.Equal(JsonValueKind.Null, card.GetProperty("opponentChampionId").ValueKind);

        using var posted = await client.PostAsync(
            $"{CompanionRoutes.LaneScoresSubmit}?session=token",
            Body($$"""{"matchId":"{{LaneScoreService.DemoMatchIdPrefix}}0000000001","score":9,"opponentChampionId":887}"""));
        using var result = JsonDocument.Parse(await posted.Content.ReadAsStringAsync());
        Assert.True(result.RootElement.GetProperty("ok").GetBoolean());

        Assert.Equal(before, File.ReadAllText(Path.Combine(_directory, LaneScoreStore.FileName)));
    }

    /// <summary>
    /// The other side of the same door: a NON-demo bridge refuses a demo match
    /// id outright, so fabricated data cannot be replayed into a real history.
    /// </summary>
    [Fact]
    public async Task ARealBridgeRefusesADemoMatchId()
    {
        await using var server = new CompanionHttpServer("token", ports: [FreePort()], laneScores: Service());
        await server.StartAsync();
        using var client = Client(server.Port);

        using var response = await client.PostAsync(
            $"{CompanionRoutes.LaneScoresSubmit}?session=token",
            Body($$"""{"matchId":"{{LaneScoreService.DemoMatchIdPrefix}}0000000001","score":9}"""));
        using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync());

        Assert.False(document.RootElement.GetProperty("ok").GetBoolean());
        Assert.Empty(_store.Read().Scores);
    }

    /// <summary>
    /// None of the three needs the League client. A user is most likely to sit
    /// down and score a game AFTER closing the client, and failing the card then
    /// would make the feature useless at the only moment it matters.
    /// </summary>
    [Fact]
    public async Task TheCardWorksWithTheLeagueClientShut()
    {
        var state = new CompanionState();
        state.SetCredentials(null);
        await using var server = new CompanionHttpServer("token", state, ports: [FreePort()], laneScores: Service());
        await server.StartAsync();
        using var client = Client(server.Port);
        _store.Capture(Game());

        using var posted = await client.PostAsync(
            $"{CompanionRoutes.LaneScoresSubmit}?session=token",
            Body("""{"matchId":"7351234567","score":7}"""));
        using var document = JsonDocument.Parse(await posted.Content.ReadAsStringAsync());

        Assert.False(state.ClientConnected);
        Assert.True(document.RootElement.GetProperty("ok").GetBoolean());
        Assert.Equal(7, Assert.Single(_store.Read().Scores).Score);
    }

    private static StringContent Body(string json) => new(json, Encoding.UTF8, "application/json");

    private static HttpClient Client(int port)
    {
        var client = new HttpClient { BaseAddress = new Uri($"http://127.0.0.1:{port}") };
        client.DefaultRequestHeaders.Add("Origin", CompanionWire.AppOrigin);
        return client;
    }

    private static int FreePort()
    {
        using var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        return ((IPEndPoint)listener.LocalEndpoint).Port;
    }
}
