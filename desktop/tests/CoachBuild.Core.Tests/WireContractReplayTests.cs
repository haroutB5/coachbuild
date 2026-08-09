using System.Net;
using System.Net.Http.Headers;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using CoachBuild.Core;
using Xunit;

namespace CoachBuild.Core.Tests;

public sealed class WireContractReplayTests
{
    [Fact]
    public async Task Bridge_replays_origin_session_status_follow_and_detach_contract()
    {
        var lcu = new MockLcuApi();
        var state = new CompanionState();
        state.SetCredentials(new LcuCredentials(1234, "test-token", "fixture"));
        await using var server = new CompanionHttpServer(
            "session-token",
            state,
            lcu,
            ports: [FindFreePort()]);
        await server.StartAsync();
        using var client = NewClient(server.Port);

        using var options = new HttpRequestMessage(HttpMethod.Options, "/status");
        options.Headers.TryAddWithoutValidation("Origin", CompanionWire.AppOrigin);
        var optionResponse = await client.SendAsync(options);
        Assert.Equal(HttpStatusCode.NoContent, optionResponse.StatusCode);
        Assert.Equal(CompanionWire.AppOrigin, optionResponse.Headers.GetValues("Access-Control-Allow-Origin").Single());

        var badOrigin = new HttpRequestMessage(HttpMethod.Get, "/status?session=session-token");
        badOrigin.Headers.TryAddWithoutValidation("Origin", "https://evil.example");
        var badOriginResponse = await client.SendAsync(badOrigin);
        Assert.Equal(HttpStatusCode.Forbidden, badOriginResponse.StatusCode);
        Assert.Equal("bad-origin", (await ReadJsonAsync(badOriginResponse)).GetProperty("error").GetString());

        var badSession = NewRequest(HttpMethod.Get, "/status?session=wrong");
        var badSessionResponse = await client.SendAsync(badSession);
        Assert.Equal(HttpStatusCode.Forbidden, badSessionResponse.StatusCode);
        Assert.Equal("bad-session", (await ReadJsonAsync(badSessionResponse)).GetProperty("error").GetString());

        var validStatus = await client.SendAsync(NewRequest(HttpMethod.Get, "/status?session=session-token&follow=builds"));
        Assert.Equal(HttpStatusCode.OK, validStatus.StatusCode);
        var status = await ReadJsonAsync(validStatus);
        Assert.Equal(CompanionWire.Version, status.GetProperty("version").GetString());
        Assert.Equal(server.Port, status.GetProperty("port").GetInt32());
        Assert.Equal("builds", server.State.FollowAttachments.GetSnapshot(FollowKind.Builds).FollowAt is not null ? "builds" : "none");

        var detach = await client.SendAsync(NewRequest(HttpMethod.Get, "/status?session=session-token&follow=builds&detach=1"));
        Assert.Equal(HttpStatusCode.OK, detach.StatusCode);
        Assert.Null(server.State.FollowAttachments.GetSnapshot(FollowKind.Builds).FollowAt);
    }

    [Fact]
    public async Task Bridge_replays_live_skills_me_apply_and_unknown_route_shapes()
    {
        var lcu = new MockLcuApi();
        lcu.Enqueue(HttpMethod.Get, "/lol-summoner/v1/current-summoner", new LcuResponse(
            true,
            200,
            MockLcuApi.Json("{\"gameName\":\"Own\",\"tagLine\":\"EUW\",\"puuid\":\"puuid\",\"summonerId\":7}")));
        var state = new CompanionState();
        state.SetCredentials(new LcuCredentials(1234, "test-token", "fixture"));
        await using var server = new CompanionHttpServer("session-token", state, lcu, ports: [FindFreePort()]);
        await server.StartAsync();
        using var client = NewClient(server.Port);

        var live = await client.SendAsync(NewRequest(HttpMethod.Get, "/live?session=session-token"));
        Assert.Equal("no-live", (await ReadJsonAsync(live)).GetProperty("error").GetString());
        var skills = await client.SendAsync(NewRequest(HttpMethod.Get, "/skills?session=session-token"));
        Assert.Equal("no-live", (await ReadJsonAsync(skills)).GetProperty("error").GetString());
        var me = await client.SendAsync(NewRequest(HttpMethod.Get, "/me?session=session-token"));
        var identity = await ReadJsonAsync(me);
        Assert.Equal("Own", identity.GetProperty("gameName").GetString());
        Assert.Equal("puuid", identity.GetProperty("puuid").GetString());

        var invalidRunes = new HttpRequestMessage(HttpMethod.Post, "/apply-runes?session=session-token")
        {
            Content = new StringContent("{\"name\":\"User page\"}", Encoding.UTF8, "application/json")
        };
        invalidRunes.Headers.TryAddWithoutValidation("Origin", CompanionWire.AppOrigin);
        var runeResponse = await client.SendAsync(invalidRunes);
        Assert.Equal("invalid-page", (await ReadJsonAsync(runeResponse)).GetProperty("reason").GetString());

        lcu.Enqueue(HttpMethod.Get, "/lol-summoner/v1/current-summoner", new LcuResponse(
            true, 200, MockLcuApi.Json("{\"summonerId\":7}")));
        lcu.Enqueue(HttpMethod.Get, "/lol-item-sets/v1/item-sets/7/sets", new LcuResponse(
            true, 200, MockLcuApi.Json("{\"accountId\":7,\"itemSets\":[{\"title\":\"Foreign\"}]}")));
        lcu.Enqueue(HttpMethod.Put, "/lol-item-sets/v1/item-sets/7/sets", new LcuResponse(true, 200, MockLcuApi.Json("{}")));
        var validItemSets = new HttpRequestMessage(HttpMethod.Post, "/apply-itemsets?session=session-token")
        {
            Content = new StringContent("{\"championId\":103,\"sets\":[{\"title\":\"CoachBuild Ahri Top\",\"blocks\":[]}]}"
                , Encoding.UTF8, "application/json")
        };
        validItemSets.Headers.TryAddWithoutValidation("Origin", CompanionWire.AppOrigin);
        var itemSetResponse = await client.SendAsync(validItemSets);
        var itemSetResult = await ReadJsonAsync(itemSetResponse);
        Assert.True(itemSetResult.GetProperty("ok").GetBoolean());
        Assert.Equal(1, itemSetResult.GetProperty("count").GetInt32());

        var unknown = await client.SendAsync(NewRequest(HttpMethod.Get, "/unknown?session=session-token"));
        Assert.Equal(HttpStatusCode.NotFound, unknown.StatusCode);
        Assert.Equal("not-found", (await ReadJsonAsync(unknown)).GetProperty("error").GetString());
    }

    [Fact]
    public async Task Bridge_live_passthrough_preserves_upstream_json_bytes()
    {
        const string raw = "{\"activePlayer\":{\"summonerName\":\"must-pass-through\"},\"gameData\":{\"gameTime\":12.5}}";
        using var live = new LiveClientDataClient(
            new LiveClientDataOptions(Scheme: "http"),
            new FixedBodyHandler(raw));
        await using var server = new CompanionHttpServer(
            "session-token",
            new CompanionState(),
            new MockLcuApi(),
            live,
            ports: [FindFreePort()]);
        await server.StartAsync();
        using var client = NewClient(server.Port);

        var response = await client.SendAsync(NewRequest(HttpMethod.Get, "/live?session=session-token"));
        var bytes = await response.Content.ReadAsByteArrayAsync();

        Assert.Equal(Encoding.UTF8.GetBytes(raw), bytes);
    }

    [Fact]
    public void Wire_records_serialize_nullable_status_fields_and_unions_exactly()
    {
        var status = JsonSerializer.Serialize(new CompanionStatus(
            CompanionWire.Version,
            48291,
            "None",
            false,
            null,
            null,
            null,
            null), JsonOptions.Wire);
        Assert.Contains("\"lastOpen\":null", status, StringComparison.Ordinal);
        Assert.Contains("\"champSelect\":null", status, StringComparison.Ordinal);
        Assert.Equal("{\"ok\":false,\"reason\":\"slots-full\"}",
            JsonSerializer.Serialize(new ApplyRunesFailure("slots-full"), JsonOptions.Wire));
    }

    [Fact]
    public void Credential_discovery_is_lockfile_first_then_process_args_and_cached_until_invalidated()
    {
        var temp = Path.Combine(Path.GetTempPath(), $"coachbuild-lockfile-{Guid.NewGuid():N}");
        File.WriteAllText(temp, "LeagueClient:1:51234:lock-token:https");
        try
        {
            var source = new CountingProcessSource(new LeagueClientProcess(
                "LeagueClientUx.exe", "--app-port=51235 --remoting-auth-token=process-token"));
            var resolver = new LcuCredentialResolver(source, LcuCredentialParser.ReadLockfile, temp);
            Assert.Equal("lockfile", resolver.Resolve()!.Source);
            Assert.Equal(0, source.Calls);

            File.WriteAllText(temp, "broken");
            resolver.Invalidate();
            Assert.Equal("process-args", resolver.Resolve()!.Source);
            Assert.Equal(1, source.Calls);
            Assert.Equal(1, resolver.Resolve() is not null ? source.Calls : -1);
            resolver.Invalidate();
            _ = resolver.Resolve();
            Assert.Equal(2, source.Calls);
            Assert.Null(LcuCredentialParser.ParseProcessArguments(null));
            Assert.Equal("process-args", LcuCredentialParser.ParseProcessArguments(
                "--app-port=51235 --remoting-auth-token=\"quoted-token\"")!.Source);
        }
        finally
        {
            try { File.Delete(temp); } catch { }
        }
    }

    [Fact]
    public async Task Lcu_client_invalidates_cached_credentials_on_401()
    {
        var source = new CountingProcessSource(new LeagueClientProcess(
            "LeagueClientUx.exe", "--app-port=51236 --remoting-auth-token=process-token"));
        var resolver = new LcuCredentialResolver(source, _ => null, Path.Combine(Path.GetTempPath(), "missing-lockfile"));
        var handler = new FixedResponseHandler(HttpStatusCode.Unauthorized);
        using var client = new LcuHttpClient(resolver, new LcuHttpClientOptions("http"), handler);
        var response = await client.GetAsync("/lol-gameflow/v1/gameflow-phase");

        Assert.Equal(401, response.StatusCode);
        Assert.Null(resolver.Cached);
    }

    [Fact]
    public void Missing_credentials_are_negative_cached_before_repeating_process_enumeration()
    {
        var source = new CountingProcessSource();
        var resolver = new LcuCredentialResolver(
            source,
            _ => null,
            Path.Combine(Path.GetTempPath(), $"coachbuild-missing-{Guid.NewGuid():N}"));

        Assert.Null(resolver.Resolve());
        Assert.Null(resolver.Resolve());
        Assert.Equal(1, source.Calls);

        resolver.Invalidate();
        Assert.Null(resolver.Resolve());
        Assert.Equal(2, source.Calls);
    }

    private sealed class CountingProcessSource(params LeagueClientProcess[] values) : ILeagueClientProcessSource
    {
        public int Calls { get; private set; }
        public IEnumerable<LeagueClientProcess> GetProcesses()
        {
            Calls++;
            return values;
        }
    }

    private sealed class FixedResponseHandler(HttpStatusCode status) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) =>
            Task.FromResult(new HttpResponseMessage(status) { Content = new StringContent("{}") });
    }

    private sealed class FixedBodyHandler(string body) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken) =>
            Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new ByteArrayContent(Encoding.UTF8.GetBytes(body))
            });
    }

    private static HttpClient NewClient(int port) => new(new HttpClientHandler())
    {
        BaseAddress = new Uri($"http://127.0.0.1:{port}")
    };

    private static HttpRequestMessage NewRequest(HttpMethod method, string path)
    {
        var request = new HttpRequestMessage(method, path);
        request.Headers.TryAddWithoutValidation("Origin", CompanionWire.AppOrigin);
        return request;
    }

    private static async Task<JsonElement> ReadJsonAsync(HttpResponseMessage response)
    {
        var raw = await response.Content.ReadAsStringAsync();
        using var document = JsonDocument.Parse(raw);
        return document.RootElement.Clone();
    }

    private static int FindFreePort()
    {
        using var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        return ((IPEndPoint)listener.LocalEndpoint).Port;
    }
}
