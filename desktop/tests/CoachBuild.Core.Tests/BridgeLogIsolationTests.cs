using System.Net;
using System.Net.Sockets;
using System.Text;
using CoachBuild.Core;
using Xunit;

namespace CoachBuild.Core.Tests;

/// <summary>
/// The bridge must never write to the user's real companion.log from a test.
///
/// <para>WHAT THIS COSTS WHEN IT IS WRONG. <c>CompanionHttpServer</c> used to
/// default its log to <c>new RedactedLog()</c>, which resolves to
/// <c>%LOCALAPPDATA%\CoachBuild\companion.log</c> -- the same file the shipped
/// app writes and the only artifact anyone has for diagnosing a real session.
/// Every <c>dotnet test</c> run therefore appended the lines
/// <see cref="WireContractReplayTests"/> deliberately provokes: a foreign-title
/// POST (rejected, by design) followed by a valid champion-103 item-set POST
/// (accepted, by design). On 2026-08-20 that file held 327 rune rejections and
/// zero successes, none of them from the product, and the fleet spent two
/// investigations on "apply-runes has never succeeded". A diagnostic that
/// manufactures its own evidence is worse than no diagnostic.</para>
/// </summary>
public sealed class BridgeLogIsolationTests
{
    [Fact]
    public async Task A_bridge_with_no_log_supplied_discards_instead_of_writing_to_the_users_log()
    {
        await using var server = new CompanionHttpServer("session-token", ports: [FindFreePort()]);

        Assert.True(server.Log.IsDiscarding);
        Assert.Equal(string.Empty, server.Log.FilePath);
        // The production path is still what an unqualified RedactedLog means --
        // this test asserts the bridge does not reach for it, not that the
        // default moved.
        Assert.EndsWith(
            Path.Combine("CoachBuild", "companion.log"),
            new RedactedLog().FilePath,
            StringComparison.Ordinal);
    }

    [Fact]
    public async Task Driving_the_apply_endpoints_writes_to_the_supplied_log_and_nowhere_else()
    {
        var productionLog = new RedactedLog().FilePath;
        var before = Length(productionLog);
        var root = Path.Combine(Path.GetTempPath(), $"coachbuild-log-isolation-{Guid.NewGuid():N}");
        Directory.CreateDirectory(root);
        try
        {
            // 1. No log supplied -- the shape every test in this suite uses.
            await using (var silent = new CompanionHttpServer(
                "session-token", Credentialed(), new MockLcuApi(), ports: [FindFreePort()]))
            {
                await silent.StartAsync();
                await PostForeignRuneAsync(silent.Port);
            }

            // 2. Positive control: the SAME request against a bridge with a log
            //    of its own must actually produce the line -- otherwise step 1
            //    proves nothing (an endpoint that logs nothing would also leave
            //    the production file alone).
            var supplied = new RedactedLog(root);
            await using (var loud = new CompanionHttpServer(
                "session-token", Credentialed(), new MockLcuApi(), log: supplied, ports: [FindFreePort()]))
            {
                await loud.StartAsync();
                await PostForeignRuneAsync(loud.Port);
            }

            Assert.Contains(
                "apply-runes: ok=False reason=bad-title",
                File.ReadAllText(supplied.FilePath),
                StringComparison.Ordinal);
            Assert.Equal(before, Length(productionLog));
        }
        finally
        {
            try { Directory.Delete(root, recursive: true); } catch { }
        }
    }

    private static CompanionState Credentialed()
    {
        var state = new CompanionState();
        state.SetCredentials(new LcuCredentials(1234, "test-token", "fixture"));
        return state;
    }

    private static async Task PostForeignRuneAsync(int port)
    {
        using var client = new HttpClient { BaseAddress = new Uri($"http://127.0.0.1:{port}") };
        using var request = new HttpRequestMessage(HttpMethod.Post, "/apply-runes?session=session-token")
        {
            Content = new StringContent("{\"name\":\"User page\"}", Encoding.UTF8, "application/json")
        };
        request.Headers.TryAddWithoutValidation("Origin", CompanionWire.AppOrigin);
        using var response = await client.SendAsync(request);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    private static long Length(string path) => File.Exists(path) ? new FileInfo(path).Length : -1;

    private static int FindFreePort()
    {
        using var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        return ((IPEndPoint)listener.LocalEndpoint).Port;
    }
}
