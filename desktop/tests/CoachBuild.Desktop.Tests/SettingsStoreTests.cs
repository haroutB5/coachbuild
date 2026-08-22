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
    public void TheRemovedItemRowsSavedGeometrySurvivesEveryLaterWrite()
    {
        // 1.0.23 removed the item-number overlay. NOTHING reads
        // itemRowCalibrations any more, and this test is the reason the
        // property still exists at all.
        //
        // Save() serialises OverlaySettings itself, so a key the class does not
        // model is DROPPED the first time any unrelated setting changes -- the
        // exact trap RankSampleSecret documents from the other direction.
        // Deleting the property would therefore have been a silent migration
        // that threw away geometry the player aligned by hand with arrow keys,
        // in exchange for nothing. An unread JSON key costs nothing; their work
        // is not recoverable.
        var root = MakeTempDirectory();
        try
        {
            var path = Path.Combine(root, "desktop-settings.json");
            File.WriteAllText(path, """
            {
              "laneOverride": "MID",
              "overlayVisible": true,
              "calibrations": {
                "1920x1080@96x96:DISPLAY1": {
                  "resolution": { "width": 1920, "height": 1080, "dpiX": 96, "dpiY": 96, "deviceName": "DISPLAY1" },
                  "geometry": { "firstBoxCenterX": 910, "centerY": 940, "boxSize": 52, "spacing": 73 }
                }
              },
              "itemRowCalibrations": {
                "2560x1440@96x96:DISPLAY1": {
                  "resolution": { "width": 2560, "height": 1440, "dpiX": 96, "dpiY": 96, "deviceName": "DISPLAY1" },
                  "geometry": { "firstBoxCenterX": 611, "centerY": 693, "boxSize": 59, "spacing": 69 }
                }
              }
            }
            """);

            var store = new OverlaySettingsStore(path);
            Assert.Equal(
                new CalibrationGeometry(611, 693, 59, 69),
                store.Read().ItemRowCalibrations["2560x1440@96x96:DISPLAY1"].Geometry);

            // Every mutation path, because Save() clones and each of these
            // round-trips the whole file.
            store.SetLaneOverride("top");
            store.SetOverlayVisible(false);
            store.SetAutostartConfigured(true);
            store.SetRankSampleSecret("secret");
            store.SaveCalibration(
                new DisplayResolution(1920, 1080, 96, 96, "DISPLAY1"),
                new CalibrationGeometry(900, 930, 50, 70));

            // From disk, not from the cache: the point is what is on the user's
            // filesystem after the app has been used for a while.
            var reloaded = new OverlaySettingsStore(path).Read();
            Assert.Equal(
                new CalibrationGeometry(611, 693, 59, 69),
                reloaded.ItemRowCalibrations["2560x1440@96x96:DISPLAY1"].Geometry);
            Assert.Contains("itemRowCalibrations", File.ReadAllText(path), StringComparison.Ordinal);

            // ...and the skill-order calibration, which IS read, still is.
            Assert.Equal(
                new CalibrationGeometry(900, 930, 50, 70),
                new OverlaySettingsStore(path).LoadCalibration(
                    new DisplayResolution(1920, 1080, 96, 96, "DISPLAY1")));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void MyStatsPairingSecretPersistsAcrossRestartAndFeedsCaptureAuth()
    {
        const string fixtureCredential = "fixture-shared-secret";
        var root = MakeTempDirectory();
        var previousEnvironment = Environment.GetEnvironmentVariable("COACHBUILD_MYSTATS_SECRET");
        try
        {
            Environment.SetEnvironmentVariable("COACHBUILD_MYSTATS_SECRET", null);
            var path = Path.Combine(root, "desktop-settings.json");
            var store = new OverlaySettingsStore(path);

            store.SetRankSampleSecret($"  {fixtureCredential}  ");
            store.SetLaneOverride("mid");
            store.SetOverlayVisible(false);

            // A new store is a process-restart boundary: no in-memory cache is
            // shared with the writer, and unrelated settings writes happened
            // after the credential was pasted.
            var afterRestart = new OverlaySettingsStore(path);
            Assert.Equal(fixtureCredential, afterRestart.Read().RankSampleSecret);
            Assert.Equal(fixtureCredential, App.ResolveRankSampleSecret(afterRestart));

            // Blank means absent. RankCaptureTests separately pins that absent
            // auth reads no LCU state and performs no POST.
            afterRestart.SetRankSampleSecret("   ");
            var unpairedRestart = new OverlaySettingsStore(path);
            Assert.Null(unpairedRestart.Read().RankSampleSecret);
            Assert.Null(App.ResolveRankSampleSecret(unpairedRestart));
        }
        finally
        {
            Environment.SetEnvironmentVariable("COACHBUILD_MYSTATS_SECRET", previousEnvironment);
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
