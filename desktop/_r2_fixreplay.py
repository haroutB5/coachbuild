p = 'desktop/tests/CoachBuild.Core.Tests/ShopVisibilityLatchTests.cs'
s = open(p, encoding='utf-8').read()

start = s.index('    [Fact]\n    public void The_whole_second_game_replayed_with_the_gate_off_draws_the_numbers_every_time()')
end = s.index('    [Fact]\n    public void The_gate_being_off_does_not_switch_off_the_other_three_gates()')

new = r'''    [Fact]
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

        // Every one of the six landed while the log says chat was believed
        // open. That is the measurement of how completely 1.0.17's gate owned
        // this game: six for six, and it honoured none of them.
        Assert.Equal(6, latch.ChatGateBypassed);
    }

'''

s = s[:start] + new + s[end:]
open(p, 'w', encoding='utf-8', newline='').write(s)
print('ok')
