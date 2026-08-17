using System.Net;
using System.Text;
using CoachBuild.Core;
using Xunit;

namespace CoachBuild.Core.Tests;

/// <summary>
/// Pins the provider-side failure cooldowns, because they are the constraint
/// that sets the caller's retry backoff.
///
/// <para>1.0.7 retried a failed skill-order fetch at 3 s and 8 s against a
/// provider that caches an <c>Error</c> for 15 s. Even if the retry had armed
/// — it did not — both attempts would have been served the cached failure
/// without touching the network, burning half the schedule on nothing. Nothing
/// tested that relationship, so nothing caught it.</para>
/// </summary>
public sealed class SkillOrderCooldownTests
{
    private const int AhriId = 103;

    [Fact]
    public async Task An_error_retry_inside_the_15s_cooldown_is_served_from_cache_and_makes_no_request()
    {
        var clock = new FakeClock();
        var handler = new CountingHandler(HttpStatusCode.InternalServerError, "boom");
        using var provider = new SkillOrderProvider(new HttpClient(handler), null, clock);

        var first = await provider.GetSkillOrderAsync(AhriId, "MID", CancellationToken.None);
        Assert.Equal(SkillOrderStatus.Error, first.Status);
        Assert.Equal(1, handler.Calls);

        // The 1.0.7 schedule: 3 s then 8 s. Both land inside the cooldown.
        clock.Advance(TimeSpan.FromSeconds(3));
        await provider.GetSkillOrderAsync(AhriId, "MID", CancellationToken.None);
        clock.Advance(TimeSpan.FromSeconds(5));
        await provider.GetSkillOrderAsync(AhriId, "MID", CancellationToken.None);

        Assert.Equal(1, handler.Calls);
    }

    [Fact]
    public async Task The_20s_error_backoff_clears_the_cooldown_and_reaches_the_network()
    {
        var clock = new FakeClock();
        var handler = new CountingHandler(HttpStatusCode.InternalServerError, "boom");
        using var provider = new SkillOrderProvider(new HttpClient(handler), null, clock);

        await provider.GetSkillOrderAsync(AhriId, "MID", CancellationToken.None);
        clock.Advance(TimeSpan.FromSeconds(20));
        await provider.GetSkillOrderAsync(AhriId, "MID", CancellationToken.None);

        Assert.Equal(2, handler.Calls);
    }

    [Fact]
    public async Task A_no_data_retry_needs_more_than_60s_which_is_why_it_waits_75()
    {
        var clock = new FakeClock();
        var handler = new CountingHandler(HttpStatusCode.OK, "null");
        using var provider = new SkillOrderProvider(new HttpClient(handler), null, clock);

        var first = await provider.GetSkillOrderAsync(AhriId, "MID", CancellationToken.None);
        Assert.Equal(SkillOrderStatus.NoData, first.Status);

        clock.Advance(TimeSpan.FromSeconds(45));
        await provider.GetSkillOrderAsync(AhriId, "MID", CancellationToken.None);
        Assert.Equal(1, handler.Calls);

        clock.Advance(TimeSpan.FromSeconds(30));
        await provider.GetSkillOrderAsync(AhriId, "MID", CancellationToken.None);
        Assert.Equal(2, handler.Calls);
    }

    [Fact]
    public async Task A_successful_order_never_expires_for_the_rest_of_the_game()
    {
        var clock = new FakeClock();
        var handler = new CountingHandler(
            HttpStatusCode.OK,
            """{"order":["Q","W","E"],"completed":true,"sampleSize":10}""");
        using var provider = new SkillOrderProvider(new HttpClient(handler), null, clock);

        await provider.GetSkillOrderAsync(AhriId, "MID", CancellationToken.None);
        clock.Advance(TimeSpan.FromHours(2));
        var second = await provider.GetSkillOrderAsync(AhriId, "MID", CancellationToken.None);

        Assert.Equal(SkillOrderStatus.Ok, second.Status);
        Assert.Equal(1, handler.Calls);
    }

    private sealed class CountingHandler : HttpMessageHandler
    {
        private readonly HttpStatusCode _status;
        private readonly string _body;
        private int _calls;

        public CountingHandler(HttpStatusCode status, string body)
        {
            _status = status;
            _body = body;
        }

        public int Calls => Volatile.Read(ref _calls);

        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            Interlocked.Increment(ref _calls);
            return Task.FromResult(new HttpResponseMessage(_status)
            {
                Content = new StringContent(_body, Encoding.UTF8, "application/json"),
            });
        }
    }

    private sealed class FakeClock : TimeProvider
    {
        private DateTimeOffset _now = new(2026, 8, 17, 12, 0, 0, TimeSpan.Zero);

        public override DateTimeOffset GetUtcNow() => _now;

        public void Advance(TimeSpan delta) => _now += delta;
    }
}

/// <summary>
/// Proves the reachability instrument is actually WIRED, not merely correct.
/// A formatter with nothing calling it is exactly the shape of the 1.0.7
/// retry: right logic, never invoked.
/// </summary>
public sealed class LiveClientReachabilityWiringTests
{
    [Fact]
    public async Task A_dead_loopback_port_fires_the_probe_as_unreachable()
    {
        var port = FreePort();
        using var client = new LiveClientDataClient(new LiveClientDataOptions(port, "http"));
        var probes = new List<LiveClientProbe>();
        client.ProbeObserved = probes.Add;

        var result = await client.GetJsonAsync("/liveclientdata/allgamedata", CancellationToken.None);

        Assert.Null(result);
        var probe = Assert.Single(probes);
        Assert.False(probe.Reachable);
        Assert.NotNull(probe.Detail);

        var reporter = new LiveReachabilityReporter(port);
        Assert.StartsWith($"live: {port} unreachable (", reporter.Observe(probe), StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_port_that_answers_404_is_reported_reachable_not_down()
    {
        using var listener = new System.Net.Sockets.TcpListener(
            System.Net.IPAddress.Loopback, 0);
        listener.Start();
        var port = ((System.Net.IPEndPoint)listener.LocalEndpoint).Port;
        _ = Task.Run(async () =>
        {
            try
            {
                using var socket = await listener.AcceptTcpClientAsync();
                var stream = socket.GetStream();
                await stream.ReadAsync(new byte[4096]);
                var head = System.Text.Encoding.ASCII.GetBytes(
                    "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                await stream.WriteAsync(head);
                await stream.FlushAsync();
            }
            catch { }
        });

        using var client = new LiveClientDataClient(new LiveClientDataOptions(port, "http"));
        var probes = new List<LiveClientProbe>();
        client.ProbeObserved = probes.Add;

        await client.GetJsonAsync("/liveclientdata/activeplayerabilities", CancellationToken.None);
        listener.Stop();

        // A 404 is routine mid-game. Reporting it as "2999 unreachable" would
        // send the reader after a firewall that is not the problem.
        Assert.True(Assert.Single(probes).Reachable);
    }

    private static int FreePort()
    {
        using var listener = new System.Net.Sockets.TcpListener(System.Net.IPAddress.Loopback, 0);
        listener.Start();
        var port = ((System.Net.IPEndPoint)listener.LocalEndpoint).Port;
        listener.Stop();
        return port;
    }
}
