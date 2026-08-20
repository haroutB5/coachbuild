using System.Runtime.ExceptionServices;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using CoachBuild.Desktop.Overlay;
using Xunit;
// Core and Desktop.Overlay both declare OverlayAbility / OverlaySkillOrder.
// The renderer takes the Desktop ones; SituationalDelta only exists in Core.
using SituationalDelta = CoachBuild.Core.SituationalDelta;

namespace CoachBuild.Desktop.Tests;

public sealed class SituationalBadgeRenderTests
{
    private const int AhriId = 103;
    private static readonly DisplayResolution Display = new(1920, 1080, 96, 96, "DISPLAY1");
    private static readonly CalibrationGeometry ItemRow = new(430, 700, 44, 52);

    private static IReadOnlyList<SituationalDelta> Galio() =>
    [
        new(3158, 4.27, "+4.27"),
        new(3009, 2.79, "+2.79"),
        new(3047, 1.13, "+1.13"),
        new(4645, 0.45, "+0.45"),
        new(4646, 0.39, "+0.39"),
        new(3068, -0.06, "-0.06"),
    ];

    [Fact]
    public void Opening_the_shop_changes_the_render_signature()
    {
        // THE memo trap. Opening the shop changes no rank, no level and no
        // geometry, so without the badges in the signature the renderer would
        // report "nothing to repaint" about the entire feature - the same shape
        // as the 1.0.12 bug where LEVEL was not in the signature.
        var renderer = new OverlayRenderer();
        var state = State();

        var shut = renderer.CreateSignature(state, Display, null, Closed());
        var open = renderer.CreateSignature(state, Display, null, Open());

        Assert.NotEqual(shut, open);
    }

    [Fact]
    public void Every_visual_input_of_a_badge_row_is_in_the_signature()
    {
        var renderer = new OverlayRenderer();
        var state = State();
        var baseline = renderer.CreateSignature(state, Display, null, Open());

        // A different number.
        var reworded = Open() with
        {
            Deltas = [new SituationalDelta(3158, 4.27, "+4.28"), .. Galio().Skip(1)],
        };
        Assert.NotEqual(baseline, renderer.CreateSignature(state, Display, null, reworded));

        // A different item in the same slot.
        var reordered = Open() with { Deltas = Galio().Reverse().ToList() };
        Assert.NotEqual(baseline, renderer.CreateSignature(state, Display, null, reordered));

        // A shorter row.
        var shorter = Open() with { Deltas = Galio().Take(3).ToList() };
        Assert.NotEqual(baseline, renderer.CreateSignature(state, Display, null, shorter));

        // The row moved.
        var moved = Open() with { Geometry = ItemRow with { CenterY = ItemRow.CenterY + 40 } };
        Assert.NotEqual(baseline, renderer.CreateSignature(state, Display, null, moved));

        // A sign flip, which is the only thing wpa drives.
        var flipped = Open() with
        {
            Deltas = [new SituationalDelta(3158, -4.27, "+4.27"), .. Galio().Skip(1)],
        };
        Assert.NotEqual(baseline, renderer.CreateSignature(state, Display, null, flipped));

        // POSITIVE CONTROL: identical input, identical signature. Without this
        // the five assertions above would also pass for a signature that simply
        // never repeats.
        Assert.Equal(baseline, renderer.CreateSignature(state, Display, null, Open()));
    }

    [Fact]
    public void An_uncalibrated_item_row_draws_nothing_at_all()
    {
        // There is no honest default position: the shop panel is draggable,
        // resizable and scaled by a setting whose own two config files disagree
        // with each other. "We do not know where it is" must mean "draw
        // nothing", never "guess".
        var input = new ItemBadgeInput(ShopOpen: true, Deltas: Galio(), Geometry: null);
        Assert.False(input.WillDraw);
        Assert.Empty(input.SignatureKey());

        var model = new OverlayRenderer().BuildModel(State(), Display, null, input);
        Assert.Empty(model.Badges!);
    }

    [Fact]
    public void A_shut_shop_and_an_empty_list_both_draw_nothing()
    {
        Assert.False(Closed().WillDraw);
        Assert.False((Open() with { Deltas = Array.Empty<SituationalDelta>() }).WillDraw);
        Assert.False(ItemBadgeInput.None.WillDraw);
    }

    [Fact]
    public void There_is_one_badge_per_delta_never_a_fixed_six()
    {
        // Drawing six badges over a four-item row would put two of them over
        // whatever sits to the right of it.
        var renderer = new OverlayRenderer();
        foreach (var count in new[] { 1, 2, 3, 4, 5, 6 })
        {
            var model = renderer.BuildModel(
                State(), Display, null, Open() with { Deltas = Galio().Take(count).ToList() });
            Assert.Equal(count, model.Badges!.Count);
        }
    }

    [Fact]
    public void Badges_sit_on_the_calibrated_pitch_and_carry_the_webs_text_verbatim()
    {
        var model = new OverlayRenderer().BuildModel(State(), Display, null, Open());
        var badges = model.Badges!;

        Assert.Equal(6, badges.Count);
        Assert.Equal(["+4.27", "+2.79", "+1.13", "+0.45", "+0.39", "-0.06"], badges.Select(badge => badge.Text));
        Assert.Equal([1, 1, 1, 1, 1, -1], badges.Select(badge => badge.Sign));

        for (var index = 0; index < badges.Count; index++)
        {
            Assert.Equal(
                ItemRow.FirstBoxCenterX + index * ItemRow.Spacing - ItemRow.BoxSize / 2,
                badges[index].Slot.Left,
                3);
            Assert.Equal(ItemRow.BoxSize, badges[index].Slot.Width, 3);
        }

        // The pitch is the SAVED pitch, so the boxes the player lined up are the
        // boxes that get drawn.
        Assert.Equal(ItemRow.Spacing, badges[1].Slot.Left - badges[0].Slot.Left, 3);
    }

    [Fact]
    public void A_blank_delta_draws_nothing_and_never_plus_zero()
    {
        var model = new OverlayRenderer().BuildModel(State(), Display, null, Open() with
        {
            Deltas = [new SituationalDelta(3158, 4.27, "+4.27"), new SituationalDelta(3009, 0, "  ")],
        });

        var badge = Assert.Single(model.Badges!);
        Assert.Equal("+4.27", badge.Text);
        Assert.DoesNotContain(model.Badges!, entry => entry.Text.Contains("0.00", StringComparison.Ordinal));
    }

    [Fact]
    public void The_numbers_are_painted_even_when_there_is_no_skill_order_to_highlight()
    {
        // `Visible` means "there is a skill order to highlight", which has
        // nothing to do with whether the shop is open. A player with no
        // skill-order data must still get their item numbers.
        RunOnSta(() =>
        {
            var canvas = new Canvas();
            var renderer = new OverlayRenderer();
            var blank = State() with
            {
                SkillOrder = new OverlaySkillOrder(Array.Empty<OverlayAbility>(), 0, false),
            };

            Assert.True(renderer.Render(canvas, blank, new OverlaySettings(), Display, null, Open()));
            Assert.False(renderer.LastModel!.Visible);
            Assert.Equal(6, canvas.Children.Count);
            Assert.All(canvas.Children.Cast<UIElement>(), child => Assert.IsType<Border>(child));
        });
    }

    [Fact]
    public void Positive_and_negative_are_told_apart_by_colour_AND_by_the_sign_in_the_text()
    {
        RunOnSta(() =>
        {
            var canvas = new Canvas();
            new OverlayRenderer().Render(canvas, State(), new OverlaySettings(), Display, null, Open());

            var pills = canvas.Children.Cast<UIElement>().OfType<Border>()
                .Where(border => border.Child is TextBlock text && text.Text.Contains('.', StringComparison.Ordinal))
                .ToList();
            Assert.Equal(6, pills.Count);

            var inks = pills
                .Select(pill => ((SolidColorBrush)((TextBlock)pill.Child).Foreground).Color)
                .ToList();
            Assert.NotEqual(inks[0], inks[5]);

            // Colour alone is not enough: the sign character has to survive a
            // colour-blind player and a screenshot.
            Assert.StartsWith("+", ((TextBlock)pills[0].Child).Text, StringComparison.Ordinal);
            Assert.StartsWith("-", ((TextBlock)pills[5].Child).Text, StringComparison.Ordinal);

            // DELIBERATELY CHANGED IN ROUND 4, and this is the guardian of the
            // rule that changed. It used to assert the opposite — that every
            // pill sits entirely ABOVE its slot — on the promise that the
            // number would then cover "neither the item icon nor the price the
            // shop prints under it".
            //
            // That promise could not be kept and it cost the calibration. There
            // is no free space above a League shop row: the space above an item
            // row is the next block's section header, and the player's
            // 2026-08-20 screenshot of Riot's "AP" set shows all three pills
            // printed across the words "Situational items that are also good".
            // Worse, adjust mode drew its alignment boxes AT the slot and told
            // the player to line THOSE up, so what they aligned was a pill-
            // height away from what they got and no amount of arrow-key work
            // could converge.
            //
            // The pill is now CENTRED on the slot, which makes the calibrated
            // box and the printed number the same object. Where the number sits
            // relative to the icon is the player's decision (arrow keys), not a
            // constant this file invents.
            var slots = ItemRow.GetSlotRects(6);
            for (var index = 0; index < pills.Count; index++)
            {
                pills[index].Measure(new System.Windows.Size(
                    double.PositiveInfinity, double.PositiveInfinity));
                var size = pills[index].DesiredSize;
                var top = Canvas.GetTop(pills[index]);
                var left = Canvas.GetLeft(pills[index]);
                Assert.Equal(
                    slots[index].Top + slots[index].Height / 2,
                    top + size.Height / 2,
                    3);
                Assert.Equal(
                    slots[index].Left + slots[index].Width / 2,
                    left + size.Width / 2,
                    3);
                Assert.False(pills[index].IsHitTestVisible);
            }
        });
    }

    [Fact]
    public void Slot_rects_share_one_implementation_with_the_ability_bar()
    {
        var geometry = new CalibrationGeometry(830, 1010, 48, 68);
        Assert.Equal(geometry.GetAbilityRects(), geometry.GetSlotRects(4));
        Assert.Equal(4, geometry.GetAbilityRects().Count);
        Assert.Empty(geometry.GetSlotRects(0));
        Assert.Empty(geometry.GetSlotRects(-3));
        Assert.Equal(6, geometry.GetSlotRects(6).Count);
    }

    [Fact]
    public void The_item_rows_default_scales_with_the_display_and_is_not_the_ability_bars()
    {
        var fourK = new DisplayResolution(3840, 2160, 192, 192, "DISPLAY1");
        var scaled = CalibrationGeometry.ItemRowScaledDefault(fourK);

        Assert.Equal(CalibrationGeometry.ItemRowReference.FirstBoxCenterX * 2, scaled.FirstBoxCenterX, 3);
        Assert.Equal(CalibrationGeometry.ItemRowReference.CenterY * 2, scaled.CenterY, 3);
        Assert.NotEqual(CalibrationGeometry.ScaledDefault(fourK), scaled);
    }

    private static ItemBadgeInput Open() => new(ShopOpen: true, Deltas: Galio(), Geometry: ItemRow);

    private static ItemBadgeInput Closed() => new(ShopOpen: false, Deltas: Galio(), Geometry: ItemRow);

    private static OverlayState State() => new(
        InGame: true,
        ChampionName: "Ahri",
        ChampionId: AhriId,
        Level: 1,
        AbilityRanks: new Dictionary<OverlayAbility, int>
        {
            [OverlayAbility.Q] = 0,
            [OverlayAbility.W] = 0,
            [OverlayAbility.E] = 0,
            [OverlayAbility.R] = 0,
        },
        SkillOrder: new OverlaySkillOrder(
            [OverlayAbility.Q, OverlayAbility.W, OverlayAbility.E, OverlayAbility.Q],
            ObservedLevels: 4,
            Completed: false),
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
