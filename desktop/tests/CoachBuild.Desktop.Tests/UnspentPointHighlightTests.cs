using System.Runtime.ExceptionServices;
using CoachBuild.Desktop.Overlay;
using Xunit;

namespace CoachBuild.Desktop.Tests;

/// <summary>
/// The user's third report on 1.0.11: <i>"it should only appear when skill
/// level up happens."</i>
///
/// <para>1.0.11 drew the pink box for the whole game. It sat on the next
/// recommended ability permanently, whether or not there was a point to spend,
/// so it was decoration rather than a prompt.</para>
///
/// <para><b>The trap this suite exists to avoid.</b> v1.0.6 already shipped
/// "render only while a point is unspent" and it failed in the field, because
/// the sampler behind it ran at 750 ms–1.5 s while the real unspent window is
/// often a fraction of a second — users effectively never saw it, and the gate
/// was reverted. Correctness of the gate is therefore only half of this; the
/// cadence tests in <see cref="LiveGameLifecycleTests"/> are the other half,
/// and neither is sufficient alone.</para>
///
/// <para>Every test here fails against 1.0.11, whose <c>NextAbility()</c>
/// returned an ability regardless of banked points.</para>
/// </summary>
public sealed class UnspentPointHighlightTests
{
    private const int Ahri = 103;
    private const int Karma = 43;

    /// <summary>
    /// A LEGAL 18-step order: exactly 5 Q, 5 W, 5 E and 3 R, with the ultimate
    /// at levels 6, 11 and 16.
    ///
    /// <para>Deliberately not <c>index % 4</c>, which is the obvious fixture and
    /// is wrong: it names R four times, one past a standard champion's cap, so
    /// a full-game walk runs out of legal ranks before level 18 and the test
    /// fails for a reason that has nothing to do with the code under test.</para>
    /// </summary>
    private static readonly OverlayAbility[] Order =
    [
        OverlayAbility.Q, OverlayAbility.W, OverlayAbility.E, OverlayAbility.Q,
        OverlayAbility.Q, OverlayAbility.R, OverlayAbility.Q, OverlayAbility.E,
        OverlayAbility.Q, OverlayAbility.E, OverlayAbility.R, OverlayAbility.E,
        OverlayAbility.E, OverlayAbility.W, OverlayAbility.W, OverlayAbility.R,
        OverlayAbility.W, OverlayAbility.W,
    ];

    // -------------------------------------------------------- the whole ask

    /// <summary>
    /// The exact cycle the user described, on the champion in their screenshot:
    /// level 1 with the point unspent shows a box, spending it takes the box
    /// away, the next level-up brings it back on the NEXT ability.
    /// </summary>
    [Fact]
    public void The_box_appears_on_level_up_and_goes_away_when_the_point_is_spent()
    {
        Assert.Equal(OverlayAbility.Q, State(level: 1, 0, 0, 0, 0).NextAbility());

        // 1.0.11 answered Q here too. That is the defect.
        Assert.Null(State(level: 1, 1, 0, 0, 0).NextAbility());

        Assert.Equal(OverlayAbility.W, State(level: 2, 1, 0, 0, 0).NextAbility());
        Assert.Null(State(level: 2, 1, 1, 0, 0).NextAbility());
        Assert.Equal(OverlayAbility.E, State(level: 3, 1, 1, 0, 0).NextAbility());
    }

    /// <summary>
    /// A whole game, level 1 to 18, following the recommendation exactly. The
    /// box must be showable at exactly 18 moments and hidden at the other 18.
    /// A gate that is merely "usually right" passes single-case tests and fails
    /// this one.
    /// </summary>
    [Fact]
    public void Across_a_full_game_the_box_is_shown_only_between_level_up_and_spend()
    {
        var ranks = new[] { 0, 0, 0, 0 };
        var shown = 0;
        var hidden = 0;

        for (var level = 1; level <= 18; level++)
        {
            var banked = State(level, ranks[0], ranks[1], ranks[2], ranks[3]);
            var next = banked.NextAbility();
            Assert.NotNull(next);
            Assert.True(banked.HasPointToSpend);
            shown++;

            ranks[(int)next!.Value]++;
            var spent = State(level, ranks[0], ranks[1], ranks[2], ranks[3]);
            Assert.Null(spent.NextAbility());
            Assert.False(spent.HasPointToSpend);
            hidden++;
        }

        Assert.Equal(18, shown);
        Assert.Equal(18, hidden);
        // Every point placed, so the last state is a maxed champion.
        Assert.Equal(18, ranks.Sum());
    }

    [Fact]
    public void A_fully_levelled_champion_with_nothing_banked_shows_nothing()
    {
        var state = State(level: 18, 5, 5, 5, 3);

        Assert.False(state.HasPointToSpend);
        Assert.Null(state.NextAbility());
    }

    /// <summary>
    /// Pre-level-1 / not-yet-populated. Live Client Data answers before the
    /// game really starts and <c>level</c> can read 0; that is not a banked
    /// point and must not draw anything.
    /// </summary>
    [Fact]
    public void A_level_zero_reading_is_not_a_banked_point()
    {
        var state = State(level: 0, 0, 0, 0, 0);

        Assert.Equal(0, state.Points.Level);
        Assert.False(state.HasPointToSpend);
        Assert.Null(state.NextAbility());
    }

    /// <summary>
    /// Two levels gained during a fight, nothing spent yet: both points are
    /// banked, and the recommendation is for the FIRST of them.
    /// </summary>
    [Fact]
    public void Banked_points_recommend_the_first_of_them()
    {
        var state = State(level: 3, 1, 0, 0, 0);

        Assert.Equal(2, state.Points.Unspent);
        Assert.Equal(OverlayAbility.W, state.NextAbility());
    }

    // --------------------------------------------------- champions with kits

    /// <summary>
    /// Karma holds R:1 from level 1 without paying for it. On the naive
    /// <c>level - (Q+W+E+R)</c> she is one point overdrawn at every level of
    /// every game, so an unspent gate would hide her box permanently — a
    /// silent, champion-specific version of the exact bug 1.0.11 fixed.
    /// </summary>
    [Fact]
    public void Karma_is_not_permanently_hidden_by_her_free_ultimate_rank()
    {
        // Level 1, R granted, nothing bought: a point is waiting.
        var banked = State(level: 1, 0, 0, 0, 1, championId: Karma);
        Assert.True(banked.HasPointToSpend);
        Assert.Equal(OverlayAbility.Q, banked.NextAbility());

        // She spends it on Q. Now nothing is waiting.
        var spent = State(level: 1, 1, 0, 0, 1, championId: Karma);
        Assert.False(spent.HasPointToSpend);
        Assert.Null(spent.NextAbility());

        // ...and the index is by PURCHASED points, so level 2 recommends the
        // second entry in the order, not the third.
        Assert.Equal(OverlayAbility.W, State(level: 2, 1, 0, 0, 1, championId: Karma).NextAbility());
    }

    /// <summary>
    /// The fail-safe, stated as behaviour. A champion whose free rank this
    /// build does not know about must degrade to the 1.0.11 always-on box, not
    /// to silence. Ahri is used with an impossible rank set precisely because
    /// she is standard: this is the shape an unknown reworked champion takes.
    /// </summary>
    [Fact]
    public void An_incoherent_reading_degrades_to_always_on_rather_than_to_nothing()
    {
        var state = State(level: 1, 1, 0, 0, 1, championId: Ahri);

        Assert.False(state.Points.Coherent);
        Assert.True(state.HasPointToSpend);
        Assert.NotNull(state.NextAbility());
    }

    // ------------------------------------------------------------- deviation

    /// <summary>
    /// The player ignored the recommendation and maxed W early, so the order's
    /// next entry names an ability that cannot take another rank. Pointing at
    /// nothing is the wrong answer; the next entry that CAN take a rank is the
    /// right one.
    /// </summary>
    [Fact]
    public void A_capped_ability_in_the_order_is_stepped_over_not_refused()
    {
        // Purchased = 6, so the order says Q. Give Q its cap and the
        // recommendation must move on to the next entry rather than vanish.
        var state = State(level: 7, 5, 0, 1, 0);

        Assert.Equal(6, state.Points.Purchased);
        Assert.Equal(1, state.Points.Unspent);
        Assert.Equal(OverlayAbility.Q, state.SkillOrder.Order[6]);
        Assert.Equal(OverlayAbility.E, state.NextAbility());
    }

    /// <summary>R's cap is 3 for a standard champion, not 5.</summary>
    [Fact]
    public void The_ultimate_cap_is_the_champions_own_not_a_constant_five()
    {
        // Purchased 10 -> order[10] is R, and R is already at its cap of 3.
        // A hardcoded "capped means rank >= 5" would recommend a fourth R.
        var state = State(level: 11, 4, 0, 3, 3);

        Assert.Equal(10, state.Points.Purchased);
        Assert.Equal(OverlayAbility.R, state.SkillOrder.Order[10]);
        Assert.Equal(OverlayAbility.E, state.NextAbility());
    }

    // -------------------------------------------------------------- renderer

    /// <summary>
    /// The renderer and the log line must not be able to disagree. Through
    /// 1.0.11 <c>OverlayRenderer</c> carried its own copy of the arithmetic, so
    /// the pixels and <c>DescribeRenderOutcome</c> were two independent answers
    /// to one question — and the unspent gate would have had to be added to
    /// both, correctly, twice.
    /// </summary>
    [Theory]
    [InlineData(1, 0, 0, 0, 0)]
    [InlineData(1, 1, 0, 0, 0)]
    [InlineData(6, 3, 1, 1, 0)]
    [InlineData(6, 3, 1, 1, 1)]
    [InlineData(18, 5, 5, 5, 3)]
    [InlineData(7, 5, 0, 1, 0)]
    public void The_rendered_model_and_the_state_agree_on_the_ability(int level, int q, int w, int e, int r)
    {
        var state = State(level, q, w, e, r);
        var display = new DisplayResolution(2560, 1440, 96, 96);
        var model = new OverlayRenderer().BuildModel(state, display);

        Assert.Equal(state.Normalize().NextAbility(), model.HighlightedAbility);
    }

    /// <summary>
    /// THE memoisation trap. A level-up changes nothing else about the render
    /// inputs — the ranks are identical, that is the whole point of a banked
    /// point — so a signature without <c>Level</c> reports "nothing to repaint"
    /// about the one frame the user is waiting for. This fails against a
    /// signature built the 1.0.11 way.
    /// </summary>
    [Fact]
    public void A_level_up_alone_invalidates_the_render_memo()
    {
        var renderer = new OverlayRenderer();
        var display = new DisplayResolution(2560, 1440, 96, 96);

        var spent = renderer.CreateSignature(State(level: 1, 1, 0, 0, 0), display);
        var levelled = renderer.CreateSignature(State(level: 2, 1, 0, 0, 0), display);

        Assert.NotEqual(spent, levelled);
    }

    // ----------------------------------------------------------- the window

    /// <summary>
    /// End to end on the real window: the log names the wait, and
    /// <c>IsDrawingHighlight</c> is false while nothing is banked. Before
    /// 1.0.12 the log had no vocabulary for this state at all.
    /// </summary>
    [Fact]
    public void The_window_reports_waiting_for_a_level_up_and_draws_nothing()
    {
        RunOnSta(() =>
        {
            var settingsPath = Path.Combine(Path.GetTempPath(), $"coachbuild-test-{Guid.NewGuid():N}.json");
            var lines = new List<string>();
            var window = new OverlayWindow(new OverlaySettingsStore(settingsPath))
            {
                Diagnostics = lines.Add,
            };
            try
            {
                window.SetOverlayVisible(true);
                window.ShowInactive();

                window.ApplyState(State(level: 1, 0, 0, 0, 0));
                Assert.True(window.IsDrawingHighlight);
                Assert.True(window.HasRenderableSkillOrder);

                window.ApplyState(State(level: 1, 1, 0, 0, 0));
                Assert.False(window.IsDrawingHighlight);
                // The hint about exclusive fullscreen must still be able to
                // fire: the user SHOULD be seeing our pixels in this game.
                Assert.True(window.HasRenderableSkillOrder);
                Assert.Contains(lines, line => line.Contains("highlight hidden", StringComparison.Ordinal));
                Assert.Contains(lines, line => line.Contains("waiting-level-up", StringComparison.Ordinal));

                window.ApplyState(State(level: 2, 1, 0, 0, 0));
                Assert.True(window.IsDrawingHighlight);
            }
            finally
            {
                window.Close();
                if (File.Exists(settingsPath)) File.Delete(settingsPath);
            }
        });
    }

    // ---------------------------------------------------------------- helpers

    private static OverlayState State(int level, int q, int w, int e, int r, int championId = Ahri) => new(
        InGame: true,
        ChampionName: "Ahri",
        ChampionId: championId,
        Level: level,
        AbilityRanks: new Dictionary<OverlayAbility, int>
        {
            [OverlayAbility.Q] = q,
            [OverlayAbility.W] = w,
            [OverlayAbility.E] = e,
            [OverlayAbility.R] = r,
        },
        SkillOrder: new OverlaySkillOrder(Order, 18, Completed: true, "published"),
        Lane: "MID",
        IsLaneAuto: false);

    private static void RunOnSta(Action action)
    {
        Exception? failure = null;
        var thread = new Thread(() =>
        {
            try { action(); }
            catch (Exception exception) { failure = exception; }
        });
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();
        thread.Join();
        if (failure is not null) ExceptionDispatchInfo.Capture(failure).Throw();
    }
}
