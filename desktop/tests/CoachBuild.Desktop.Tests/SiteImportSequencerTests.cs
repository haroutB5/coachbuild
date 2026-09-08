using System.Text.Json;
using CoachBuild.Desktop.Web;
using Xunit;

namespace CoachBuild.Desktop.Tests;

/// <summary>
/// The Coachless select-and-recompute walk, driven entirely by scripted fake
/// step responses: no browser, no clock. The static fixture cannot exercise
/// the recompute (it holds no selected state), so THESE tests are the
/// contract — the orchestrator live-verifies the JS against the real site.
/// </summary>
public sealed class SiteImportSequencerTests
{
    private static readonly string[] WalkSlots =
    [
        "Keystone", "Starter", "1st Item", "2nd Item",
        "Spell", "Boots", "3rd Item", "4th+ Item",
    ];

    /// <summary>
    /// The walk's click set: item slots only, starting at 1st Item, in DOM
    /// order. Keystone, Starter and Spell are never clicked (the keystone
    /// conditioning flipped the build to Hubris — live-verified 2026-09-08);
    /// Starter's conditioned top row is read, never clicked.
    /// </summary>
    private static readonly string[] ClickableSlots =
    [
        "1st Item", "2nd Item", "Boots", "3rd Item", "4th+ Item",
    ];

    private static readonly string[] ReadOnlyTail =
    [
        "Spell", "Boots", "3rd Item", "4th+ Item",
    ];

    private static CoachlessSlotState Slot(
        string title,
        bool topSelected = false,
        bool topSelectable = true,
        bool hasActive = false,
        int rows = 4) =>
        new(title, topSelected, rows, topSelectable, hasActive);

    private static CoachlessStepResponse StateResponse(
        IEnumerable<CoachlessSlotState> slots, string hash) =>
        new("state", null, true, hash, slots.ToList(), null, null);

    private static CoachlessStepResponse DiscoverResponse(string hash = "h0") =>
        StateResponse(WalkSlots.Select(title => Slot(title)), hash);

    /// <summary>The live Jhin ADC shape: only the first four slots grant selections.</summary>
    private static CoachlessStepResponse JhinDiscoverResponse(string hash = "h0") =>
        StateResponse(
            WalkSlots.Select(title => Slot(
                title, topSelectable: !ReadOnlyTail.Contains(title))),
            hash);

    private static CoachlessStepResponse ClickedResponse(string slot) =>
        new("clicked", slot, false, null, [], null, null);

    private static CoachlessStepResponse AlreadySelectedResponse(string slot) =>
        new("already-selected", slot, true, null, [], null, null);

    private static CoachlessStepResponse ReadOnlyResponse(string slot) =>
        new("read-only", slot, true, null, [], null, null);

    private static CoachlessStepResponse PollResponse(string hash, string? activeSlot = null) =>
        StateResponse(
            WalkSlots.Select(title => Slot(
                title, topSelected: title == activeSlot, hasActive: title == activeSlot)),
            hash);

    private static CoachlessStepResponse DoneResponse(string? payloadJson = """{"source":"coachless"}""") =>
        new("done", null, true, null, [], payloadJson, null);

    private static CoachlessStepResponse ErrorResponse(string error) =>
        new(null, null, false, null, [], null, error);

    /// <summary>Runs one full walk turn: assert the command, feed the scripted reply.</summary>
    private static SequencerState Turn(
        SequencerState state, SequencerCommand expected, CoachlessStepResponse reply)
    {
        Assert.Equal(expected, SiteImportSequencer.CommandFor(state));
        return SiteImportSequencer.Transition(state, reply);
    }

    /// <summary>
    /// Drives a walk already past its clicks to the terminal succeed: every
    /// remaining click answers already-selected (no polls), then the final
    /// read returns <paramref name="payloadJson"/>.
    /// </summary>
    private static SucceedCommand FinishWalk(
        SequencerState state, string payloadJson = """{"source":"coachless"}""")
    {
        var guard = 0;
        while (SiteImportSequencer.CommandFor(state) is ClickSlotCommand click && guard++ < 50)
            state = SiteImportSequencer.Transition(state, AlreadySelectedResponse(click.Title));
        Assert.IsType<ReadFinalCommand>(SiteImportSequencer.CommandFor(state));
        state = SiteImportSequencer.Transition(state, DoneResponse(payloadJson));
        return Assert.IsType<SucceedCommand>(SiteImportSequencer.CommandFor(state));
    }

    private static IReadOnlyList<string> PayloadNotes(string payloadJson)
    {
        using var document = JsonDocument.Parse(payloadJson);
        return document.RootElement
            .GetProperty("meta").GetProperty("notes")
            .EnumerateArray().Select(note => note.GetString() ?? string.Empty)
            .ToList();
    }

    [Fact]
    public void The_walk_gate_clicks_item_slots_from_1st_only()
    {
        foreach (var title in new[] { "1st Item", "2nd Item", "3rd Item", "4th+ Item", "Boots" })
            Assert.True(SiteImportExtractors.IsWalkClickableSlot(title), title);
        // Keystone/Starter/Spell never qualify, and the match is exact and
        // ordinal — a near-miss title must fall back to the top-row read,
        // never to a click on the wrong section.
        foreach (var title in new[] { "Keystone", "Starter", "Spell", null, string.Empty, "1st item", "Boots " })
            Assert.False(SiteImportExtractors.IsWalkClickableSlot(title), title ?? "null");
    }

    [Fact]
    public void Happy_path_clicks_item_slots_from_1st_in_dom_order_then_reads()
    {
        var state = SiteImportSequencer.Initial();
        var clicked = new List<string>();

        state = Turn(state, new InspectCommand(), DiscoverResponse());
        foreach (var slot in ClickableSlots)
        {
            state = Turn(state, new ClickSlotCommand(slot), ClickedResponse(slot));
            clicked.Add(slot);
            // Two agreeing settle polls before the next slot; the selection
            // arrives with the second.
            state = Turn(state, new InspectCommand(), PollResponse("settle-a"));
            state = Turn(state, new InspectCommand(), PollResponse("settle-a", slot));
        }
        state = Turn(state, new ReadFinalCommand(), DoneResponse());

        var done = Assert.IsType<SucceedCommand>(SiteImportSequencer.CommandFor(state));
        Assert.Equal("""{"source":"coachless"}""", done.PayloadJson);
        Assert.Equal(ClickableSlots, clicked);
    }

    [Fact]
    public void Jhin_shape_clicks_1st_and_2nd_then_reads_mixed()
    {
        // The live-verified shape: 1st/2nd grant selections; everything else
        // (Keystone/Starter/Spell unclickable by rule, Boots/3rd/4th+ capped
        // read-only) collapses to conditioned top rows that are never
        // clicked. The walk clicks the two, skips the rest outright
        // (no click, no wait), and reads selected rows mixed with top rows.
        var state = Turn(SiteImportSequencer.Initial(), new InspectCommand(), JhinDiscoverResponse());
        var clicked = new List<string>();

        foreach (var slot in new[] { "1st Item", "2nd Item" })
        {
            state = Turn(state, new ClickSlotCommand(slot), ClickedResponse(slot));
            clicked.Add(slot);
            state = Turn(state, new InspectCommand(), PollResponse("s", slot));
            state = Turn(state, new InspectCommand(), PollResponse("s", slot));
        }
        Assert.Equal(new ReadFinalCommand(), SiteImportSequencer.CommandFor(state));

        const string mixed = """{"source":"coachless","championSlug":"jhin","role":"adc","runes":null,"itemBlocks":[{"title":"Starter","itemIds":[1120],"selected":false},{"title":"1st Item","itemIds":[6697],"selected":true},{"title":"2nd Item","itemIds":[3046],"selected":true},{"title":"3rd Item","itemIds":[3031],"selected":false},{"title":"4th+ Item","itemIds":[3033],"selected":false},{"title":"Boots","itemIds":[3006],"selected":false}]}""";
        state = Turn(state, new ReadFinalCommand(), DoneResponse(mixed));

        // No degradations on this walk, so the mixed payload passes through
        // byte-identical — selected flags and all.
        var done = Assert.IsType<SucceedCommand>(SiteImportSequencer.CommandFor(state));
        Assert.Equal(mixed, done.PayloadJson);
        Assert.Equal(new[] { "1st Item", "2nd Item" }, clicked);
    }

    [Fact]
    public void Keystone_starter_and_spell_alone_go_straight_to_read()
    {
        // Selectable but never clickable: with no item slot at/after 1st
        // Item the walk skips clicking entirely rather than failing.
        var state = Turn(
            SiteImportSequencer.Initial(),
            new InspectCommand(),
            StateResponse(
                new[]
                {
                    Slot("Keystone"),
                    Slot("Starter"),
                    Slot("Spell"),
                },
                "h0"));

        Assert.Equal(new ReadFinalCommand(), SiteImportSequencer.CommandFor(state));
    }

    [Fact]
    public void Read_only_discovery_slots_are_never_clicked_or_waited_on()
    {
        // A read-only 1st Item is skipped at discovery (the walk opens on
        // 2nd); a read-only 3rd falls off after the last click with no
        // settle polls between. Keystone/Starter/Spell are skipped by rule,
        // not by selectability.
        var state = Turn(
            SiteImportSequencer.Initial(),
            new InspectCommand(),
            StateResponse(
                new[]
                {
                    Slot("Keystone"),
                    Slot("Starter"),
                    Slot("1st Item", topSelectable: false),
                    Slot("2nd Item"),
                    Slot("Spell"),
                    Slot("3rd Item", topSelectable: false),
                },
                "h0"));

        state = Turn(state, new ClickSlotCommand("2nd Item"), ClickedResponse("2nd Item"));
        state = Turn(state, new InspectCommand(), PollResponse("s", "2nd Item"));
        state = Turn(state, new InspectCommand(), PollResponse("s", "2nd Item"));
        Assert.Equal(new ReadFinalCommand(), SiteImportSequencer.CommandFor(state));
    }

    [Fact]
    public void All_read_only_discovery_goes_straight_to_read()
    {
        var state = Turn(
            SiteImportSequencer.Initial(),
            new InspectCommand(),
            StateResponse(WalkSlots.Select(title => Slot(title, topSelectable: false)), "h0"));

        Assert.Equal(new ReadFinalCommand(), SiteImportSequencer.CommandFor(state));
    }

    [Fact]
    public void Read_only_click_answer_skips_the_settle_wait()
    {
        // Race guard: the top row lost its selectable class between inspect
        // and click. The script refuses the click; the driver moves on with
        // no settle polls and no note.
        var state = Turn(SiteImportSequencer.Initial(), new InspectCommand(), DiscoverResponse());
        var parsed = CoachlessStepResponse.Parse(
            """{"stage":"read-only","clickedSlot":"1st Item","settled":true}""");
        Assert.Equal("read-only", parsed.Stage);

        state = Turn(state, new ClickSlotCommand("1st Item"), ReadOnlyResponse("1st Item"));
        Assert.Equal(
            new ClickSlotCommand("2nd Item"),
            SiteImportSequencer.CommandFor(state));
    }

    [Fact]
    public void Settle_poll_resets_on_a_changed_fingerprint()
    {
        var state = Turn(SiteImportSequencer.Initial(), new InspectCommand(), DiscoverResponse());
        state = Turn(state, new ClickSlotCommand("1st Item"), ClickedResponse("1st Item"));

        // One poll each of two hashes, neither showing a selection: still
        // unsettled, still polling.
        state = Turn(state, new InspectCommand(), PollResponse("h1"));
        state = Turn(state, new InspectCommand(), PollResponse("h2"));
        Assert.IsType<InspectCommand>(SiteImportSequencer.CommandFor(state));

        // A second agreeing poll WITH the selection advances to the next slot.
        state = Turn(state, new InspectCommand(), PollResponse("h2", "1st Item"));
        Assert.Equal(
            new ClickSlotCommand("2nd Item"),
            SiteImportSequencer.CommandFor(state));
    }

    [Fact]
    public void Already_selected_rows_skip_the_settle_wait()
    {
        var state = Turn(SiteImportSequencer.Initial(), new InspectCommand(), DiscoverResponse());

        // The guard is idempotent: an already-selected top row advances
        // straight to the next click with no inspect between.
        state = Turn(
            state,
            new ClickSlotCommand("1st Item"),
            AlreadySelectedResponse("1st Item"));
        Assert.Equal(
            new ClickSlotCommand("2nd Item"),
            SiteImportSequencer.CommandFor(state));
    }

    [Fact]
    public void Clicked_slot_that_never_activates_degrades_with_a_note()
    {
        // The tables settle but the clicked slot never shows a selection:
        // the walk moves on (not fails) and notes the slot into the payload
        // meta; the final read falls back to that slot's top row.
        var state = Turn(SiteImportSequencer.Initial(), new InspectCommand(), JhinDiscoverResponse());
        state = Turn(state, new ClickSlotCommand("1st Item"), ClickedResponse("1st Item"));

        for (var poll = 0; poll < SiteImportSequencer.SettlePollCap; poll++)
        {
            Assert.IsType<InspectCommand>(SiteImportSequencer.CommandFor(state));
            state = SiteImportSequencer.Transition(state, PollResponse("same"));
        }

        Assert.Equal(
            new ClickSlotCommand("2nd Item"),
            SiteImportSequencer.CommandFor(state));
        var done = FinishWalk(state);
        var notes = PayloadNotes(done.PayloadJson);
        var note = Assert.Single(notes);
        Assert.Contains("1st Item", note, StringComparison.Ordinal);
        Assert.Contains("top row", note, StringComparison.Ordinal);
    }

    [Fact]
    public void Slot_that_never_settles_degrades_with_its_own_note()
    {
        // Alternate fingerprints forever: the tables never stabilise. Same
        // outcome as a settled-but-unselected slot — move on with a note —
        // but the note names the cause precisely.
        var state = Turn(SiteImportSequencer.Initial(), new InspectCommand(), JhinDiscoverResponse());
        state = Turn(state, new ClickSlotCommand("1st Item"), ClickedResponse("1st Item"));

        var hash = "flip";
        for (var poll = 0; poll < SiteImportSequencer.SettlePollCap; poll++)
        {
            Assert.IsType<InspectCommand>(SiteImportSequencer.CommandFor(state));
            hash = hash == "flip" ? "flop" : "flip";
            state = SiteImportSequencer.Transition(state, PollResponse(hash));
        }

        Assert.Equal(
            new ClickSlotCommand("2nd Item"),
            SiteImportSequencer.CommandFor(state));
        var done = FinishWalk(state);
        var note = Assert.Single(PayloadNotes(done.PayloadJson));
        Assert.Contains("1st Item", note, StringComparison.Ordinal);
        Assert.Contains("never settled", note, StringComparison.Ordinal);
    }

    [Fact]
    public void The_settle_budget_is_five_seconds_per_slot()
    {
        // Pins the brief's "~5s per slot" in code: polls x delay.
        Assert.Equal(
            5000,
            SiteImportSequencer.SettlePollCap * SiteImportSequencer.SettlePollDelayMs);
    }

    [Fact]
    public void Missing_slot_section_fails_with_the_slot_named()
    {
        var state = Turn(SiteImportSequencer.Initial(), new InspectCommand(), DiscoverResponse());
        state = SiteImportSequencer.Transition(
            state, ErrorResponse("slot \"2nd Item\" not found"));

        var fail = Assert.IsType<FailCommand>(SiteImportSequencer.CommandFor(state));
        Assert.Contains("2nd Item", fail.Reason, StringComparison.Ordinal);
    }

    [Fact]
    public void Empty_final_slot_still_fails_with_the_slot_named()
    {
        // The top-row fallback covers unselected slots, but a slot with NO
        // rows at all has nothing to read — that stays a typed failure.
        var state = SiteImportSequencer.Initial();
        state = Turn(state, new InspectCommand(), DiscoverResponse());
        foreach (var slot in ClickableSlots)
        {
            state = Turn(state, new ClickSlotCommand(slot), ClickedResponse(slot));
            state = Turn(state, new InspectCommand(), PollResponse("s1", slot));
            state = Turn(state, new InspectCommand(), PollResponse("s1", slot));
        }
        state = Turn(
            state,
            new ReadFinalCommand(),
            ErrorResponse("slot \"Boots\" has no rows"));

        var fail = Assert.IsType<FailCommand>(SiteImportSequencer.CommandFor(state));
        Assert.Contains("Boots", fail.Reason, StringComparison.Ordinal);
    }

    [Fact]
    public void A_page_that_keeps_adding_slots_hits_the_total_step_cap()
    {
        // 45 clickable item slots at ~3 steps each (click + 2 polls)
        // overshoot the absolute cap long before the walk converges. The cap
        // is the remaining backstop now that settle exhaustion degrades.
        // Titles cycle the five walk slots: the sequencer keys clicks by
        // title, so repeats are just more breadth to spend steps on.
        var many = Enumerable.Range(0, 45).Select(index => ClickableSlots[index % ClickableSlots.Length]).ToArray();
        var state = SiteImportSequencer.Transition(
            SiteImportSequencer.Initial(),
            StateResponse(many.Select(title => Slot(title)), "h0"));

        var guard = 0;
        while (SiteImportSequencer.CommandFor(state) is not FailCommand && guard++ < 1000)
        {
            var command = SiteImportSequencer.CommandFor(state);
            state = command switch
            {
                ClickSlotCommand click => SiteImportSequencer.Transition(
                    state, ClickedResponse(click.Title)),
                // Each poll shows the clicked slot selected under a stable
                // hash, so every slot converges in two polls and the walk
                // spends its steps on breadth, not retries.
                InspectCommand => SiteImportSequencer.Transition(
                    state,
                    new CoachlessStepResponse(
                        "state", null, true, "same",
                        [Slot(state.Slots[state.Position].Title, hasActive: true)],
                        null, null)),
                _ => throw new InvalidOperationException("unexpected command " + command),
            };
        }

        var fail = Assert.IsType<FailCommand>(SiteImportSequencer.CommandFor(state));
        Assert.Equal(SiteImportSequencer.NoConvergenceFailure, fail.Reason);
        Assert.True(state.Steps >= SiteImportSequencer.MaxSteps);
    }

    [Fact]
    public void Empty_discovery_is_no_build()
    {
        var state = SiteImportSequencer.Transition(
            SiteImportSequencer.Initial(),
            StateResponse([], "h0"));

        var fail = Assert.IsType<FailCommand>(SiteImportSequencer.CommandFor(state));
        Assert.Equal("no build on page", fail.Reason);
    }

    [Fact]
    public void Clicking_the_wrong_slot_fails_loudly()
    {
        var state = Turn(SiteImportSequencer.Initial(), new InspectCommand(), DiscoverResponse());
        state = SiteImportSequencer.Transition(state, ClickedResponse("3rd Item"));

        var fail = Assert.IsType<FailCommand>(SiteImportSequencer.CommandFor(state));
        Assert.Contains("changed", fail.Reason, StringComparison.Ordinal);
    }

    [Fact]
    public void Wrong_stage_answers_fail_loudly()
    {
        var discovering = SiteImportSequencer.Transition(
            SiteImportSequencer.Initial(), ClickedResponse("Keystone"));
        Assert.IsType<FailCommand>(SiteImportSequencer.CommandFor(discovering));

        var clicking = Turn(
            SiteImportSequencer.Initial(), new InspectCommand(), DiscoverResponse());
        var misanswered = SiteImportSequencer.Transition(clicking, PollResponse("h1"));
        Assert.IsType<FailCommand>(SiteImportSequencer.CommandFor(misanswered));
    }

    [Fact]
    public void Final_read_without_a_payload_fails()
    {
        var state = SiteImportSequencer.Initial();
        state = Turn(state, new InspectCommand(), DiscoverResponse());
        foreach (var slot in ClickableSlots)
        {
            state = Turn(state, new ClickSlotCommand(slot), AlreadySelectedResponse(slot));
        }
        state = Turn(state, new ReadFinalCommand(), DoneResponse(null));

        Assert.IsType<FailCommand>(SiteImportSequencer.CommandFor(state));
    }

    [Fact]
    public void Terminal_states_ignore_further_responses()
    {
        var failed = SiteImportSequencer.Transition(
            SiteImportSequencer.Initial(), ErrorResponse("no build on page"));
        Assert.Same(
            failed,
            SiteImportSequencer.Transition(failed, DiscoverResponse()));
    }

    [Fact]
    public void Step_errors_map_to_the_shared_typed_failures()
    {
        var start = SiteImportSequencer.Initial();
        var noBuild = SiteImportSequencer.Transition(start, ErrorResponse("no build on page"));
        Assert.Equal(
            "no build on page",
            Assert.IsType<FailCommand>(SiteImportSequencer.CommandFor(noBuild)).Reason);

        var notPage = SiteImportSequencer.Transition(start, ErrorResponse("not a champion builds page"));
        Assert.Equal(
            "site page not recognized",
            Assert.IsType<FailCommand>(SiteImportSequencer.CommandFor(notPage)).Reason);
    }

    [Fact]
    public void Response_parser_unwraps_the_script_envelope()
    {
        // ExecuteScriptAsync JSON-encodes the returned JS string: the parser
        // must accept the wrapped string and the bare object alike.
        var bare = """{"stage":"clicked","clickedSlot":"Starter","settled":false}""";
        var wrapped = JsonSerializer.Serialize(bare);

        foreach (var raw in new[] { bare, wrapped })
        {
            var response = CoachlessStepResponse.Parse(raw);
            Assert.Equal("clicked", response.Stage);
            Assert.Equal("Starter", response.ClickedSlot);
            Assert.False(response.Settled);
            Assert.Null(response.Error);
        }
    }

    [Fact]
    public void Response_parser_reports_errors_and_rejects_garbage()
    {
        var error = CoachlessStepResponse.Parse(
            "{\"error\":\"slot \\\"X\\\" not found\"}");
        Assert.Equal("slot \"X\" not found", error.Error);

        foreach (var raw in new[] { null, string.Empty, "not json", "42", "[1,2]", """{"nonsense":true}""" })
        {
            var response = CoachlessStepResponse.Parse(raw);
            Assert.Equal("site page not recognized", response.Error);
        }
    }

    [Fact]
    public void Response_parser_reads_slots_and_the_done_payload()
    {
        var raw = """
            {"stage":"state","settled":true,"hash":"abc123",
             "slots":[{"title":"Keystone","topSelected":true,"rows":4,"topSelectable":true,"hasActive":true},
                      {"title":"Starter","topSelected":false,"rows":5,"topSelectable":false,"hasActive":false}]}
            """;
        var state = CoachlessStepResponse.Parse(raw);
        Assert.Equal("abc123", state.Hash);
        Assert.Equal(
            new[]
            {
                new CoachlessSlotState("Keystone", true, 4, true, true),
                new CoachlessSlotState("Starter", false, 5, false, false),
            },
            state.Slots);

        var done = CoachlessStepResponse.Parse(
            """{"stage":"done","settled":true,"payload":{"source":"coachless","itemBlocks":[]}}""");
        Assert.Equal("done", done.Stage);
        Assert.Contains("\"coachless\"", done.PayloadJson, StringComparison.Ordinal);
    }

    [Fact]
    public void Response_parser_defaults_selectability_to_read_only()
    {
        // A slot shape predating the gating fields must never be clicked:
        // missing flags mean read-only, the safe direction.
        var parsed = CoachlessStepResponse.Parse(
            """{"stage":"state","settled":true,"hash":"h","slots":[{"title":"Spell","topSelected":false,"rows":6}]}""");
        var slot = Assert.Single(parsed.Slots);
        Assert.False(slot.TopSelectable);
        Assert.False(slot.HasActive);
    }

    [Fact]
    public void Step_builders_emit_the_actions_the_script_switches_on()
    {
        Assert.Equal("""{"action":"inspect"}""", SiteImportSteps.Inspect());
        Assert.Equal("""{"action":"read"}""", SiteImportSteps.Read());

        using var click = JsonDocument.Parse(SiteImportSteps.Click("4th+ Item"));
        Assert.Equal("click", click.RootElement.GetProperty("action").GetString());
        Assert.Equal("4th+ Item", click.RootElement.GetProperty("slot").GetString());

        // A hostile slot title cannot break out of the embedded JSON.
        var hostile = SiteImportSteps.Click("x\"};alert(1);//");
        using var hostileDocument = JsonDocument.Parse(hostile);
        Assert.Equal("x\"};alert(1);//", hostileDocument.RootElement.GetProperty("slot").GetString());

        // Every built step embeds cleanly: no leftover token, and the script
        // still closes over the template exactly once.
        foreach (var step in new[] { SiteImportSteps.Inspect(), SiteImportSteps.Click("Boots"), SiteImportSteps.Read() })
        {
            var script = SiteImportExtractors.CoachlessStepScript(step);
            Assert.DoesNotContain("__COACHLESS_STEP_JSON__", script, StringComparison.Ordinal);
            Assert.Contains("JSON.stringify", script, StringComparison.Ordinal);
        }
    }
}
