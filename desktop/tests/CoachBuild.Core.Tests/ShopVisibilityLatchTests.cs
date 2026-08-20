using System.Linq;
using CoachBuild.Core;
using Xunit;

namespace CoachBuild.Core.Tests;

/// <summary>
/// The shop-open inference, driven entirely through <see cref="ShopObservation"/>
/// so the whole state machine is provable without a keyboard, a game, or an
/// unlocked workstation.
/// </summary>
public sealed class ShopVisibilityLatchTests
{
    /// <summary>
    /// One in-game tick. <paramref name="atMs"/> is the MONOTONIC reading the
    /// latch expires stale chat beliefs off; it defaults to 0 so every test
    /// written before the belief could expire still describes the same
    /// instant-in-time it always did.
    /// </summary>
    private static ShopObservation InGame(
        bool shop = false,
        bool close = false,
        bool chat = false,
        bool allChat = false,
        bool foreground = true,
        double atMs = 0) =>
        new(
            InGame: true,
            LeagueForeground: foreground,
            ShopKeyDown: shop,
            CloseKeyDown: close,
            ChatKeyDown: chat,
            ChatAllKeyDown: allChat,
            At: TimeSpan.FromMilliseconds(atMs));

    private static ShopObservation OutOfGame(bool shop = false) =>
        new(
            InGame: false,
            LeagueForeground: false,
            ShopKeyDown: shop,
            CloseKeyDown: false,
            ChatKeyDown: false,
            ChatAllKeyDown: false,
            At: TimeSpan.Zero);

    [Fact]
    public void A_press_opens_and_a_second_press_closes()
    {
        var latch = new ShopVisibilityLatch(chatGateEnabled: true);
        latch.Observe(InGame());

        var opened = latch.Observe(InGame(shop: true));
        Assert.True(opened.Open);
        Assert.True(opened.Changed);
        Assert.Equal(ShopVisibilityLatch.ReasonShopKey, opened.Reason);

        var released = latch.Observe(InGame());
        Assert.True(released.Open);
        Assert.False(released.Changed);

        var closed = latch.Observe(InGame(shop: true));
        Assert.False(closed.Open);
        Assert.True(closed.Changed);
        Assert.Equal(2, latch.Toggles);
    }

    [Fact]
    public void A_held_key_toggles_once_not_once_per_tick()
    {
        // 50 ms polling over a 150 ms keypress is three samples. Level
        // triggering here would open and close the shop twice per tap.
        var latch = new ShopVisibilityLatch(chatGateEnabled: true);
        latch.Observe(InGame());
        for (var tick = 0; tick < 20; tick++) latch.Observe(InGame(shop: true));

        Assert.True(latch.IsOpen);
        Assert.Equal(1, latch.Toggles);
    }

    [Fact]
    public void A_key_held_across_the_start_of_a_game_is_not_a_press()
    {
        // REGRESSION. The not-in-game branch used to zero the previous-key
        // state, which is exactly what turns a held key into a rising edge on
        // the first in-game tick - the opposite of what its own comment
        // claimed. The player rests a finger on grave in the loading screen and
        // the numbers appear over a shop that is shut.
        var latch = new ShopVisibilityLatch(chatGateEnabled: true);
        for (var tick = 0; tick < 5; tick++)
        {
            latch.Observe(new ShopObservation(
                InGame: false,
                LeagueForeground: true,
                ShopKeyDown: true,
                CloseKeyDown: false,
                ChatKeyDown: false,
                ChatAllKeyDown: false,
                At: TimeSpan.Zero));
        }

        var firstInGameTick = latch.Observe(InGame(shop: true));

        Assert.False(firstInGameTick.Open);
        Assert.Equal(0, latch.Toggles);

        // And the key still works once it is released and pressed again.
        latch.Observe(InGame());
        Assert.True(latch.Observe(InGame(shop: true)).Open);
    }

    [Fact]
    public void Returning_to_League_with_the_key_already_held_is_not_a_press()
    {
        var latch = new ShopVisibilityLatch(chatGateEnabled: true);
        latch.Observe(InGame());
        latch.Observe(InGame(shop: true, foreground: false));
        latch.Observe(InGame(shop: true, foreground: false));

        var back = latch.Observe(InGame(shop: true));

        Assert.False(back.Open);
        Assert.Equal(0, latch.Toggles);
    }

    [Fact]
    public void A_key_pressed_in_another_application_never_reaches_the_latch()
    {
        var latch = new ShopVisibilityLatch(chatGateEnabled: true);
        latch.Observe(InGame());
        for (var tick = 0; tick < 10; tick++)
        {
            latch.Observe(InGame(shop: tick % 2 == 0, foreground: false));
        }

        Assert.False(latch.IsOpen);
        Assert.Equal(0, latch.Toggles);
        Assert.Equal(ShopVisibilityLatch.ReasonLeagueNotForeground, latch.Reason);
    }

    [Fact]
    public void Losing_the_foreground_while_the_shop_is_open_closes_it()
    {
        var latch = new ShopVisibilityLatch(chatGateEnabled: true);
        latch.Observe(InGame());
        latch.Observe(InGame(shop: true));
        Assert.True(latch.IsOpen);

        var alttabbed = latch.Observe(InGame(foreground: false));
        Assert.False(alttabbed.Open);
        Assert.True(alttabbed.Changed);
        Assert.Equal(ShopVisibilityLatch.ReasonLeagueNotForeground, alttabbed.Reason);
    }

    [Fact]
    public void Escape_closes_the_shop()
    {
        var latch = new ShopVisibilityLatch(chatGateEnabled: true);
        latch.Observe(InGame());
        latch.Observe(InGame(shop: true));
        latch.Observe(InGame());

        var escaped = latch.Observe(InGame(close: true));
        Assert.False(escaped.Open);
        Assert.True(escaped.Changed);
        Assert.Equal(ShopVisibilityLatch.ReasonCloseKey, escaped.Reason);
    }

    [Fact]
    public void While_chat_is_open_the_shop_key_is_ignored_and_says_so()
    {
        // The player's shop key is grave, which is also a character people
        // type. Without this gate every backtick in chat opens the numbers.
        var latch = new ShopVisibilityLatch(chatGateEnabled: true);
        latch.Observe(InGame());
        latch.Observe(InGame(chat: true));
        Assert.True(latch.IsChatOpen);
        latch.Observe(InGame());

        var typed = latch.Observe(InGame(shop: true));

        Assert.False(typed.Open);
        Assert.False(typed.Changed);
        // Changed is false BY DEFINITION here, so a Changed-only report could
        // never mention this. The separate flag is the only way the log can
        // distinguish "ignored your key" from "never saw your key".
        Assert.True(typed.SuppressedByChatNow);
        Assert.Equal(1, latch.SuppressedByChat);
        Assert.Equal(0, latch.Toggles);
        Assert.Equal(ShopVisibilityLatch.ReasonChatSuppressed, typed.Reason);
    }

    [Fact]
    public void Sending_the_message_closes_chat_and_the_shop_key_works_again()
    {
        var latch = new ShopVisibilityLatch(chatGateEnabled: true);
        latch.Observe(InGame());
        latch.Observe(InGame(chat: true));   // Enter opens chat
        latch.Observe(InGame());
        latch.Observe(InGame(chat: true));   // Enter sends and closes it
        latch.Observe(InGame());

        Assert.False(latch.IsChatOpen);
        Assert.True(latch.Observe(InGame(shop: true)).Open);
        Assert.Equal(0, latch.SuppressedByChat);
    }

    [Fact]
    public void Escape_leaves_chat_without_also_closing_the_shop()
    {
        // In game these are one keypress doing one thing, never both.
        var latch = new ShopVisibilityLatch(chatGateEnabled: true);
        latch.Observe(InGame());
        latch.Observe(InGame(shop: true));
        latch.Observe(InGame());
        latch.Observe(InGame(chat: true));
        latch.Observe(InGame());
        Assert.True(latch.IsOpen);
        Assert.True(latch.IsChatOpen);

        latch.Observe(InGame(close: true));

        Assert.False(latch.IsChatOpen);
        Assert.True(latch.IsOpen);
    }

    [Fact]
    public void The_end_of_a_game_forgets_everything()
    {
        var latch = new ShopVisibilityLatch(chatGateEnabled: true);
        latch.Observe(InGame());
        latch.Observe(InGame(shop: true));
        latch.Observe(InGame());
        latch.Observe(InGame(chat: true));
        Assert.True(latch.IsOpen);
        Assert.Equal(1, latch.Toggles);

        var ended = latch.Observe(OutOfGame());

        Assert.False(ended.Open);
        Assert.True(ended.Changed);
        Assert.False(latch.IsChatOpen);
        Assert.Equal(0, latch.Toggles);
        Assert.Equal(0, latch.SuppressedByChat);
        Assert.Equal(ShopVisibilityLatch.ReasonNotInGame, ended.Reason);
    }

    [Fact]
    public void Idle_in_game_reports_closed_rather_than_whichever_gate_ran_last()
    {
        var latch = new ShopVisibilityLatch(chatGateEnabled: true);
        latch.Observe(OutOfGame());
        var idle = latch.Observe(InGame());

        Assert.False(idle.Open);
        Assert.Equal(ShopVisibilityLatch.ReasonIdle, idle.Reason);
    }

    // -- The 2026-08-19 incident: a belief that could never end ---------------
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
        var latch = new ShopVisibilityLatch(chatGateEnabled: true);
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
        var latch = new ShopVisibilityLatch(chatGateEnabled: true);
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
        var latch = new ShopVisibilityLatch(chatGateEnabled: true);
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
        var latch = new ShopVisibilityLatch(chatGateEnabled: true);
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
        var latch = new ShopVisibilityLatch(chatGateEnabled: true);
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
        var latch = new ShopVisibilityLatch(chatGateEnabled: true);
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
        var latch = new ShopVisibilityLatch(chatGateEnabled: true);
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
        var latch = new ShopVisibilityLatch(chatGateEnabled: true);
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
        var latch = new ShopVisibilityLatch(chatGateEnabled: true);
        latch.Observe(InGame());
        latch.Observe(InGame(chat: true, atMs: 0));
        latch.Observe(InGame(atMs: 50));

        var typed = latch.Observe(InGame(shop: true, atMs: 500));

        Assert.True(typed.SuppressedByChatNow);
        Assert.False(typed.Open);
        Assert.Equal(0, latch.ChatOverrides);
    }

    [Fact]
    public void An_override_survives_the_conversations_between_the_two_presses()
    {
        // REGRESSION, and a DELIBERATE REVERSAL of 1.0.17. This test used to
        // assert the opposite - that a suppression only counts inside the
        // belief episode it landed in - on the reasoning that a press
        // swallowed two conversations ago should not arm an override against a
        // belief that is perfectly correct.
        //
        // The second game killed that reasoning. Chat opened and closed roughly
        // fifteen times in eight minutes, and five of the six swallowed presses
        // were the only press inside their episode, so the counter was zeroed
        // before a second press could ever meet it: the recovery shipped in
        // 1.0.17 was unreachable for anybody who actually talks. Insistence is
        // now counted per GAME and cleared by an HONOURED press, which is the
        // event that means the player finally got what they were asking for.
        var latch = new ShopVisibilityLatch(chatGateEnabled: true);
        latch.Observe(InGame());
        latch.Observe(InGame(chat: true, atMs: 0));
        latch.Observe(InGame(atMs: 50));
        Assert.True(latch.Observe(InGame(shop: true, atMs: 500)).SuppressedByChatNow);
        latch.Observe(InGame(atMs: 550));

        latch.Observe(InGame(chat: true, atMs: 1_000));       // that conversation ends
        latch.Observe(InGame(atMs: 1_050));
        latch.Observe(InGame(chat: true, atMs: 2_000));       // and a new one starts
        latch.Observe(InGame(atMs: 2_050));

        var insisted = latch.Observe(InGame(shop: true, atMs: 9_000));
        Assert.False(insisted.SuppressedByChatNow);
        Assert.True(insisted.Open);
        Assert.Equal(ShopVisibilityLatch.ReasonChatOverridden, insisted.Reason);
        Assert.Equal(1, latch.ChatOverrides);

        // ...and the honoured press ENDS the run, so the next swallowed press
        // starts a fresh one rather than overriding on its own.
        latch.Observe(InGame(atMs: 9_050));
        latch.Observe(InGame(chat: true, atMs: 10_000));
        latch.Observe(InGame(atMs: 10_050));
        var swallowedAgain = latch.Observe(InGame(shop: true, atMs: 11_000));
        Assert.True(swallowedAgain.SuppressedByChatNow);
        Assert.Equal(1, latch.ChatOverrides);
    }

    [Fact]
    public void The_second_press_that_should_have_worked_in_the_real_log_now_does()
    {
        // The exact pair from _evidence/gaming-pc-companion-2026-08-19-1017.log:
        //   22:57:59.7411  your shop key was ignored (2 so far this game)
        //   22:58:00.4411  your shop key was ignored (3 so far this game)
        // 0.700 s apart - comfortably past InsistGap - and the second one was
        // swallowed anyway. Pinned in real numbers so a future tweak to the
        // bookkeeping cannot quietly make it unreachable again.
        var latch = new ShopVisibilityLatch(chatGateEnabled: true);
        latch.Observe(InGame());
        latch.Observe(InGame(chat: true, atMs: 0));
        latch.Observe(InGame(atMs: 50));

        var first = latch.Observe(InGame(shop: true, atMs: 700));
        Assert.True(first.SuppressedByChatNow);
        latch.Observe(InGame(atMs: 750));

        var second = latch.Observe(InGame(shop: true, atMs: 1_400));
        Assert.Equal(TimeSpan.FromMilliseconds(700), TimeSpan.FromMilliseconds(1_400 - 700));
        Assert.False(second.SuppressedByChatNow);
        Assert.True(second.Open);
        Assert.Equal(1, latch.ChatOverrides);
    }

    [Fact]
    public void The_belief_says_so_in_the_log_exactly_when_it_changes()
    {
        // The incident's log recorded four suppressed presses and NOT ONE WORD
        // about when the watcher decided chat was open, which is why it could
        // not be diagnosed from the log alone.
        var latch = new ShopVisibilityLatch(chatGateEnabled: true);
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
        var latch = new ShopVisibilityLatch(chatGateEnabled: true);
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
        var latch = new ShopVisibilityLatch(chatGateEnabled: true);
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

    [Fact]
    public void Changed_is_raised_only_on_a_transition()
    {
        var latch = new ShopVisibilityLatch(chatGateEnabled: true);
        var changes = 0;
        void Feed(ShopObservation observation)
        {
            if (latch.Observe(observation).Changed) changes++;
        }

        Feed(InGame());
        for (var tick = 0; tick < 30; tick++) Feed(InGame());
        Feed(InGame(shop: true));
        for (var tick = 0; tick < 30; tick++) Feed(InGame(shop: true));
        for (var tick = 0; tick < 30; tick++) Feed(InGame());

        Assert.Equal(1, changes);
        Assert.True(latch.IsOpen);
    }

    // ---------------------------------------------------------------------
    // 1.0.18: the gate is OFF unless asked for. These describe what SHIPS -
    // every test above this line opts INTO the gate, so without them the
    // shipped configuration would have no coverage at all.
    // ---------------------------------------------------------------------

    [Fact]
    public void With_the_gate_off_a_press_lands_even_while_chat_is_believed_open()
    {
        // The user's instruction after two games of swallowed presses: the shop
        // key must show the numbers EVERY time. They know their shop character
        // can appear in a typed word and want it honoured anyway.
        var latch = new ShopVisibilityLatch(chatGateEnabled: false);
        latch.Observe(InGame());
        latch.Observe(InGame(chat: true, atMs: 0));
        latch.Observe(InGame(atMs: 50));
        Assert.True(latch.IsChatOpen);

        var pressed = latch.Observe(InGame(shop: true, atMs: 500));

        Assert.True(pressed.Open);
        Assert.True(pressed.Changed);
        Assert.False(pressed.SuppressedByChatNow);
        Assert.Equal(ShopVisibilityLatch.ReasonChatGateOff, pressed.Reason);
        Assert.Equal(0, latch.SuppressedByChat);
        Assert.Equal(1, latch.ChatGateBypassed);

        // ...and the belief is untouched by the press: it is an observation
        // now, not a veto, which is what keeps ChatGateBypassed meaningful.
        Assert.True(latch.IsChatOpen);
    }

    [Fact]
    public void With_the_gate_off_a_press_outside_chat_is_an_ordinary_press()
    {
        // The bypass counter must count BYPASSES, not presses. If it ticked on
        // every press it would read as "the gate would have been wrong forty
        // times" in a game where chat was never open at all.
        var latch = new ShopVisibilityLatch(chatGateEnabled: false);
        latch.Observe(InGame());

        var pressed = latch.Observe(InGame(shop: true, atMs: 500));

        Assert.True(pressed.Open);
        Assert.Equal(ShopVisibilityLatch.ReasonShopKey, pressed.Reason);
        Assert.Equal(0, latch.ChatGateBypassed);
    }

    [Fact]
    public void With_the_gate_off_the_belief_writes_no_lines()
    {
        // ~50 lines a game about a decision that is no longer being made, in a
        // file trimmed at 200 KB. The fact a future incident needs rides on the
        // honoured-press reason instead.
        var latch = new ShopVisibilityLatch(chatGateEnabled: false);
        var notes = new List<string>();
        void Feed(ShopObservation observation)
        {
            if (latch.Observe(observation).ChatNote is { } note) notes.Add(note);
        }

        Feed(InGame());
        for (var round = 0; round < 5; round++)
        {
            var at = round * 1_000;
            Feed(InGame(chat: true, atMs: at));
            Feed(InGame(atMs: at + 50));
            Feed(InGame(chat: true, atMs: at + 400));
            Feed(InGame(atMs: at + 450));
        }

        Assert.Empty(notes);

        // POSITIVE CONTROL on the identical script: the lines exist, they are
        // just switched off. Without this, a note-formatting bug would read as
        // a pass.
        var gated = new ShopVisibilityLatch(chatGateEnabled: true);
        var gatedNotes = new List<string>();
        void FeedGated(ShopObservation observation)
        {
            if (gated.Observe(observation).ChatNote is { } note) gatedNotes.Add(note);
        }

        FeedGated(InGame());
        for (var round = 0; round < 5; round++)
        {
            var at = round * 1_000;
            FeedGated(InGame(chat: true, atMs: at));
            FeedGated(InGame(atMs: at + 50));
            FeedGated(InGame(chat: true, atMs: at + 400));
            FeedGated(InGame(atMs: at + 450));
        }

        Assert.Equal(10, gatedNotes.Count);
    }

    [Fact]
    public void The_whole_second_game_replayed_with_the_gate_off_draws_the_numbers_every_time()
    {
        // _evidence/gaming-pc-companion-2026-08-19-1017.log, to the
        // millisecond: every belief the log STATES and every one of the six
        // presses it swallowed, in one interleaved script. On 1.0.17 the score
        // was 6 ignored / 0 honoured. Anything but 6 honoured here is the same
        // bug back.
        //
        // The belief is driven to the state the log NAMES on each line rather
        // than by replaying raw Enter edges, and that distinction is a finding
        // in itself: the transcribed lines do not alternate (two consecutive
        // "believed open (Enter)" at 22:57:59.183 and .432, two consecutive
        // "believed closed" at 22:58:22.288 and 24.130), and no path through
        // this class can emit that - BelieveChatOpen returns its note only when
        // the belief was closed and ForgetChatBelief only when it was open. A
        // naive edge replay therefore disagrees with the log about the belief
        // at three of the six presses. See the Round 2 handoff.
        var latch = new ShopVisibilityLatch(chatGateEnabled: false);
        var start = TimeSpan.Parse("22:55:00");
        double At(string clock) => (TimeSpan.Parse(clock) - start).TotalMilliseconds;

        // (clock, believed-open) as the log states it; null = a shop press.
        var script = new (string Clock, bool? BeliefOpen)[]
        {
            ("22:55:35.038", true),
            ("22:55:35.284", null),
            ("22:55:38.042", false),
            ("22:57:59.183", true),
            ("22:57:59.432", true),
            ("22:57:59.741", null),
            ("22:58:00.441", null),
            ("22:58:19.992", true),
            ("22:58:22.288", false),
            ("22:58:23.991", null),
            ("22:58:24.130", false),
            ("22:58:25.729", true),
            ("22:58:30.886", true),
            ("22:58:31.478", null),
            ("22:58:31.740", false),
            ("22:58:49.379", true),
            ("22:58:50.338", false),
            ("23:00:03.041", true),
            ("23:00:05.337", false),
            ("23:01:14.137", true),
            ("23:01:14.990", false),
            ("23:02:57.378", true),
            ("23:02:58.477", false),
            ("23:03:02.039", true),
            ("23:03:05.840", null),
            ("23:03:08.391", false),
        };

        var honoured = 0;
        latch.Observe(InGame(atMs: -50));
        foreach (var (clock, beliefOpen) in script)
        {
            var at = At(clock);
            if (beliefOpen is { } wanted)
            {
                // An Enter tap, and only when it would actually move the belief
                // to where the log says it was.
                if (latch.IsChatOpen != wanted)
                {
                    latch.Observe(InGame(chat: true, atMs: at));
                    latch.Observe(InGame(atMs: at + 50));
                }

                Assert.Equal(wanted, latch.IsChatOpen);
                continue;
            }

            var pressed = latch.Observe(InGame(shop: true, atMs: at));
            latch.Observe(InGame(atMs: at + 50));
            Assert.False(pressed.SuppressedByChatNow);
            Assert.True(pressed.Changed);
            honoured++;
        }

        Assert.Equal(6, honoured);
        Assert.Equal(0, latch.SuppressedByChat);
        Assert.Equal(6, latch.Toggles);

        // FIVE of the six landed while the log SAYS chat was believed open, and
        // the sixth is the transcript contradicting itself: the press at
        // 22:58:23.991 was logged as suppressed, which is only reachable with
        // the belief open, while the last belief line before it (22:58:22.288)
        // says closed and the next one (22:58:24.130) says closed again. Pinned
        // at 5 rather than fudged to 6 so this number stays a measurement of
        // the evidence rather than of the story - and so the count moves if the
        // user ever sends an untranscribed copy of the file.
        Assert.Equal(5, latch.ChatGateBypassed);
    }

    [Fact]
    public void The_gate_being_off_does_not_switch_off_the_other_three_gates()
    {
        // Escape, the foreground gate and the end of the game are
        // unconditional. Turning the chat gate off must not take them with it -
        // an overlay left drawn over another application is a worse bug than
        // the one being fixed.
        var latch = new ShopVisibilityLatch(chatGateEnabled: false);
        latch.Observe(InGame());
        Assert.True(latch.Observe(InGame(shop: true)).Open);
        latch.Observe(InGame());

        // Escape closes it.
        Assert.False(latch.Observe(InGame(close: true)).Open);
        Assert.Equal(ShopVisibilityLatch.ReasonCloseKey, latch.Reason);

        // Alt-tab closes it.
        latch.Observe(InGame());
        Assert.True(latch.Observe(InGame(shop: true)).Open);
        var left = latch.Observe(InGame(foreground: false));
        Assert.False(left.Open);
        Assert.Equal(ShopVisibilityLatch.ReasonLeagueNotForeground, left.Reason);

        // And the end of the game forgets the counters, bypasses included.
        latch.Observe(InGame());
        latch.Observe(InGame(chat: true, atMs: 100));
        latch.Observe(InGame(atMs: 150));
        latch.Observe(InGame(shop: true, atMs: 200));
        Assert.True(latch.ChatGateBypassed > 0);
        latch.Observe(OutOfGame());
        Assert.Equal(0, latch.ChatGateBypassed);
        Assert.Equal(0, latch.Toggles);
        Assert.False(latch.IsOpen);
    }

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
