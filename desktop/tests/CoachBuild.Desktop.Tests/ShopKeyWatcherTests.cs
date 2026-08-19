using CoachBuild.Core;
using CoachBuild.Desktop.Overlay;
using Xunit;

namespace CoachBuild.Desktop.Tests;

public sealed class ShopKeyWatcherTests
{
    private const uint VkGrave = 0xC0;
    private const uint VkP = 0x50;
    private const uint VkShift = 0x10;
    private const uint VkControl = 0x11;
    private const uint VkMenu = 0x12;

    [Fact]
    public void An_unmodified_bind_does_not_fire_while_Shift_is_held()
    {
        // League treats [1] and [Shift][1] as two different binds - its own
        // input.ini carries both - so modifiers are matched EXACTLY and not as
        // a minimum. Without this, every smart-cast press would toggle the
        // latch for a player whose shop key shares a physical key.
        var held = new HashSet<uint> { VkGrave };
        using var watcher = Watcher(held, Grave());

        Assert.True(watcher.IsBindDown(new LeagueKeybind(VkGrave, false, false, false, "[`]")));

        held.Add(VkShift);
        Assert.False(watcher.IsBindDown(new LeagueKeybind(VkGrave, false, false, false, "[`]")));

        // ...and the SHIFTED bind fires exactly then, and not before.
        Assert.True(watcher.IsBindDown(new LeagueKeybind(VkGrave, false, true, false, "[Shift][`]")));
        held.Remove(VkShift);
        Assert.False(watcher.IsBindDown(new LeagueKeybind(VkGrave, false, true, false, "[Shift][`]")));
    }

    [Theory]
    [InlineData(VkControl, true, false, false)]
    [InlineData(VkShift, false, true, false)]
    [InlineData(VkMenu, false, false, true)]
    public void Each_modifier_is_matched_on_its_own_axis(uint modifier, bool ctrl, bool shift, bool alt)
    {
        var held = new HashSet<uint> { VkP, modifier };
        using var watcher = Watcher(held, Grave());

        Assert.True(watcher.IsBindDown(new LeagueKeybind(VkP, ctrl, shift, alt, "bind")));
        Assert.False(watcher.IsBindDown(new LeagueKeybind(VkP, !ctrl, shift, alt, "bind")));
        Assert.False(watcher.IsBindDown(new LeagueKeybind(VkP, ctrl, !shift, alt, "bind")));
        Assert.False(watcher.IsBindDown(new LeagueKeybind(VkP, ctrl, shift, !alt, "bind")));
    }

    [Fact]
    public void An_unresolved_bind_is_never_down()
    {
        using var watcher = Watcher(new HashSet<uint>(), Grave());
        var unresolved = new LeagueKeybind(0, false, false, false, "[Zorp]");

        Assert.False(unresolved.IsResolved);
        Assert.False(watcher.IsBindDown(unresolved));
    }

    [Fact]
    public void Sample_composes_the_shop_close_and_chat_keys_and_the_foreground_gate()
    {
        var held = new HashSet<uint>();
        using var watcher = Watcher(held, Grave(), foreground: () => true);

        var idle = watcher.Sample(inGame: true);
        Assert.True(idle.InGame);
        Assert.True(idle.LeagueForeground);
        Assert.False(idle.ShopKeyDown);
        Assert.False(idle.CloseKeyDown);
        Assert.False(idle.ChatKeyDown);

        held.Add(VkGrave);
        Assert.True(watcher.Sample(true).ShopKeyDown);
        held.Clear();

        held.Add(0x1B);
        Assert.True(watcher.Sample(true).CloseKeyDown);
        held.Clear();

        held.Add(0x0D);
        Assert.True(watcher.Sample(true).ChatKeyDown);
    }

    [Fact]
    public void Either_of_two_alternative_binds_counts_as_the_shop_key()
    {
        var held = new HashSet<uint>();
        var binds = new ResolvedShopBinds(
            [new LeagueKeybind(VkP, false, false, false, "[p]"), new LeagueKeybind(VkGrave, false, false, false, "[`]")],
            new LeagueKeybind(0x1B, false, false, false, "Esc"),
            new LeagueKeybind(0x0D, false, false, false, "Return"),
            @"C:\fixture", false, []);
        using var watcher = Watcher(held, binds);

        held.Add(VkP);
        Assert.True(watcher.Sample(true).ShopKeyDown);
        held.Clear();
        held.Add(VkGrave);
        Assert.True(watcher.Sample(true).ShopKeyDown);
        held.Clear();
        held.Add(0x51);
        Assert.False(watcher.Sample(true).ShopKeyDown);
    }

    [Fact]
    public void A_foreground_probe_that_throws_reads_as_not_foreground()
    {
        // Degrade, never crash: the worst case has to be "the numbers do not
        // appear on their own", never "the tray app fell over mid-game".
        using var watcher = Watcher(
            new HashSet<uint>(), Grave(), foreground: () => throw new InvalidOperationException("boom"));

        Assert.False(watcher.Sample(inGame: true).LeagueForeground);
    }

    [Fact]
    public void The_watcher_reports_only_transitions_and_says_why()
    {
        var held = new HashSet<uint>();
        var changes = new List<ShopLatchState>();
        var lines = new List<string>();
        using var watcher = Watcher(held, Grave(), foreground: () => true);
        watcher.ShopVisibilityChanged += state => changes.Add(state);
        watcher.Diagnostics = lines.Add;
        watcher.SetInGame(true);

        for (var tick = 0; tick < 10; tick++) watcher.Poll();
        Assert.Empty(changes);

        held.Add(VkGrave);
        for (var tick = 0; tick < 10; tick++) watcher.Poll();
        held.Remove(VkGrave);
        for (var tick = 0; tick < 10; tick++) watcher.Poll();

        // Twenty polls over one press-and-release, one transition.
        var opened = Assert.Single(changes);
        Assert.True(opened.Open);
        Assert.True(watcher.IsShopOpen);
        Assert.Equal(1, watcher.Latch.Toggles);

        held.Add(VkGrave);
        for (var tick = 0; tick < 10; tick++) watcher.Poll();
        Assert.Equal(2, changes.Count);
        Assert.False(changes[1].Open);

        Assert.NotEmpty(lines);
        Assert.All(lines, line => Assert.StartsWith("shop: ", line, StringComparison.Ordinal));
    }

    [Fact]
    public void Chat_suppression_is_reported_even_though_the_verdict_never_changes()
    {
        // The chat gate is the one branch whose whole effect is that NOTHING
        // happens. A Changed-only report is silent about exactly the case it
        // exists for, so the player who says "I press my key and nothing
        // happens" gets an empty log either way.
        var held = new HashSet<uint>();
        var lines = new List<string>();
        var changes = 0;
        using var watcher = Watcher(held, Grave(), foreground: () => true);
        watcher.Diagnostics = lines.Add;
        watcher.ShopVisibilityChanged += _ => changes++;
        watcher.SetInGame(true);
        watcher.Poll();

        Tap(watcher, held, 0x0D);      // Enter opens chat
        Assert.True(watcher.Latch.IsChatOpen);
        Tap(watcher, held, VkGrave);   // and now the shop key, while chatting

        Assert.False(watcher.IsShopOpen);
        Assert.Equal(0, changes);
        Assert.Equal(1, watcher.Latch.SuppressedByChat);
        Assert.Contains(lines, line => line.Contains("ignored", StringComparison.OrdinalIgnoreCase));
        Assert.Contains(lines, line => line.Contains("chat", StringComparison.OrdinalIgnoreCase));

        // NEGATIVE CONTROL, same watcher, same log: leave chat and the very
        // same key now works. Without it, "no numbers appeared" would be
        // consistent with a watcher that is simply dead.
        Tap(watcher, held, 0x0D);
        Tap(watcher, held, VkGrave);
        Assert.True(watcher.IsShopOpen);
        Assert.Equal(1, changes);
        Assert.Equal(1, watcher.Latch.SuppressedByChat);
    }

    private static void Tap(ShopKeyWatcher watcher, HashSet<uint> held, uint key)
    {
        held.Add(key);
        watcher.Poll();
        watcher.Poll();
        held.Remove(key);
        watcher.Poll();
    }

    [Fact]
    public void Disposing_stops_the_timer_and_is_idempotent()
    {
        var watcher = Watcher(new HashSet<uint>(), Grave());
        watcher.Start();
        watcher.Start();     // second Start must not create a second timer
        watcher.Dispose();
        watcher.Dispose();

        // Starting after disposal is a no-op, not a resurrection.
        watcher.Start();
        watcher.SetInGame(true);
    }

    [Fact]
    public void The_poll_interval_is_short_enough_for_an_ordinary_key_tap()
    {
        // An ordinary tap is 80-150 ms. Anything at or above that could fall
        // between two samples and lose the press outright.
        Assert.True(ShopKeyWatcher.PollIntervalMs <= 60);
        Assert.True(ShopKeyWatcher.PollIntervalMs >= 10);
    }

    private static ResolvedShopBinds Grave() => new(
        [new LeagueKeybind(VkGrave, false, false, false, "[`]")],
        new LeagueKeybind(0x1B, false, false, false, "Esc"),
        new LeagueKeybind(0x0D, false, false, false, "Return"),
        @"C:\fixture",
        UsedFallback: false,
        []);

    private static ShopKeyWatcher Watcher(
        HashSet<uint> held,
        ResolvedShopBinds binds,
        Func<bool>? foreground = null) =>
        new(binds, held.Contains, foreground ?? (() => true));
}
