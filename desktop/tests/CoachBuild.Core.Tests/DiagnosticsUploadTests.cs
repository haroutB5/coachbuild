using System.Reflection;
using System.Text;
using System.Text.Json;
using CoachBuild.Core;
using Xunit;

namespace CoachBuild.Core.Tests;

/// <summary>
/// The desktop half of the companion-log upload.
///
/// <para>Two things are being defended and they are not equally important. The
/// FEATURE is that a tray click posts the tail of companion.log. The RULE is
/// that it can never cost a player their item set or their runes, and that it
/// can never leak a credential or an identifier on the way out. The rule
/// outranks the feature, and
/// <see cref="A_hung_upload_cannot_delay_an_item_set_apply"/>,
/// <see cref="Nothing_in_the_upload_path_can_throw"/> and
/// <see cref="Every_identifier_shape_a_real_log_can_carry_is_redacted_before_it_leaves"/>
/// are the three tests that say so.</para>
/// </summary>
public sealed class DiagnosticsUploadTests
{
    // ─────────────────────────────────────────────────────────────────────
    // The contract, pinned against the server half
    // ─────────────────────────────────────────────────────────────────────

    /// <summary>
    /// Not a tautology. Each of these four is a value the SERVER decides and
    /// this side merely has to agree with: the route
    /// (app/api/mystats/diagnostics/route.ts), the closed one-value `source`
    /// vocabulary and the byte ceiling (both in lib/mystats/diagnostics.ts), and
    /// the header name (lib/mystats/accountAuth.ts, shared with rank-sample).
    /// If one of them moves, this fails and names where the real answer lives.
    /// </summary>
    [Fact]
    public void The_wire_contract_matches_the_server_half()
    {
        Assert.Equal("/api/mystats/diagnostics", RankSampleClient.DiagnosticsPath);
        Assert.Equal("companion", DiagnosticsBody.CompanionSource);
        Assert.Equal(256 * 1024, DiagnosticsBody.MaxWireBytes);
        Assert.Equal("x-coachbuild-account-secret", RankSampleClient.SecretHeader);
    }

    /// <summary>
    /// Identity is gameName + tagLine and there is NO puuid field, because the
    /// LCU's puuid is a 36-char local UUID that joins to nothing Riot-backed.
    /// The server's parseDiagnosticsIdentity has no puuid branch either; a field
    /// added here would be silently ignored, which is the worse failure.
    /// </summary>
    [Fact]
    public void The_body_carries_a_riot_id_and_never_a_puuid()
    {
        var json = JsonSerializer.Serialize(
            DiagnosticsBody.Create(new OwnIdentity("Name", "TAG", "local-uuid"), "line"),
            JsonOptions.Wire);

        using var document = JsonDocument.Parse(json);
        var root = document.RootElement;
        Assert.Equal("Name", root.GetProperty("gameName").GetString());
        Assert.Equal("TAG", root.GetProperty("tagLine").GetString());
        Assert.Equal("line", root.GetProperty("body").GetString());
        Assert.Equal("companion", root.GetProperty("source").GetString());
        Assert.False(root.TryGetProperty("puuid", out _));
        Assert.Equal(4, root.EnumerateObject().Count());
    }

    /// <summary>
    /// One transport for both My Stats POSTs. A second HttpClient is how the
    /// timeout, the header spelling, the 4xx/5xx split and the ok:false reading
    /// quietly come to disagree.
    /// </summary>
    [Fact]
    public void One_client_serves_both_my_stats_posts_against_one_origin()
    {
        using var client = new RankSampleClient("https://example.test");

        Assert.IsAssignableFrom<IRankSampleSink>(client);
        Assert.IsAssignableFrom<IDiagnosticsSink>(client);
        Assert.Equal("https://example.test/api/mystats/rank-sample", client.Endpoint.ToString());
        Assert.Equal("https://example.test/api/mystats/diagnostics", client.DiagnosticsEndpoint.ToString());
    }

    // ─────────────────────────────────────────────────────────────────────
    // The tail
    // ─────────────────────────────────────────────────────────────────────

    /// <summary>
    /// The cap is the LOG's own ceiling, not a second literal, so the two cannot
    /// drift into disagreeing about how much history exists.
    /// </summary>
    [Fact]
    public void The_tail_cap_is_tied_to_the_logs_own_ceiling()
    {
        Assert.Equal(CompanionWire.MaxLogBytes, LogTail.MaxTailBytes);
        Assert.True(DiagnosticsBody.MaxWireBytes > LogTail.MaxTailBytes,
            "redaction can lengthen text, so the wire ceiling must have headroom over the tail cap");
    }

    [Fact]
    public void A_short_log_is_sent_whole()
    {
        var text = "first\nsecond\nthird\n";
        Assert.Equal(text, LogTail.ReadFrom(Stream(text)));
    }

    /// <summary>
    /// The tail is dropped to the next line boundary. That is not tidiness: an
    /// offset chosen by arithmetic can land inside a multi-byte UTF-8 sequence,
    /// and the replacement character would otherwise be the first thing in the
    /// file the user uploads.
    /// </summary>
    [Fact]
    public void A_truncated_tail_never_begins_mid_line()
    {
        var text = "aaaaaaaaaa\nbbbbbbbbbb\ncccccccccc\n";
        var tail = LogTail.ReadFrom(Stream(text), maxBytes: 16);

        Assert.NotNull(tail);
        Assert.DoesNotContain('\uFFFD', tail!);
        Assert.StartsWith("cccccccccc", tail, StringComparison.Ordinal);
    }

    [Fact]
    public void A_multibyte_boundary_never_produces_a_replacement_character()
    {
        // Each of these lines is 3 bytes of content plus a newline, so a byte
        // cap that is not a multiple of 4 lands inside a character.
        var text = string.Concat(Enumerable.Repeat("\u4e2d\n", 400));
        var tail = LogTail.ReadFrom(Stream(text), maxBytes: 1023);

        Assert.NotNull(tail);
        Assert.DoesNotContain('\uFFFD', tail!);
    }

    /// <summary>
    /// A pathological log with no newline in the whole tail is returned whole
    /// rather than emptied. An empty upload reads to the user as the button
    /// being broken, which is the one outcome this feature exists to remove.
    /// </summary>
    [Fact]
    public void A_tail_with_no_newline_at_all_is_still_sent()
    {
        var text = new string('x', 4096);
        var tail = LogTail.ReadFrom(Stream(text), maxBytes: 1024);

        Assert.NotNull(tail);
        Assert.Equal(1024, Encoding.UTF8.GetByteCount(tail!));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    public void A_blank_path_reads_nothing(string? path) => Assert.Null(LogTail.Read(path));

    [Fact]
    public void An_absent_or_empty_file_reads_nothing()
    {
        var missing = Path.Combine(Path.GetTempPath(), $"coachbuild-missing-{Guid.NewGuid():N}.log");
        Assert.Null(LogTail.Read(missing));

        var empty = Path.Combine(Path.GetTempPath(), $"coachbuild-empty-{Guid.NewGuid():N}.log");
        File.WriteAllText(empty, string.Empty);
        try { Assert.Null(LogTail.Read(empty)); }
        finally { File.Delete(empty); }
    }

    /// <summary>
    /// The reader must not be able to break the writer. The process reading this
    /// file is the process appending to it, and an exclusive open would make the
    /// diagnostics button able to stop logging.
    /// </summary>
    [Fact]
    public void Reading_the_tail_does_not_lock_the_log_against_the_writer()
    {
        var path = Path.Combine(Path.GetTempPath(), $"coachbuild-shared-{Guid.NewGuid():N}.log");
        var log = new RedactedLog(Path.GetDirectoryName(path)!);
        try
        {
            File.WriteAllText(path, "one\ntwo\n");
            using var writer = new FileStream(path, FileMode.Append, FileAccess.Write, FileShare.ReadWrite | FileShare.Delete);

            Assert.Equal("one\ntwo\n", LogTail.Read(path));

            writer.Write(Encoding.UTF8.GetBytes("three\n"));
            writer.Flush();
            Assert.Equal("one\ntwo\nthree\n", LogTail.Read(path));
        }
        finally
        {
            GC.KeepAlive(log);
            if (File.Exists(path)) File.Delete(path);
        }
    }

    [Fact]
    public void LimitBytes_trims_from_the_front_on_a_line_boundary()
    {
        var text = "alpha\nbravo\ncharlie\n";
        Assert.Equal(text, LogTail.LimitBytes(text, 1024));

        var trimmed = LogTail.LimitBytes(text, 12);
        Assert.Equal("charlie\n", trimmed[^8..]);
        Assert.True(Encoding.UTF8.GetByteCount(trimmed) <= 12);
    }

    // ─────────────────────────────────────────────────────────────────────
    // Redaction — the shared policy, and what a real log actually contains
    // ─────────────────────────────────────────────────────────────────────

    /// <summary>
    /// The four shapes the brief names, plus the secret itself, plus the ONE
    /// shape a real log was found to carry that no rule covered.
    ///
    /// <para>The first four scored ZERO against the 166KB companion.log on the
    /// authoring machine on 2026-08-21 — the product's own writes are already
    /// redacted, so they are defence for text that arrives from outside (the
    /// bridge's free-text `diagnostics` field, or an older build's lines). The
    /// user-profile path is different: it is reachable by construction, via
    /// LeagueConfigLocator's %LOCALAPPDATA% candidate and App.LogConfigSearch's
    /// one-line join of the first eight candidates. See
    /// ComplianceRules.UserProfileRegex.</para>
    /// </summary>
    [Fact]
    public async Task Every_identifier_shape_a_real_log_can_carry_is_redacted_before_it_leaves()
    {
        const string secret = "shared-secret-value";
        var log = string.Join('\n',
            "shop: looked for League's Config in 5 place(s): C:\\Users\\Harout\\AppData\\Local\\Riot Games",
            "bridge: apply-runes for MunsterHunter#EUW",
            "bridge: identity a1b2c3d4-5e6f-4789-8abc-0123456789ab resolved",
            "bridge: GET /status?session=abc123def&follow=builds",
            "lcu: --remoting-auth-token=SUPERSECRETTOKEN --app-port=51234",
            $"pairing: using {secret} for the account header",
            string.Empty);

        var sink = new RecordingSink();
        var outcome = await NewService(HealthyLcu(), sink, secret: secret, tail: log).UploadAsync();

        Assert.Equal(DiagnosticsUploadOutcome.Sent, outcome);
        var body = Assert.Single(sink.Bodies).Body;

        Assert.DoesNotContain("Harout", body, StringComparison.Ordinal);
        Assert.Contains("[user-redacted]", body, StringComparison.Ordinal);
        Assert.DoesNotContain("MunsterHunter#EUW", body, StringComparison.Ordinal);
        Assert.Contains("[player-redacted]", body, StringComparison.Ordinal);
        Assert.DoesNotContain("a1b2c3d4-5e6f-4789-8abc-0123456789ab", body, StringComparison.Ordinal);
        Assert.Contains("[id-redacted]", body, StringComparison.Ordinal);
        Assert.DoesNotContain("abc123def", body, StringComparison.Ordinal);
        Assert.Contains("session=[redacted]", body, StringComparison.Ordinal);
        Assert.DoesNotContain("SUPERSECRETTOKEN", body, StringComparison.Ordinal);
        Assert.Contains("remoting-auth-token=[redacted]", body, StringComparison.Ordinal);
        Assert.DoesNotContain(secret, body, StringComparison.Ordinal);

        // The rest of the path survives. It is the entire diagnostic value of
        // that line, and redacting it wholesale would trade a real answer for a
        // marginal gain.
        Assert.Contains("AppData", body, StringComparison.Ordinal);
        Assert.Contains("looked for League's Config", body, StringComparison.Ordinal);
    }

    /// <summary>
    /// The shared policy, not a private one. Two independent pins: the redacted
    /// upload equals what ComplianceRules.Redact produces for the same input,
    /// and a shape the shared policy does NOT redact is still not redacted here.
    /// A private redactor would have to diverge from at least one of them.
    /// </summary>
    [Fact]
    public async Task The_upload_uses_the_shared_redaction_policy_and_no_second_one()
    {
        const string secret = "s3cr3t";
        var log = "apply-itemsets: count=2\nlive: champion=Syndra id=134\nsession=zzz\n";

        var sink = new RecordingSink();
        await NewService(HealthyLcu(), sink, secret: secret, tail: log).UploadAsync();

        Assert.Equal(
            ComplianceRules.Redact(log, secrets: [secret]),
            Assert.Single(sink.Bodies).Body);
    }

    /// <summary>
    /// THE TAIL, NOT A GREP. A line nobody has ever written a rule about must
    /// arrive verbatim — a filter tuned to today's bugs is exactly what makes
    /// next month's bug invisible, and an omitted line is indistinguishable from
    /// a line that never happened.
    /// </summary>
    [Fact]
    public async Task An_unrecognised_line_is_sent_verbatim()
    {
        const string oddity = "kraken: something nobody has written a parser for yet (0x8007007e)";
        var sink = new RecordingSink();

        await NewService(HealthyLcu(), sink, tail: $"poll: phase None -> ChampSelect\n{oddity}\n").UploadAsync();

        Assert.Contains(oddity, Assert.Single(sink.Bodies).Body, StringComparison.Ordinal);
    }

    /// <summary>
    /// Redaction can LENGTHEN text, so the wire cap is applied after it and
    /// against the server's own number. Without this the button would answer a
    /// pathological log with an unexplained "rejected" — the server 400s a body
    /// over DIAGNOSTICS_BODY_MAX_BYTES.
    /// </summary>
    [Fact]
    public async Task A_body_that_redaction_inflated_is_still_within_the_servers_ceiling()
    {
        // `session=a` (9 bytes) becomes `session=[redacted]` (18): the tail is
        // under the read cap and the redacted text is over the wire cap.
        var log = string.Concat(Enumerable.Repeat("session=a\n", 20_000));
        Assert.True(Encoding.UTF8.GetByteCount(log) <= LogTail.MaxTailBytes);

        var sink = new RecordingSink();
        await NewService(HealthyLcu(), sink, tail: log).UploadAsync();

        var body = Assert.Single(sink.Bodies).Body;
        Assert.True(Encoding.UTF8.GetByteCount(ComplianceRules.Redact(log)) > DiagnosticsBody.MaxWireBytes,
            "fixture no longer exercises the inflation case");
        Assert.True(Encoding.UTF8.GetByteCount(body) <= DiagnosticsBody.MaxWireBytes);
        Assert.EndsWith("session=[redacted]\n", body, StringComparison.Ordinal);
    }

    // ─────────────────────────────────────────────────────────────────────
    // Outcomes — every route out says something
    // ─────────────────────────────────────────────────────────────────────

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    public async Task Without_a_secret_nothing_is_posted_and_nothing_is_read(string? secret)
    {
        var lcu = HealthyLcu();
        var sink = new RecordingSink();

        var outcome = await NewService(lcu, sink, secret: secret).UploadAsync();

        Assert.Equal(DiagnosticsUploadOutcome.NotPaired, outcome);
        Assert.Empty(sink.Bodies);
        // Fail-closed, and cheap: the client is never even asked.
        Assert.Empty(lcu.Calls);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   \n  ")]
    public async Task An_empty_log_posts_nothing(string? tail)
    {
        var sink = new RecordingSink();
        var outcome = await NewService(HealthyLcu(), sink, tail: tail).UploadAsync();

        Assert.Equal(DiagnosticsUploadOutcome.NoLog, outcome);
        Assert.Empty(sink.Bodies);
    }

    [Fact]
    public async Task An_unreadable_client_identity_posts_nothing()
    {
        var lcu = new ScriptedLcu { SummonerBody = """{"gameName":"","tagLine":null}""" };
        var sink = new RecordingSink();

        var outcome = await NewService(lcu, sink).UploadAsync();

        Assert.Equal(DiagnosticsUploadOutcome.NoIdentity, outcome);
        Assert.Empty(sink.Bodies);
    }

    [Theory]
    [InlineData(RankSamplePostResult.Posted, DiagnosticsUploadOutcome.Sent)]
    [InlineData(RankSamplePostResult.Rejected, DiagnosticsUploadOutcome.Rejected)]
    [InlineData(RankSamplePostResult.Failed, DiagnosticsUploadOutcome.Failed)]
    public async Task The_servers_answer_becomes_the_users_answer(
        RankSamplePostResult posted, DiagnosticsUploadOutcome expected)
    {
        var sink = new RecordingSink { Result = posted };
        Assert.Equal(expected, await NewService(HealthyLcu(), sink).UploadAsync());
    }

    /// <summary>
    /// A silent no-op is the failure mode this feature exists to remove, so
    /// every outcome must have a sentence AND a distinct greppable log word.
    /// </summary>
    [Fact]
    public void Every_outcome_has_its_own_message_and_its_own_log_word()
    {
        var outcomes = Enum.GetValues<DiagnosticsUploadOutcome>();

        Assert.All(outcomes, outcome =>
        {
            Assert.False(string.IsNullOrWhiteSpace(DiagnosticsMessages.Text(outcome)));
            Assert.False(string.IsNullOrWhiteSpace(DiagnosticsMessages.LogWord(outcome)));
        });
        Assert.Equal(outcomes.Length, outcomes.Select(DiagnosticsMessages.Text).Distinct(StringComparer.Ordinal).Count());
        Assert.Equal(outcomes.Length, outcomes.Select(DiagnosticsMessages.LogWord).Distinct(StringComparer.Ordinal).Count());
        Assert.Single(outcomes, DiagnosticsMessages.IsSuccess);
    }

    /// <summary>
    /// Nothing the user is shown, and nothing written to the log, may contain
    /// the secret or the log's own contents.
    /// </summary>
    [Fact]
    public async Task No_log_line_carries_the_secret_or_the_uploads_contents()
    {
        const string secret = "do-not-print-me";
        var directory = Path.Combine(Path.GetTempPath(), $"coachbuild-diag-{Guid.NewGuid():N}");
        Directory.CreateDirectory(directory);
        var log = new RedactedLog(directory);
        try
        {
            await NewService(HealthyLcu(), new RecordingSink(), secret: secret,
                tail: "bridge: MunsterHunter#EUW did a thing\n", log: log).UploadAsync();

            var written = File.ReadAllText(log.FilePath);
            Assert.Contains("diagnostics: upload sent", written, StringComparison.Ordinal);
            Assert.DoesNotContain(secret, written, StringComparison.Ordinal);
            Assert.DoesNotContain("did a thing", written, StringComparison.Ordinal);
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    // ─────────────────────────────────────────────────────────────────────
    // The rule: an upload can never cost an apply
    // ─────────────────────────────────────────────────────────────────────

    /// <summary>
    /// The reason this feature is allowed to exist at all. An upload whose POST
    /// never answers must be invisible to an item-set write happening at the
    /// same moment — no shared lock, no shared queue, no shared connection
    /// budget. The upload here is left hanging deliberately and is never
    /// awaited; the apply is asserted to complete on its own, THROUGH THE SAME
    /// ILcuApi and the same CompanionState write gate.
    ///
    /// <para><b>The hang is in the SINK, not in the LCU, and that is a
    /// correction rather than a convenience.</b> The first draft hung
    /// <c>/lol-summoner/v1/current-summoner</c> and the apply timed out — because
    /// <see cref="ItemSetApplyService.ApplyAsync"/> reads that same route to get
    /// the summoner id. That is a shared LEAGUE CLIENT route, not shared state
    /// in this app, and no amount of discipline here can make one client answer
    /// two callers when it is answering neither. What this test is entitled to
    /// prove is the part that IS in our control: everything the upload does
    /// after that read — the redaction and the POST, which is where all the
    /// unbounded time actually lives — cannot touch an apply.</para>
    ///
    /// <para><b>Verified by mutation, not by reading it.</b> Making
    /// <see cref="DiagnosticsUploadService.Fire"/> await its own task before
    /// returning makes this test HANG rather than fail, which is the proof that
    /// the assertion below is load-bearing and not decorative — the same way the
    /// LP lane proved its equivalent.</para>
    /// </summary>
    [Fact]
    public async Task A_hung_upload_cannot_delay_an_item_set_apply()
    {
        var lcu = new ScriptedLcu();
        var sink = new RecordingSink { Hang = true };
        var service = NewService(lcu, sink);

        service.Fire();
        await sink.Entered.Task.WaitAsync(TimeSpan.FromSeconds(5));

        // No CompanionState is handed to the upload service at all -- see
        // The_upload_service_shares_no_state_with_the_apply_paths -- so there is
        // no write gate for it to be holding while this runs.
        var itemSets = new ItemSetApplyService(lcu);
        var apply = itemSets.ApplyAsync(new ApplyItemSetsRequest(
            103,
            [MockLcuApi.Json("""{"title":"CoachBuild Ahri Mid","uid":"coachbuild-ahri-mid","blocks":[]}""")]));

        var result = await apply.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.IsType<ApplyItemSetsSuccess>(result);

        // The upload is still stuck where we left it, which is the point: it got
        // no further and cost the apply nothing.
        Assert.False(service.PendingUpload!.IsCompleted);
        sink.Release();
        await service.PendingUpload!.WaitAsync(TimeSpan.FromSeconds(5));
    }

    /// <summary>
    /// The same guarantee from the other direction: <see cref="DiagnosticsUploadService.Fire"/>
    /// returns while the POST is still outstanding, so a caller on a game path
    /// cannot be charged for it even in wall-clock terms.
    /// </summary>
    [Fact]
    public async Task Fire_returns_while_the_upload_is_still_outstanding()
    {
        var sink = new RecordingSink { Hang = true };
        var service = NewService(new ScriptedLcu(), sink);

        var started = System.Diagnostics.Stopwatch.StartNew();
        service.Fire();
        started.Stop();

        Assert.True(started.Elapsed < TimeSpan.FromSeconds(1), $"Fire blocked for {started.Elapsed}");
        await sink.Entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.False(service.PendingUpload!.IsCompleted);
        sink.Release();
        await service.PendingUpload!.WaitAsync(TimeSpan.FromSeconds(5));
    }

    /// <summary>
    /// Every dependency in the upload path, made hostile one at a time —
    /// including the caller's own result callback, which runs on the same task.
    /// None of them may produce a throw anyone can see.
    /// </summary>
    [Theory]
    [InlineData("lcu-throws")]
    [InlineData("sink-throws")]
    [InlineData("secret-throws")]
    [InlineData("log-path-throws")]
    [InlineData("tail-throws")]
    [InlineData("lcu-dead")]
    [InlineData("no-identity")]
    public async Task Nothing_in_the_upload_path_can_throw(string hostility)
    {
        var lcu = new ScriptedLcu();
        var sink = new RecordingSink();
        Func<string?> secret = () => "secret";
        Func<string?> path = () => "log.txt";
        Func<string?, int, string?> tail = (_, _) => "a line\n";

        switch (hostility)
        {
            case "lcu-throws": lcu.Throw = true; break;
            case "sink-throws": sink.Throw = true; break;
            case "secret-throws": secret = () => throw new InvalidOperationException("settings on fire"); break;
            case "log-path-throws": path = () => throw new IOException("path on fire"); break;
            case "tail-throws": tail = (_, _) => throw new IOException("disk on fire"); break;
            case "lcu-dead": lcu.Dead = true; break;
            case "no-identity": lcu.SummonerBody = """{"gameName":"","tagLine":null}"""; break;
        }

        var service = new DiagnosticsUploadService(lcu, sink, secret, path, RedactedLog.Discarding, tail);

        // The assertion IS that this returns an outcome. An escaping exception
        // fails the test by escaping.
        var outcome = await service.UploadAsync();
        Assert.True(Enum.IsDefined(outcome));

        // ...and the same through Fire, whose callback is also hostile.
        service.Fire(_ => throw new InvalidOperationException("the caller's UI exploded"));
        await service.PendingUpload!.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.True(service.PendingUpload!.IsCompletedSuccessfully);
    }

    /// <summary>
    /// Structural half of the same rule. <see cref="CompanionState"/> is what
    /// the apply paths serialise their LCU writes through
    /// (<c>BeginLcuWrite</c>), and the update gate reads
    /// <c>ActiveLcuWriteTransactions</c> off it. This service is not given one
    /// and therefore cannot hold that gate open, cannot make the companion look
    /// busy, and cannot be made to by a later edit without this failing.
    /// </summary>
    [Fact]
    public void The_upload_service_shares_no_state_with_the_apply_paths()
    {
        var parameters = typeof(DiagnosticsUploadService)
            .GetConstructors()
            .SelectMany(constructor => constructor.GetParameters())
            .Select(parameter => parameter.ParameterType)
            .ToArray();

        Assert.DoesNotContain(typeof(CompanionState), parameters);
        Assert.DoesNotContain(typeof(ItemSetApplyService), parameters);
        Assert.DoesNotContain(typeof(RuneApplyService), parameters);
    }

    // ─────────────────────────────────────────────────────────────────────
    // User-triggered only
    // ─────────────────────────────────────────────────────────────────────

    /// <summary>
    /// The service has exactly one way in, and it is a method somebody has to
    /// call. No timer, no phase hook, no <c>Start</c>.
    ///
    /// <para>Structural on purpose: silent background log shipping is a
    /// different product with a different consent conversation, and the way that
    /// gets shipped by accident is a scheduler being added to a class that
    /// already knows how to post. Adding one now fails this test.</para>
    /// </summary>
    [Fact]
    public void The_service_exposes_no_automatic_trigger()
    {
        var members = typeof(DiagnosticsUploadService)
            .GetMembers(BindingFlags.Public | BindingFlags.Instance | BindingFlags.Static | BindingFlags.DeclaredOnly)
            .Where(member => member.MemberType is MemberTypes.Method or MemberTypes.Property or MemberTypes.Event)
            .Select(member => member.Name)
            .Where(name => !name.StartsWith("get_", StringComparison.Ordinal))
            .ToHashSet(StringComparer.Ordinal);

        Assert.Equal(
            new HashSet<string>(["Fire", "UploadAsync", "PendingUpload"], StringComparer.Ordinal),
            members.Except(["ToString", "Equals", "GetHashCode", "GetType"]).ToHashSet(StringComparer.Ordinal));
        Assert.Empty(typeof(DiagnosticsUploadService).GetEvents());
    }

    // ─────────────────────────────────────────────────────────────────────
    // Fixtures
    // ─────────────────────────────────────────────────────────────────────

    private static MemoryStream Stream(string text) =>
        new(Encoding.UTF8.GetBytes(text), writable: false);

    private static ScriptedLcu HealthyLcu() => new();

    private static DiagnosticsUploadService NewService(
        ILcuApi lcu,
        IDiagnosticsSink sink,
        string? secret = "shared-secret",
        string? tail = "poll: phase None -> ChampSelect\n",
        RedactedLog? log = null) =>
        new(lcu, sink, () => secret, () => "companion.log", log ?? RedactedLog.Discarding, (_, _) => tail);

    private sealed class RecordingSink : IDiagnosticsSink
    {
        private readonly TaskCompletionSource _release =
            new(TaskCreationOptions.RunContinuationsAsynchronously);

        public List<DiagnosticsBody> Bodies { get; } = [];

        public List<string> Secrets { get; } = [];

        public bool Throw { get; set; }

        public bool Hang { get; set; }

        public TaskCompletionSource Entered { get; } =
            new(TaskCreationOptions.RunContinuationsAsynchronously);

        public RankSamplePostResult Result { get; set; } = RankSamplePostResult.Posted;

        public void Release() => _release.TrySetResult();

        public async Task<RankSamplePostResult> PostAsync(
            DiagnosticsBody body, string secret, CancellationToken cancellationToken)
        {
            if (Throw) throw new InvalidOperationException("the sink exploded");
            lock (Bodies)
            {
                Bodies.Add(body);
                Secrets.Add(secret);
            }
            Entered.TrySetResult();
            if (Hang) await _release.Task.ConfigureAwait(false);
            return Result;
        }
    }

    /// <summary>An <see cref="ILcuApi"/> that can be dead, slow, lying or absent.</summary>
    private sealed class ScriptedLcu : ILcuApi
    {
        private readonly TaskCompletionSource _summonerRelease =
            new(TaskCreationOptions.RunContinuationsAsynchronously);

        public List<string> Calls { get; } = [];

        public string SummonerBody { get; set; } =
            """{"summonerId":7,"gameName":"Name","tagLine":"TAG","puuid":"local-uuid"}""";

        public bool Throw { get; set; }

        public bool Dead { get; set; }

        public bool HangSummoner { get; set; }

        public TaskCompletionSource SummonerEntered { get; } =
            new(TaskCreationOptions.RunContinuationsAsynchronously);

        public void ReleaseSummoner() => _summonerRelease.TrySetResult();

        /// <summary>
        /// NOTE for anyone reaching for <see cref="HangSummoner"/>: the item-set
        /// apply path reads that same route for the summoner id, so hanging it
        /// blocks an apply for reasons that have nothing to do with this
        /// service. See <see cref="A_hung_upload_cannot_delay_an_item_set_apply"/>.
        /// </summary>
        public async Task<LcuResponse> SendAsync(
            HttpMethod method, string path, object? body = null, CancellationToken cancellationToken = default)
        {
            lock (Calls) Calls.Add($"{method} {path}");
            if (Throw) throw new InvalidOperationException("the client exploded");
            if (Dead) return new LcuResponse(false, 0);

            if (path == "/lol-summoner/v1/current-summoner")
            {
                SummonerEntered.TrySetResult();
                if (HangSummoner) await _summonerRelease.Task.ConfigureAwait(false);
                return Ok(SummonerBody);
            }

            if (path.StartsWith("/lol-item-sets/v1/item-sets/", StringComparison.Ordinal))
                return method == HttpMethod.Put
                    ? Ok("{}")
                    : Ok("""{"accountId":1,"timestamp":1,"itemSets":[]}""");

            return new LcuResponse(false, 404);
        }

        private static LcuResponse Ok(string raw) => new(true, 200, MockLcuApi.Json(raw), raw);
    }
}
