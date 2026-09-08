body = r'''
    // ---------------------------------------------------------------------
    // Putting the badges AWAY. The first field screenshot of this feature
    // showed the pills drawn correctly over open terrain with the shop shut.
    // ---------------------------------------------------------------------

    [Fact]
    public void Press_to_show_and_press_to_hide_stay_in_step_across_a_whole_game_of_chat()
    {
        // THE STRAND, DIRECTLY. The latch is a toggle, so a press that is
        // SWALLOWED desyncs it from the real shop by exactly one: the player
        // presses to close, League closes the shop, the gate eats the press,
        // and the latch is still open with the pills still drawn. With the gate
        // off no press is ever eaten, so the toggle cannot slip - and the chat
        // traffic below is the same shape that ate six presses on 1.0.17.
        var latch = new ShopVisibilityLatch(chatGateEnabled: false);
        latch.Observe(InGame(atMs: 0));

        var expected = false;
        for (var press = 0; press < 20; press++)
        {
            var at = 1_000 + press * 900;

            // A chat message lands between every pair of presses.
            latch.Observe(InGame(chat: true, atMs: at - 400));
            latch.Observe(InGame(atMs: at - 350));

            var pressed = latch.Observe(InGame(shop: true, atMs: at));
            latch.Observe(InGame(atMs: at + 50));

            expected = !expected;
            Assert.Equal(expected, pressed.Open);
            Assert.Equal(expected, latch.IsOpen);
            Assert.True(pressed.Changed);
            Assert.False(pressed.SuppressedByChatNow);
        }

        Assert.Equal(20, latch.Toggles);
        Assert.Equal(0, latch.SuppressedByChat);
        Assert.False(latch.IsOpen);   // twenty presses, so back where it started
    }

    [Fact]
    public void A_press_hides_the_badges_even_when_the_belief_is_stale_and_wrong()
    {
        // The worst state the inference can be in: the badges are up, the
        // belief is stuck open from a chat edge nothing ever closed, and the
        // player wants the pills gone. The press must land.
        var latch = new ShopVisibilityLatch(chatGateEnabled: false);
        latch.Observe(InGame(atMs: 0));
        latch.Observe(InGame(shop: true, atMs: 100));
        latch.Observe(InGame(atMs: 150));
        Assert.True(latch.IsOpen);

        // A belief opens and is never closed by anything.
        latch.Observe(InGame(chat: true, atMs: 200));
        latch.Observe(InGame(atMs: 250));
        Assert.True(latch.IsChatOpen);

        var hidden = latch.Observe(InGame(shop: true, atMs: 1_000));

        Assert.False(hidden.Open);
        Assert.True(hidden.Changed);
        Assert.Equal(ShopVisibilityLatch.ReasonChatGateOff, hidden.Reason);
    }

    [Fact]
    public void An_open_latch_that_nothing_affirms_is_dropped_rather_than_left_over_the_map()
    {
        // League closes the shop when you click its close button and when you
        // walk out of range, and NEITHER produces a key edge. Before this the
        // pills stayed drawn for the rest of the match; the player saw exactly
        // that. The player's own press is still the fast path - this only
        // bounds the case where they never press again.
        var latch = new ShopVisibilityLatch(chatGateEnabled: false);
        latch.Observe(InGame(atMs: 0));
        latch.Observe(InGame(shop: true, atMs: 1_000));
        latch.Observe(InGame(atMs: 1_050));
        Assert.True(latch.IsOpen);

        var timeout = ShopVisibilityLatch.OpenLatchTimeout.TotalMilliseconds;

        // One tick short: still up. The badges must not vanish early.
        var early = latch.Observe(InGame(atMs: 1_000 + timeout - 50));
        Assert.True(early.Open);
        Assert.False(early.Changed);
        Assert.Equal(0, latch.LatchesTimedOut);

        var dropped = latch.Observe(InGame(atMs: 1_000 + timeout));

        Assert.False(dropped.Open);
        Assert.True(dropped.Changed);
        Assert.Equal(ShopVisibilityLatch.ReasonOpenTimedOut, dropped.Reason);
        Assert.Equal(1, latch.LatchesTimedOut);

        // ...and it does not keep firing at 50 ms once the latch is shut.
        for (var tick = 0; tick < 20; tick++)
            Assert.False(latch.Observe(InGame(atMs: 1_000 + timeout + tick * 50)).Changed);
        Assert.Equal(1, latch.LatchesTimedOut);
    }

    [Fact]
    public void A_fresh_press_re_arms_the_open_latch_rather_than_racing_the_expiry()
    {
        // Staleness is judged AFTER the edges for the same reason the chat
        // belief is: a player who reopens the shop must get the full window,
        // not whatever is left of the previous one.
        var latch = new ShopVisibilityLatch(chatGateEnabled: false);
        var timeout = ShopVisibilityLatch.OpenLatchTimeout.TotalMilliseconds;
        latch.Observe(InGame(atMs: 0));

        latch.Observe(InGame(shop: true, atMs: 0));           // open
        latch.Observe(InGame(atMs: 50));
        latch.Observe(InGame(shop: true, atMs: timeout - 10_000));   // close
        latch.Observe(InGame(atMs: timeout - 9_950));
        latch.Observe(InGame(shop: true, atMs: timeout - 9_900));    // open again
        latch.Observe(InGame(atMs: timeout - 9_850));
        Assert.True(latch.IsOpen);

        // Past the ORIGINAL deadline, well inside the new one.
        Assert.True(latch.Observe(InGame(atMs: timeout + 1_000)).Open);
        Assert.Equal(0, latch.LatchesTimedOut);

        // And past the new one it goes.
        Assert.False(latch.Observe(InGame(atMs: timeout * 2)).Open);
        Assert.Equal(1, latch.LatchesTimedOut);
    }
}
'''

p = 'desktop/tests/CoachBuild.Core.Tests/ShopVisibilityLatchTests.cs'
s = open(p, encoding='utf-8').read().rstrip()
cut = s.rfind('}')
s = s[:cut].rstrip('\n') + '\n' + body
open(p, 'w', encoding='utf-8', newline='').write(s)
print('ok')
