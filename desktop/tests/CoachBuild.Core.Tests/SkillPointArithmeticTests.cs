using CoachBuild.Core;
using Xunit;

namespace CoachBuild.Core.Tests;

/// <summary>
/// "How many skill points are banked right now" — the single number the 1.0.12
/// overlay gate rests on.
///
/// <para>The naive form of it, <c>level - (Q+W+E+R)</c>, is not merely
/// imprecise for four champions; it is permanently negative for them. Karma,
/// Elise and Nidalee hold R rank 1 from level 1 without paying for it, and
/// Jayce's Transform is a free rank he never buys. A gate built on the naive
/// sum would have shipped an overlay that can never draw for those four, in any
/// game, for the same silent reason the whole in-game feature was dead before
/// 1.0.11. The free-rank tests below are the ones that would catch that.</para>
///
/// <para>The numbers come from the web app's measured ddragon table
/// (<c>lib/championKit.ts</c>), not from this file's imagination.</para>
/// </summary>
public sealed class SkillPointArithmeticTests
{
    private const int Karma = 43;
    private const int Elise = 60;
    private const int Nidalee = 76;
    private const int Jayce = 126;
    private const int Udyr = 77;
    private const int Aphelios = 523;
    private const int Ahri = 103;

    [Theory]
    // level, Q, W, E, R -> unspent
    [InlineData(1, 0, 0, 0, 0, 1)]  // just spawned: one point waiting
    [InlineData(1, 1, 0, 0, 0, 0)]  // spent it: nothing to advise
    [InlineData(2, 1, 0, 0, 0, 1)]  // levelled again
    [InlineData(6, 3, 1, 1, 0, 1)]  // ult unlocked, not yet taken
    [InlineData(6, 3, 1, 1, 1, 0)]
    [InlineData(18, 5, 5, 5, 3, 0)] // fully spent
    [InlineData(7, 2, 1, 1, 1, 2)]  // banked two, e.g. levelled twice in a fight
    public void A_standard_champion_banks_level_minus_ranks(int level, int q, int w, int e, int r, int expected)
    {
        var state = SkillPointArithmetic.Evaluate(level, [q, w, e, r], ChampionKit.For(Ahri));

        Assert.True(state.Coherent);
        Assert.Equal(expected, state.Unspent);
        Assert.Equal(expected > 0, state.HasUnspentPoint);
    }

    /// <summary>
    /// The test that fails if <c>ChampionKit</c> is deleted. Karma at level 1
    /// who has spent her one point reads Q1 + R1 = two ranks against one level.
    /// Naively that is <c>unspent = -1</c>, and it stays negative for the whole
    /// game — the overlay would never appear for her again.
    /// </summary>
    [Theory]
    [InlineData(Karma)]
    [InlineData(Elise)]
    [InlineData(Nidalee)]
    public void A_free_ultimate_rank_is_not_a_spent_point(int championId)
    {
        var kit = ChampionKit.For(championId);
        Assert.Equal(1, kit.FreeR);

        // Level 1, R granted, Q bought.
        var spent = SkillPointArithmetic.Evaluate(1, [1, 0, 0, 1], kit);
        Assert.True(spent.Coherent);
        Assert.Equal(1, spent.Purchased);
        Assert.Equal(0, spent.Unspent);

        // Level 2, R granted, Q bought, second point still banked.
        var banked = SkillPointArithmetic.Evaluate(2, [1, 0, 0, 1], kit);
        Assert.True(banked.Coherent);
        Assert.True(banked.HasUnspentPoint);
        Assert.Equal(1, banked.Unspent);
    }

    /// <summary>Jayce's Transform is granted at level 1 and never ranked again.</summary>
    [Fact]
    public void Jayces_transform_is_free_and_his_basics_go_to_six()
    {
        var kit = ChampionKit.For(Jayce);
        Assert.Equal(1, kit.FreeR);
        Assert.Equal(6, kit.MaxRankAt(0));
        Assert.Equal(1, kit.MaxRankAt(3));

        var state = SkillPointArithmetic.Evaluate(3, [2, 1, 0, 1], kit);
        Assert.True(state.Coherent);
        Assert.Equal(3, state.Purchased);
        Assert.Equal(0, state.Unspent);
    }

    /// <summary>
    /// Udyr's R is a fourth basic, not an ultimate: six ranks, all bought, no
    /// level gate. Aphelios pays for his R on the ordinary cadence. Both are
    /// exceptional in their CAPS and ordinary in their arithmetic, and getting
    /// that backwards would move them from working to blank.
    /// </summary>
    [Theory]
    [InlineData(Udyr, 6)]
    [InlineData(Aphelios, 3)]
    public void Champions_with_odd_caps_still_pay_for_every_rank(int championId, int maxR)
    {
        var kit = ChampionKit.For(championId);
        Assert.Equal(0, kit.FreeR);
        Assert.Equal(maxR, kit.MaxRankAt(3));

        var state = SkillPointArithmetic.Evaluate(4, [2, 1, 0, 1], kit);
        Assert.Equal(4, state.Purchased);
        Assert.Equal(0, state.Unspent);
    }

    [Fact]
    public void An_unknown_champion_gets_the_standard_kit_not_a_refusal()
    {
        Assert.Same(ChampionKit.Standard, ChampionKit.For(999_999));
        Assert.Same(ChampionKit.Standard, ChampionKit.For(null));
        Assert.Equal(5, ChampionKit.Standard.MaxRankAt(0));
        Assert.Equal(3, ChampionKit.Standard.MaxRankAt(3));
        Assert.False(ChampionKit.Standard.HasFreeRanks);
    }

    /// <summary>
    /// The fail-safe. A champion this build does not know about, that grants a
    /// rank for free, reads as having spent more points than it was given.
    /// That must be REPORTED, not clamped into a confident zero — the caller
    /// degrades to always showing the highlight, because the failure mode of
    /// getting this wrong in the other direction is a feature that silently
    /// disappears for one champion and nobody can explain why.
    /// </summary>
    [Fact]
    public void An_impossible_reading_is_reported_rather_than_clamped_into_a_lie()
    {
        var state = SkillPointArithmetic.Evaluate(1, [1, 0, 0, 1], ChampionKit.Standard);

        Assert.False(state.Coherent);
        Assert.False(state.HasUnspentPoint);
        Assert.Equal(2, state.Purchased);
        Assert.Equal(0, state.Unspent); // never negative on the wire
    }

    /// <summary>
    /// A level cheat (Practice Tool) or a double level-up in a fight banks
    /// several points at once. Indexing the recommendation by LEVEL rather than
    /// by points purchased would recommend the wrong ability for every one of
    /// them.
    /// </summary>
    [Fact]
    public void Several_banked_points_are_counted_individually()
    {
        var state = SkillPointArithmetic.Evaluate(7, [1, 0, 0, 0], ChampionKit.Standard);

        Assert.True(state.Coherent);
        Assert.Equal(1, state.Purchased);
        Assert.Equal(6, state.Unspent);
    }

    [Fact]
    public void Ranks_shorter_than_four_slots_do_not_throw()
    {
        var state = SkillPointArithmetic.Evaluate(3, [1, 1], ChampionKit.Standard);

        Assert.Equal(2, state.Purchased);
        Assert.Equal(1, state.Unspent);
    }
}
