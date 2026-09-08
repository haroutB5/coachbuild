watcher_tests = r'''
    [Fact]
    public void An_honoured_press_says_so_in_the_log_and_names_the_gate()
    {
        // Q2 OF THE ROUND-2 BRIEF, pinned. An honoured press ALWAYS changes the
        // verdict, so it always reaches the transition line - but until 1.0.18
        // that line said nothing about the gate, and a log with no shop lines
        // in it was equally consistent with "the gate ate every press" and
        // "the watcher never saw the key at all". Now one line answers both.
        var held = new HashSet<uint>();
        var lines = new List<string>();
        using var watcher = Watcher(held, Grave(), foreground: () => true);
        watcher.Diagnostics = lines.Add;
        watcher.SetInGame(true);
        watcher.Poll();

        Tap(watcher, held, VkGrave);

        Assert.True(watcher.IsShopOpen);
        var opened = Assert.Single(lines, line => line.StartsWith("shop: open (", StringComparison.Ordinal));
        Assert.Contains(ShopVisibilityLatch.ReasonShopKey, opened, StringComparison.Ordinal);
        Assert.Contains("1 toggle(s)", opened, StringComparison.Ordinal);
        Assert.Contains("chat gate off", opened, StringComparison.Ordinal);
    }

    [Fact]
    public void With_the_gate_off_the_key_works_while_chat_is_open_and_the_log_says_which()
    {
        // The shipped default, end to end through the real watcher: Enter opens
        // chat, the shop key lands anyway, and the reason on the line is the
        // one that tells a future reader the gate WOULD have swallowed it.
        var held = new HashSet<uint>();
        var lines = new List<string>();
        using var watcher = Watcher(held, Grave(), foreground: () => true);
        watcher.Diagnostics = lines.Add;
        watcher.SetInGame(true);
        watcher.Poll();

        Tap(watcher, held, 0x0D);
        Assert.True(watcher.Latch.IsChatOpen);

        Tap(watcher, held, VkGrave);

        Assert.True(watcher.IsShopOpen);
        Assert.Equal(0, watcher.Latch.SuppressedByChat);
        Assert.Equal(1, watcher.Latch.ChatGateBypassed);
        Assert.DoesNotContain(lines, line => line.Contains("ignored", StringComparison.OrdinalIgnoreCase));

        var opened = Assert.Single(lines, line => line.StartsWith("shop: open (", StringComparison.Ordinal));
        Assert.Contains(ShopVisibilityLatch.ReasonChatGateOff, opened, StringComparison.Ordinal);
        Assert.Contains("1 honoured while chat looked open", opened, StringComparison.Ordinal);

        // ...and with the gate off the belief writes no lines of its own, so
        // the only shop lines in the log are presses.
        Assert.All(lines, line => Assert.StartsWith("shop: ", line, StringComparison.Ordinal));
        Assert.DoesNotContain(lines, line => line.Contains("believed", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public void The_gate_is_off_unless_the_watcher_is_told_otherwise()
    {
        // The flag is positional and required on both constructors precisely so
        // this cannot drift: a default-on latch behind a default-off setting is
        // the failure mode where every test passes and the shipped app gates.
        using var off = Watcher(new HashSet<uint>(), Grave());
        using var on = Watcher(new HashSet<uint>(), Grave(), chatGate: true);

        Assert.False(off.Latch.ChatGateEnabled);
        Assert.True(on.Latch.ChatGateEnabled);
    }
'''

settings_tests = r'''
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
'''

p = 'desktop/tests/CoachBuild.Desktop.Tests/ShopKeyWatcherTests.cs'
s = open(p, encoding='utf-8').read()
anchor = '    /// <summary>\n    /// Press and release a whole chord'
assert s.count(anchor) == 1
s = s.replace(anchor, watcher_tests + '\n' + anchor)
if 'using CoachBuild.Core;' not in s:
    raise SystemExit('missing core using')
open(p, 'w', encoding='utf-8', newline='').write(s)

p2 = 'desktop/tests/CoachBuild.Desktop.Tests/SettingsStoreTests.cs'
s2 = open(p2, encoding='utf-8').read()
anchor2 = '    private static string MakeTempDirectory()'
assert s2.count(anchor2) == 1
s2 = s2.replace(anchor2, settings_tests + '\n' + anchor2)
open(p2, 'w', encoding='utf-8', newline='').write(s2)
print('ok')
