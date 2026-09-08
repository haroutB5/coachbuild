import io

p = r"tests/CoachBuild.Core.Tests/ShopVisibilityLatchTests.cs"
s = io.open(p, encoding="utf-8").read()
marker = "    [Fact]\n    public void Changed_is_raised_only_on_a_transition()"
assert marker in s

new_tests = r'''    // -- The 2026-08-19 incident: a belief that could never end ---------------
    //
    // Twenty minutes into a real game the player pressed their shop key four
    // times over 19 seconds and the numbers never drew once. companion.log:
    //
    //   21:04:31.38  shop: your shop key was ignored ... (1 so far this game)
    //   21:04:31.69  ... (2)
    //   21:04:40.20  ... (3)
    //   21:04:50.69  ... (4)
    //
    // The gate's own justification had been "believing chat is open when it is
    // not merely SUPPRESSES a toggle - the player presses the key again and it
    // works". These tests are that sentence, made true.

    [Fact]
    public void Shift_Enter_opens_all_chat_and_the_plain_Enter_that_sends_it_closes_the_belief()
    {
        // ROOT CAUSE, REPRODUCED. Modifiers are matched exactly, so Shift+Enter
        // used to be invisible while the plain Enter that SENDS the message was
        // seen - the belief flipped to "open" at the exact moment chat actually
        // closed, and nothing could ever flip it back. One unseen edge, a dead
        // feature for the rest of the match.
        var latch = new ShopVisibilityLatch();
        latch.Observe(InGame());

        latch.Observe(InGame(allChat: true, atMs: 1_000));   // Shift+Enter opens all chat
        Assert.True(latch.IsChatOpen);
        latch.Observe(InGame(atMs: 1_050));

        latch.Observe(InGame(chat: true, atMs: 4_000));      // plain Enter sends it
        Assert.False(latch.IsChatOpen);
        latch.Observe(InGame(atMs: 4_050));

        // ...and the shop key works immediately, with nothing swallowed.
        Assert.True(latch.Observe(InGame(shop: true, atMs: 4_100)).Open);
        Assert.Equal(0, latch.SuppressedByChat);
    }

    [Fact]
    public void Shift_Enter_while_already_typing_switches_channel_and_leaves_chat_open()
    {
        // In game it changes the channel; it never closes the input. So it SETS
        // the belief rather than toggling it - a toggle here would close a
        // belief that is correct and reopen the original bug from the far side.
        var latch = new ShopVisibilityLatch();
        latch.Observe(InGame());
        latch.Observe(InGame(chat: true, atMs: 100));
        latch.Observe(InGame(atMs: 150));
        Assert.True(latch.IsChatOpen);

        latch.Observe(InGame(allChat: true, atMs: 500));
        Assert.True(latch.IsChatOpen);
    }

    [Fact]
    public void Modulating_Shift_with_Enter_already_held_is_not_a_second_press()
    {
        // Enter and Shift+Enter are ONE physical key. Edging them separately
        // would have the belief flip every time a finger found or left Shift
        // while Enter was down.
        var latch = new ShopVisibilityLatch();
        latch.Observe(InGame());

        latch.Observe(InGame(chat: true, atMs: 100));        // Enter down
        Assert.True(latch.IsChatOpen);
        latch.Observe(InGame(allChat: true, atMs: 150));     // Shift joins it
        latch.Observe(InGame(chat: true, atMs: 200));        // Shift leaves it
        latch.Observe(InGame(allChat: true, atMs: 250));     // and back

        Assert.True(latch.IsChatOpen);
        latch.Observe(InGame(atMs: 300));                    // released at last
        latch.Observe(InGame(chat: true, atMs: 400));        // a real second press
        Assert.False(latch.IsChatOpen);
    }

    [Fact]
    public void Pressing_the_shop_key_again_overrides_a_stuck_chat_belief()
    {
        // THE RECOVERY THE OLD COMMENT ONLY PROMISED. The belief is wrong (chat
        // is not really open) and no key will ever correct it, so the player's
        // second deliberate press is the evidence: nobody presses their shop
        // bind twice, seconds apart, while typing a message.
        var latch = new ShopVisibilityLatch();
        latch.Observe(InGame());
        latch.Observe(InGame(chat: true, atMs: 4_000));
        latch.Observe(InGame(atMs: 4_050));
        Assert.True(latch.IsChatOpen);

        var first = latch.Observe(InGame(shop: true, atMs: 5_000));
        Assert.True(first.SuppressedByChatNow);
        Assert.False(first.Open);
        latch.Observe(InGame(atMs: 5_050));

        var second = latch.Observe(InGame(shop: true, atMs: 5_900));  // 900 ms later
        Assert.True(second.Open);
        Assert.True(second.Changed);
        Assert.False(second.SuppressedByChatNow);
        Assert.False(latch.IsChatOpen);
        Assert.Equal(ShopVisibilityLatch.ReasonChatOverridden, second.Reason);
        Assert.Equal(1, latch.ChatOverrides);
        Assert.Equal(1, latch.SuppressedByChat);
    }

    [Fact]
    public void The_real_log_would_have_recovered_on_the_third_press()
    {
        // The incident's own timings, replayed: 0.00 s, +0.31 s, +8.82 s.
        // The fumbled double-tap must NOT override the gate; the deliberate
        // third attempt must.
        var latch = new ShopVisibilityLatch();
        latch.Observe(InGame());
        latch.Observe(InGame(chat: true, atMs: 0));
        latch.Observe(InGame(atMs: 50));
        Assert.True(latch.IsChatOpen);

        Assert.True(latch.Observe(InGame(shop: true, atMs: 1_000)).SuppressedByChatNow);
        latch.Observe(InGame(atMs: 1_050));
        Assert.True(latch.Observe(InGame(shop: true, atMs: 1_310)).SuppressedByChatNow);
        latch.Observe(InGame(atMs: 1_360));

        var third = latch.Observe(InGame(shop: true, atMs: 9_820));
        Assert.True(third.Open);
        Assert.Equal(2, latch.SuppressedByChat);
        Assert.Equal(1, latch.ChatOverrides);
    }

    [Fact]
    public void A_double_letter_typed_in_chat_does_not_override_the_gate()
    {
        // NEGATIVE CONTROL for the rule above, and the reason the gap exists at
        // all. A player on League's default P bind typing "happy" produces two
        // shop-key edges ~100 ms apart. Both must be swallowed - otherwise the
        // recovery would break the case the gate was built for.
        var latch = new ShopVisibilityLatch();
        latch.Observe(InGame());
        latch.Observe(InGame(chat: true, atMs: 0));
        latch.Observe(InGame(atMs: 50));

        Assert.True(latch.Observe(InGame(shop: true, atMs: 1_000)).SuppressedByChatNow);
        latch.Observe(InGame(atMs: 1_050));
        var secondLetter = latch.Observe(InGame(shop: true, atMs: 1_110));

        Assert.True(secondLetter.SuppressedByChatNow);
        Assert.False(secondLetter.Open);
        Assert.Equal(0, latch.ChatOverrides);
        Assert.Equal(2, latch.SuppressedByChat);
    }

    [Fact]
    public void A_chat_belief_with_no_Enter_to_affirm_it_goes_stale()
    {
        // The backstop. Insistence needs the player to press again; this needs
        // nothing at all, so a desync cannot outlive a fight even if the player
        // never touches the shop key.
        var latch = new ShopVisibilityLatch();
        latch.Observe(InGame());
        latch.Observe(InGame(chat: true, atMs: 0));
        latch.Observe(InGame(atMs: 50));
        Assert.True(latch.IsChatOpen);

        // One tick short of the timeout: still believed, still suppressing.
        var justBefore = ShopVisibilityLatch.ChatBeliefTimeout.TotalMilliseconds - 50;
        latch.Observe(InGame(atMs: justBefore));
        Assert.True(latch.IsChatOpen);
        Assert.True(latch.Observe(InGame(shop: true, atMs: justBefore)).SuppressedByChatNow);
        latch.Observe(InGame(atMs: justBefore + 50));

        latch.Observe(InGame(atMs: ShopVisibilityLatch.ChatBeliefTimeout.TotalMilliseconds));
        Assert.False(latch.IsChatOpen);
        Assert.Equal(1, latch.ChatBeliefsExpired);
        Assert.True(latch.Observe(InGame(shop: true, atMs: 40_000)).Open);
    }

    [Fact]
    public void A_fresh_Enter_re_arms_the_belief_rather_than_racing_the_expiry()
    {
        // Staleness is judged AFTER the edges, so a player who opens chat,
        // sends, and opens it again gets a full window each time.
        var latch = new ShopVisibilityLatch();
        latch.Observe(InGame());
        var timeout = ShopVisibilityLatch.ChatBeliefTimeout.TotalMilliseconds;

        latch.Observe(InGame(chat: true, atMs: 0));
        latch.Observe(InGame(atMs: 50));
        latch.Observe(InGame(chat: true, atMs: 5_000));   // sent
        latch.Observe(InGame(atMs: 5_050));
        latch.Observe(InGame(chat: true, atMs: 6_000));   // and typing again
        latch.Observe(InGame(atMs: 6_050));

        latch.Observe(InGame(atMs: 6_000 + timeout - 50));
        Assert.True(latch.IsChatOpen);
        Assert.Equal(0, latch.ChatBeliefsExpired);
    }

    [Fact]
    public void The_first_typed_shop_character_is_still_swallowed()
    {
        // The gate's ORIGINAL job, unchanged. Everything above only bounds how
        // long a WRONG belief can last; a correct one must still work on the
        // very first press, or typing a backtick opens the numbers again.
        var latch = new ShopVisibilityLatch();
        latch.Observe(InGame());
        latch.Observe(InGame(chat: true, atMs: 0));
        latch.Observe(InGame(atMs: 50));

        var typed = latch.Observe(InGame(shop: true, atMs: 500));

        Assert.True(typed.SuppressedByChatNow);
        Assert.False(typed.Open);
        Assert.Equal(0, latch.ChatOverrides);
    }

    [Fact]
    public void An_override_needs_a_suppression_in_the_SAME_belief_episode()
    {
        // Otherwise a press swallowed three minutes and two conversations ago
        // would arm an override against a belief that is perfectly correct.
        var latch = new ShopVisibilityLatch();
        latch.Observe(InGame());
        latch.Observe(InGame(chat: true, atMs: 0));
        latch.Observe(InGame(atMs: 50));
        Assert.True(latch.Observe(InGame(shop: true, atMs: 500)).SuppressedByChatNow);
        latch.Observe(InGame(atMs: 550));

        latch.Observe(InGame(chat: true, atMs: 1_000));       // that conversation ends
        latch.Observe(InGame(atMs: 1_050));
        latch.Observe(InGame(chat: true, atMs: 2_000));       // and a new one starts
        latch.Observe(InGame(atMs: 2_050));

        var typed = latch.Observe(InGame(shop: true, atMs: 9_000));
        Assert.True(typed.SuppressedByChatNow);
        Assert.Equal(0, latch.ChatOverrides);
    }

    [Fact]
    public void The_belief_says_so_in_the_log_exactly_when_it_changes()
    {
        // The incident's log recorded four suppressed presses and NOT ONE WORD
        // about when the watcher decided chat was open, which is why it could
        // not be diagnosed from the log alone.
        var latch = new ShopVisibilityLatch();
        var notes = new List<string>();
        void Feed(ShopObservation observation)
        {
            if (latch.Observe(observation).ChatNote is { } note) notes.Add(note);
        }

        Feed(InGame());
        for (var tick = 0; tick < 5; tick++) Feed(InGame(atMs: tick * 50));
        Assert.Empty(notes);                                   // silence while nothing moves

        Feed(InGame(chat: true, atMs: 1_000));
        Feed(InGame(atMs: 1_050));
        Assert.Single(notes);
        Assert.Contains("open", notes[0], StringComparison.OrdinalIgnoreCase);

        for (var tick = 0; tick < 5; tick++) Feed(InGame(atMs: 1_100 + tick * 50));
        Assert.Single(notes);                                  // still one: nothing changed

        Feed(InGame(chat: true, atMs: 2_000));
        Assert.Equal(2, notes.Count);
        Assert.Contains("closed", notes[1], StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void Losing_the_foreground_reports_the_cleared_belief_once_not_every_tick()
    {
        var latch = new ShopVisibilityLatch();
        var notes = new List<string>();
        void Feed(ShopObservation observation)
        {
            if (latch.Observe(observation).ChatNote is { } note) notes.Add(note);
        }

        Feed(InGame());
        Feed(InGame(chat: true, atMs: 100));
        Feed(InGame(atMs: 150));
        notes.Clear();

        for (var tick = 0; tick < 20; tick++) Feed(InGame(foreground: false, atMs: 200 + tick * 50));

        Assert.Single(notes);
        Assert.False(latch.IsChatOpen);
    }

    [Fact]
    public void The_end_of_a_game_forgets_the_belief_and_its_counters()
    {
        var latch = new ShopVisibilityLatch();
        latch.Observe(InGame());
        latch.Observe(InGame(chat: true, atMs: 0));
        latch.Observe(InGame(atMs: 50));
        latch.Observe(InGame(shop: true, atMs: 500));
        latch.Observe(InGame(atMs: 550));
        latch.Observe(InGame(shop: true, atMs: 2_000));
        Assert.Equal(1, latch.ChatOverrides);

        latch.Observe(OutOfGame());

        Assert.False(latch.IsChatOpen);
        Assert.Equal(0, latch.ChatOverrides);
        Assert.Equal(0, latch.SuppressedByChat);
        Assert.Equal(0, latch.ChatBeliefsExpired);
    }

'''

s = s.replace(marker, new_tests + marker, 1)
io.open(p, "w", encoding="utf-8", newline="\n").write(s)
print("inserted")
