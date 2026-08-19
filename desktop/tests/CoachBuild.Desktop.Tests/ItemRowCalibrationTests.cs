using CoachBuild.Core;
using CoachBuild.Desktop.Overlay;
using CoachBuild.Desktop.Tray;
using Xunit;

namespace CoachBuild.Desktop.Tests;

public sealed class ItemRowCalibrationTests
{
    private static readonly DisplayResolution Display = new(1920, 1080, 96, 96, "DISPLAY1");
    private static readonly DisplayResolution Second = new(2560, 1440, 96, 96, "DISPLAY2");

    [Fact]
    public void An_uncalibrated_item_row_is_null_and_not_a_default()
    {
        // "No calibration" and "the default calibration" are different facts,
        // and the item row must draw nothing in the first case.
        var root = Temp();
        try
        {
            var store = new OverlaySettingsStore(Path.Combine(root, "desktop-settings.json"));

            Assert.Null(store.TryLoadCalibration(CalibrationTarget.ItemRow, Display));

            // The skill overlay keeps its defaulting behaviour, because THERE
            // the default is a measurement: the ability HUD does not move.
            Assert.Equal(CalibrationGeometry.ScaledDefault(Display), store.LoadCalibration(Display));
            Assert.Equal(
                CalibrationGeometry.ItemRowScaledDefault(Display),
                store.LoadCalibrationOrDefault(CalibrationTarget.ItemRow, Display));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void The_two_targets_are_stored_independently_in_both_directions()
    {
        var root = Temp();
        try
        {
            var store = new OverlaySettingsStore(Path.Combine(root, "desktop-settings.json"));
            var skill = new CalibrationGeometry(910, 940, 52, 73);
            var itemRow = new CalibrationGeometry(430, 700, 44, 52);

            store.SaveCalibration(CalibrationTarget.SkillOrder, Display, skill);
            Assert.Equal(skill, store.LoadCalibration(Display));
            // Saving the ability bar must NOT invent an item row.
            Assert.Null(store.TryLoadCalibration(CalibrationTarget.ItemRow, Display));

            store.SaveCalibration(CalibrationTarget.ItemRow, Display, itemRow);
            Assert.Equal(itemRow, store.TryLoadCalibration(CalibrationTarget.ItemRow, Display));
            // ...and saving the item row must not move the ability bar.
            Assert.Equal(skill, store.LoadCalibration(Display));
            Assert.NotEqual(skill, store.TryLoadCalibration(CalibrationTarget.ItemRow, Display));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void A_calibration_is_keyed_to_the_exact_display_it_was_made_on()
    {
        // Folding both targets into one map keyed by display would mean a
        // monitor change silently applied the ability bar position to the shop
        // row. This is the per-display half of that argument.
        var root = Temp();
        try
        {
            var store = new OverlaySettingsStore(Path.Combine(root, "desktop-settings.json"));
            var itemRow = new CalibrationGeometry(430, 700, 44, 52);
            store.SaveCalibration(CalibrationTarget.ItemRow, Display, itemRow);

            Assert.Equal(itemRow, store.TryLoadCalibration(CalibrationTarget.ItemRow, Display));
            Assert.Null(store.TryLoadCalibration(CalibrationTarget.ItemRow, Second));
            Assert.Null(store.TryLoadCalibration(
                CalibrationTarget.ItemRow, Display with { DpiX = 144, DpiY = 144 }));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void Both_targets_survive_a_round_trip_through_the_file()
    {
        var root = Temp();
        try
        {
            var path = Path.Combine(root, "desktop-settings.json");
            var skill = new CalibrationGeometry(910, 940, 52, 73);
            var itemRow = new CalibrationGeometry(430, 700, 44, 52);

            var writer = new OverlaySettingsStore(path);
            writer.SaveCalibration(CalibrationTarget.SkillOrder, Display, skill);
            writer.SaveCalibration(CalibrationTarget.ItemRow, Display, itemRow);
            writer.SaveCalibration(CalibrationTarget.ItemRow, Second, itemRow with { CenterY = 940 });

            var reader = new OverlaySettingsStore(path);
            Assert.Equal(skill, reader.LoadCalibration(Display));
            Assert.Equal(itemRow, reader.TryLoadCalibration(CalibrationTarget.ItemRow, Display));
            Assert.Equal(940, reader.TryLoadCalibration(CalibrationTarget.ItemRow, Second)!.CenterY);
            Assert.Contains("itemRowCalibrations", File.ReadAllText(path), StringComparison.Ordinal);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void An_existing_settings_file_from_1015_is_read_untouched()
    {
        // Nobody's ability-bar calibration is disturbed by this feature
        // arriving. A 1.0.15 file simply has no itemRowCalibrations key.
        var root = Temp();
        try
        {
            var path = Path.Combine(root, "desktop-settings.json");
            File.WriteAllText(path, """
            {
              "laneOverride": "MID",
              "overlayVisible": true,
              "autostartConfigured": true,
              "calibrations": {
                "1920x1080@96x96:DISPLAY1": {
                  "resolution": { "width": 1920, "height": 1080, "dpiX": 96, "dpiY": 96, "deviceName": "DISPLAY1" },
                  "geometry": { "firstBoxCenterX": 910, "centerY": 940, "boxSize": 52, "spacing": 73 }
                }
              }
            }
            """);

            var store = new OverlaySettingsStore(path);
            var settings = store.Read();

            Assert.Equal("MID", settings.LaneOverride);
            Assert.Equal(new CalibrationGeometry(910, 940, 52, 73), store.LoadCalibration(Display));
            Assert.Empty(settings.ItemRowCalibrations);
            Assert.Null(store.TryLoadCalibration(CalibrationTarget.ItemRow, Display));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void The_two_new_tray_verbs_are_distinct_and_the_override_defaults_off()
    {
        var verbs = new[]
        {
            TrayMenuState.AdjustItemsMenuVerb,
            TrayMenuState.ShowItemNumbersVerb,
            TrayMenuState.CancelAdjustMenuVerb,
            TrayMenuState.OpenLogFolderVerb,
        };

        Assert.Equal(verbs.Length, verbs.Distinct(StringComparer.Ordinal).Count());
        Assert.All(verbs, verb => Assert.False(string.IsNullOrWhiteSpace(verb)));
        Assert.False(TrayMenuState.Default.ForceItemNumbers);

        // 1.0.13 removed the second global accelerator because RegisterHotKey is
        // exclusive system-wide. Neither new verb may reintroduce one.
        Assert.DoesNotContain("Ctrl+", TrayMenuState.AdjustItemsMenuVerb, StringComparison.Ordinal);
        Assert.DoesNotContain("Ctrl+", TrayMenuState.ShowItemNumbersVerb, StringComparison.Ordinal);
    }

    [Fact]
    public void The_manual_override_is_only_offered_in_a_game()
    {
        // A control that can be ticked to no effect is a control that lies
        // about what it does.
        Assert.False(TrayMenuState.Default.IsInGame);
        Assert.True((TrayMenuState.Default with { Phase = CompanionPhase.InProgress }).IsInGame);
    }

    private static string Temp()
    {
        var path = Path.Combine(Path.GetTempPath(), "coachbuild-itemrow-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(path);
        return path;
    }
}
