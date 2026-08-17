using CoachBuild.Core;
using CoachBuild.Desktop.Tray;
using CoachBuild.Desktop.Web;
using Xunit;

namespace CoachBuild.Desktop.Tests;

/// <summary>
/// 1.0.10's headline fix: champ select opened a WebView2 window and nothing
/// closed it when the game started. Measured PID-scoped to the app's own tree,
/// that is <b>1 process / 48.7 MB</b> before champ select against <b>7 processes
/// / 728 MB / 16.6% of one core</b> while the player is in the game — six times
/// over <c>desktop/perf/README.md</c>'s own 120 MB acceptance target, and none of
/// it the overlay.
/// </summary>
public sealed class CompanionWindowPolicyTests
{
    private const bool ChampSelectOpenedIt = false;
    private const bool TheUserAskedForIt = true;

    // ------------------------------------------------------------- the teardown

    [Fact]
    public void The_window_champ_select_opened_is_torn_down_when_the_game_starts()
    {
        Assert.Equal(
            CompanionWindowAction.CloseForGame,
            CompanionWindowPolicy.Decide(CompanionPhase.InProgress, windowOpen: true, ChampSelectOpenedIt));
    }

    [Fact]
    public void A_window_that_finishes_opening_after_load_in_is_still_torn_down()
    {
        // The champ-select open is asynchronous (runtime probe, then a
        // dispatcher-created window). An edge-triggered rule that only fired on
        // the ChampSelect -> InProgress transition would miss a window that
        // appears a second into the game and leak it for the whole match. The
        // question is asked every tick precisely so this cannot happen.
        var decisions = new List<CompanionWindowAction>();
        foreach (var windowOpen in new[] { false, false, true })
        {
            decisions.Add(CompanionWindowPolicy.Decide(
                CompanionPhase.InProgress, windowOpen, ChampSelectOpenedIt));
        }

        Assert.Equal(
            [CompanionWindowAction.None, CompanionWindowAction.None, CompanionWindowAction.CloseForGame],
            decisions);
    }

    [Fact]
    public void Reconnecting_into_a_live_game_tears_it_down_too()
    {
        Assert.Equal(
            CompanionWindowAction.CloseForGame,
            CompanionWindowPolicy.Decide(CompanionPhase.Reconnect, windowOpen: true, ChampSelectOpenedIt));
    }

    // ----------------------------------------------------- what it must not do

    [Fact]
    public void A_window_the_user_asked_for_is_never_taken_away()
    {
        // Tray Reopen, or double-clicking the app during a game. Both are the
        // user asking for the window; neither is CoachBuild's to close.
        Assert.Equal(
            CompanionWindowAction.None,
            CompanionWindowPolicy.Decide(CompanionPhase.InProgress, windowOpen: true, TheUserAskedForIt));
    }

    [Fact]
    public void An_lcu_blip_cannot_re_close_a_window_the_user_reopened_mid_game()
    {
        // GameflowPoller reports "None" whenever it has no credentials, so a
        // momentary LCU stall looks exactly like leaving the game and coming
        // back. An edge-triggered rule would fire a second teardown on the way
        // back in and take the user's window with it.
        var phases = new[]
        {
            CompanionPhase.InProgress,
            CompanionPhase.None,
            CompanionPhase.Unknown,
            CompanionPhase.InProgress,
        };

        Assert.All(
            phases,
            phase => Assert.Equal(
                CompanionWindowAction.None,
                CompanionWindowPolicy.Decide(phase, windowOpen: true, TheUserAskedForIt)));
    }

    [Theory]
    [InlineData(CompanionPhase.None)]
    [InlineData(CompanionPhase.Unknown)]
    [InlineData(CompanionPhase.Lobby)]
    [InlineData(CompanionPhase.Matchmaking)]
    [InlineData(CompanionPhase.ReadyCheck)]
    [InlineData(CompanionPhase.ChampSelect)]
    [InlineData(CompanionPhase.WaitingForStats)]
    [InlineData(CompanionPhase.PreEndOfGame)]
    [InlineData(CompanionPhase.EndOfGame)]
    public void Outside_a_game_the_window_is_left_alone(CompanionPhase phase)
    {
        // ChampSelect is in this list on purpose: the draft page is the entire
        // reason the window exists.
        Assert.Equal(
            CompanionWindowAction.None,
            CompanionWindowPolicy.Decide(phase, windowOpen: true, ChampSelectOpenedIt));
    }

    [Fact]
    public void The_end_of_game_is_not_in_game_so_a_staged_update_is_free_to_apply()
    {
        // WaitingForStats is "in game" to TrayMenuState, and deliberately is not
        // here: the match is over, the browser is cheap again, and the scoreboard
        // is exactly when a staged restart should be allowed through.
        Assert.True(TrayMenuState.Default with { Phase = CompanionPhase.WaitingForStats } is { IsInGame: true });
        Assert.False(CompanionWindowPolicy.IsInGame(CompanionPhase.WaitingForStats));
    }

    [Fact]
    public void Closing_a_window_that_is_not_open_is_never_requested()
    {
        Assert.Equal(
            CompanionWindowAction.None,
            CompanionWindowPolicy.Decide(CompanionPhase.InProgress, windowOpen: false, ChampSelectOpenedIt));
    }

    // ------------------------------------------------------------- ownership

    /// <summary>
    /// The dominant real-world sequence, and the one a create-only ownership
    /// rule gets wrong: the app is launched by hand once and left running for
    /// hours, so by the time champ select arrives there is already a window. If
    /// launching still owned it, the teardown would never fire for that user —
    /// which is most of them.
    /// </summary>
    [Fact]
    public void Champ_select_takes_over_a_window_that_was_launched_by_hand_hours_earlier()
    {
        var owned = CompanionWindowPolicy.IsUserOwned(CompanionWindowOpener.User);
        Assert.Equal(
            CompanionWindowAction.None,
            CompanionWindowPolicy.Decide(CompanionPhase.Lobby, windowOpen: true, owned));

        // Champ select navigates that same window to the draft page.
        owned = CompanionWindowPolicy.IsUserOwned(CompanionWindowOpener.ChampSelect);

        Assert.False(owned);
        Assert.Equal(
            CompanionWindowAction.CloseForGame,
            CompanionWindowPolicy.Decide(CompanionPhase.InProgress, windowOpen: true, owned));
    }

    [Fact]
    public void Bringing_the_draft_window_forward_from_the_tray_adopts_it()
    {
        var owned = CompanionWindowPolicy.IsUserOwned(CompanionWindowOpener.ChampSelect);
        owned = CompanionWindowPolicy.IsUserOwned(CompanionWindowOpener.User);

        Assert.True(owned);
        Assert.Equal(
            CompanionWindowAction.None,
            CompanionWindowPolicy.Decide(CompanionPhase.InProgress, windowOpen: true, owned));
    }

    // ------------------------------------------------------ the interplay proof

    /// <summary>
    /// The invariant that makes this teardown safe to ship next to 1.0.9's
    /// updater. Closing the window removes the "window open" restart gate, so
    /// the ONLY thing left refusing a restart mid-match is the write-sensitive
    /// busy gate. Every phase the teardown fires in must therefore be busy in at
    /// least one of the two tables that feed it.
    /// </summary>
    [Fact]
    public void Every_phase_the_teardown_fires_in_still_holds_the_update_busy_gate()
    {
        var checkedPhases = new List<CompanionPhase>();
        foreach (var phase in Enum.GetValues<CompanionPhase>())
        {
            if (!CompanionWindowPolicy.IsInGame(phase)) continue;
            checkedPhases.Add(phase);

            // App.IsUpdateBusyContext reads the first; VelopackUpdateService's
            // isCompanionBusy also reaches CompanionState, which reads the second.
            var busyByAppPhaseTable = App.IsBusyPhase(phase);
            var busyByComplianceRules = ComplianceRules.IsCompanionBusy(phase.ToString(), 0);

            Assert.True(
                busyByAppPhaseTable || busyByComplianceRules,
                $"{phase} tears the companion window down but is not an update-busy phase; "
                + "the teardown would clear the last gate and let the app restart into a game.");
        }

        // A rename or an enum reshuffle that quietly emptied the loop would
        // otherwise leave this assertion passing over nothing.
        Assert.Equal([CompanionPhase.Reconnect, CompanionPhase.InProgress], checkedPhases);
    }

    /// <summary>
    /// The other half: InProgress is busy through <c>ComplianceRules</c> even
    /// with no LCU write in flight, which is what makes the phase alone — not a
    /// transient write — sufficient to refuse the restart.
    /// </summary>
    [Fact]
    public void Being_in_a_game_is_busy_on_its_own_not_only_during_an_lcu_write()
    {
        Assert.True(ComplianceRules.IsCompanionBusy("InProgress", activeLcuWriteTransactions: 0));
        Assert.True(ComplianceRules.IsCompanionBusy("ChampSelect", activeLcuWriteTransactions: 0));
        Assert.False(ComplianceRules.IsCompanionBusy("WaitingForStats", activeLcuWriteTransactions: 0));
    }
}
