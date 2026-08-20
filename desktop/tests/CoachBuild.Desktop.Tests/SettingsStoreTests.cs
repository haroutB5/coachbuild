global using System.IO;

using System.Text.Json;
using CoachBuild.Desktop.Overlay;
using Xunit;

namespace CoachBuild.Desktop.Tests;

public sealed class SettingsStoreTests
{
    [Fact]
    public void LaneAndCalibrationSurviveRoundTripWithResolutionTag()
    {
        var root = MakeTempDirectory();
        try
        {
            var store = new OverlaySettingsStore(Path.Combine(root, "desktop-settings.json"));
            var display = new DisplayResolution(1920, 1080, 96, 96, "DISPLAY1");
            var geometry = new CalibrationGeometry(910, 940, 52, 73);

            store.SetLaneOverride("mid");
            store.SetOverlayVisible(false);
            store.SaveCalibration(display, geometry);

            var settings = store.Read();
            Assert.Equal("MID", settings.LaneOverride);
            Assert.False(settings.OverlayVisible);
            Assert.Equal(geometry, store.LoadCalibration(display));
            Assert.NotEqual(geometry, store.LoadCalibration(display with { DpiX = 144, DpiY = 144 }));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void NewProfilesShowTheOverlayByDefaultWithoutASettingsFile()
    {
        var root = MakeTempDirectory();
        try
        {
            var store = new OverlaySettingsStore(Path.Combine(root, "desktop-settings.json"));
            Assert.True(store.Read().OverlayVisible);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void SettingsCacheRefreshesAfterAWriteWithoutRereadingEveryRead()
    {
        var root = MakeTempDirectory();
        try
        {
            var path = Path.Combine(root, "desktop-settings.json");
            var store = new OverlaySettingsStore(path);
            Assert.True(store.Read().OverlayVisible);

            File.WriteAllText(path, "{\"overlayVisible\":false}");
            Assert.True(store.Read().OverlayVisible);

            store.SetOverlayVisible(false);
            Assert.False(store.Read().OverlayVisible);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void LegacyElectronSettingsAreReadAndMigratedOnFirstWrite()
    {
        var root = MakeTempDirectory();
        try
        {
            var legacyPath = Path.Combine(root, "coachbuild-overlay-settings.json");
            File.WriteAllText(legacyPath, JsonSerializer.Serialize(new
            {
                lane = "BOT",
                calibration = new
                {
                    geometry = new { firstBoxCenterX = 700, centerY = 900, boxSize = 48, spacing = 68 },
                    calibratedWidth = 1920,
                    calibratedHeight = 1080,
                },
            }));

            var store = new OverlaySettingsStore(Path.Combine(root, "desktop-settings.json"));
            Assert.Equal("BOT", store.Read().LaneOverride);
            Assert.Equal(700, store.LoadCalibration(new DisplayResolution(1920, 1080)).FirstBoxCenterX);

            store.SetOverlayVisible(false);
            Assert.True(File.Exists(store.Path));
            Assert.Equal("BOT", store.Read().LaneOverride);
            Assert.False(store.Read().OverlayVisible);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }


    [Fact]
    public void TheChatGateIsOffOnAFreshProfileAndSurvivesOtherWrites()
    {
        // Off by default with no settings file at all - the shipped behaviour
        // must not depend on a key being present.
        var root = MakeTempDirectory();
        try
        {
            var path = Path.Combine(root, "desktop-settings.json");
            var store = new OverlaySettingsStore(path);
            Assert.False(store.Read().ChatGateEnabled);

            // Opt in by hand, the way the escape hatch is documented...
            var settings = store.Read();
            settings.ChatGateEnabled = true;
            store.Save(settings);
            Assert.True(store.Read().ChatGateEnabled);

            // ...and it must survive a write of a COMPLETELY unrelated setting.
            // Save() clones before it writes, so a field missing from
            // CloneSettings is silently reset by the next lane change - which
            // is a data-loss bug that no test of the field on its own catches.
            store.SetLaneOverride("mid");
            store.SetOverlayVisible(false);
            store.SaveCalibration(new DisplayResolution(1920, 1080), new CalibrationGeometry(910, 940, 52, 73));
            Assert.True(store.Read().ChatGateEnabled);

            // And it must survive a reload from disk, not just the cache.
            Assert.True(new OverlaySettingsStore(path).Read().ChatGateEnabled);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    private static string MakeTempDirectory()
    {
        var path = Path.Combine(Path.GetTempPath(), "CoachBuild-SettingsTests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(path);
        return path;
    }
}
