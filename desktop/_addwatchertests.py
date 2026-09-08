import io

p = r"tests/CoachBuild.Desktop.Tests/ShopKeyWatcherTests.cs"
s = io.open(p, encoding="utf-8").read()
marker = "    private static void Tap(ShopKeyWatcher watcher, HashSet<uint> held, uint key)"
assert marker in s

new_tests = r'''    [Fact]
    public void Sample_sees_Shift_Enter_as_all_chat_and_not_as_the_plain_chat_key()
    {
        // THE PRODUCTION HALF OF THE 2026-08-19 FIX. The latch can only heal a
        // desync it is told about, and modifiers are matched EXACTLY, so
        // Shift+Enter reaches it only if Sample composes it deliberately.
        // Asserting this here rather than only in the latch's own tests is the
        // difference between "the state machine handles all-chat" and "the app
        // can ever see all-chat".
        var held = new HashSet<uint>();
        using var watcher = Watcher(held, Grave(), foreground: () => true);

        held.Add(0x0D);
        var plain = watcher.Sample(true);
        Assert.True(plain.ChatKeyDown);
        Assert.False(plain.ChatAllKeyDown);

        held.Add(VkShift);
        var all = watcher.Sample(true);
        Assert.False(all.ChatKeyDown);      // exact modifier match, as designed
        Assert.True(all.ChatAllKeyDown);    // ...and this is the field that rescues it

        // Alt+Enter is League's FULLSCREEN toggle and opens no chat at all, so
        // it must remain invisible on both axes. The exactness rule is right
        // for Alt and was only ever wrong for Shift.
        held.Remove(VkShift);
        held.Add(VkMenu);
        var alt = watcher.Sample(true);
        Assert.False(alt.ChatKeyDown);
        Assert.False(alt.ChatAllKeyDown);
    }

    [Fact]
    public void Sample_stamps_a_monotonic_reading_that_actually_advances()
    {
        // A latch that expires stale chat beliefs off ShopObservation.At is
        // inert if production stamps a constant. The tests inject a clock; this
        // is the one that proves the DEFAULT one moves.
        var held = new HashSet<uint>();
        using var watcher = Watcher(held, Grave(), foreground: () => true, uptime: null);

        var first = watcher.Sample(true).At;
        var spin = System.Diagnostics.Stopwatch.StartNew();
        while (spin.ElapsedMilliseconds < 5) { }
        var second = watcher.Sample(true).At;

        Assert.True(second > first, $"At did not advance: {first} then {second}");
    }

    [Fact]
    public void The_incident_replayed_end_to_end_recovers_on_the_players_second_press()
    {
        // The whole 2026-08-19 failure, driven through the real watcher: chat
        // opened with Shift+Enter (unseen by the old build), sent with a plain
        // Enter (seen), which left the belief stuck open and swallowed every
        // shop press for the rest of the game.
        var held = new HashSet<uint>();
        var now = TimeSpan.Zero;
        var lines = new List<string>();
        using var watcher = Watcher(held, Grave(), foreground: () => true, uptime: () => now);
        watcher.Diagnostics = lines.Add;
        watcher.SetInGame(true);
        watcher.Poll();

        // Shift+Enter -> type -> Enter to send. Chat is REALLY closed after this.
        TapAt(watcher, held, ref now, [VkShift, 0x0D]);
        Assert.True(watcher.Latch.IsChatOpen);
        now += TimeSpan.FromSeconds(4);
        TapAt(watcher, held, ref now, [0x0D]);
        Assert.False(watcher.Latch.IsChatOpen);

        // ...so the very next shop press works, with nothing swallowed at all.
        now += TimeSpan.FromSeconds(1);
        TapAt(watcher, held, ref now, [VkGrave]);
        Assert.True(watcher.IsShopOpen);
        Assert.Equal(0, watcher.Latch.SuppressedByChat);
        Assert.Contains(lines, line => line.Contains("all chat", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public void A_stuck_belief_is_broken_by_the_players_own_repeated_press()
    {
        // Belt and braces for every desync this cannot see (chat closed by a
        // click, an Enter lost between two 50 ms samples). Whatever stranded
        // the belief, pressing again gets the numbers back.
        var held = new HashSet<uint>();
        var now = TimeSpan.Zero;
        var lines = new List<string>();
        using var watcher = Watcher(held, Grave(), foreground: () => true, uptime: () => now);
        watcher.Diagnostics = lines.Add;
        watcher.SetInGame(true);
        watcher.Poll();

        TapAt(watcher, held, ref now, [0x0D]);          // chat believed open
        Assert.True(watcher.Latch.IsChatOpen);

        now += TimeSpan.FromSeconds(1);
        TapAt(watcher, held, ref now, [VkGrave]);       // swallowed
        Assert.False(watcher.IsShopOpen);
        Assert.Equal(1, watcher.Latch.SuppressedByChat);

        now += TimeSpan.FromSeconds(9);
        TapAt(watcher, held, ref now, [VkGrave]);       // and now honoured
        Assert.True(watcher.IsShopOpen);
        Assert.Equal(1, watcher.Latch.ChatOverrides);
        Assert.Contains(lines, line => line.Contains("overridden", StringComparison.OrdinalIgnoreCase));
    }

    /// <summary>
    /// Press and release a whole chord, advancing the injected clock across the
    /// samples the way the 50 ms timer would.
    /// </summary>
    private static void TapAt(
        ShopKeyWatcher watcher, HashSet<uint> held, ref TimeSpan now, uint[] chord)
    {
        foreach (var key in chord) held.Add(key);
        watcher.Poll();
        now += TimeSpan.FromMilliseconds(ShopKeyWatcher.PollIntervalMs);
        watcher.Poll();
        foreach (var key in chord) held.Remove(key);
        now += TimeSpan.FromMilliseconds(ShopKeyWatcher.PollIntervalMs);
        watcher.Poll();
    }

'''

s = s.replace(marker, new_tests + marker, 1)

old_factory = '''    private static ShopKeyWatcher Watcher(
        HashSet<uint> held,
        ResolvedShopBinds binds,
        Func<bool>? foreground = null) =>
        new(binds, held.Contains, foreground ?? (() => true));'''
new_factory = '''    private static ShopKeyWatcher Watcher(
        HashSet<uint> held,
        ResolvedShopBinds binds,
        Func<bool>? foreground = null,
        Func<TimeSpan>? uptime = null) =>
        new(binds, held.Contains, foreground ?? (() => true), uptime);'''
assert old_factory in s
s = s.replace(old_factory, new_factory, 1)

io.open(p, "w", encoding="utf-8", newline="\n").write(s)
print("inserted")
