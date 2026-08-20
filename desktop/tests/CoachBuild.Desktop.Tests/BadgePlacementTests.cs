using System.Runtime.ExceptionServices;
using System.Windows;
using System.Windows.Controls;
using CoachBuild.Desktop.Overlay;
using Xunit;
using SituationalDelta = CoachBuild.Core.SituationalDelta;
using WpfPoint = System.Windows.Point;
using WpfSize = System.Windows.Size;

namespace CoachBuild.Desktop.Tests;

/// <summary>
/// DEFECT D — "the badges move when the set changes shape", 2026-08-20.
///
/// <para>Two screenshots from the player's gaming PC, one saved calibration,
/// version 1.0.19 in both:</para>
///
/// <list type="bullet">
/// <item>A CoachBuild set with THREE blocks (<c>Starting / WPA build /
/// Situational</c>): the six pills sit BELOW the situational icons, under the
/// price row.</item>
/// <item>Riot's own <c>AP</c> set with FIVE blocks (<c>Starting Items / Core
/// Build Order / Core Final Build / Situational items that are also good /
/// Boots Options</c>): the three pills sit ABOVE the icons, printed across the
/// section header.</item>
/// </list>
///
/// <para><b>The overlay did not move. The shop did.</b> Both photos are of a
/// monitor, taken by hand at different distances, so absolute pixels are not
/// comparable across them — each set's OWN icon height is the ruler. On that
/// scale the pills sit about 2.1 icon heights BELOW the row centre in the first
/// and about 0.8 ABOVE it in the second, a difference of about 2.9; and the
/// shop's own block pitch, measured on the second photo between the "Core Build
/// Order" and "Core Final Build" headers, is also about 2.9. <b>One block.</b>
/// And the AP set has exactly one more block above its Situational row than the
/// CoachBuild set does. Call it ±0.2 icon heights — the point is not the third
/// decimal, it is that the residual is a whole number of shop blocks and not
/// some arbitrary offset.</para>
///
/// <para>The tests in this file are the code half of that arithmetic: the badge
/// anchor is a pure function of the saved calibration and the slot INDEX, with
/// no term for the number of blocks, the number of deltas, the set's title or
/// anything else about its shape. The apparent movement is entirely the shop
/// row sliding down one block-pitch per block added above it — which no part of
/// this app can observe, because screen capture, OCR and memory reads are
/// excluded by the 1.0.16 policy.</para>
///
/// <para><b>So the desktop cannot fix Defect D.</b> It can only stop making it
/// worse (the WYSIWYG half below, which was a real and separate error) and make
/// the next report readable in one line. The actual fix is to stop the row
/// moving, which belongs in <c>itemSetBody.ts</c>.</para>
/// </summary>
public sealed class BadgePlacementTests
{
    private static readonly DisplayResolution Display = new(1920, 1080, 96, 96, "DISPLAY1");

    /// <summary>The measured shape from round 3's screenshot, not the invented default.</summary>
    private static readonly CalibrationGeometry ItemRow = new(634, 721, 53, 63);

    private static IReadOnlyList<SituationalDelta> SixDeltas() =>
    [
        new(3137, 1.76, "+1.76"),
        new(3020, 0.36, "+0.36"),
        new(4005, 0.32, "+0.32"),
        new(4629, 0.23, "+0.23"),
        new(3009, -0.22, "-0.22"),
        new(3152, -0.27, "-0.27"),
    ];

    private static IReadOnlyList<SituationalDelta> ThreeDeltas() =>
    [
        new(3137, 1.70, "+1.70"),
        new(3020, 1.17, "+1.17"),
        new(4005, -0.61, "-0.61"),
    ];

    // ── The mechanism ────────────────────────────────────────────────────────

    [Fact]
    public void The_badge_anchor_has_NO_term_for_the_sets_shape()
    {
        // THE WHOLE DIAGNOSIS, as arithmetic. Slot i is
        //   (FirstBoxCenterX + i*Spacing - BoxSize/2, CenterY - BoxSize/2, …)
        // and the only inputs are the saved calibration and i. A row of three
        // and a row of six put slot 0 in the SAME place; a set with two blocks
        // above the row and a set with three put slot 0 in the same place,
        // because neither number is an input at all.
        var three = ItemRow.GetSlotRects(3);
        var six = ItemRow.GetSlotRects(6);

        Assert.Equal(3, three.Count);
        Assert.Equal(6, six.Count);
        for (var index = 0; index < three.Count; index++)
        {
            Assert.Equal(three[index], six[index]);
        }

        // Only the LENGTH of the row is data. Where it starts is not.
        Assert.Equal(three[0], six[0]);
    }

    [Fact]
    public void A_live_render_puts_the_pills_in_the_same_place_for_two_differently_shaped_sets()
    {
        // The end-to-end version of the assertion above, through the painter
        // that actually draws in a game. If this ever fails, the overlay really
        // does move with the set and everything the round-4 handoff says about
        // the shop moving instead is wrong.
        RunOnSta(() =>
        {
            var wide = Paint(SixDeltas());
            var narrow = Paint(ThreeDeltas());

            Assert.Equal(6, wide.Count);
            Assert.Equal(3, narrow.Count);
            for (var index = 0; index < narrow.Count; index++)
            {
                // Same pill text width is not assumed — these are different
                // numbers ("+1.76" vs "+1.70", "-0.27" vs "-0.61") — so the
                // CENTRE is the thing that must match, which is what centring
                // on the slot guarantees.
                Assert.Equal(Centre(wide[index]).X, Centre(narrow[index]).X, 3);
                Assert.Equal(Centre(wide[index]).Y, Centre(narrow[index]).Y, 3);
            }
        });
    }

    [Fact]
    public void The_row_length_is_the_only_thing_the_data_decides()
    {
        // The negative control for the two above: something about the badges
        // DOES follow the data, and it is how many there are. A test suite
        // where nothing at all responded to the deltas would pass the two
        // assertions above with the feature deleted.
        RunOnSta(() =>
        {
            Assert.Equal(6, Paint(SixDeltas()).Count);
            Assert.Equal(3, Paint(ThreeDeltas()).Count);
            Assert.Empty(Paint([]));
        });
    }

    // ── WYSIWYG: the half of Defect D the desktop really did cause ───────────

    [Fact]
    public void What_the_player_aligns_in_adjust_mode_is_what_the_game_paints()
    {
        // Through 1.0.19 adjust mode drew a solid pink box AT the slot with the
        // number written inside it, and the live render drew the pill ABOVE the
        // slot (slot.Top - pillHeight - gap). So the player lined up the boxes,
        // exactly as the legend told them to, and the numbers came out roughly
        // a pill-height higher — landing on the shop's section header in the
        // 2026-08-20 AP screenshot. No amount of arrow-key work could converge
        // on that: they would have had to deliberately mis-align the boxes.
        //
        // This asserts the pair against a REAL live render, not against a
        // second copy of the placement arithmetic, because a re-derivation
        // would agree with a preview that disagrees with the game.
        RunOnSta(() =>
        {
            var settingsPath = TempSettings();
            var window = new OverlayWindow(
                new OverlaySettingsStore(settingsPath),
                NullGameWindowLocator.Instance);
            try
            {
                window.ShowInactive();
                window.SetSituationalDeltas(SixDeltas(), "\"CoachBuild Syndra Mid\" — Situational is block 3 of 3 (6 items)");
                window.BeginAdjustment(CalibrationTarget.ItemRow);

                var geometry = window.LastAdjustGeometry;
                Assert.NotNull(geometry);
                var preview = window.LastAdjustBadgeRects;
                Assert.Equal(6, preview.Count);

                var live = Paint(SixDeltas(), geometry!);

                Assert.Equal(preview.Count, live.Count);
                for (var index = 0; index < preview.Count; index++)
                {
                    Assert.Equal(preview[index].Left, live[index].Left, 3);
                    Assert.Equal(preview[index].Top, live[index].Top, 3);
                    Assert.Equal(preview[index].Width, live[index].Width, 3);
                    Assert.Equal(preview[index].Height, live[index].Height, 3);
                }
            }
            finally
            {
                Cleanup(window, settingsPath);
            }
        });
    }

    [Fact]
    public void The_calibrated_box_IS_the_badge_and_not_a_place_above_it()
    {
        // The 1.0.19 rule, pinned as the thing that must NOT come back:
        // `Canvas.SetTop(pill, slot.Top - size.Height - gap)` put the pill
        // entirely outside its own slot. Reinstating it makes both assertions
        // here fail, and the WYSIWYG test above fail with it.
        var slot = new Rect(600, 700, 53, 53);
        var pill = new WpfSize(40, 24);

        var placed = OverlayRenderer.PlaceBadge(slot, pill);

        Assert.Equal(slot.Left + slot.Width / 2, placed.Left + placed.Width / 2, 6);
        Assert.Equal(slot.Top + slot.Height / 2, placed.Top + placed.Height / 2, 6);
        Assert.True(placed.Top >= slot.Top, "the pill must not start above its slot");
        Assert.True(placed.Bottom <= slot.Bottom, "the pill must not run past the bottom of its slot");
    }

    [Fact]
    public void A_pill_taller_than_its_slot_is_still_centred_and_never_off_screen()
    {
        // A tiny calibrated box with a long number in it. Centring can push the
        // top negative, which on a canvas means "off the top of the display" —
        // the clamp that stops that predates round 4 and stays.
        var slot = new Rect(0, 4, 10, 10);
        var placed = OverlayRenderer.PlaceBadge(slot, new WpfSize(60, 30));

        // Centring alone would put the top at 4 + (10-30)/2 = -6.
        Assert.Equal(0d, placed.Top, 6);
        // The horizontal axis is NOT clamped, and must not be: a number that
        // hangs off the left of a badly placed slot is visible and fixable with
        // an arrow key, where one silently pinned to x=0 would look like a
        // calibration that refuses to move.
        Assert.Equal(slot.Left + slot.Width / 2, placed.Left + placed.Width / 2, 6);
        Assert.Equal(-25d, placed.Left, 6);
    }

    [Fact]
    public void The_pill_scales_off_the_slot_so_a_4K_player_gets_the_same_proportions()
    {
        // One expression, shared by the preview and the painter. A second copy
        // would be a second answer to "how big is the number".
        Assert.Equal(53 * 0.34, OverlayRenderer.BadgeFontSize(new Rect(0, 0, 53, 53)), 6);
        Assert.Equal(9d, OverlayRenderer.BadgeFontSize(new Rect(0, 0, 10, 10)), 6);
        Assert.Equal(22d, OverlayRenderer.BadgeFontSize(new Rect(0, 0, 400, 400)), 6);
    }

    // ── Defect E: naming the set, on both surfaces ───────────────────────────

    [Fact]
    public void Adjust_mode_names_the_set_the_numbers_belong_to()
    {
        // DEFECT E. The app writes an item set through the LCU, so it knows
        // what it wrote and when — but there is no LCU read that returns which
        // set is SELECTED in the in-game shop dropdown, and screen capture, OCR
        // and memory reads are excluded by the 1.0.16 policy. It therefore
        // cannot detect that the player is aiming at the wrong row.
        //
        // What it CAN do is say which row it means, where the player is looking
        // while they decide. On 2026-08-20 they calibrated against Riot's "AP"
        // set and nothing on screen told them not to.
        RunOnSta(() =>
        {
            var settingsPath = TempSettings();
            var window = new OverlayWindow(
                new OverlaySettingsStore(settingsPath),
                NullGameWindowLocator.Instance);
            try
            {
                const string label = "\"CoachBuild Syndra Mid\" — Situational is block 3 of 3 (6 items)";
                window.ShowInactive();
                window.SetSituationalDeltas(SixDeltas(), label);
                window.BeginAdjustment(CalibrationTarget.ItemRow);

                var legend = LegendText(window);
                Assert.Contains(label, legend, StringComparison.Ordinal);
                Assert.Contains("Select that set in the shop's dropdown", legend, StringComparison.Ordinal);
                // The block POSITION is in it too, because that is the number
                // that tells two otherwise-identical reports apart.
                Assert.Contains("block 3 of 3", legend, StringComparison.Ordinal);
            }
            finally
            {
                Cleanup(window, settingsPath);
            }
        });
    }

    [Fact]
    public void With_no_set_to_name_adjust_mode_stays_quiet_rather_than_guessing()
    {
        // NEGATIVE CONTROL. An older web build, or any payload whose Situational
        // block could not be located, produces an empty label — and an empty
        // label must not print "select that set", because there is no such set
        // to select. A wrong name is worse than no name for someone hunting a
        // misaligned row.
        RunOnSta(() =>
        {
            var settingsPath = TempSettings();
            var window = new OverlayWindow(
                new OverlaySettingsStore(settingsPath),
                NullGameWindowLocator.Instance);
            try
            {
                window.ShowInactive();
                window.SetSituationalDeltas(SixDeltas(), string.Empty);
                window.BeginAdjustment(CalibrationTarget.ItemRow);

                var legend = LegendText(window);
                Assert.DoesNotContain("Select that set", legend, StringComparison.Ordinal);
                // ...and the rest of the legend is untouched: the player still
                // gets told what the boxes are for.
                Assert.Contains("Line these up with the Situational row", legend, StringComparison.Ordinal);
            }
            finally
            {
                Cleanup(window, settingsPath);
            }
        });
    }

    [Fact]
    public void The_badge_diagnostic_line_says_which_row_it_was_aimed_at()
    {
        // The 2026-08-20 log carried one line, identical on all eleven shop
        // toggles: `badges: 6 shown at 544x904 size 59 pitch 69 …`. It is
        // exactly as true of the 3-block set as of the 5-block one, which is
        // why two screenshots that look completely different produced the same
        // diagnostic and cost a whole round to tell apart. The set and the
        // block position are now on it.
        RunOnSta(() =>
        {
            var settingsPath = TempSettings();
            var store = new OverlaySettingsStore(settingsPath);
            var window = new OverlayWindow(store, NullGameWindowLocator.Instance);
            try
            {
                var lines = new List<string>();
                window.ShowInactive();
                // A calibration has to exist or the row refuses to draw at all,
                // which is a different (and correct) line.
                window.BeginAdjustment(CalibrationTarget.ItemRow);
                window.HandleAdjustKey(System.Windows.Input.Key.Up, step: 10);
                window.HandleAdjustKey(System.Windows.Input.Key.Enter);

                window.Diagnostics = lines.Add;
                window.SetSituationalDeltas(
                    SixDeltas(),
                    "\"CoachBuild Syndra Mid\" — Situational is block 3 of 3 (6 items)");
                window.ApplyState(InGame());
                window.SetShopOpen(true);

                var shown = lines.FirstOrDefault(line =>
                    line.Contains("badges: 6 shown at", StringComparison.Ordinal));
                Assert.NotNull(shown);
                Assert.Contains("CoachBuild Syndra Mid", shown!, StringComparison.Ordinal);
                Assert.Contains("Situational is block 3 of 3", shown!, StringComparison.Ordinal);
            }
            finally
            {
                Cleanup(window, settingsPath);
            }
        });
    }

    [Fact]
    public void A_new_set_LABEL_alone_is_enough_to_repaint()
    {
        // The memo trap, in its label-shaped form. Switching champions can
        // produce the same numbers under a different set — and more to the
        // point, the same numbers under a set whose Situational block has moved
        // from position 5 to position 3 because the database went down. If the
        // label were not part of the early-out, the legend and the diagnostic
        // line would both keep describing the previous set.
        RunOnSta(() =>
        {
            var settingsPath = TempSettings();
            var window = new OverlayWindow(
                new OverlaySettingsStore(settingsPath),
                NullGameWindowLocator.Instance);
            try
            {
                window.ShowInactive();
                window.SetSituationalDeltas(SixDeltas(), "\"X\" — Situational is block 5 of 5 (6 items)");
                window.BeginAdjustment(CalibrationTarget.ItemRow);
                Assert.Contains("block 5 of 5", LegendText(window), StringComparison.Ordinal);

                // Same deltas, different shape.
                window.SetSituationalDeltas(SixDeltas(), "\"X\" — Situational is block 3 of 3 (6 items)");

                Assert.Equal("\"X\" — Situational is block 3 of 3 (6 items)", window.SituationalSetLabel);
                Assert.Contains("block 3 of 3", LegendText(window), StringComparison.Ordinal);
                Assert.DoesNotContain("block 5 of 5", LegendText(window), StringComparison.Ordinal);
            }
            finally
            {
                Cleanup(window, settingsPath);
            }
        });
    }

    // ── helpers ──────────────────────────────────────────────────────────────

    private static WpfPoint Centre(Rect rect) =>
        new(rect.Left + rect.Width / 2, rect.Top + rect.Height / 2);

    /// <summary>Paints one badge row through the real renderer and hands back where the pills landed.</summary>
    private static IReadOnlyList<Rect> Paint(
        IReadOnlyList<SituationalDelta> deltas,
        CalibrationGeometry? geometry = null)
    {
        var renderer = new OverlayRenderer();
        renderer.Render(
            new Canvas(),
            InGame(),
            new OverlaySettings(),
            Display,
            geometry ?? ItemRow,
            new ItemBadgeInput(ShopOpen: true, Deltas: deltas, Geometry: geometry ?? ItemRow));
        return renderer.LastBadgeRects;
    }

    private static OverlayState InGame() => OverlayState.Empty with
    {
        InGame = true,
        ChampionId = 134,
        ChampionName = "Syndra",
        Level = 6,
    };

    private static string LegendText(OverlayWindow window)
    {
        // The legend is the one Border on the canvas whose TextBlock carries
        // the key-help line; the pills are Borders too.
        var canvas = (Canvas)window.Content;
        return canvas.Children.OfType<Border>()
            .Select(border => border.Child)
            .OfType<TextBlock>()
            .Select(text => text.Text)
            .FirstOrDefault(text => text.Contains("Enter: save", StringComparison.Ordinal))
            ?? string.Empty;
    }

    private static string TempSettings() =>
        Path.Combine(Path.GetTempPath(), $"coachbuild-test-{Guid.NewGuid():N}.json");

    private static void Cleanup(OverlayWindow window, string settingsPath)
    {
        try { window.Close(); } catch { /* teardown is not the assertion */ }
        try { if (File.Exists(settingsPath)) File.Delete(settingsPath); } catch { }
    }

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
