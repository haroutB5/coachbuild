using System.Text.Json;
using CoachBuild.Core;
using Xunit;

namespace CoachBuild.Core.Tests;

public sealed class SituationalOverlayTests
{
    // Galio mid, patch 16.16 - the capture the web lane identified as the
    // screenshot the user pointed at, verbatim. Six items, one of them
    // negative, ordered by delta descending.
    private const string GalioMid = """
    [ {"id":3158,"wpa":4.27,"text":"+4.27"},
      {"id":3009,"wpa":2.79,"text":"+2.79"},
      {"id":3047,"wpa":1.13,"text":"+1.13"},
      {"id":4645,"wpa":0.45,"text":"+0.45"},
      {"id":4646,"wpa":0.39,"text":"+0.39"},
      {"id":3068,"wpa":-0.06,"text":"-0.06"} ]
    """;

    private static JsonElement Json(string raw) => JsonDocument.Parse(raw).RootElement.Clone();

    /// <summary>
    /// The <c>Situational</c> block as <c>itemSetBody.ts</c> actually writes it:
    /// ids are STRINGS on the LCU item-set wire, and the block is the LAST of
    /// however many the export produced.
    /// </summary>
    private static SituationalBlockInfo Block(string title, int ordinal, int count, params int[] ids) =>
        new(title, ordinal, count, ids);

    /// <summary>
    /// The block that GalioMid's numbers actually annotate. `situationalWire`
    /// and `situationalBlocks` are both built from ONE `picks` array in
    /// `itemSetBody.ts`, so this agreement is production's own invariant and
    /// not a convenience of the fixture.
    /// </summary>
    private static SituationalBlockInfo GalioBlock =>
        Block("CoachBuild Galio Mid", 3, 3, 3158, 3009, 3047, 4645, 4646, 3068);

    /// <summary>
    /// A REAL one-item block, for the single-entry fixtures below.
    ///
    /// <para>These used to be handed <c>SituationalBlockInfo.Unknown</c> behind
    /// an <c>Unchecked</c> alias whose own comment said why: a Known block plus
    /// one dropped entry was a count mismatch that suppressed the whole row.
    /// That is a defect report, and it was filed as a fixture note - eight
    /// tests were routed around the production path so the interaction was
    /// never exercised. The parser no longer cross-checks a row it has already
    /// dropped entries from, so they run the real path now.</para>
    /// </summary>
    private static SituationalBlockInfo OneItemBlock => Block("CoachBuild Galio Mid", 3, 3, 3158);

    /// <summary>The block a TWELVE-entry payload arrived with; the web's own cap is six.</summary>
    private static SituationalBlockInfo TwelveItemBlock => Block(
        "CoachBuild Galio Mid", 3, 3, Enumerable.Range(1, 12).Select(index => 1000 + index).ToArray());

    /// <summary>Three items, the middle one unbuyable: the shape One_bad_entry_... sends.</summary>
    private static SituationalBlockInfo ThreeItemBlock =>
        Block("CoachBuild Galio Mid", 3, 3, 3158, 999999, 3009);

    [Fact]
    public void Parses_the_real_payload_in_order_and_keeps_the_webs_own_text()
    {
        // The PRODUCTION shape: a real Situational block from the same payload,
        // not `Unknown`. Round 4 added the cross-check and every existing test
        // here would have kept passing with it permanently disabled, because
        // every existing fixture wrote `"blocks":[]`.
        var set = SituationalOverlayParser.Parse(
            3, Json(GalioMid), DateTimeOffset.UnixEpoch, GalioBlock, out var rejections);

        Assert.Empty(rejections);
        Assert.Equal(3, set.ChampionId);
        Assert.Equal(6, set.Deltas.Count);
        Assert.Equal([3158, 3009, 3047, 4645, 4646, 3068], set.Deltas.Select(delta => delta.ItemId));

        // The text is rendered VERBATIM. A second formatter on this side is how
        // the page and the overlay end up disagreeing at a rounding boundary
        // while both look right in isolation.
        Assert.Equal("+4.27", set.Deltas[0].Text);
        Assert.Equal("-0.06", set.Deltas[5].Text);
        Assert.Equal(4.27, set.Deltas[0].Wpa, 5);
        Assert.True(set.Deltas[5].Wpa < 0);
    }

    [Fact]
    public void More_than_six_entries_are_capped_and_the_drop_is_reported()
    {
        var many = "[" + string.Join(",", Enumerable.Range(1, 12)
            .Select(index => $"{{\"id\":{1000 + index},\"wpa\":1.0,\"text\":\"+1.00\"}}")) + "]";

        var set = SituationalOverlayParser.Parse(
            3, Json(many), DateTimeOffset.UnixEpoch, TwelveItemBlock, out var rejections);

        Assert.Equal(SituationalOverlayParser.MaxDeltas, set.Deltas.Count);
        Assert.NotEmpty(rejections);
        // Order is preserved: the ones kept are the FIRST six, which is the
        // window the page showed.
        Assert.Equal(1001, set.Deltas[0].ItemId);
        Assert.Equal(1006, set.Deltas[5].ItemId);
    }

    [Theory]
    [InlineData("""[ {"id":3158,"wpa":4.27} ]""", "text")]
    [InlineData("""[ {"id":3158,"wpa":4.27,"text":""} ]""", "blank")]
    [InlineData("""[ {"id":3158,"wpa":4.27,"text":"   "} ]""", "blank")]
    [InlineData("""[ {"id":3158,"wpa":4.27,"text":"a paragraph of nonsense"} ]""", "longer")]
    [InlineData("""[ {"wpa":4.27,"text":"+4.27"} ]""", "numeric id")]
    [InlineData("""[ {"id":"3158","wpa":4.27,"text":"+4.27"} ]""", "numeric id")]
    [InlineData("""[ {"id":223158,"wpa":4.27,"text":"+4.27"} ]""", "outside")]
    [InlineData("""[ {"id":0,"wpa":4.27,"text":"+4.27"} ]""", "outside")]
    [InlineData("""[ {"id":3158,"wpa":null,"text":"+4.27"} ]""", "finite")]
    [InlineData("""[ {"id":3158,"wpa":"4.27","text":"+4.27"} ]""", "finite")]
    [InlineData("""[ "not an object" ]""", "not an object")]
    public void A_malformed_entry_is_dropped_with_a_reason_and_never_invented(string raw, string reasonFragment)
    {
        var set = SituationalOverlayParser.Parse(
            3, Json(raw), DateTimeOffset.UnixEpoch, OneItemBlock, out var rejections);

        Assert.Empty(set.Deltas);
        var why = string.Join("; ", rejections);
        Assert.Contains(reasonFragment, why, StringComparison.OrdinalIgnoreCase);
        // The block is KNOWN here. The row is empty for the ENTRY's own reason,
        // never re-reported as a contradiction with the block it came with.
        Assert.DoesNotContain("do not describe", why, StringComparison.Ordinal);
    }

    [Fact]
    public void An_absent_delta_renders_nothing_and_never_plus_zero()
    {
        var set = SituationalOverlayParser.Parse(
            3, Json("""[ {"id":3158,"wpa":0,"text":""} ]"""), DateTimeOffset.UnixEpoch, OneItemBlock, out _);

        Assert.Empty(set.Deltas);
        Assert.DoesNotContain(set.Deltas, delta => delta.Text.Contains('0', StringComparison.Ordinal));
    }

    [Fact]
    public void A_missing_wpa_is_a_zero_sign_not_a_rejection()
    {
        // wpa drives colour only. Losing it should cost the number its colour,
        // never the number.
        var set = SituationalOverlayParser.Parse(
            3, Json("""[ {"id":3158,"text":"+4.27"} ]"""), DateTimeOffset.UnixEpoch, OneItemBlock, out var rejections);

        Assert.Empty(rejections);
        Assert.Equal("+4.27", Assert.Single(set.Deltas).Text);
        Assert.Equal(0, set.Deltas[0].Wpa);
    }

    [Fact]
    public void One_bad_entry_does_not_take_the_good_ones_with_it()
    {
        var set = SituationalOverlayParser.Parse(3, Json("""
        [ {"id":3158,"wpa":4.27,"text":"+4.27"},
          {"id":999999,"wpa":1.0,"text":"+1.00"},
          {"id":3009,"wpa":2.79,"text":"+2.79"} ]
        """), DateTimeOffset.UnixEpoch, ThreeItemBlock, out var rejections);

        Assert.Equal([3158, 3009], set.Deltas.Select(delta => delta.ItemId));
        Assert.Single(rejections);
        Assert.Contains("entry 1", rejections[0], StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("""{"id":3047,"wpa":null,"text":"+1.13"}""", "finite")]
    [InlineData("""{"id":3047,"wpa":1.13,"text":""}""", "blank")]
    [InlineData("""{"id":3047,"wpa":1.13,"text":"   "}""", "blank")]
    [InlineData("""{"id":223047,"wpa":1.13,"text":"+1.13"}""", "outside")]
    [InlineData("""{"id":3047,"wpa":1.13,"text":"a paragraph of nonsense"}""", "longer")]
    [InlineData(""" "not an object" """, "not an object")]
    public void A_valid_block_plus_ONE_rejected_entry_still_draws_the_other_five(
        string entry, string reasonFragment)
    {
        // THE COMBINATION NOTHING COVERED, and the one that matters most.
        // `deltas` is the POST-rejection list; `block.ItemIds` is the
        // PRE-rejection one, straight off the wire. Cross-checking one against
        // the other turned ONE malformed entry into SIX missing numbers - a
        // per-item degradation promoted to a whole-feature outage, logged as
        // "every number was rejected", which reads as a cross-check failure
        // rather than as one bad number.
        //
        // `"wpa": null` is not hypothetical: JSON.stringify(NaN) emits null, so
        // a single NaN anywhere in a freshly-baked artifact lands here and used
        // to take the feature dark for that champion.
        //
        // The parent commit lost one badge and kept five. That is the floor.
        var payload = "[" + string.Join(",",
            """{"id":3158,"wpa":4.27,"text":"+4.27"}""",
            """{"id":3009,"wpa":2.79,"text":"+2.79"}""",
            entry,
            """{"id":4645,"wpa":0.45,"text":"+0.45"}""",
            """{"id":4646,"wpa":0.39,"text":"+0.39"}""",
            """{"id":3068,"wpa":-0.06,"text":"-0.06"}""") + "]";

        var set = SituationalOverlayParser.Parse(
            3, Json(payload), DateTimeOffset.UnixEpoch, GalioBlock, out var rejections);
        var why = string.Join("; ", rejections);

        Assert.Equal([3158, 3009, 4645, 4646, 3068], set.Deltas.Select(delta => delta.ItemId));
        Assert.Single(rejections);
        Assert.Contains("entry 2", why, StringComparison.Ordinal);
        Assert.Contains(reasonFragment, why, StringComparison.OrdinalIgnoreCase);

        // The assertion that fails before the fix: the row came back EMPTY with
        // "the numbers do not describe the Situational block that was written".
        Assert.DoesNotContain("do not describe", why, StringComparison.Ordinal);

        // ...and the surviving numbers still carry the set they belong to.
        Assert.Contains("CoachBuild Galio Mid", set.SetLabel, StringComparison.Ordinal);
    }

    [Fact]
    public void A_CLEAN_row_over_the_WRONG_items_is_still_suppressed_whole()
    {
        // THE NEGATIVE CONTROL for the theory above. Not cross-checking a row
        // that already lost entries must not become not cross-checking at all:
        // six good numbers over six icons look correct whichever items they
        // describe, and that is the one failure the check exists to catch.
        var payload = """
        [ {"id":3158,"wpa":4.27,"text":"+4.27"},
          {"id":3009,"wpa":2.79,"text":"+2.79"},
          {"id":3047,"wpa":1.13,"text":"+1.13"},
          {"id":4645,"wpa":0.45,"text":"+0.45"},
          {"id":4646,"wpa":0.39,"text":"+0.39"},
          {"id":6653,"wpa":-0.06,"text":"-0.06"} ]
        """;

        var set = SituationalOverlayParser.Parse(
            3, Json(payload), DateTimeOffset.UnixEpoch, GalioBlock, out var rejections);

        Assert.Empty(set.Deltas);
        Assert.Equal(string.Empty, set.SetLabel);
        var why = Assert.Single(rejections);
        Assert.Contains("do not describe", why, StringComparison.Ordinal);
        Assert.Contains("position 6", why, StringComparison.Ordinal);
    }

    [Fact]
    public void An_absent_field_is_empty_and_silent_but_a_wrong_shaped_one_is_reported()
    {
        Assert.Empty(SituationalOverlayParser.Parse(3, null, DateTimeOffset.UnixEpoch, GalioBlock, out var absent).Deltas);
        Assert.Empty(absent);

        Assert.Empty(SituationalOverlayParser.Parse(3, Json("null"), DateTimeOffset.UnixEpoch, GalioBlock, out var nulled).Deltas);
        Assert.Empty(nulled);

        // An older web build omits the key entirely; a WRONG one sends the
        // wrong type, and that is worth a line.
        Assert.Empty(SituationalOverlayParser.Parse(3, Json("{}"), DateTimeOffset.UnixEpoch, GalioBlock, out var wrong).Deltas);
        Assert.NotEmpty(wrong);
        Assert.Empty(SituationalOverlayParser.Parse(3, Json("42"), DateTimeOffset.UnixEpoch, GalioBlock, out var number).Deltas);
        Assert.NotEmpty(number);
    }

    [Fact]
    public void A_payload_without_a_champion_is_refused_outright()
    {
        var set = SituationalOverlayParser.Parse(0, Json(GalioMid), DateTimeOffset.UnixEpoch, GalioBlock, out var rejections);
        Assert.Empty(set.Deltas);
        Assert.NotEmpty(rejections);
    }

    [Fact]
    public void The_numbers_are_gated_on_the_champion_matching_never_on_them_merely_existing()
    {
        // The item set is written in champ select and drawn in game, so the
        // data outlives its phase - and anything that outlives a phase can
        // outlive the champion it described.
        var set = SituationalOverlayParser.Parse(3, Json(GalioMid), DateTimeOffset.UnixEpoch, GalioBlock, out _);

        Assert.NotNull(set.For(3));
        Assert.Equal(6, set.For(3)!.Count);
        Assert.Null(set.For(64));
        Assert.Null(set.For(0));
        Assert.Null(set.For(-1));
    }

    [Fact]
    public void An_empty_set_answers_null_for_its_own_champion_too()
    {
        var empty = new SituationalOverlaySet(3, Array.Empty<SituationalDelta>(), DateTimeOffset.UnixEpoch, string.Empty);
        Assert.False(empty.Any);
        Assert.Null(empty.For(3));
    }

    [Fact]
    public void Companion_state_clears_rather_than_keeping_the_last_champions_numbers()
    {
        var state = new CompanionState();
        var galio = SituationalOverlayParser.Parse(3, Json(GalioMid), DateTimeOffset.UnixEpoch, GalioBlock, out _);

        state.SetSituational(galio);
        Assert.Equal(6, state.Situational!.Deltas.Count);

        // A write with NO situational field must CLEAR, not leave the previous
        // one in place. An older web build, or a champion with no alternatives,
        // must produce no numbers - not last champion's numbers.
        state.SetSituational(SituationalOverlayParser.Parse(64, null, DateTimeOffset.UnixEpoch, GalioBlock, out _));
        Assert.Null(state.Situational);

        state.SetSituational(galio);
        state.SetSituational(null);
        Assert.Null(state.Situational);
    }
}
