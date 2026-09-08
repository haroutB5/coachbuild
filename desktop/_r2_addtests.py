import io

p = 'desktop/tests/CoachBuild.Core.Tests/ShopVisibilityLatchTests.cs'
s = open(p, encoding='utf-8').read()

body = r'''
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
        // millisecond: every chat transition it recorded and every one of the
        // six presses it swallowed, in one interleaved script. On 1.0.17 the
        // score was 6 ignored / 0 honoured. Anything but 6 honoured here is the
        // same bug back.
        var latch = new ShopVisibilityLatch(chatGateEnabled: false);
        var start = TimeSpan.Parse("22:55:00");
        double At(string clock) => (TimeSpan.Parse(clock) - start).TotalMilliseconds;

        var chatEdges = new[]
        {
            "22:55:35.038", "22:55:38.042",
            "22:57:59.183", "22:57:59.432",
            "22:58:19.992", "22:58:22.288", "22:58:24.130",
            "22:58:25.729", "22:58:30.886", "22:58:31.740",
            "22:58:49.379", "22:58:50.338",
            "23:00:03.041", "23:00:05.337",
            "23:01:14.137", "23:01:14.990",
            "23:02:57.378", "23:02:58.477",
            "23:03:02.039", "23:03:08.391",
        };
        var shopPresses = new[]
        {
            "22:55:35.284", "22:57:59.741", "22:58:00.441",
            "22:58:23.991", "22:58:31.478", "23:03:05.840",
        };

        var script = chatEdges.Select(clock => (At: At(clock), Chat: true))
            .Concat(shopPresses.Select(clock => (At: At(clock), Chat: false)))
            .OrderBy(entry => entry.At)
            .ToList();

        var honoured = 0;
        latch.Observe(InGame(atMs: -50));
        foreach (var step in script)
        {
            // Press and release, one poll apart, the way the 50 ms timer sees it.
            latch.Observe(InGame(chat: step.Chat, shop: !step.Chat, atMs: step.At));
            latch.Observe(InGame(atMs: step.At + 50));
            if (!step.Chat) honoured++;
        }

        Assert.Equal(6, honoured);
        Assert.Equal(0, latch.SuppressedByChat);
        Assert.Equal(6, latch.Toggles);

        // Every one of the six landed while chat was believed open. That is the
        // measurement of how completely 1.0.17's gate owned this game.
        Assert.Equal(6, latch.ChatGateBypassed);
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
}
'''

s = s.rstrip()
cut = s.rfind('}')
s = s[:cut].rstrip('\n') + '\n' + body

if 'using System.Linq;' not in s:
    s = s.replace('using CoachBuild.Core;', 'using System.Linq;\nusing CoachBuild.Core;', 1)

open(p, 'w', encoding='utf-8', newline='').write(s)
print('ok')
