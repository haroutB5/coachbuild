import io

p = 'tests/CoachBuild.Desktop.Tests/SettingsStoreTests.cs'
s = io.open(p, encoding='utf-8').read()

old_start = s.index("""    [Fact]
    public void TheChatGateIsOffOnAFreshProfileAndSurvivesOtherWrites()""")
old_end = s.index("""    [Fact]
    public void MyStatsPairingSecretPersistsAcrossRestartAndFeedsCaptureAuth()""")

new_test = '''    [Fact]
    public void TheRemovedItemRowsSavedGeometrySurvivesEveryLaterWrite()
    {
        // 1.0.22 removed the item-number overlay. NOTHING reads
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

'''

s = s[:old_start] + new_test + s[old_end:]
io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('ok')
