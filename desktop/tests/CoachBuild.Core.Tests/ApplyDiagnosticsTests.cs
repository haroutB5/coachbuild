using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using CoachBuild.Core;
using Xunit;

namespace CoachBuild.Core.Tests;

/// <summary>
/// The web has sent <c>diagnostics</c> on every failed-consensus export since
/// <c>33785c7</c>; the bridge skipped the unknown field, so the one channel
/// that reaches the machine the game is actually on carried nothing.
///
/// <para>Two subjects here, and they pull in opposite directions on purpose.
/// The field must ARRIVE — a diagnostic nobody can read is the outage all over
/// again — and it must stay INERT: it is commentary on a write that changes the
/// player's League config, so no shape of it may cost them their item set.
/// Every test below asserts one of those two, and the malformed cases assert
/// both at once.</para>
/// </summary>
public sealed class ApplyDiagnosticsTests
{
    /// <summary>
    /// The two sentences <c>consensusFailureLine</c> actually builds, copied
    /// from <c>components/hextech/itemSetsApply.ts</c> rather than paraphrased.
    ///
    /// <para>NOTE THE SECOND ONE. <c>HANDOFF-marco-neon-usage.md</c> §3a and
    /// <c>companionClient.ts</c>'s header both describe this array as one line
    /// per block the export DROPPED. That stopped being true at <c>56bbe6a</c>,
    /// which added the precomputed-artifact fallback: a live query can fail and
    /// the block still ship, and that case emits a line too — one that says
    /// SERVED FROM, never OMITTED, and carries the age of the numbers the user
    /// is looking at. So the log must be able to say "your Pro block is there,
    /// but it is patch-16.16 data because the live query failed", which is a
    /// different sentence from "your Pro block is gone" and a different action
    /// for the reader.</para>
    /// </summary>
    private const string OmittedLine =
        "Pro build block OMITTED because the query FAILED, not because this champion has no data: " +
        "/api/pros returned HTTP 500 for championId=222 role=4";

    private const string RecoveredLine =
        "OTP build block SERVED FROM the precomputed patch-16.16 artifact " +
        "(generated 2026-08-20T18:00:00.000Z, STALE for this patch) because the live query FAILED: " +
        "/api/otp returned HTTP 500 for championId=222 role=4";

    // ── The field arrives ─────────────────────────────────────────────────

    [Fact]
    public void The_bridge_no_longer_skips_the_field()
    {
        // The whole defect, in one assertion. This body is what the shipped web
        // POSTs during a Neon outage; every desktop before this change
        // deserialized it into a request with nowhere to put these two
        // sentences, and System.Text.Json's Skip default threw them away
        // without a word.
        var request = JsonSerializer.Deserialize<ApplyItemSetsRequest>($$"""
        {"championId":222,"sets":[{"title":"CoachBuild Jinx Bot","blocks":[]}],
         "replacePrefix":"CoachBuild",
         "diagnostics":["{{OmittedLine}}","{{RecoveredLine}}"]}
        """, JsonOptions.Wire);

        Assert.NotNull(request);
        Assert.NotNull(request!.Diagnostics);
        Assert.Equal(JsonValueKind.Array, request.Diagnostics!.Value.ValueKind);
        Assert.Equal(2, request.Diagnostics.Value.GetArrayLength());
    }

    [Fact]
    public async Task A_successful_export_writes_every_line_the_web_sent()
    {
        await InLog(async (log, path) =>
        {
            var result = await new ItemSetApplyService(SuccessfulLcu(), Connected(), log)
                .ApplyAsync(Request(222, $"""["{OmittedLine}","{RecoveredLine}"]"""));

            Assert.IsType<ApplyItemSetsSuccess>(result);
            var text = ReadLog(path);
            Assert.Contains($"apply-itemsets: {OmittedLine}", text, StringComparison.Ordinal);
            Assert.Contains($"apply-itemsets: {RecoveredLine}", text, StringComparison.Ordinal);
            // Verbatim, not re-worded. The sentence already names the BLOCK the
            // user lost and not just the endpoint, which is the whole reason it
            // connects "my Pro build block is gone" to "/api/pros answered 500".
            Assert.DoesNotContain("diagnostics dropped", text, StringComparison.Ordinal);
        });
    }

    [Fact]
    public async Task The_line_survives_a_real_POST_over_the_wire()
    {
        // The record-level test above proves the SHAPE deserializes. This
        // proves the PATH: a real HTTP POST at the bridge's own port, through
        // CompanionHttpServer's ReadJsonAsync and JsonOptions.Wire, into the
        // log the tray app writes. Those are the two links the shipped web
        // depends on and neither is exercised by constructing a record.
        var productionLog = new RedactedLog().FilePath;
        var before = Length(productionLog);
        var root = TempRoot();
        try
        {
            // A log OF ITS OWN. Never the default: an unqualified RedactedLog
            // resolves to the user's real companion.log, and a test that writes
            // there manufactures the evidence the next investigation reads.
            // See BridgeLogIsolationTests.
            var supplied = new RedactedLog(root);
            await using var server = new CompanionHttpServer(
                "session-token", Connected(), SuccessfulLcu(), log: supplied, ports: [FreePort()]);
            await server.StartAsync();

            using var client = new HttpClient { BaseAddress = new Uri($"http://127.0.0.1:{server.Port}") };
            using var post = new HttpRequestMessage(HttpMethod.Post, "/apply-itemsets?session=session-token")
            {
                Content = new StringContent($$"""
                {"championId":222,"sets":[{"title":"CoachBuild Jinx Bot","blocks":[]}],
                 "diagnostics":["{{OmittedLine}}"]}
                """, Encoding.UTF8, "application/json")
            };
            post.Headers.TryAddWithoutValidation("Origin", CompanionWire.AppOrigin);

            using var response = await client.SendAsync(post);
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
            Assert.True(document.RootElement.GetProperty("ok").GetBoolean());

            Assert.Contains($"apply-itemsets: {OmittedLine}", ReadLog(supplied.FilePath), StringComparison.Ordinal);
            Assert.Equal(before, Length(productionLog));
        }
        finally
        {
            Cleanup(root);
        }
    }

    // ── The field stays inert ─────────────────────────────────────────────

    [Fact]
    public void An_older_web_build_omits_the_field_and_still_deserializes()
    {
        var request = JsonSerializer.Deserialize<ApplyItemSetsRequest>("""
        {"championId":3,"sets":[{"title":"CoachBuild Galio Mid","blocks":[]}],"replacePrefix":"CoachBuild"}
        """, JsonOptions.Wire);

        Assert.NotNull(request);
        Assert.Equal(3, request!.ChampionId);
        Assert.Single(request.Sets!);
        Assert.Null(request.Diagnostics);
        Assert.True(ApplyPayloadValidation.TryValidateItemSets(request, out _));
    }

    [Theory]
    [InlineData("""{"championId":3,"sets":[{"title":"CoachBuild X","blocks":[]}],"diagnostics":"nonsense"}""")]
    [InlineData("""{"championId":3,"sets":[{"title":"CoachBuild X","blocks":[]}],"diagnostics":42}""")]
    [InlineData("""{"championId":3,"sets":[{"title":"CoachBuild X","blocks":[]}],"diagnostics":[null,7,{"a":1}]}""")]
    [InlineData("""{"championId":3,"sets":[{"title":"CoachBuild X","blocks":[]}],"diagnostics":{"pro":"broke"}}""")]
    public void A_malformed_diagnostics_field_never_costs_the_caller_their_request(string body)
    {
        // This is why the member is a raw JsonElement and not string[]. A typed
        // list throws inside Deserialize on the first non-string member, which
        // turns the WHOLE request into null -- so a bad diagnostic would fail
        // the item-set write it was only ever supposed to describe.
        var request = JsonSerializer.Deserialize<ApplyItemSetsRequest>(body, JsonOptions.Wire);

        Assert.NotNull(request);
        Assert.Equal(3, request!.ChampionId);
        Assert.Single(request.Sets!);
        Assert.True(ApplyPayloadValidation.TryValidateItemSets(request, out _));
    }

    [Fact]
    public async Task A_healthy_export_says_nothing_at_all()
    {
        // The silence is a feature and it is load-bearing. Every export that
        // worked omits the key, so a "no diagnostics" line would print on every
        // apply forever -- and a line that always prints is a line nobody reads
        // on the one day it changes.
        await InLog(async (log, path) =>
        {
            await new ItemSetApplyService(SuccessfulLcu(), Connected(), log).ApplyAsync(Request(3, null));

            var text = ReadLog(path);
            Assert.Contains("apply-itemsets: count=1", text, StringComparison.Ordinal);
            Assert.DoesNotContain("diagnostics", text, StringComparison.OrdinalIgnoreCase);
        });
    }

    [Fact]
    public async Task One_bad_line_costs_that_line_and_nothing_else()
    {
        await InLog(async (log, path) =>
        {
            var result = await new ItemSetApplyService(SuccessfulLcu(), Connected(), log)
                .ApplyAsync(Request(222, $"""[7,"   ","{OmittedLine}"]"""));

            Assert.IsType<ApplyItemSetsSuccess>(result);
            var text = ReadLog(path);
            // The good line still lands...
            Assert.Contains($"apply-itemsets: {OmittedLine}", text, StringComparison.Ordinal);
            // ...and the two that did not are named, with their positions, so a
            // reader can tell "the web sent nothing" from "the web sent
            // something this bridge would not print".
            Assert.Contains("diagnostics dropped 2 lines", text, StringComparison.Ordinal);
            Assert.Contains("line 0 is Number, not a string", text, StringComparison.Ordinal);
            Assert.Contains("line 1 is blank", text, StringComparison.Ordinal);
        });
    }

    [Fact]
    public async Task A_failed_write_records_no_diagnostics()
    {
        // Order matters: the lines go
        // out AFTER the PUT succeeds. An export that never reached League has
        // already failed loudly, and the case this feature exists for is the
        // opposite one -- a SUCCESSFUL export quietly missing a block.
        await InLog(async (log, path) =>
        {
            var api = new MockLcuApi();
            api.Enqueue(HttpMethod.Get, "/lol-summoner/v1/current-summoner",
                new LcuResponse(true, 200, MockLcuApi.Json("{\"summonerId\":77}")));
            api.Enqueue(HttpMethod.Get, "/lol-item-sets/v1/item-sets/77/sets",
                new LcuResponse(true, 200, MockLcuApi.Json("{\"accountId\":77,\"itemSets\":[]}")));
            api.Enqueue(HttpMethod.Put, "/lol-item-sets/v1/item-sets/77/sets", new LcuResponse(false, 500, null));

            var result = await new ItemSetApplyService(api, Connected(), log)
                .ApplyAsync(Request(222, $"""["{OmittedLine}"]"""));

            Assert.IsType<ApplyItemSetsFailure>(result);
            Assert.DoesNotContain("OMITTED", ReadLog(path), StringComparison.Ordinal);
        });
    }

    // ── The sender is not trusted ─────────────────────────────────────────

    [Fact]
    public async Task More_lines_than_the_bound_are_dropped_and_the_drop_is_reported()
    {
        // The log is a 200 KB ring buffer that trims from the FRONT. An
        // unbounded diagnostics array is therefore a way to page out the
        // champ-select and live lines a reader actually needs -- which is why
        // the bound exists, and why exceeding it is reported rather than
        // silently obeyed.
        await InLog(async (log, path) =>
        {
            var many = string.Join(",", Enumerable.Range(0, 12).Select(i => $"\"line number {i}\""));
            await new ItemSetApplyService(SuccessfulLcu(), Connected(), log).ApplyAsync(Request(222, $"[{many}]"));

            var text = ReadLog(path);
            Assert.Equal(ApplyDiagnosticsParser.MaxLines, CountLines(text, "line number "));
            Assert.Contains($"more than {ApplyDiagnosticsParser.MaxLines} lines; the rest were dropped", text, StringComparison.Ordinal);
        });
    }

    [Fact]
    public async Task An_over_long_line_is_CUT_rather_than_thrown_away()
    {
        // Dropping it would lose the one thing the feature exists to deliver.
        // The head of the sentence is where the block name and the reason live,
        // so keep the head and mark the cut -- a truncated sentence is still
        // true; a missing one is the 2026-08-20 silence again.
        await InLog(async (log, path) =>
        {
            var padded = OmittedLine + new string('x', 4000);
            await new ItemSetApplyService(SuccessfulLcu(), Connected(), log)
                .ApplyAsync(Request(222, $"""["{padded}"]"""));

            var text = ReadLog(path);
            Assert.Contains("Pro build block OMITTED because the query FAILED", text, StringComparison.Ordinal);
            Assert.Contains(ApplyDiagnosticsParser.TruncationMarker, text, StringComparison.Ordinal);
            Assert.Contains("was longer than", text, StringComparison.Ordinal);
            Assert.DoesNotContain(new string('x', ApplyDiagnosticsParser.MaxLineLength + 1), text, StringComparison.Ordinal);
        });
    }

    [Fact]
    public async Task Control_characters_never_reach_the_log()
    {
        // A line the user is asked to open in a terminal must not be able to
        // carry an ANSI escape, and one wire event must not be able to become
        // several log entries.
        //
        // The payload is BUILT here and serialized rather than pasted as a
        // literal: a raw control byte in a .cs file is invisible in review and
        // does not survive every editor it passes through.
        const char esc = (char)0x1b;
        const char tab = (char)0x09;
        const char lf = (char)0x0a;
        var hostile = $"Pro build{esc}[31m block{tab}OMITTED{lf}fake 1970-01-01T00:00:00Z live: all clear";

        await InLog(async (log, path) =>
        {
            await new ItemSetApplyService(SuccessfulLcu(), Connected(), log)
                .ApplyAsync(Request(222, JsonSerializer.Serialize(new[] { hostile })));

            var text = ReadLog(path);
            Assert.DoesNotContain(esc.ToString(), text, StringComparison.Ordinal);
            Assert.DoesNotContain(tab.ToString(), text, StringComparison.Ordinal);
            // The forged second entry is folded into the first line rather than
            // given a timestamp of its own -- one wire event, one log entry.
            Assert.Equal(1, CountLines(text, "OMITTED"));
            Assert.Equal(1, CountLines(text, "fake 1970"));
        });
    }

    [Fact]
    public async Task Account_identifiers_are_redacted_before_they_are_written()
    {
        // These lines land in the file the user is ASKED TO SEND US. The web's
        // own template carries none of this, but the field is free text chosen
        // by whatever POSTed to the bridge, and "the sender is our own web app"
        // is an assumption a localhost HTTP endpoint does not get to make.
        await InLog(async (log, path) =>
        {
            await new ItemSetApplyService(SuccessfulLcu(), Connected(), log)
                .ApplyAsync(Request(222, """
                ["Pro build block OMITTED (player: Hide on bush#KR1, puuid a1b2c3d4-5e6f-4789-8abc-0123456789ab, session=abc123)"]
                """));

            var text = ReadLog(path);
            Assert.DoesNotContain("Hide on bush#KR1", text, StringComparison.Ordinal);
            Assert.DoesNotContain("a1b2c3d4-5e6f-4789-8abc-0123456789ab", text, StringComparison.Ordinal);
            Assert.DoesNotContain("abc123", text, StringComparison.Ordinal);
            Assert.Contains("[player-redacted]", text, StringComparison.Ordinal);
            Assert.Contains("[id-redacted]", text, StringComparison.Ordinal);
            // ...and the diagnostic itself survives the redaction. A rule that
            // ate the whole line would be a third way to lose the signal.
            Assert.Contains("Pro build block OMITTED", text, StringComparison.Ordinal);
        });
    }

    [Fact]
    public void The_redaction_rule_is_the_shared_one_and_applies_everywhere()
    {
        // Asserted at ComplianceRules and not only through the log, because the
        // point of putting it there is that every OTHER caller gets it too --
        // a second policy inside the diagnostics parser would have left the
        // same hole in every line the bridge already writes.
        Assert.Equal(
            "identity [id-redacted] resolved",
            ComplianceRules.Redact("identity a1b2c3d4-5e6f-4789-8abc-0123456789ab resolved"));

        // And it does NOT eat the session tokens or temp suffixes the product
        // really writes, which are all "N"-format (32 hex, no dashes).
        const string token = "0123456789abcdef0123456789abcdef";
        Assert.Contains(token, ComplianceRules.Redact($"companion-session.txt.tmp-{token}"), StringComparison.Ordinal);
    }

    // ── Helpers ───────────────────────────────────────────────────────────

    private static async Task InLog(Func<RedactedLog, string, Task> body)
    {
        var root = TempRoot();
        try
        {
            var log = new RedactedLog(root);
            await body(log, log.FilePath);
        }
        finally
        {
            Cleanup(root);
        }
    }

    private static string TempRoot() =>
        Path.Combine(Path.GetTempPath(), $"cb-diagnostics-{Guid.NewGuid():N}");

    private static void Cleanup(string root)
    {
        try { Directory.Delete(root, recursive: true); } catch { }
    }

    private static int CountLines(string text, string needle) =>
        text.Split('\n').Count(line => line.Contains(needle, StringComparison.Ordinal));

    /// <summary>
    /// The log file does not exist until something is written to it, and one
    /// test below asserts that NOTHING was -- so an absent file is a pass, not
    /// an exception.
    /// </summary>
    /// <summary>
    /// Reads a companion log that something may still be appending to.
    ///
    /// <para><c>File.ReadAllText</c> opens with <c>FileShare.Read</c>, which
    /// REFUSES to coexist with the write handle <c>RedactedLog.AppendLocked</c>
    /// holds for the length of one <c>File.AppendAllText</c>. In the tests that
    /// drive a real <c>CompanionHttpServer</c> the bridge is still writing its
    /// own lines when the assertion reads, so the two collide roughly one run
    /// in three and the test fails with an IOException that says nothing about
    /// the behaviour under test. Sharing ReadWrite is the fix rather than a
    /// retry loop: the reader has no business locking a log out.</para>
    /// </summary>
    private static string ReadLog(string path)
    {
        if (!File.Exists(path)) return string.Empty;
        using var stream = new FileStream(
            path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
        using var reader = new StreamReader(stream);
        return reader.ReadToEnd();
    }

    private static long Length(string path) => File.Exists(path) ? new FileInfo(path).Length : -1;

    private static int FreePort()
    {
        using var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        return ((IPEndPoint)listener.LocalEndpoint).Port;
    }

    private static ApplyItemSetsRequest Request(int championId, string? diagnostics)
    {
        var set = JsonDocument.Parse("{\"title\":\"CoachBuild Set\",\"blocks\":[]}").RootElement.Clone();
        return new ApplyItemSetsRequest(
            championId,
            [set],
            null,
            diagnostics is null ? null : JsonDocument.Parse(diagnostics).RootElement.Clone());
    }

    private static CompanionState Connected()
    {
        var state = new CompanionState();
        state.SetCredentials(new LcuCredentials(1234, "test-token", "fixture"));
        return state;
    }

    private static MockLcuApi SuccessfulLcu()
    {
        var api = new MockLcuApi();
        api.Enqueue(HttpMethod.Get, "/lol-summoner/v1/current-summoner",
            new LcuResponse(true, 200, MockLcuApi.Json("{\"summonerId\":77}")));
        api.Enqueue(HttpMethod.Get, "/lol-item-sets/v1/item-sets/77/sets",
            new LcuResponse(true, 200, MockLcuApi.Json("{\"accountId\":77,\"itemSets\":[]}")));
        api.Enqueue(HttpMethod.Put, "/lol-item-sets/v1/item-sets/77/sets",
            new LcuResponse(true, 200, MockLcuApi.Json("{}")));
        return api;
    }
}
