using System.Net;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using CoachBuild.Core;
using Xunit;

namespace CoachBuild.Core.Tests;

/// <summary>
/// The desktop half of the session LP record
/// (docs/superpowers/specs/2026-08-20-session-record-lp-design.md, §5).
///
/// <para>Two things are being defended here and they are not equally
/// important. The feature is that three samples get taken. The RULE is that
/// taking them can never cost a player their item set or their runes — a
/// capture that hangs, throws, 500s or is simply not configured must be
/// invisible to every apply path. The rule outranks the feature, and
/// <see cref="A_hung_ranked_read_cannot_delay_an_item_set_apply"/> plus
/// <see cref="Nothing_in_the_capture_path_can_throw"/> are the tests that say
/// so.</para>
/// </summary>
public sealed class RankCaptureTests
{
    // ─────────────────────────────────────────────────────────────────────
    // The endpoint itself
    // ─────────────────────────────────────────────────────────────────────

    /// <summary>
    /// A pin, not a tautology. This path was taken from the route table
    /// compiled into the League client installed on the machine that wrote it
    /// (LeagueClient.exe, 2026-08-15) rather than from memory, and the whole
    /// feature is downstream of it being right. If someone "tidies" it to a
    /// remembered spelling, this fails and points at where the real answer
    /// lives.
    /// </summary>
    [Fact]
    public void The_ranked_path_and_queue_key_are_the_ones_the_installed_client_registers()
    {
        Assert.Equal("/lol-ranked/v1/current-ranked-stats", RankedStats.CurrentRankedStatsPath);
        Assert.Equal("RANKED_SOLO_5x5", RankedStats.SoloQueueKey);
    }

    // ─────────────────────────────────────────────────────────────────────
    // Reading the body
    // ─────────────────────────────────────────────────────────────────────

    [Fact]
    public void Reads_solo_queue_out_of_the_queueMap_shape()
    {
        var sample = RankedStats.ReadSoloQueue(MockLcuApi.Json(
            """
            {"queueMap":{
              "RANKED_FLEX_SR":{"queueType":"RANKED_FLEX_SR","tier":"IRON","division":"IV","leaguePoints":3},
              "RANKED_SOLO_5x5":{"queueType":"RANKED_SOLO_5x5","tier":"GOLD","division":"I","leaguePoints":90}
            }}
            """));

        Assert.Equal(new RankSample("GOLD", "I", 90), sample);
    }

    /// <summary>
    /// The same client binary models the leagues-server DTO as an array under
    /// <c>queues</c>. Reading both is the hedge against the one thing the route
    /// table could not tell us: which shape the body actually arrives in.
    /// </summary>
    [Fact]
    public void Reads_solo_queue_out_of_the_queues_array_shape()
    {
        var sample = RankedStats.ReadSoloQueue(MockLcuApi.Json(
            """
            {"queues":[
              {"queueType":"RANKED_FLEX_SR","tier":"SILVER","rank":"II","leaguePoints":40},
              {"queueType":"RANKED_SOLO_5x5","tier":"PLATINUM","rank":"IV","leaguePoints":10}
            ]}
            """));

        Assert.Equal(new RankSample("PLATINUM", "IV", 10), sample);
    }

    /// <summary>
    /// Spec §1 decision 2 and HARD RULE 4: solo queue only. A body carrying
    /// nothing but flex is not a fallback, it is no sample.
    /// </summary>
    [Fact]
    public void Flex_alone_is_no_sample_rather_than_a_substitute()
    {
        Assert.Null(RankedStats.ReadSoloQueue(MockLcuApi.Json(
            """{"queueMap":{"RANKED_FLEX_SR":{"tier":"DIAMOND","division":"II","leaguePoints":55}}}""")));
    }

    [Theory]
    [InlineData("NONE")]
    [InlineData("UNRANKED")]
    [InlineData("")]
    [InlineData("   ")]
    public void An_account_with_no_standing_produces_no_sample(string tier)
    {
        Assert.Null(RankedStats.ReadSoloQueue(MockLcuApi.Json(
            $$$$"""{"queueMap":{"RANKED_SOLO_5x5":{"tier":"{{{{tier}}}}","division":"I","leaguePoints":0}}}""")));
    }

    /// <summary>
    /// A REAL ranked-stats body, copied verbatim out of the installed client's
    /// own trace: record <c>{"t":"re1",...,"ri":14}</c> of
    /// <c>Logs\LeagueClient Logs\2026-07-27T14-00-20_3788_LeagueClient-tracing.json</c>,
    /// whose matching <c>er1</c> request is <c>leagues-ledge/v2/signedRankedStats</c>.
    /// Trimmed to the fields under test and to two queues; nothing renamed.
    ///
    /// <para>Every other reader test in this file is a fixture someone wrote.
    /// This one is the client's own words, and it is the reason the readers are
    /// shaped the way they are: the body has NO <c>queueMap</c>, NO
    /// <c>division</c> and NO <c>isProvisional</c>, and it reports the unplayed
    /// flex queue as <c>tier: null</c> with <c>leaguePoints: 0</c> — a zero that
    /// a reader checking LP before tier would happily have recorded as a
    /// standing.</para>
    /// </summary>
    private const string CapturedRankedStatsBody = """
        {"queues":[
          {"queueType":"RANKED_SOLO_5x5","provisionalGameThreshold":5,"tier":"PLATINUM","rank":"IV",
           "leaguePoints":91,"cumulativeLp":1691,"wins":64,"losses":65,
           "provisionalGamesRemaining":0,"highestTier":"PLATINUM","highestRank":"II","ratedRating":0},
          {"queueType":"RANKED_FLEX_SR","provisionalGameThreshold":5,"tier":null,"rank":null,
           "leaguePoints":0,"cumulativeLp":0,"wins":0,"losses":0,"provisionalGamesRemaining":0}
        ]}
        """;

    [Fact]
    public void Reads_the_body_a_real_client_actually_returned()
    {
        var sample = RankedStats.ReadSoloQueue(MockLcuApi.Json(CapturedRankedStatsBody));

        Assert.NotNull(sample);
        Assert.Equal("PLATINUM", sample!.Tier);
        Assert.Equal("IV", sample.Division);
        Assert.Equal(91, sample.LeaguePoints);
        Assert.Equal(1691, sample.CumulativeLp);
    }

    [Theory]
    [InlineData("-1")]
    [InlineData("\"1691\"")]
    public void A_malformed_optional_cumulative_lp_keeps_the_fallback_sample(string cumulativeLp)
    {
        var sample = RankedStats.ReadSoloQueue(MockLcuApi.Json(
            $$$$"""{"queues":[{"queueType":"RANKED_SOLO_5x5","tier":"GOLD","rank":"I","leaguePoints":90,"cumulativeLp":{{{{cumulativeLp}}}}}]}"""));

        Assert.Equal(new RankSample("GOLD", "I", 90), sample);
        Assert.Null(sample?.CumulativeLp);
    }

    /// <summary>
    /// Placements have no ladder position, so there is nothing to difference.
    /// Skipping renders as <c>unavailable</c> (spec §6), which is honest;
    /// recording the provisional zero would render as a confident number.
    ///
    /// <para>Both spellings, because only the SECOND one exists in the captured
    /// body. The draft this file arrived in checked <c>isProvisional</c> alone,
    /// which is a guard that reads as covered and fires never.</para>
    /// </summary>
    [Theory]
    [InlineData("""{"queueMap":{"RANKED_SOLO_5x5":{"tier":"GOLD","division":"IV","leaguePoints":0,"isProvisional":true}}}""")]
    [InlineData("""{"queues":[{"queueType":"RANKED_SOLO_5x5","tier":"GOLD","rank":"IV","leaguePoints":0,"provisionalGamesRemaining":3}]}""")]
    public void A_placement_account_produces_no_sample(string body)
    {
        Assert.Null(RankedStats.ReadSoloQueue(MockLcuApi.Json(body)));
    }

    /// <summary>
    /// A settled account reports <c>provisionalGamesRemaining: 0</c>, which must
    /// NOT be read as "provisional". Getting this backwards would make the
    /// feature silently record nothing, forever, for everyone.
    /// </summary>
    [Fact]
    public void Zero_placement_games_remaining_is_a_settled_account()
    {
        var sample = RankedStats.ReadSoloQueue(MockLcuApi.Json(
            """{"queues":[{"queueType":"RANKED_SOLO_5x5","tier":"GOLD","rank":"IV","leaguePoints":42,"provisionalGamesRemaining":0}]}"""));

        Assert.Equal(42, sample?.LeaguePoints);
    }

    /// <summary>
    /// Spec §2: apex tiers have no divisions. Whatever the client puts in that
    /// slot — "NA", "I", nothing — the sample must not claim a division, because
    /// a literal "I" on a Master account silently shifts the ladder arithmetic
    /// by a division's worth of LP.
    /// </summary>
    [Theory]
    [InlineData("MASTER", "NA")]
    [InlineData("GRANDMASTER", "I")]
    [InlineData("CHALLENGER", null)]
    public void Apex_tiers_carry_no_division(string tier, string? division)
    {
        var divisionJson = division is null ? "" : $",\"division\":\"{division}\"";
        var sample = RankedStats.ReadSoloQueue(MockLcuApi.Json(
            $$$$"""{"queueMap":{"RANKED_SOLO_5x5":{"tier":"{{{{tier}}}}"{{{{divisionJson}}}},"leaguePoints":432}}}"""));

        Assert.NotNull(sample);
        Assert.Equal(tier, sample!.Tier);
        Assert.Null(sample.Division);
        Assert.Equal(432, sample.LeaguePoints);
    }

    /// <summary>
    /// ALL OR NOTHING. A defaulted field here is not a weaker answer, it is a
    /// wrong one: the consumer subtracts two samples, so a missing tier read as
    /// IRON prints a four-figure loss the player never took.
    /// </summary>
    [Theory]
    [InlineData("""{"queueMap":{"RANKED_SOLO_5x5":{"division":"I","leaguePoints":90}}}""")]
    [InlineData("""{"queueMap":{"RANKED_SOLO_5x5":{"tier":"GOLD","division":"I"}}}""")]
    [InlineData("""{"queueMap":{"RANKED_SOLO_5x5":{"tier":"GOLD","division":"I","leaguePoints":-4}}}""")]
    [InlineData("""{"queueMap":{"RANKED_SOLO_5x5":{"tier":"GOLD","division":"I","leaguePoints":"90"}}}""")]
    [InlineData("""{"queueMap":{"RANKED_SOLO_5x5":[]}}""")]
    [InlineData("""{"queueMap":[]}""")]
    [InlineData("""{"queues":"nope"}""")]
    [InlineData("""{}""")]
    [InlineData("""[]""")]
    // A JSON string SCALAR at the root. Escaped rather than raw on purpose: the
    // raw form `""""a string""""` yields the bare characters `a string`, which is
    // not JSON at all, so the fixture threw before the reader was ever called.
    [InlineData("\"a string\"")]
    public void A_partial_or_malformed_body_is_no_sample(string body)
    {
        Assert.Null(RankedStats.ReadSoloQueue(MockLcuApi.Json(body)));
    }

    [Fact]
    public void A_null_body_is_no_sample()
    {
        Assert.Null(RankedStats.ReadSoloQueue(null));
    }

    // ─────────────────────────────────────────────────────────────────────
    // What goes on the wire
    // ─────────────────────────────────────────────────────────────────────

    /// <summary>
    /// Spec §4 asks for a <c>puuid</c>. The companion has no puuid worth
    /// sending: the League client's is a local UUID, not the Riot puuid
    /// <c>my_matches</c> is keyed on (CLAUDE.md, My Stats invariant 1), which is
    /// exactly why <c>lib/mystats/accountRequest.ts</c>'s detect mode carries
    /// none either and re-resolves server-side. This test exists so that the
    /// LCU's puuid can never be quietly wired into that field to satisfy the
    /// spec's letter — the resulting rows would join to nothing, silently.
    /// </summary>
    [Fact]
    public void The_body_carries_the_identity_the_server_can_resolve_and_no_client_puuid()
    {
        // A REAL LCU puuid, lifted from this box's own client traces. Its shape
        // is the entire point of this test: 36 characters, dashed, and it
        // MATCHES lib/mystats/rankSample.ts's server-side guard
        // /^[A-Za-z0-9_-]{20,128}$/. So a desktop half that "just satisfied
        // spec §4" by sending it would be ACCEPTED — 200, {ok:true,
        // stored:true} — and would write a my_rank_samples time series keyed to
        // an identifier that joins to nothing in my_matches. Every session
        // would render `unavailable` forever while the table filled up and
        // pruned on schedule: a completely healthy-looking system producing
        // nothing at all.
        //
        // CLAUDE.md, My Stats invariant 1, states it flatly and says it was
        // learned the hard way: the LCU's puuid is a 36-char LOCAL uuid, not
        // Riot's 78-char encrypted one, and identity must be re-resolved from
        // gameName + tagLine. lib/mystats/accountRequest.ts's detect mode
        // already carries no puuid for exactly this reason.
        const string lcuLocalUuid = "07444e1e-7826-5d2a-ac6c-d4de0340a102";

        var body = RankSampleBody.Create(
            new OwnIdentity("Faker", "KR1", lcuLocalUuid),
            new RankSample("EMERALD", "III", 42),
            new DateTimeOffset(2026, 8, 21, 9, 30, 0, TimeSpan.Zero));

        var json = JsonSerializer.Serialize(body, JsonOptions.Wire);
        Assert.DoesNotContain("puuid", json, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain(lcuLocalUuid, json, StringComparison.Ordinal);

        using var document = JsonDocument.Parse(json);
        var root = document.RootElement;
        Assert.Equal("Faker", root.GetProperty("gameName").GetString());
        Assert.Equal("KR1", root.GetProperty("tagLine").GetString());
        Assert.Equal("EMERALD", root.GetProperty("tier").GetString());
        Assert.Equal("III", root.GetProperty("division").GetString());
        Assert.Equal(42, root.GetProperty("lp").GetInt32());
        Assert.False(root.TryGetProperty("cumulativeLp", out _));
        Assert.Equal("2026-08-21T09:30:00.0000000+00:00", root.GetProperty("observedAt").GetString());
    }

    [Fact]
    public void Riots_cumulative_lp_is_serialized_when_the_lcu_supplies_it()
    {
        var sample = Assert.IsType<RankSample>(RankedStats.ReadSoloQueue(MockLcuApi.Json(CapturedRankedStatsBody)));
        var body = RankSampleBody.Create(
            new OwnIdentity("Name", "TAG", "local-uuid"),
            sample,
            new DateTimeOffset(2026, 8, 21, 9, 30, 0, TimeSpan.Zero));

        using var document = JsonDocument.Parse(JsonSerializer.Serialize(body, JsonOptions.Wire));
        Assert.Equal(1691, document.RootElement.GetProperty("cumulativeLp").GetInt32());
    }

    /// <summary>
    /// Spec §3 fixes the <c>source</c> vocabulary at companion|cron|page, so all
    /// three desktop moments post <c>companion</c> and the moment survives only
    /// in the log. Pinned so nobody "improves" it into a value the column's
    /// check constraint would reject.
    /// </summary>
    [Theory]
    [InlineData(RankCaptureTrigger.AppStart)]
    [InlineData(RankCaptureTrigger.ChampSelect)]
    [InlineData(RankCaptureTrigger.GameEnd)]
    public async Task Every_desktop_sample_declares_source_companion(RankCaptureTrigger trigger)
    {
        var lcu = ScriptedLcu.Healthy();
        var sink = new RecordingSink();
        var service = NewService(lcu, sink);

        await service.CaptureAsync(trigger);

        Assert.Equal("companion", Assert.Single(sink.Bodies).Source);
    }

    /// <summary>The header name must equal ACCOUNT_SECRET_HEADER in lib/mystats/accountAuth.ts.</summary>
    [Fact]
    public void The_secret_travels_in_the_header_the_server_reads()
    {
        Assert.Equal("x-coachbuild-account-secret", RankSampleClient.SecretHeader);
        Assert.Equal("/api/mystats/rank-sample", RankSampleClient.SamplePath);
    }

    [Theory]
    [InlineData(HttpStatusCode.OK, """{"ok":true}""", RankSamplePostResult.Posted)]
    [InlineData(HttpStatusCode.OK, "", RankSamplePostResult.Posted)]
    // A 200 that says no is still a no. The status line is not the answer.
    [InlineData(HttpStatusCode.OK, """{"ok":false,"reason":"unauthorized"}""", RankSamplePostResult.Rejected)]
    [InlineData(HttpStatusCode.Unauthorized, """{"ok":false}""", RankSamplePostResult.Rejected)]
    [InlineData(HttpStatusCode.BadRequest, "", RankSamplePostResult.Rejected)]
    [InlineData(HttpStatusCode.InternalServerError, "", RankSamplePostResult.Failed)]
    [InlineData(HttpStatusCode.ServiceUnavailable, "", RankSamplePostResult.Failed)]
    public async Task The_client_classifies_every_answer_without_throwing(
        HttpStatusCode status, string body, RankSamplePostResult expected)
    {
        using var handler = new StubHandler(status, body);
        using var client = new RankSampleClient("https://coachbuild.vercel.app", handler);

        var result = await client.PostAsync(SampleBody(), "secret", CancellationToken.None);

        Assert.Equal(expected, result);
        Assert.Equal("secret", handler.LastSecretHeader);
        Assert.Equal("https://coachbuild.vercel.app/api/mystats/rank-sample", handler.LastUri?.ToString());
    }

    [Fact]
    public async Task A_transport_failure_is_a_return_value_not_an_exception()
    {
        using var handler = new StubHandler(new HttpRequestException("no route to host"));
        using var client = new RankSampleClient("https://coachbuild.vercel.app", handler);

        Assert.Equal(
            RankSamplePostResult.Failed,
            await client.PostAsync(SampleBody(), "secret", CancellationToken.None));
    }

    // ─────────────────────────────────────────────────────────────────────
    // The three moments (spec §5)
    // ─────────────────────────────────────────────────────────────────────

    [Fact]
    public async Task Champ_select_entry_takes_a_sample()
    {
        var lcu = ScriptedLcu.Healthy();
        lcu.Phases.Enqueue("None");
        lcu.Phases.Enqueue("ChampSelect");
        var sink = new RecordingSink();
        var service = NewService(lcu, sink);
        var poller = NewPoller(lcu, service);

        await poller.TickAsync();
        Assert.Empty(sink.Bodies);

        await poller.TickAsync();
        await Settle(service);

        var posted = Assert.Single(sink.Bodies);
        Assert.Equal("GOLD", posted.Tier);
        Assert.Equal(90, posted.Lp);
    }

    [Fact]
    public async Task A_game_ending_takes_a_sample()
    {
        var lcu = ScriptedLcu.Healthy();
        lcu.Phases.Enqueue("InProgress");
        lcu.Phases.Enqueue("WaitingForStats");
        var sink = new RecordingSink();
        var service = NewService(lcu, sink);
        var poller = NewPoller(lcu, service);

        await poller.TickAsync();
        Assert.Empty(sink.Bodies);

        await poller.TickAsync();
        await Settle(service);

        Assert.Single(sink.Bodies);
    }

    /// <summary>
    /// A dropped connection walks InProgress -> Reconnect -> InProgress. Reading
    /// that as a game ending would post a mid-game sample AND leave the real
    /// game end unsampled, because by then the phase has already moved.
    /// </summary>
    [Fact]
    public async Task A_reconnect_is_not_a_game_ending()
    {
        var lcu = ScriptedLcu.Healthy();
        foreach (var phase in new[] { "InProgress", "Reconnect", "InProgress", "EndOfGame" })
            lcu.Phases.Enqueue(phase);
        var sink = new RecordingSink();
        var service = NewService(lcu, sink);
        var poller = NewPoller(lcu, service);

        for (var tick = 0; tick < 3; tick++)
        {
            await poller.TickAsync();
            await Settle(service);
            Assert.Empty(sink.Bodies);
        }

        await poller.TickAsync();
        await Settle(service);
        Assert.Single(sink.Bodies);
    }

    /// <summary>
    /// Champ select ticks every 350 ms in production. Sampling per tick would
    /// be ~85 LCU reads and ~85 rows per draft.
    /// </summary>
    [Fact]
    public async Task Staying_in_champ_select_samples_exactly_once()
    {
        var lcu = ScriptedLcu.Healthy();
        for (var tick = 0; tick < 12; tick++) lcu.Phases.Enqueue("ChampSelect");
        var sink = new RecordingSink();
        var service = NewService(lcu, sink);
        var poller = NewPoller(lcu, service);

        for (var tick = 0; tick < 12; tick++)
        {
            await poller.TickAsync();
            await Settle(service);
        }

        Assert.Single(sink.Bodies);
    }

    // ─────────────────────────────────────────────────────────────────────
    // The rule: capture can never cost an apply
    // ─────────────────────────────────────────────────────────────────────

    /// <summary>
    /// The reason this feature is allowed to exist at all. A ranked read that
    /// never answers must be invisible to an item-set write happening at the
    /// same moment — no shared lock, no shared queue, no shared connection
    /// budget. The capture here is left hanging deliberately and is never
    /// awaited; the apply is asserted to complete on its own.
    /// </summary>
    [Fact]
    public async Task A_hung_ranked_read_cannot_delay_an_item_set_apply()
    {
        var lcu = ScriptedLcu.Healthy();
        lcu.HangRankedStats = true;
        var sink = new RecordingSink();
        var service = NewService(lcu, sink);

        service.Fire(RankCaptureTrigger.GameEnd);
        await lcu.RankedStatsEntered.Task.WaitAsync(TimeSpan.FromSeconds(5));

        var itemSets = new ItemSetApplyService(lcu);
        var apply = itemSets.ApplyAsync(new ApplyItemSetsRequest(
            103,
            [MockLcuApi.Json("""{"title":"CoachBuild Ahri Mid","uid":"coachbuild-ahri-mid","blocks":[]}""")]));

        var result = await apply.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.IsType<ApplyItemSetsSuccess>(result);

        // The capture is still stuck where we left it, which is the point: it
        // got no further and cost the apply nothing.
        Assert.False(service.PendingCapture!.IsCompleted);
        lcu.ReleaseRankedStats();
    }

    /// <summary>
    /// Every dependency in the capture path, made hostile one at a time. None
    /// of them may produce a throw the caller can see — the gameflow loop
    /// invokes this from inside the tick that drives champ select.
    /// </summary>
    [Theory]
    [InlineData("lcu-throws")]
    [InlineData("sink-throws")]
    [InlineData("secret-throws")]
    [InlineData("garbage-body")]
    [InlineData("lcu-dead")]
    [InlineData("no-identity")]
    public async Task Nothing_in_the_capture_path_can_throw(string hostility)
    {
        var lcu = ScriptedLcu.Healthy();
        var sink = new RecordingSink();
        Func<string?> secret = () => "secret";

        switch (hostility)
        {
            case "lcu-throws": lcu.Throw = true; break;
            case "sink-throws": sink.Throw = true; break;
            case "secret-throws": secret = () => throw new InvalidOperationException("settings on fire"); break;
            case "garbage-body": lcu.RankedStatsBody = """{"queueMap":"not an object"}"""; break;
            case "lcu-dead": lcu.Dead = true; break;
            case "no-identity": lcu.SummonerBody = """{"gameName":"","tagLine":null}"""; break;
        }

        var service = new RankCaptureService(lcu, sink, secret, RedactedLog.Discarding, options: NoSettle);

        // The assertion IS that these return. An escaping exception fails the
        // test by escaping.
        await service.CaptureAsync(RankCaptureTrigger.AppStart);
        await service.CaptureAsync(RankCaptureTrigger.ChampSelect);
        await service.CaptureAsync(RankCaptureTrigger.GameEnd);
    }

    /// <summary>
    /// No secret means INERT, never unauthenticated. Same fail-closed rule the
    /// server half states in lib/mystats/accountAuth.ts, and the same posture
    /// components/live/mystatsAccount.ts already takes in the browser.
    /// </summary>
    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    public async Task Without_a_secret_nothing_is_posted_and_nothing_is_read(string? secret)
    {
        var lcu = ScriptedLcu.Healthy();
        var sink = new RecordingSink();
        var service = new RankCaptureService(lcu, sink, () => secret, RedactedLog.Discarding, options: NoSettle);

        await service.CaptureAsync(RankCaptureTrigger.ChampSelect);

        Assert.Empty(sink.Bodies);
        Assert.Equal(0, lcu.RankedStatsReads);
    }

    /// <summary>The secret must never be able to reach the file the user sends us.</summary>
    [Fact]
    public async Task The_secret_never_reaches_the_log()
    {
        var directory = Path.Combine(Path.GetTempPath(), $"coachbuild-rank-log-{Guid.NewGuid():N}");
        try
        {
            var log = new RedactedLog(directory);
            var service = new RankCaptureService(
                ScriptedLcu.Healthy(), new RecordingSink(), () => "super-secret-value", log, options: NoSettle);

            await service.CaptureAsync(RankCaptureTrigger.ChampSelect);

            var written = File.Exists(log.FilePath) ? File.ReadAllText(log.FilePath) : string.Empty;
            Assert.DoesNotContain("super-secret-value", written, StringComparison.Ordinal);
            Assert.Contains("rank-sample: champ-select GOLD I 90lp", written, StringComparison.Ordinal);
        }
        finally
        {
            try { Directory.Delete(directory, recursive: true); } catch { }
        }
    }

    // ─────────────────────────────────────────────────────────────────────
    // The game-end settle loop
    // ─────────────────────────────────────────────────────────────────────

    [Fact]
    public void Account_secret_redaction_uses_the_shared_compliance_policy()
    {
        const string secret = "fixture-shared-secret";

        var redacted = ComplianceRules.Redact(
            $"rank-sample: header x-coachbuild-account-secret={secret}",
            secrets: [secret]);

        Assert.DoesNotContain(secret, redacted, StringComparison.Ordinal);
        Assert.Equal(
            "rank-sample: header x-coachbuild-account-secret=[redacted]",
            redacted);
    }

    /// <summary>
    /// Leaving InProgress is the client noticing the game is over, not the
    /// platform having scored it. Posting the pre-game number there would make
    /// the last game of every session disappear from the total while spec §6
    /// still called the bracket <c>exact</c>.
    /// </summary>
    [Fact]
    public async Task Game_end_waits_for_the_lp_to_move_before_posting()
    {
        var lcu = ScriptedLcu.Healthy();
        var sink = new RecordingSink();
        var delays = 0;
        var service = new RankCaptureService(
            lcu, sink, () => "secret", RedactedLog.Discarding,
            options: new RankCaptureOptions(GameEndSettleAttempts: 4),
            delay: (_, _) => { delays++; return Task.CompletedTask; });

        // Champ select establishes the pre-game standing.
        await service.CaptureAsync(RankCaptureTrigger.ChampSelect);
        Assert.Equal(90, Assert.Single(sink.Bodies).Lp);

        // The client keeps reporting the old number for two reads, then settles.
        lcu.RankedStatsSequence.Enqueue(Solo("GOLD", "I", 90));
        lcu.RankedStatsSequence.Enqueue(Solo("GOLD", "I", 90));
        lcu.RankedStatsSequence.Enqueue(Solo("PLATINUM", "IV", 12));

        await service.CaptureAsync(RankCaptureTrigger.GameEnd);

        Assert.Equal(2, sink.Bodies.Count);
        Assert.Equal("PLATINUM", sink.Bodies[1].Tier);
        Assert.Equal(12, sink.Bodies[1].Lp);
        Assert.Equal(2, delays);
    }

    /// <summary>
    /// A dodge, a remake and an already-settled read all leave LP untouched.
    /// Refusing to record those would delete the bracket edge for exactly the
    /// games the user is most likely to ask about.
    /// </summary>
    [Fact]
    public async Task Game_end_posts_an_unchanged_reading_once_the_budget_is_spent()
    {
        var lcu = ScriptedLcu.Healthy();
        var sink = new RecordingSink();
        var service = new RankCaptureService(
            lcu, sink, () => "secret", RedactedLog.Discarding,
            options: new RankCaptureOptions(GameEndSettleAttempts: 3),
            delay: (_, _) => Task.CompletedTask);

        await service.CaptureAsync(RankCaptureTrigger.ChampSelect);
        await service.CaptureAsync(RankCaptureTrigger.GameEnd);

        Assert.Equal(2, sink.Bodies.Count);
        Assert.Equal(90, sink.Bodies[1].Lp);
        // One read for champ select, then 1 + 3 attempts for the settle loop.
        Assert.Equal(5, lcu.RankedStatsReads);
    }

    /// <summary>An unranked account is not an unsettled one, so it must not spin.</summary>
    [Fact]
    public async Task Game_end_does_not_spin_on_an_account_with_no_standing()
    {
        var lcu = ScriptedLcu.Healthy();
        lcu.RankedStatsBody = """{"queueMap":{"RANKED_SOLO_5x5":{"tier":"NONE","division":"NA","leaguePoints":0}}}""";
        var sink = new RecordingSink();
        var delays = 0;
        var service = new RankCaptureService(
            lcu, sink, () => "secret", RedactedLog.Discarding,
            options: new RankCaptureOptions(GameEndSettleAttempts: 6),
            delay: (_, _) => { delays++; return Task.CompletedTask; });

        await service.CaptureAsync(RankCaptureTrigger.GameEnd);

        Assert.Empty(sink.Bodies);
        Assert.Equal(1, lcu.RankedStatsReads);
        Assert.Equal(0, delays);
    }

    /// <summary>The worst case has to be a number someone can read, not an emergent one.</summary>
    [Fact]
    public void The_settle_window_is_bounded_and_says_so()
    {
        Assert.Equal(TimeSpan.FromSeconds(30), new RankCaptureOptions().MaximumSettleWindow);
        Assert.Equal(TimeSpan.Zero, new RankCaptureOptions(GameEndSettleAttempts: 0).MaximumSettleWindow);
    }

    // ─────────────────────────────────────────────────────────────────────
    // Fixtures
    // ─────────────────────────────────────────────────────────────────────

    private static readonly RankCaptureOptions NoSettle = new(GameEndSettleAttempts: 0);

    private static RankCaptureService NewService(ScriptedLcu lcu, RecordingSink sink) =>
        new(lcu, sink, () => "secret", RedactedLog.Discarding, options: NoSettle);

    private static GameflowPoller NewPoller(ScriptedLcu lcu, RankCaptureService service) =>
        // A lambda, not the `service.Fire` method group: Fire's second parameter
        // is optional, and C# will not bind a method group with an optional
        // parameter to Action<T>. Production wires it the same way.
        new(Resolver(), lcu, new CompanionState(), rankCapture: trigger => service.Fire(trigger));

    private static async Task Settle(RankCaptureService service)
    {
        if (service.PendingCapture is { } pending) await pending.WaitAsync(TimeSpan.FromSeconds(5));
    }

    private static RankSampleBody SampleBody() => RankSampleBody.Create(
        new OwnIdentity("Name", "TAG", "local-uuid"),
        new RankSample("GOLD", "I", 90),
        DateTimeOffset.UnixEpoch);

    /// <summary>
    /// <c>leaguePoints</c> is deliberately NOT the last key. As the last key its
    /// interpolation hole butts straight up against the three closing braces of
    /// the JSON, and no raw-string dollar count disambiguates that run — which is
    /// exactly how this file arrived not compiling (CS9007). Key order is
    /// meaningless to a JSON reader; the brace run is not.
    /// </summary>
    private static string Solo(string tier, string division, int lp) =>
        $$$$"""{"queueMap":{"RANKED_SOLO_5x5":{"queueType":"RANKED_SOLO_5x5","leaguePoints":{{{{lp}}}},"tier":"{{{{tier}}}}","division":"{{{{division}}}}"}}}""";

    private static LcuCredentialResolver Resolver() => new(
        new FixedRankProcessSource(),
        _ => null,
        Path.Combine(Path.GetTempPath(), $"coachbuild-missing-{Guid.NewGuid():N}"));

    private sealed class FixedRankProcessSource : ILeagueClientProcessSource
    {
        public IEnumerable<LeagueClientProcess> GetProcesses() =>
            [new LeagueClientProcess("LeagueClientUx.exe", "--app-port=51234 --remoting-auth-token=test")];
    }

    /// <summary>
    /// An <see cref="ILcuApi"/> that can be made hostile in each of the ways a
    /// real client can be: dead, slow, lying, or absent.
    /// </summary>
    private sealed class ScriptedLcu : ILcuApi
    {
        private readonly TaskCompletionSource _rankedRelease =
            new(TaskCreationOptions.RunContinuationsAsynchronously);

        public Queue<string> Phases { get; } = new();
        public Queue<string> RankedStatsSequence { get; } = new();
        public string RankedStatsBody { get; set; } =
            """{"queueMap":{"RANKED_SOLO_5x5":{"queueType":"RANKED_SOLO_5x5","tier":"GOLD","division":"I","leaguePoints":90}}}""";
        public string SummonerBody { get; set; } =
            """{"summonerId":7,"gameName":"Name","tagLine":"TAG","puuid":"local-uuid"}""";
        public bool Throw { get; set; }
        public bool Dead { get; set; }
        public bool HangRankedStats { get; set; }
        public int RankedStatsReads { get; private set; }
        public TaskCompletionSource RankedStatsEntered { get; } =
            new(TaskCreationOptions.RunContinuationsAsynchronously);

        public static ScriptedLcu Healthy() => new();

        public void ReleaseRankedStats() => _rankedRelease.TrySetResult();

        public async Task<LcuResponse> SendAsync(
            HttpMethod method, string path, object? body = null, CancellationToken cancellationToken = default)
        {
            if (Throw) throw new InvalidOperationException("the client exploded");
            if (Dead) return new LcuResponse(false, 0);

            if (path == RankedStats.CurrentRankedStatsPath)
            {
                RankedStatsReads++;
                RankedStatsEntered.TrySetResult();
                if (HangRankedStats) await _rankedRelease.Task.ConfigureAwait(false);
                var raw = RankedStatsSequence.Count > 0 ? RankedStatsSequence.Dequeue() : RankedStatsBody;
                return Ok(raw);
            }

            if (path == "/lol-summoner/v1/current-summoner") return Ok(SummonerBody);
            if (path == "/lol-gameflow/v1/gameflow-phase")
                return Ok(JsonSerializer.Serialize(Phases.Count > 0 ? Phases.Dequeue() : "None"));
            if (path == "/lol-champ-select/v1/session")
                return Ok("""{"localPlayerCellId":10,"myTeam":[],"theirTeam":[],"actions":[]}""");
            if (path.StartsWith("/lol-item-sets/v1/item-sets/", StringComparison.Ordinal))
                return method == HttpMethod.Put
                    ? Ok("{}")
                    : Ok("""{"accountId":1,"timestamp":1,"itemSets":[]}""");

            return new LcuResponse(false, 404);
        }

        private static LcuResponse Ok(string raw) => new(true, 200, MockLcuApi.Json(raw), raw);
    }

    private sealed class RecordingSink : IRankSampleSink
    {
        public List<RankSampleBody> Bodies { get; } = [];
        public bool Throw { get; set; }
        public RankSamplePostResult Result { get; set; } = RankSamplePostResult.Posted;

        public Task<RankSamplePostResult> PostAsync(
            RankSampleBody body, string secret, CancellationToken cancellationToken)
        {
            if (Throw) throw new InvalidOperationException("the sink exploded");
            Bodies.Add(body);
            return Task.FromResult(Result);
        }
    }

    private sealed class StubHandler : HttpMessageHandler
    {
        private readonly HttpStatusCode _status;
        private readonly string _body;
        private readonly Exception? _failure;

        public StubHandler(HttpStatusCode status, string body)
        {
            _status = status;
            _body = body;
        }

        public StubHandler(Exception failure)
        {
            _failure = failure;
            _body = string.Empty;
        }

        public string? LastSecretHeader { get; private set; }
        public Uri? LastUri { get; private set; }

        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request, CancellationToken cancellationToken)
        {
            LastUri = request.RequestUri;
            LastSecretHeader = request.Headers.TryGetValues(RankSampleClient.SecretHeader, out var values)
                ? string.Join(",", values)
                : null;
            if (_failure is not null) throw _failure;
            return Task.FromResult(new HttpResponseMessage(_status)
            {
                Content = new StringContent(_body, Encoding.UTF8, "application/json"),
            });
        }
    }
}
