using System.Text.Json;
using CoachBuild.Core;
using Xunit;

namespace CoachBuild.Core.Tests;

/// <summary>
/// The situational deltas are DECORATION on a write that changes the player's
/// League config. Every test here exists to prove that the decoration can never
/// cost them their item set.
/// </summary>
public sealed class SituationalApplyPathTests
{
    private const string GoodSituational = """
    [ {"id":3158,"wpa":4.27,"text":"+4.27"}, {"id":3068,"wpa":-0.06,"text":"-0.06"} ]
    """;

    [Fact]
    public void An_older_web_build_omits_the_field_and_still_deserializes()
    {
        // The 0.113.x body, byte for byte. The new optional member must not
        // make an old client's request unreadable.
        var request = JsonSerializer.Deserialize<ApplyItemSetsRequest>("""
        {"championId":3,"sets":[{"title":"CoachBuild Galio Mid","blocks":[]}],"replacePrefix":"CoachBuild"}
        """, JsonOptions.Wire);

        Assert.NotNull(request);
        Assert.Equal(3, request!.ChampionId);
        Assert.Single(request.Sets!);
        Assert.Null(request.Situational);
    }

    [Fact]
    public void A_future_web_build_can_add_members_without_breaking_this_one()
    {
        // The other direction of the same contract: UnmappedMemberHandling is
        // left at its default of Skip on purpose.
        var request = JsonSerializer.Deserialize<ApplyItemSetsRequest>("""
        {"championId":3,"sets":[{"title":"CoachBuild Galio Mid","blocks":[]}],
         "situational":[{"id":3158,"wpa":4.27,"text":"+4.27"}],
         "somethingTheDesktopHasNeverHeardOf":{"nested":[1,2,3]}}
        """, JsonOptions.Wire);

        Assert.NotNull(request);
        Assert.Equal(JsonValueKind.Array, request!.Situational!.Value.ValueKind);
    }

    [Theory]
    [InlineData("""{"championId":3,"sets":[{"title":"CoachBuild X","blocks":[]}],"situational":"nonsense"}""")]
    [InlineData("""{"championId":3,"sets":[{"title":"CoachBuild X","blocks":[]}],"situational":[{"id":null}]}""")]
    [InlineData("""{"championId":3,"sets":[{"title":"CoachBuild X","blocks":[]}],"situational":[{"id":3158,"wpa":null,"text":null}]}""")]
    [InlineData("""{"championId":3,"sets":[{"title":"CoachBuild X","blocks":[]}],"situational":42}""")]
    public void A_malformed_situational_field_never_costs_the_caller_their_request(string body)
    {
        // The field is a raw JsonElement precisely so this cannot happen. A
        // typed list throws inside Deserialize on the first malformed member,
        // which turns the WHOLE request into null and fails an item-set write
        // over a decoration.
        var request = JsonSerializer.Deserialize<ApplyItemSetsRequest>(body, JsonOptions.Wire);

        Assert.NotNull(request);
        Assert.Equal(3, request!.ChampionId);
        Assert.Single(request.Sets!);
        Assert.True(ApplyPayloadValidation.TryValidateItemSets(request, out _));
    }

    [Fact]
    public async Task A_successful_write_files_the_numbers_away_for_the_overlay()
    {
        var state = Connected();
        var api = SuccessfulLcu();

        var result = await new ItemSetApplyService(api, state).ApplyAsync(Request(3, GoodSituational));

        Assert.IsType<ApplyItemSetsSuccess>(result);
        Assert.NotNull(state.Situational);
        Assert.Equal(3, state.Situational!.ChampionId);
        Assert.Equal(2, state.Situational.Deltas.Count);
        Assert.Equal("+4.27", state.Situational.Deltas[0].Text);
    }

    [Fact]
    public async Task A_malformed_field_costs_the_numbers_and_nothing_else()
    {
        var state = Connected();
        var api = SuccessfulLcu();

        var result = await new ItemSetApplyService(api, state).ApplyAsync(
            Request(3, """[ {"id":"not a number"}, "garbage", {"id":3158} ]"""));

        // The write still succeeded and the PUT still went out.
        Assert.IsType<ApplyItemSetsSuccess>(result);
        Assert.Contains(api.Calls, call => call.Method == HttpMethod.Put);
        Assert.Null(state.Situational);
    }

    [Fact]
    public async Task A_failed_write_records_nothing()
    {
        // The order matters: RecordSituational runs AFTER the PUT succeeds, so
        // a set that never reached League cannot leave numbers behind that
        // claim it did.
        var state = Connected();
        var api = new MockLcuApi();
        api.Enqueue(HttpMethod.Get, "/lol-summoner/v1/current-summoner",
            new LcuResponse(true, 200, MockLcuApi.Json("{\"summonerId\":77}")));
        api.Enqueue(HttpMethod.Get, "/lol-item-sets/v1/item-sets/77/sets",
            new LcuResponse(true, 200, MockLcuApi.Json("{\"accountId\":77,\"itemSets\":[]}")));
        api.Enqueue(HttpMethod.Put, "/lol-item-sets/v1/item-sets/77/sets",
            new LcuResponse(false, 500, null));

        var result = await new ItemSetApplyService(api, state).ApplyAsync(Request(3, GoodSituational));

        Assert.IsType<ApplyItemSetsFailure>(result);
        Assert.Null(state.Situational);
    }

    [Fact]
    public async Task A_second_write_for_a_different_champion_replaces_the_first()
    {
        var state = Connected();

        await new ItemSetApplyService(SuccessfulLcu(), state).ApplyAsync(Request(3, GoodSituational));
        Assert.Equal(3, state.Situational!.ChampionId);

        // Galio's numbers must not survive into Lee Sin's game.
        await new ItemSetApplyService(SuccessfulLcu(), state).ApplyAsync(Request(64, null));

        Assert.Null(state.Situational);
    }

    /// <summary>
    /// The set as the web actually writes it, with a real <c>Situational</c>
    /// block. Round 4 exists partly because every fixture in this file wrote
    /// <c>"blocks":[]</c>, so the cross-check the apply path now runs would
    /// have been permanently unreachable from the suite while every test stayed
    /// green.
    /// </summary>
    private const string RealSet = """
    {"title":"CoachBuild Galio Mid","blocks":[
      {"type":"Starting","items":[{"id":"1056","count":1}]},
      {"type":"WPA build","items":[{"id":"2503","count":1}]},
      {"type":"Situational","items":[{"id":"3158","count":1},{"id":"3068","count":1}]}]}
    """;

    private const string WrongRow = """
    [ {"id":6653,"wpa":4.27,"text":"+4.27"}, {"id":3068,"wpa":-0.06,"text":"-0.06"} ]
    """;

    /// <summary>
    /// The RealSet's two items, one of them carrying a null wpa.
    /// <c>JSON.stringify(NaN)</c> emits <c>null</c>, so this is the shape a
    /// single NaN in a freshly-baked artifact arrives as.
    /// </summary>
    private const string OneBadEntry = """
    [ {"id":3158,"wpa":4.27,"text":"+4.27"}, {"id":3068,"wpa":null,"text":"-0.06"} ]
    """;

    [Fact]
    public async Task The_numbers_are_cross_checked_against_the_block_that_was_written()
    {
        var state = Connected();

        var result = await new ItemSetApplyService(SuccessfulLcu(), state)
            .ApplyAsync(RealRequest(3, RealSet, GoodSituational));

        Assert.IsType<ApplyItemSetsSuccess>(result);
        Assert.Equal(2, state.Situational!.Deltas.Count);
        // ...and the set they belong to travels WITH them, block position and
        // all, because that is the only thing the app can honestly say about a
        // shop dropdown it cannot see.
        Assert.Contains("CoachBuild Galio Mid", state.Situational.SetLabel, StringComparison.Ordinal);
        Assert.Contains("block 3 of 3", state.Situational.SetLabel, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Numbers_that_describe_a_DIFFERENT_row_are_dropped_whole()
    {
        // Six green pills over six icons look correct whichever items they are.
        // A row of numbers that does not describe the row of icons under it is
        // not a degraded feature -- it is a confident claim about the wrong
        // items, and it is indistinguishable from a right one on screen.
        var state = Connected();

        var result = await new ItemSetApplyService(SuccessfulLcu(), state)
            .ApplyAsync(RealRequest(3, RealSet, WrongRow));

        // The WRITE is untouched. The decoration can never cost the player
        // their item set -- that is this file's whole subject.
        Assert.IsType<ApplyItemSetsSuccess>(result);
        Assert.Null(state.Situational);
    }

    [Fact]
    public async Task One_rejected_entry_costs_that_number_and_never_the_whole_row()
    {
        // The apply-path half of the B2 regression. The cross-check compared a
        // PRE-rejection block against a POST-rejection row, so one null wpa in
        // the artifact took every number off the screen for that champion and
        // said "every number was rejected" while the log line above it named
        // exactly one. A cold rebuild is producing new artifacts right now;
        // this is the path that would have gone dark.
        var root = Path.Combine(Path.GetTempPath(), $"cb-log-{Guid.NewGuid():N}");
        try
        {
            var log = new RedactedLog(root);
            var state = Connected();

            var result = await new ItemSetApplyService(SuccessfulLcu(), state, log)
                .ApplyAsync(RealRequest(3, RealSet, OneBadEntry));

            Assert.IsType<ApplyItemSetsSuccess>(result);
            Assert.Equal(3158, Assert.Single(state.Situational!.Deltas).ItemId);

            var text = File.ReadAllText(log.FilePath);
            Assert.Contains("situational: 1 delta(s) for champion 3", text, StringComparison.Ordinal);
            Assert.DoesNotContain("every number was rejected", text, StringComparison.Ordinal);
            Assert.DoesNotContain("do not describe", text, StringComparison.Ordinal);

            // ...and the log SAYS the cross-check did not run, rather than
            // claiming a one-per-icon fit it no longer verified. A row short of
            // its block is drawn from slot 1 outwards, so anything after the
            // dropped entry sits an icon early.
            Assert.Contains("NOT cross-checked", text, StringComparison.Ordinal);
        }
        finally
        {
            try { Directory.Delete(root, recursive: true); } catch { }
        }
    }

    [Fact]
    public async Task A_payload_with_no_situational_block_still_draws_its_numbers()
    {
        // NEGATIVE CONTROL, and the one that stops the cross-check from being a
        // new way to silently delete the feature. An older web build, or any
        // future change to the block name, must cost the numbers their
        // CROSS-CHECK and never the numbers.
        var state = Connected();

        var result = await new ItemSetApplyService(SuccessfulLcu(), state).ApplyAsync(
            RealRequest(3, """{"title":"CoachBuild Galio Mid","blocks":[]}""", GoodSituational));

        Assert.IsType<ApplyItemSetsSuccess>(result);
        Assert.Equal(2, state.Situational!.Deltas.Count);
        Assert.Equal(string.Empty, state.Situational.SetLabel);
    }

    [Fact]
    public async Task The_log_names_the_set_and_the_block_position_it_aimed_at()
    {
        // Defect D and E share one line. The block ORDINAL is in it because the
        // shop stacks blocks vertically: "block 3 of 3" and "block 5 of 5" put
        // the same row a block-pitch apart under one saved calibration, which
        // is exactly what the 2026-08-20 pair of screenshots showed.
        var root = Path.Combine(Path.GetTempPath(), $"cb-log-{Guid.NewGuid():N}");
        try
        {
            var log = new RedactedLog(root);
            await new ItemSetApplyService(SuccessfulLcu(), Connected(), log)
                .ApplyAsync(RealRequest(3, RealSet, GoodSituational));

            var text = File.ReadAllText(log.FilePath);
            Assert.Contains("situational: 2 delta(s) for champion 3", text, StringComparison.Ordinal);
            Assert.Contains("they line up ONLY with shop set", text, StringComparison.Ordinal);
            Assert.Contains("CoachBuild Galio Mid", text, StringComparison.Ordinal);
            Assert.Contains("Situational is block 3 of 3", text, StringComparison.Ordinal);
        }
        finally
        {
            try { Directory.Delete(root, recursive: true); } catch { }
        }
    }

    [Fact]
    public async Task A_row_that_was_REJECTED_never_reports_itself_as_never_supplied()
    {
        // The summary line is the line people read, and it used to contradict
        // the rejection line directly above it: a payload that supplied plenty
        // and had every entry thrown away logged "none supplied", which reads
        // as "the web sent nothing" and sends the next diagnostic round at the
        // wrong side of the wire.
        var root = Path.Combine(Path.GetTempPath(), $"cb-log-{Guid.NewGuid():N}");
        try
        {
            var log = new RedactedLog(root);
            await new ItemSetApplyService(SuccessfulLcu(), Connected(), log)
                .ApplyAsync(RealRequest(3, RealSet, WrongRow));

            var text = File.ReadAllText(log.FilePath);
            Assert.Contains("every number was rejected for champion 3", text, StringComparison.Ordinal);
            Assert.DoesNotContain("none supplied", text, StringComparison.Ordinal);
            Assert.Contains("position 1", text, StringComparison.Ordinal);
        }
        finally
        {
            try { Directory.Delete(root, recursive: true); } catch { }
        }
    }

    [Fact]
    public async Task A_payload_that_really_supplied_nothing_still_says_so()
    {
        // The other half of the pair. Two different silences with two different
        // answers: nothing arrived, versus everything arrived and was refused.
        var root = Path.Combine(Path.GetTempPath(), $"cb-log-{Guid.NewGuid():N}");
        try
        {
            var log = new RedactedLog(root);
            await new ItemSetApplyService(SuccessfulLcu(), Connected(), log)
                .ApplyAsync(RealRequest(3, RealSet, null));

            var text = File.ReadAllText(log.FilePath);
            Assert.Contains("none supplied for champion 3", text, StringComparison.Ordinal);
            Assert.DoesNotContain("every number was rejected", text, StringComparison.Ordinal);
        }
        finally
        {
            try { Directory.Delete(root, recursive: true); } catch { }
        }
    }

    private static ApplyItemSetsRequest RealRequest(int championId, string set, string? situational)
    {
        return new ApplyItemSetsRequest(
            championId,
            [JsonDocument.Parse(set).RootElement.Clone()],
            null,
            situational is null ? null : JsonDocument.Parse(situational).RootElement.Clone());
    }

    private static ApplyItemSetsRequest Request(int championId, string? situational)
    {
        var set = JsonDocument.Parse("{\"title\":\"CoachBuild Set\",\"blocks\":[]}").RootElement.Clone();
        return new ApplyItemSetsRequest(
            championId,
            [set],
            null,
            situational is null ? null : JsonDocument.Parse(situational).RootElement.Clone());
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
