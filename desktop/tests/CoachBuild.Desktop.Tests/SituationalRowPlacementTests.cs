using System.Globalization;
using System.Windows.Input;
using CoachBuild.Desktop.Overlay;
using Xunit;

namespace CoachBuild.Desktop.Tests;

/// <summary>
/// WHERE the situational pills land, and why they landed in the wrong place in
/// the field.
///
/// <para>The 2026-08-20 log from the player's gaming PC repeats one line on
/// every one of eleven shop toggles:</para>
///
/// <code>
/// overlay: badges: 6 shown at 544x904 size 59 pitch 69 on \\.\DISPLAY1 2560x1440@96 source=league
/// </code>
///
/// <para>Their screenshot shows those six pills in a row BELOW the shop's SELL
/// and UNDO buttons, not on the Situational item icons. The first test here is
/// the whole diagnosis: those four numbers are
/// <see cref="CalibrationGeometry.ItemRowScaledDefault"/> for that display, to
/// the pixel — a constant the model documents as "a starting position, not a
/// measurement" and which the item row is supposed to refuse to draw.</para>
/// </summary>
public sealed class SituationalRowPlacementTests
{
    private static readonly DisplayResolution GamingPc = new(2560, 1440, 96, 96, "DISPLAY1");
    private static readonly DisplayResolution Reference = new(1920, 1080, 96, 96, "DISPLAY1");

    [Fact]
    public void The_field_log_line_is_the_untouched_default_to_the_pixel()
    {
        // The evidence, reproduced by arithmetic rather than paraphrased. If
        // this test ever stops matching the log line, the diagnosis behind
        // every other test in this file is wrong and should be re-derived.
        var geometry = CalibrationGeometry.ItemRowScaledDefault(GamingPc);
        var slots = geometry.GetSlotRects(6);
        var first = slots[0];

        Assert.Equal("544", first.Left.ToString("0", CultureInfo.InvariantCulture));
        Assert.Equal("904", first.Top.ToString("0", CultureInfo.InvariantCulture));
        Assert.Equal("59", first.Width.ToString("0", CultureInfo.InvariantCulture));
        Assert.Equal("69", geometry.Spacing.ToString("0", CultureInfo.InvariantCulture));

        // ...and it is NOT the skill-order default, which is the other geometry
        // in the same render and which the same log shows landing correctly
        // (highlight W/E/R at 1128/1190/1252 x 1317, size 57). Two defaults
        // that could be confused for one another would make the log line
        // ambiguous about which one drew.
        var skill = CalibrationGeometry.ScaledDefault(GamingPc);
        Assert.NotEqual(skill.CenterY, geometry.CenterY);
        Assert.NotEqual(skill.Spacing, geometry.Spacing);
    }

    [Fact]
    public void An_item_row_stored_at_the_untouched_default_reads_as_never_positioned()
    {
        // The player's settings.json already holds this entry — the write that
        // produced it is fixed, but nobody is going to hand-edit JSON. Reading
        // it back as "never positioned" is what makes the fix reach them.
        var root = Temp();
        try
        {
            var store = new OverlaySettingsStore(Path.Combine(root, "desktop-settings.json"));
            store.SaveCalibration(
                CalibrationTarget.ItemRow,
                GamingPc,
                CalibrationGeometry.ItemRowScaledDefault(GamingPc));

            Assert.Null(store.TryLoadCalibration(CalibrationTarget.ItemRow, GamingPc));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void A_row_one_pixel_off_the_default_is_a_measurement_and_is_kept()
    {
        // The negative control for the test above. Without it, "the item row
        // never loads" would pass just as well as "the untouched default never
        // loads", and the feature would be quietly dead for everyone who HAS
        // calibrated.
        var root = Temp();
        try
        {
            var store = new OverlaySettingsStore(Path.Combine(root, "desktop-settings.json"));
            var moved = CalibrationGeometry.ItemRowScaledDefault(GamingPc) with { CenterY = 721 };
            store.SaveCalibration(CalibrationTarget.ItemRow, GamingPc, moved);

            Assert.Equal(moved, store.TryLoadCalibration(CalibrationTarget.ItemRow, GamingPc));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void Only_the_item_row_is_treated_this_way()
    {
        // Scope, asserted. The ability HUD's default IS a measurement — the
        // bar does not move — so a skill-order calibration that happens to
        // equal it is a legitimate saved value and must survive.
        var root = Temp();
        try
        {
            var store = new OverlaySettingsStore(Path.Combine(root, "desktop-settings.json"));
            var skillDefault = CalibrationGeometry.ScaledDefault(GamingPc);
            store.SaveCalibration(CalibrationTarget.SkillOrder, GamingPc, skillDefault);

            Assert.Equal(skillDefault, store.TryLoadCalibration(CalibrationTarget.SkillOrder, GamingPc));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void Visiting_the_item_row_and_pressing_Enter_saves_nothing()
    {
        // THE WRITE PATH THAT CAUSED THIS. Tray -> "Adjust item numbers" seeds
        // a working copy from LoadCalibrationOrDefault, and through 1.0.18
        // Enter persisted it whether or not the player had moved a single box.
        // Round 1 and round 2 both told this player to use the tray items, so
        // this is not a hypothetical route.
        RunOnSta(window =>
        {
            var lines = new List<string>();
            window.Diagnostics = lines.Add;
            window.ShowInactive();
            window.BeginAdjustment(CalibrationTarget.ItemRow);
            Assert.True(window.IsAdjusting);

            window.HandleAdjustKey(Key.Enter);

            Assert.False(window.IsAdjusting);
            Assert.Contains(lines, line => line.Contains("saved nothing", StringComparison.Ordinal));
            Assert.DoesNotContain(lines, line => line.Contains("overlay: saved ", StringComparison.Ordinal));
        });
    }

    [Fact]
    public void Moving_the_item_row_then_pressing_Enter_saves_it()
    {
        // The other half, without which "saves nothing" could be implemented
        // by never saving at all.
        RunOnSta(window =>
        {
            var lines = new List<string>();
            window.Diagnostics = lines.Add;
            window.ShowInactive();
            window.BeginAdjustment(CalibrationTarget.ItemRow);

            window.HandleAdjustKey(Key.Up, step: 10);
            window.HandleAdjustKey(Key.Enter);

            Assert.False(window.IsAdjusting);
            Assert.Contains(
                lines,
                line => line.Contains("overlay: saved the situational item numbers", StringComparison.Ordinal));
            Assert.DoesNotContain(lines, line => line.Contains("saved nothing", StringComparison.Ordinal));
        });
    }

    [Fact]
    public void Tab_still_commits_both_overlays_when_both_were_moved()
    {
        // The guarantee this change must not break: Tab exists so a player can
        // move both overlays in one visit, and saving only the visible one
        // would silently drop half their work. Narrowing "touched" from
        // "visited" to "moved" must not narrow it to "on screen at Enter".
        RunOnSta(window =>
        {
            var lines = new List<string>();
            window.Diagnostics = lines.Add;
            window.ShowInactive();
            window.BeginAdjustment(CalibrationTarget.SkillOrder);

            window.HandleAdjustKey(Key.Left, step: 10);
            window.HandleAdjustKey(Key.Tab);
            Assert.Equal(CalibrationTarget.ItemRow, window.AdjustTarget);
            window.HandleAdjustKey(Key.Down, step: 10);
            window.HandleAdjustKey(Key.Enter);

            Assert.Contains(
                lines,
                line => line.Contains("overlay: saved the skill-order box", StringComparison.Ordinal));
            Assert.Contains(
                lines,
                line => line.Contains("overlay: saved the situational item numbers", StringComparison.Ordinal));
        });
    }

    [Fact]
    public void A_target_that_was_only_Tabbed_through_is_not_saved()
    {
        // The exact shape of the field bug: the player adjusted the ability bar
        // (the same log shows a skill box that is NOT the default), Tabbed to
        // look at the item row, and pressed Enter.
        RunOnSta(window =>
        {
            var lines = new List<string>();
            window.Diagnostics = lines.Add;
            window.ShowInactive();
            window.BeginAdjustment(CalibrationTarget.SkillOrder);

            window.HandleAdjustKey(Key.Left, step: 10);
            window.HandleAdjustKey(Key.Tab);
            window.HandleAdjustKey(Key.Enter);

            Assert.Contains(
                lines,
                line => line.Contains("overlay: saved the skill-order box", StringComparison.Ordinal));
            Assert.DoesNotContain(
                lines,
                line => line.Contains("overlay: saved the situational item numbers", StringComparison.Ordinal));
        });
    }

    [Fact]
    public void The_reference_constant_is_not_claimed_to_be_a_measurement()
    {
        // A guard on the one thing that would make every number above a lie:
        // if someone later "fixes" the default by moving the constant, the
        // scaled value on the player's display changes and the healing read in
        // TryLoadCalibration silently stops matching their stored entry. This
        // pins the pair together.
        Assert.Equal(new CalibrationGeometry(430, 700, 44, 52), CalibrationGeometry.ItemRowReference);
        Assert.Equal(
            CalibrationGeometry.ItemRowReference,
            CalibrationGeometry.ItemRowScaledDefault(Reference));
    }

    private static string Temp()
    {
        var root = Path.Combine(Path.GetTempPath(), $"coachbuild-rowplacement-{Guid.NewGuid():N}");
        Directory.CreateDirectory(root);
        return root;
    }

    private static void RunOnSta(Action<OverlayWindow> body)
    {
        Exception? failure = null;
        var thread = new Thread(() =>
        {
            var settingsPath = Path.Combine(Path.GetTempPath(), $"coachbuild-test-{Guid.NewGuid():N}.json");
            OverlayWindow? window = null;
            try
            {
                window = new OverlayWindow(new OverlaySettingsStore(settingsPath), NullGameWindowLocator.Instance);
                body(window);
            }
            catch (Exception error)
            {
                failure = error;
            }
            finally
            {
                // Teardown is deliberately non-fatal: round 2 saw a one-off
                // failure in this STA/WPF harness that was almost certainly a
                // teardown throw, not an assertion.
                try { window?.Close(); } catch { }
                try { if (File.Exists(settingsPath)) File.Delete(settingsPath); } catch { }
            }
        });
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();
        thread.Join();
        if (failure is not null) throw failure;
    }
}
