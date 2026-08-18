using System.Net;
using System.Text;
using System.Text.Json;
using CoachBuild.Core;
using Xunit;

namespace CoachBuild.Core.Tests;

public sealed class SkillOrderProviderTests
{
    [Fact]
    public async Task Ok_payload_maps_order_and_uses_the_same_champion_role_cache_key()
    {
        var handler = new FixtureHandler(_ => """
        {
          "priority":["Q","W","E"],
          "levels":{"Q":[1],"W":[2],"E":[3],"R":[6]},
          "order":["Q","W","E","Q"],
          "completed":false,
          "observedLevels":4,
          "completionBasis":"derived",
          "sampleSize":123,
          "winRate":0.51,
          "share":0.2
        }
        """);
        using var http = new HttpClient(handler);
        using var provider = new SkillOrderProvider(
            http,
            new Uri("https://coachbuild.vercel.app/api/skill-order"));

        var first = await provider.GetSkillOrderAsync(103, "MID", CancellationToken.None);
        var second = await provider.GetSkillOrderAsync(103, "MID", CancellationToken.None);

        Assert.Equal(SkillOrderStatus.Ok, first.Status);
        Assert.Equal(103, first.ChampionId);
        Assert.Equal(
            new[] { OverlayAbility.Q, OverlayAbility.W, OverlayAbility.E, OverlayAbility.Q },
            first.Order.Order);
        Assert.Equal(4, first.Order.ObservedLevels);
        Assert.False(first.Order.Completed);
        Assert.Equal("derived", first.Order.CompletionBasis);
        Assert.Equal(123, first.SampleSize);
        Assert.Equal(first, second);
        Assert.Equal(1, handler.Calls);
        Assert.Contains("champ=103", handler.Requests.Single(), StringComparison.Ordinal);
        Assert.Contains("role=2", handler.Requests.Single(), StringComparison.Ordinal);
    }

    [Fact]
    public async Task Bare_null_is_no_data_and_is_cached_without_a_second_request()
    {
        var handler = new FixtureHandler(_ => "null");
        using var provider = new SkillOrderProvider(new HttpClient(handler));

        var first = await provider.GetSkillOrderAsync(103, "SUPPORT", CancellationToken.None);
        var second = await provider.GetSkillOrderAsync(103, "SUPPORT", CancellationToken.None);
        var unsetRole = await provider.GetSkillOrderAsync(103, null, CancellationToken.None);

        Assert.Equal(SkillOrderStatus.NoData, first.Status);
        Assert.Equal(SkillOrderStatus.NoData, second.Status);
        Assert.Equal(SkillOrderStatus.NoData, unsetRole.Status);
        Assert.Empty(first.Order.Order);
        Assert.Equal(1, handler.Calls);
    }

    [Fact]
    public async Task Entering_in_progress_clears_the_per_game_cache()
    {
        var handler = new FixtureHandler(_ => """
        {"order":["Q","W","E"],"completed":true,"sampleSize":1}
        """);
        using var provider = new SkillOrderProvider(new HttpClient(handler));
        var state = new CompanionState();
        await using var bridge = new CompanionHttpServer(
            "session",
            state,
            new MockLcuApi(),
            skillOrders: provider);

        _ = await provider.GetSkillOrderAsync(103, "TOP", CancellationToken.None);
        Assert.Equal(1, handler.Calls);
        state.SetPhase("InProgress");
        _ = await provider.GetSkillOrderAsync(103, "TOP", CancellationToken.None);

        Assert.Equal(2, handler.Calls);
    }

    [Fact]
    public async Task Malformed_payload_is_error_and_error_cache_prevents_poll_storm()
    {
        var handler = new FixtureHandler(_ => "{\"order\":[\"Q\",\"X\"],\"completed\":true,\"sampleSize\":1}");
        using var provider = new SkillOrderProvider(new HttpClient(handler));

        var first = await provider.GetSkillOrderAsync(103, "BOT", CancellationToken.None);
        var second = await provider.GetSkillOrderAsync(103, "BOT", CancellationToken.None);

        Assert.Equal(SkillOrderStatus.Error, first.Status);
        Assert.Equal(SkillOrderStatus.Error, second.Status);
        Assert.Equal(1, handler.Calls);
    }

    [Fact]
    public async Task Manual_override_changes_the_lane_fetch_and_wins_over_detected_position()
    {
        var provider = new RecordingSkillOrderProvider(lane => OkResult(103, lane, 10));

        var selection = await SkillOrderLaneResolver.ResolveAsync(
            provider,
            103,
            laneOverride: "MID",
            detectedPosition: "TOP",
            CancellationToken.None);

        Assert.Equal("MID", selection.Lane);
        Assert.False(selection.IsLaneAuto);
        Assert.Equal(10, selection.Result.SampleSize);
        Assert.Equal(["MID"], provider.Requests);
    }

    [Fact]
    public async Task Unresolved_position_fetches_all_lanes_and_picks_the_largest_sample()
    {
        var samples = new Dictionary<string, int>(StringComparer.Ordinal)
        {
            ["TOP"] = 20,
            ["JUNGLE"] = 30,
            ["MID"] = 200,
            ["BOT"] = 100,
            ["SUPPORT"] = 40,
        };
        var provider = new RecordingSkillOrderProvider(lane => OkResult(103, lane, samples[lane]));

        var selection = await SkillOrderLaneResolver.ResolveAsync(
            provider,
            103,
            laneOverride: null,
            detectedPosition: "NONE",
            CancellationToken.None);

        Assert.Equal(5, provider.Requests.Count);
        Assert.Equal(SkillOrderLaneResolver.Lanes.OrderBy(lane => lane), provider.Requests.OrderBy(lane => lane));
        Assert.Equal("MID", selection.Lane);
        Assert.True(selection.IsLaneAuto);
        Assert.Equal(200, selection.Result.SampleSize);
        // The selected lane is the same lane whose response supplies the
        // displayed recommendation; it cannot drift to a label-only guess.
        Assert.Equal("MID", provider.Requests.Single(lane => lane == selection.Lane));
    }

    /// <summary>
    /// The replacement for <c>Own_champion_resolution_reads_only_the_matching_player</c>,
    /// which asserted against <c>LivePlayerListResolver.ResolveOwnChampionId</c>
    /// using a fixture that invented a <c>championId</c> field Riot has never
    /// sent. That test passed for four releases while the feature it covered
    /// could not work at all. The resolver is gone; the compliance property it
    /// was really protecting is asserted here against the real wire shape, and
    /// the id resolution itself lives in <c>ChampionIdentityTests</c>.
    /// </summary>
    [Fact]
    public void Own_champion_resolution_reads_only_the_matching_player()
    {
        using var document = JsonDocument.Parse("""
        [
          {"riotId":"Other#EUW","rawChampionName":"game_character_displayname_Ahri",
           "championName":"Ahri","position":"MIDDLE","summonerName":""},
          {"riotId":"Own#EUW","rawChampionName":"game_character_displayname_Volibear",
           "championName":"Volibear","position":"TOP","summonerName":""}
        ]
        """);
        var me = new LiveLocalIdentity("Own#EUW", "Own", "EUW", null);

        var match = LiveLocalPlayerResolver.Match(document.RootElement, me);
        Assert.NotNull(match);
        var champion = LiveLocalPlayerResolver.ReadChampion(match!.Player);

        // Only the local player's own entry is ever read.
        Assert.Equal("Volibear", champion.RawKey);
        Assert.Equal("TOP", champion.Position);

        var stranger = new LiveLocalIdentity("Missing#EUW", "Missing", "EUW", null);
        Assert.Null(LiveLocalPlayerResolver.Match(document.RootElement, stranger));
    }

    private sealed class FixtureHandler(Func<Uri, string> payloadFactory) : HttpMessageHandler
    {
        public int Calls { get; private set; }
        public List<string> Requests { get; } = [];

        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            Calls++;
            Requests.Add(request.RequestUri?.ToString() ?? string.Empty);
            var response = new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(
                    payloadFactory(request.RequestUri!),
                    Encoding.UTF8,
                    "application/json")
            };
            return Task.FromResult(response);
        }
    }

    private sealed class RecordingSkillOrderProvider(Func<string, SkillOrderResult> resultFactory) : ISkillOrderProvider
    {
        public List<string> Requests { get; } = [];

        public Task<SkillOrderResult> GetSkillOrderAsync(
            int championId,
            string? role,
            CancellationToken ct)
        {
            Requests.Add(role ?? string.Empty);
            return Task.FromResult(resultFactory(role ?? string.Empty));
        }
    }

    private static SkillOrderResult OkResult(int championId, string lane, int sampleSize) =>
        new(
            SkillOrderStatus.Ok,
            new OverlaySkillOrder([OverlayAbility.Q], 1, Completed: false),
            championId,
            sampleSize);
}
