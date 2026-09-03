using System.Net;
using System.Net.Http;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using CoachBuild.Core;
using Xunit;

namespace CoachBuild.Core.Tests;

/// <summary>
/// POST /client-log: the hosted page forwards its [autoExport] decision
/// lines here because its own console dies with the WebView2 window at game
/// start. The bridge validates bounds, redacts, appends to companion.log
/// prefixed with "web: ", and never lets a logging call fail anything.
/// </summary>
public sealed class ClientLogTests
{
    [Theory]
    [InlineData(null)]
    [InlineData(0)]
    [InlineData(21)]
    public void Rejects_missing_empty_and_oversized_batches(int? count)
    {
        var log = new RedactedLog(TempRoot());
        var service = new ClientLogService(log, () => DateTimeOffset.UtcNow);
        List<string?>? lines = count is null
            ? null
            : Enumerable.Range(0, count.Value).Select(_ => (string?)"103/2: hold - x").ToList();
        var result = service.Accept(lines);
        Assert.False(result.Ok);
        Assert.Equal("bad-body", result.Reason);
        Assert.Equal(0, result.Accepted);
    }

    [Fact]
    public void Rejects_null_empty_and_overlong_members()
    {
        var log = new RedactedLog(TempRoot());
        var service = new ClientLogService(log, () => DateTimeOffset.UtcNow);
        Assert.Equal("bad-body", service.Accept(["ok line", null]).Reason);
        Assert.Equal("bad-body", service.Accept(["ok line", ""]).Reason);
        Assert.Equal("bad-body", service.Accept(["ok line", new string('x', 513)]).Reason);
    }

    [Fact]
    public void Accepts_a_valid_batch_and_prefixes_each_line()
    {
        var log = new RedactedLog(TempRoot());
        var service = new ClientLogService(log, () => DateTimeOffset.UtcNow);
        var result = service.Accept(["103/2: hold - timer phase PLANNING", "103/2: wrote item set"]);
        Assert.True(result.Ok);
        Assert.Equal(2, result.Accepted);
        var text = File.ReadAllText(log.FilePath);
        Assert.Contains("web: 103/2: hold - timer phase PLANNING", text);
        Assert.Contains("web: 103/2: wrote item set", text);
    }

    [Fact]
    public void Redacts_player_shaped_content_before_writing()
    {
        var log = new RedactedLog(TempRoot());
        var service = new ClientLogService(log, () => DateTimeOffset.UtcNow);
        service.Accept(["note from Foo#EUW about the draft"]);
        var text = File.ReadAllText(log.FilePath);
        Assert.DoesNotContain("Foo#EUW", text);
        Assert.Contains("[player-redacted]", text);
    }

    [Fact]
    public void Throttles_a_second_batch_inside_the_window_then_accepts_after()
    {
        var log = new RedactedLog(TempRoot());
        var now = new DateTimeOffset(2026, 9, 3, 12, 0, 0, TimeSpan.Zero);
        var service = new ClientLogService(log, () => now);
        Assert.True(service.Accept(["first"]).Ok);
        var throttled = service.Accept(["second"]);
        Assert.False(throttled.Ok);
        Assert.Equal("throttled", throttled.Reason);
        now = now.Add(ClientLogService.MinInterval);
        Assert.True(service.Accept(["third"]).Ok);
        var text = File.ReadAllText(log.FilePath);
        Assert.Contains("web: first", text);
        Assert.DoesNotContain("web: second", text);
        Assert.Contains("web: third", text);
    }

    [Fact]
    public async Task Bridge_accepts_client_log_without_lcu_credentials()
    {
        // Logging is diagnostics, not a client write: no game client, no
        // credentials, still 200. (Apply endpoints answer no-client here.)
        var log = new RedactedLog(TempRoot());
        await using var server = new CompanionHttpServer(
            "session-token", new CompanionState(), new MockLcuApi(), log: log, ports: [FindFreePort()]);
        await server.StartAsync();
        using var client = NewClient(server.Port);

        var request = PostJson("/client-log?session=session-token", "{\"lines\":[\"103/2: hold - x\"]}");
        var response = await client.SendAsync(request);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await ReadJsonAsync(response);
        Assert.True(body.GetProperty("ok").GetBoolean());
        Assert.Equal(1, body.GetProperty("accepted").GetInt32());
        Assert.Contains("web: 103/2: hold - x", File.ReadAllText(log.FilePath));
    }

    [Fact]
    public async Task Bridge_rejects_bad_origin_bad_session_and_bad_body()
    {
        var log = new RedactedLog(TempRoot());
        await using var server = new CompanionHttpServer(
            "session-token", new CompanionState(), new MockLcuApi(), log: log, ports: [FindFreePort()]);
        await server.StartAsync();
        using var client = NewClient(server.Port);

        var evil = PostJson("/client-log?session=session-token", "{\"lines\":[\"x\"]}");
        evil.Headers.TryAddWithoutValidation("Origin", "https://evil.example");
        Assert.Equal(HttpStatusCode.Forbidden, (await client.SendAsync(evil)).StatusCode);

        var badSession = await client.SendAsync(
            PostJson("/client-log?session=nope", "{\"lines\":[\"x\"]}"));
        Assert.Equal(HttpStatusCode.Forbidden, badSession.StatusCode);

        var badBody = await client.SendAsync(
            PostJson("/client-log?session=session-token", "{\"lines\":[]}"));
        var badJson = await ReadJsonAsync(badBody);
        Assert.False(badJson.GetProperty("ok").GetBoolean());
        Assert.Equal("bad-body", badJson.GetProperty("reason").GetString());
    }

    private static string TempRoot() =>
        Path.Combine(Path.GetTempPath(), $"coachbuild-clientlog-{Guid.NewGuid():N}");

    private static HttpClient NewClient(int port) => new(new HttpClientHandler())
    {
        BaseAddress = new Uri($"http://127.0.0.1:{port}")
    };

    private static HttpRequestMessage PostJson(string path, string json)
    {
        var request = new HttpRequestMessage(HttpMethod.Post, path);
        request.Headers.TryAddWithoutValidation("Origin", CompanionWire.AppOrigin);
        request.Content = new StringContent(json, Encoding.UTF8, "application/json");
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
