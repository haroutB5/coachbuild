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
    public void Own_champion_resolution_reads_only_the_matching_player()
    {
        using var document = JsonDocument.Parse("""
        [
          {"riotId":"Other#EUW","championId":999,"summonerId":"do-not-retain"},
          {"riotId":"Own#EUW","championId":103,"summonerId":"also-do-not-retain"}
        ]
        """);

        Assert.Equal(103, LivePlayerListResolver.ResolveOwnChampionId(document.RootElement, "Own#EUW"));
        Assert.Null(LivePlayerListResolver.ResolveOwnChampionId(document.RootElement, "Missing#EUW"));
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
}
