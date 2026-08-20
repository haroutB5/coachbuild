using System.Text.Json;
using CoachBuild.Core;
using Xunit;

namespace CoachBuild.Core.Tests;

/// <summary>
/// WHICH SET the numbers belong to, and WHERE IN IT the row sits.
///
/// <para><b>Defect E, 2026-08-20.</b> The overlay drew three numbers over
/// Riot's own <c>AP</c> recommended set — <c>Starting Items / Core Build Order
/// / Core Final Build / Situational items that are also good / Boots
/// Options</c>, seven items in that last row — while the numbers described
/// three completely different items from a CoachBuild set the player had not
/// selected. Nothing in the app, the log or the screen said so, and it cost a
/// full diagnostic round.</para>
///
/// <para><b>Defect D, same day.</b> Two screenshots at ONE saved calibration:
/// a 3-block CoachBuild set with the pills below the icons, and the 5-block AP
/// set with the pills above them on the section header. The overlay did not
/// move between those two — see <c>BadgePlacementTests</c>, which proves the
/// badge anchor has no term for the set's shape. The SHOP moved, because a
/// block's worth of vertical space was added above the row. That is why
/// <see cref="SituationalBlockInfo.Describe"/> carries the block's ORDINAL and
/// not just the set's name: two reports of "the numbers are off" are one
/// subtraction apart with it and indistinguishable without it.</para>
/// </summary>
public sealed class SituationalSetLocatorTests
{
    /// <summary>
    /// The shape <c>buildItemSets</c> emits, verbatim: item ids are STRINGS on
    /// the LCU item-set wire (<c>itemRef</c> in <c>itemSetBody.ts</c> does
    /// <c>String(id)</c>), <c>Starting</c> is first and <c>Situational</c> is
    /// last.
    /// </summary>
    private const string CoachBuildSyndra = """
    {
      "title": "CoachBuild Syndra Mid",
      "type": "custom",
      "blocks": [
        { "type": "Starting", "items": [ {"id":"1056","count":1} ] },
        { "type": "WPA build", "items": [
            {"id":"2503","count":1},{"id":"4646","count":1},{"id":"3089","count":1},
            {"id":"3158","count":1},{"id":"3135","count":1},{"id":"3157","count":1} ] },
        { "type": "Situational", "items": [
            {"id":"3137","count":1},{"id":"3020","count":1},{"id":"4005","count":1},
            {"id":"4629","count":1},{"id":"3009","count":1},{"id":"3152","count":1} ] }
      ]
    }
    """;

    /// <summary>
    /// The same champion with the database healthy: <c>Pro build</c> and
    /// <c>OTP build</c> present, so <c>Situational</c> is block 5 of 5 instead
    /// of 3 of 3. This is the shape the 2026-08-20 Neon 402 removed from every
    /// set in the game, and the shape it will come back as.
    /// </summary>
    private const string CoachBuildSyndraFullData = """
    {
      "title": "CoachBuild Syndra Mid",
      "blocks": [
        { "type": "Starting", "items": [ {"id":"1056","count":1} ] },
        { "type": "WPA build", "items": [ {"id":"2503","count":1} ] },
        { "type": "Pro build", "items": [ {"id":"4005","count":1} ] },
        { "type": "OTP build", "items": [ {"id":"4005","count":1} ] },
        { "type": "Situational", "items": [
            {"id":"3137","count":1},{"id":"3020","count":1},{"id":"4005","count":1},
            {"id":"4629","count":1},{"id":"3009","count":1},{"id":"3152","count":1} ] }
      ]
    }
    """;

    private static IReadOnlyList<JsonElement> Sets(params string[] raw) =>
        raw.Select(item => JsonDocument.Parse(item).RootElement.Clone()).ToArray();

    [Fact]
    public void The_real_export_is_located_by_name_position_and_contents()
    {
        var block = SituationalSetLocator.Find(Sets(CoachBuildSyndra));

        Assert.True(block.Known);
        Assert.Equal("CoachBuild Syndra Mid", block.SetTitle);
        Assert.Equal(3, block.BlockOrdinal);
        Assert.Equal(3, block.BlockCount);
        // STRING ids on the wire, read as numbers here. A `TryGetInt32` on a
        // JsonValueKind.String returns false, so an implementation that assumed
        // numbers would find six items and zero ids and quietly cross-check
        // nothing.
        Assert.Equal([3137, 3020, 4005, 4629, 3009, 3152], block.ItemIds);
    }

    [Fact]
    public void The_block_POSITION_is_what_moves_when_the_database_goes_down()
    {
        // THE DEFECT-D FACT, in one assertion. Same champion, same title, same
        // six situational items, same saved calibration on the player's screen
        // — and a different number of blocks above the row, which is a
        // different Y in the shop panel and therefore a different place for the
        // pills to land relative to the icons.
        var outage = SituationalSetLocator.Find(Sets(CoachBuildSyndra));
        var healthy = SituationalSetLocator.Find(Sets(CoachBuildSyndraFullData));

        Assert.Equal(outage.SetTitle, healthy.SetTitle);
        Assert.Equal(outage.ItemIds, healthy.ItemIds);

        Assert.Equal(3, outage.BlockOrdinal);
        Assert.Equal(5, healthy.BlockOrdinal);

        // ...and the difference is legible without doing the subtraction by
        // hand, because the log line and the adjust legend both print this.
        Assert.Contains("block 3 of 3", outage.Describe(), StringComparison.Ordinal);
        Assert.Contains("block 5 of 5", healthy.Describe(), StringComparison.Ordinal);
        Assert.NotEqual(outage.Describe(), healthy.Describe());
    }

    [Fact]
    public void Riots_own_situational_row_is_NOT_treated_as_ours()
    {
        // "Situational items that are also good" is Riot's label on their
        // recommended sets. Matching it would be asserting agreement with a row
        // this app did not choose and cannot map positionally — which is
        // exactly the thing that went wrong in the field.
        var riot = Sets("""
        {
          "title": "AP",
          "blocks": [
            { "type": "Starting Items", "items": [ {"id":"2003","count":1} ] },
            { "type": "Core Build Order", "items": [ {"id":"1052","count":1} ] },
            { "type": "Core Final Build", "items": [ {"id":"3020","count":1} ] },
            { "type": "Situational items that are also good", "items": [
                {"id":"3157","count":1},{"id":"3089","count":1} ] },
            { "type": "Boots Options", "items": [ {"id":"3020","count":1} ] }
          ]
        }
        """);

        var block = SituationalSetLocator.Find(riot);

        Assert.False(block.Known);
        Assert.Same(SituationalBlockInfo.Unknown, block);
        Assert.Equal("an item set this payload did not identify", block.Describe());
    }

    [Fact]
    public void Case_is_the_only_thing_forgiven_in_the_block_name()
    {
        Assert.True(SituationalSetLocator.Find(Sets("""
        {"title":"T","blocks":[{"type":"SITUATIONAL","items":[{"id":"3157"}]}]}
        """)).Known);

        Assert.False(SituationalSetLocator.Find(Sets("""
        {"title":"T","blocks":[{"type":"Situational swaps","items":[{"id":"3157"}]}]}
        """)).Known);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("""{"title":"T","blocks":[]}""")]
    [InlineData("""{"title":"T"}""")]
    [InlineData("""{"title":"T","blocks":"not an array"}""")]
    [InlineData(""" "not an object" """)]
    [InlineData("""{"blocks":[{"items":[{"id":"1"}]}]}""")]
    [InlineData("""{"blocks":[{"type":42,"items":[{"id":"1"}]}]}""")]
    public void Anything_it_cannot_read_is_UNKNOWN_and_never_a_guess(string? raw)
    {
        var block = raw is null
            ? SituationalSetLocator.Find(null)
            : SituationalSetLocator.Find(Sets(raw));

        Assert.False(block.Known);
        Assert.Empty(block.ItemIds);
        // Unknown must never invent a NAME. A wrong name is worse than no name
        // for a player hunting a misaligned row.
        Assert.DoesNotContain("\"", block.Describe(), StringComparison.Ordinal);
    }

    [Fact]
    public void A_numeric_id_is_read_too_rather_than_assumed_away()
    {
        var block = SituationalSetLocator.Find(Sets("""
        {"title":"T","blocks":[{"type":"Situational","items":[{"id":3157},{"id":"3089"}]}]}
        """));

        Assert.Equal([3157, 3089], block.ItemIds);
    }

    [Fact]
    public void An_unreadable_id_holds_its_POSITION_instead_of_shortening_the_row()
    {
        // Dropping it would turn a parse problem into a phantom count mismatch
        // and suppress every number for the wrong reason.
        var block = SituationalSetLocator.Find(Sets("""
        {"title":"T","blocks":[{"type":"Situational","items":[
            {"id":"3157"},{"id":"not a number"},{"nope":1},{"id":3089}]}]}
        """));

        Assert.Equal([3157, 0, 0, 3089], block.ItemIds);

        // ...and the unchecked position agrees with whatever is drawn over it,
        // because an unchecked position is not a contradiction.
        Assert.True(SituationalSetLocator.Agrees(
            block,
            [new(3157, 1, "+1.00"), new(9999, 1, "+1.00"), new(8888, 1, "+1.00"), new(3089, 1, "+1.00")],
            out _));
    }

    [Fact]
    public void The_web_builds_both_rows_from_one_list_and_this_pins_it()
    {
        // `situationalBlockPicks` is called ONCE in itemSetBody.ts and feeds
        // both `situationalBlocks` and `situationalWire`, so this holds by
        // construction today — which is exactly why it is worth a test. A row
        // of numbers whose ids do not match the row of icons under them is not
        // a degraded feature, it is a confident claim about the wrong items,
        // and the two are indistinguishable on screen.
        var block = SituationalSetLocator.Find(Sets(CoachBuildSyndra));

        Assert.True(SituationalSetLocator.Agrees(
            block,
            [
                new(3137, 1.76, "+1.76"), new(3020, 0.36, "+0.36"), new(4005, 0.32, "+0.32"),
                new(4629, 0.23, "+0.23"), new(3009, -0.22, "-0.22"), new(3152, -0.27, "-0.27"),
            ],
            out var why));
        Assert.Empty(why);
    }

    [Fact]
    public void A_row_of_the_wrong_LENGTH_disagrees_and_says_both_numbers()
    {
        var block = SituationalSetLocator.Find(Sets(CoachBuildSyndra));

        Assert.False(SituationalSetLocator.Agrees(
            block,
            [new(3137, 1.76, "+1.76"), new(3020, 0.36, "+0.36")],
            out var why));
        Assert.Contains("6 item", why, StringComparison.Ordinal);
        Assert.Contains("2 number", why, StringComparison.Ordinal);
    }

    [Fact]
    public void A_row_of_the_right_length_over_the_wrong_ITEMS_names_the_position()
    {
        // The field case: three numbers for three items, drawn over a row of
        // different items. With the right count this is invisible on screen —
        // six green pills over six icons look correct whichever items they are.
        var block = SituationalSetLocator.Find(Sets(CoachBuildSyndra));

        Assert.False(SituationalSetLocator.Agrees(
            block,
            [
                new(3137, 1.76, "+1.76"), new(3020, 0.36, "+0.36"), new(4005, 0.32, "+0.32"),
                new(4629, 0.23, "+0.23"), new(3009, -0.22, "-0.22"), new(6653, -0.27, "-0.27"),
            ],
            out var why));
        Assert.Contains("position 6", why, StringComparison.Ordinal);
        Assert.Contains("3152", why, StringComparison.Ordinal);
        Assert.Contains("6653", why, StringComparison.Ordinal);
    }

    [Fact]
    public void An_UNKNOWN_block_agrees_with_everything_on_purpose()
    {
        // NEGATIVE CONTROL, and the most important one in this file. Returning
        // false here would let any change in the set's wire shape silently
        // delete the whole feature — the exact failure mode rounds 1 to 3 spent
        // themselves chasing. Unknown means "not checked", and the caller says
        // so in the log rather than acting on it.
        Assert.True(SituationalSetLocator.Agrees(
            SituationalBlockInfo.Unknown,
            [new(1, 1, "+1.00"), new(2, 2, "+2.00")],
            out var why));
        Assert.Empty(why);
    }

    [Fact]
    public void The_first_set_carrying_a_situational_block_is_the_answer()
    {
        // `itemSetsApply.ts` writes exactly ONE set (0.112.0's second set was
        // rejected by the user), so this is a defensive ordering rather than a
        // live case — but "the first one that HAS the block" is a different
        // rule from "the first one", and a set list that ever grows would tell
        // them apart the hard way.
        var block = SituationalSetLocator.Find(Sets(
            """{"title":"No blocks here","blocks":[{"type":"Starting","items":[]}]}""",
            CoachBuildSyndra));

        Assert.Equal("CoachBuild Syndra Mid", block.SetTitle);
    }
}
