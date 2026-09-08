using System.Net;
using System.Net.Sockets;
using CoachBuild.Core;
using Xunit;

namespace CoachBuild.Core.Tests;

public sealed class LocalDraftBridgeTests
{
    [Fact]
    public async Task Pool_reads_only_local_mastery_and_returns_ranked_played_champion_ids()
    {
        var lcu = new MockLcuApi();
        lcu.Enqueue(HttpMethod.Get, "/lol-champion-mastery/v1/local-player/champion-mastery",
            new LcuResponse(true, 200, MockLcuApi.Json("""
                [{"championId":112,"championPoints":80},{"championId":103,"championPoints":100},
                 {"championId":22,"championPoints":0},{"championId":-1,"championPoints":200}]
                """)));
        var state = new CompanionState();
        state.SetCredentials(new LcuCredentials(1234, "fixture", "test"));
        await using var server = new CompanionHttpServer("token", state, lcu, ports: [FreePort()]);
        await server.StartAsync();
        using var client = Client(server.Port);
        Assert.Equal("[103,112]", await client.GetStringAsync("/draft/pool?session=token"));
        Assert.Single(lcu.Calls);
    }

    [Theory]
    [InlineData("slug=viktor&lane=middle&patch=16.17", "token", 200)]
    [InlineData("slug=https://evil.test&lane=middle&patch=16.17", "token", 400)]
    [InlineData("slug=viktor&lane=invalid&patch=16.17", "token", 400)]
    [InlineData("slug=viktor&lane=middle&patch=16.17", "wrong", 403)]
    public async Task Counters_are_authenticated_and_only_fetch_the_fixed_upstream(string query, string token, int status)
    {
        var transport = new CounterTransport();
        await using var server = new CompanionHttpServer("token", ports: [FreePort()], countersTransport: transport);
        await server.StartAsync();
        using var client = Client(server.Port);
        using var response = await client.GetAsync($"/draft/counters-html?{query}&session={token}");
        Assert.Equal(status, (int)response.StatusCode);
        if (status == 200)
        {
            Assert.Equal("https://lolalytics.com/lol/viktor/counters/?lane=middle&tier=emerald_plus&patch=16.17", transport.Url);
            Assert.Equal("text/plain", response.Content.Headers.ContentType?.MediaType);
            Assert.Equal("<html>fixture</html>", await response.Content.ReadAsStringAsync());
        }
        else Assert.Null(transport.Url);
    }

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

    private sealed class CounterTransport : HttpMessageHandler
    {
        public string? Url { get; private set; }
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token)
        {
            Url = request.RequestUri?.AbsoluteUri;
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent("<html>fixture</html>") });
        }
    }
}
