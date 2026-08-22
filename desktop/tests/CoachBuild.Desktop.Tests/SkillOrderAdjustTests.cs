using System.Windows.Input;
using CoachBuild.Desktop.Overlay;
using Xunit;

namespace CoachBuild.Desktop.Tests;

/// <summary>
/// Adjust mode, after the item-number overlay was removed in 1.0.23.
///
/// <para><b>Why this file exists.</b> The rules below were previously pinned by
/// <c>SituationalRowPlacementTests</c>, because that is where they were WRITTEN:
/// "nothing is saved unless you moved it" was added in 1.0.19 to stop the item
/// row persisting an invented default as though the player had measured it.
/// The item row is gone; the rule is not, it applies to the skill-order box
/// too, and deleting its only coverage along with the feature that motivated it
/// is how a guarantee quietly stops holding.</para>
///
/// <para>The single-target collapse is also asserted here: there is one thing
/// to adjust now, Tab no longer switches anything, and the log must not offer
/// the player a second target that does not exist.</para>
/// </summary>
public sealed class SkillOrderAdjustTests
{
    [Fact]
    public void Opening_adjust_mode_and_pressing_Enter_saves_nothing()
    {
        RunOnSta(window =>
        {
            var lines = new List<string>();
            window.Diagnostics = lines.Add;
            window.ShowInactive();
            window.BeginAdjustment();
            Assert.True(window.IsAdjusting);

            window.HandleAdjustKey(Key.Enter);

            Assert.False(window.IsAdjusting);
            Assert.Contains(lines, line => line.Contains("saved nothing", StringComparison.Ordinal));
            Assert.DoesNotContain(lines, line => line.Contains("overlay: saved the", StringComparison.Ordinal));
        });
    }

    [Fact]
    public void Moving_the_box_then_pressing_Enter_saves_it()
    {
        // The other half, without which "saves nothing" could be implemented by
        // never saving at all.
        RunOnSta(window =>
        {
            var lines = new List<string>();
            window.Diagnostics = lines.Add;
            window.ShowInactive();
            window.BeginAdjustment();

            window.HandleAdjustKey(Key.Up, step: 10);
            window.HandleAdjustKey(Key.Enter);

            Assert.False(window.IsAdjusting);
            Assert.Contains(
                lines,
                line => line.Contains("overlay: saved the skill-order box", StringComparison.Ordinal));
            Assert.DoesNotContain(lines, line => line.Contains("saved nothing", StringComparison.Ordinal));
        });
    }

    [Fact]
    public void Esc_discards_a_move_instead_of_committing_it()
    {
        RunOnSta(window =>
        {
            var lines = new List<string>();
            window.Diagnostics = lines.Add;
            window.ShowInactive();
            window.BeginAdjustment();

            window.HandleAdjustKey(Key.Left, step: 10);
            window.HandleAdjustKey(Key.Escape);

            Assert.False(window.IsAdjusting);
            Assert.DoesNotContain(lines, line => line.Contains("overlay: saved the", StringComparison.Ordinal));
        });
    }

    [Fact]
    public void Every_arrow_size_and_pitch_key_still_moves_the_box_it_is_documented_to_move()
    {
        // The legend on screen promises arrows, +/- and [/]. This is that
        // promise, key by key, measured where it is stored.
        //
        // PHYSICAL PIXELS, not DIPs. The keys move _workingCalibration, which
        // is physical; LastAdjustGeometry is that value put through
        // CalibrationGeometry.ForDpi for the preview, so on a 192-DPI monitor
        // it is half. Asserting against the preview would make this test pass
        // or fail on the DPI of whatever machine ran it.
        RunOnSta((window, store) =>
        {
            window.ShowInactive();
            var display = window.CurrentDisplay!.Resolution;
            var start = store.LoadCalibration(display);
            window.BeginAdjustment();

            window.HandleAdjustKey(Key.Right, step: 10);
            window.HandleAdjustKey(Key.Down, step: 4);
            window.HandleAdjustKey(Key.OemPlus, step: 3);
            window.HandleAdjustKey(Key.OemCloseBrackets, step: 5);
            window.HandleAdjustKey(Key.Enter);

            Assert.Equal(
                start with
                {
                    FirstBoxCenterX = start.FirstBoxCenterX + 10,
                    CenterY = start.CenterY + 4,
                    BoxSize = start.BoxSize + 3,
                    Spacing = start.Spacing + 5,
                },
                store.LoadCalibration(display));
        });
    }

    [Fact]
    public void The_opposite_key_undoes_each_move_exactly()
    {
        // Pure equality of the same transform, so this one is DPI-agnostic and
        // says something the test above cannot: the pairs are inverses, not
        // merely four keys that each change something.
        RunOnSta(window =>
        {
            window.ShowInactive();
            window.BeginAdjustment();
            var start = window.LastAdjustGeometry!;

            window.HandleAdjustKey(Key.Right, step: 10);
            window.HandleAdjustKey(Key.Down, step: 4);
            window.HandleAdjustKey(Key.OemPlus, step: 3);
            window.HandleAdjustKey(Key.OemCloseBrackets, step: 5);
            Assert.NotEqual(start, window.LastAdjustGeometry);

            window.HandleAdjustKey(Key.Left, step: 10);
            window.HandleAdjustKey(Key.Up, step: 4);
            window.HandleAdjustKey(Key.OemMinus, step: 3);
            window.HandleAdjustKey(Key.OemOpenBrackets, step: 5);
            Assert.Equal(start, window.LastAdjustGeometry);
        });
    }

    [Fact]
    public void A_saved_box_is_what_the_next_session_loads_and_the_next_game_paints()
    {
        // End to end through the real store, on the real display key: the value
        // Enter wrote is the value LoadCalibration hands the renderer, and it
        // survives a store built fresh from the same file.
        RunOnSta((window, store) =>
        {
            window.ShowInactive();
            var display = window.CurrentDisplay!.Resolution;
            var start = store.LoadCalibration(display);
            window.BeginAdjustment();

            window.HandleAdjustKey(Key.Right, step: 7);
            window.HandleAdjustKey(Key.Enter);

            var saved = store.LoadCalibration(display);
            Assert.Equal(start.FirstBoxCenterX + 7, saved.FirstBoxCenterX);
            Assert.Equal(saved, new OverlaySettingsStore(store.Path).LoadCalibration(display));
        });
    }

    [Fact]
    public void There_is_exactly_one_adjust_target_and_Tab_is_not_a_switch_any_more()
    {
        // The item row was the second target and Tab moved between the two.
        // With one target left, Tab must fall through as an unhandled key
        // rather than silently doing something to a target that is gone.
        RunOnSta(window =>
        {
            var lines = new List<string>();
            window.Diagnostics = lines.Add;
            window.ShowInactive();
            window.BeginAdjustment();

            Assert.False(window.HandleAdjustKey(Key.Tab));

            // Tab must not count as a move, either: that would resurrect the
            // 1.0.18 defect (a session that adjusted nothing writing a default)
            // through a different door.
            window.HandleAdjustKey(Key.Enter);
            Assert.Contains(lines, line => line.Contains("saved nothing", StringComparison.Ordinal));

            Assert.DoesNotContain(
                lines,
                line => line.Contains("item", StringComparison.OrdinalIgnoreCase)
                    || line.Contains("situational", StringComparison.OrdinalIgnoreCase));
        });
    }

    [Fact]
    public void The_tray_offers_one_adjust_verb_and_no_item_number_controls()
    {
        // The menu is the other half of "nothing remains that could draw them":
        // a verb naming a feature that no longer exists is a control that lies.
        var commands = Enum.GetNames<Tray.TrayCommand>();
        Assert.DoesNotContain("AdjustItems", commands);
        Assert.DoesNotContain("ToggleItemNumbers", commands);
        Assert.Contains("Adjust", commands);

        Assert.Equal("Adjust overlay position", Tray.TrayMenuState.AdjustMenuVerb);
        Assert.DoesNotContain(
            typeof(Tray.TrayMenuState).GetFields()
                .Where(field => field.IsLiteral && field.FieldType == typeof(string))
                .Select(field => (string)field.GetRawConstantValue()!),
            verb => verb.Contains("item number", StringComparison.OrdinalIgnoreCase));
    }

    private static void RunOnSta(Action<OverlayWindow> body) =>
        RunOnSta((window, _) => body(window));

    private static void RunOnSta(Action<OverlayWindow, OverlaySettingsStore> body)
    {
        Exception? failure = null;
        var thread = new Thread(() =>
        {
            var settingsPath = Path.Combine(Path.GetTempPath(), $"coachbuild-test-{Guid.NewGuid():N}.json");
            OverlayWindow? window = null;
            try
            {
                var store = new OverlaySettingsStore(settingsPath);
                window = new OverlayWindow(store, NullGameWindowLocator.Instance);
                body(window, store);
            }
            catch (Exception error)
            {
                failure = error;
            }
            finally
            {
                // Teardown is deliberately non-fatal: this STA/WPF harness has
                // produced one-off teardown throws that are not assertions.
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
