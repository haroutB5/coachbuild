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
    private static ShopObservation InGame(
        bool shop = false,
        bool close = false,
        bool chat = false,
        bool foreground = true) =>
        new(InGame: true, LeagueForeground: foreground, ShopKeyDown: shop, CloseKeyDown: close, ChatKeyDown: chat);

    [Fact]
    public void A_press_opens_and_a_second_press_closes()
    {
        var latch = new ShopVisibilityLatch();
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
        var latch = new ShopVisibilityLatch();
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
        var latch = new ShopVisibilityLatch();
        for (var tick = 0; tick < 5; tick++)
        {
            latch.Observe(new ShopObservation(
                InGame: false, LeagueForeground: true, ShopKeyDown: true, CloseKeyDown: false));
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
        var latch = new ShopVisibilityLatch();
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
        var latch = new ShopVisibilityLatch();
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
        var latch = new ShopVisibilityLatch();
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
        var latch = new ShopVisibilityLatch();
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
        var latch = new ShopVisibilityLatch();
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
        var latch = new ShopVisibilityLatch();
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
        var latch = new ShopVisibilityLatch();
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
        var latch = new ShopVisibilityLatch();
        latch.Observe(InGame());
        latch.Observe(InGame(shop: true));
        latch.Observe(InGame());
        latch.Observe(InGame(chat: true));
        Assert.True(latch.IsOpen);
        Assert.Equal(1, latch.Toggles);

        var ended = latch.Observe(new ShopObservation(false, false, false, false));

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
        var latch = new ShopVisibilityLatch();
        latch.Observe(new ShopObservation(false, false, false, false));
        var idle = latch.Observe(InGame());

        Assert.False(idle.Open);
        Assert.Equal(ShopVisibilityLatch.ReasonIdle, idle.Reason);
    }

    [Fact]
    public void Changed_is_raised_only_on_a_transition()
    {
        var latch = new ShopVisibilityLatch();
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
}
