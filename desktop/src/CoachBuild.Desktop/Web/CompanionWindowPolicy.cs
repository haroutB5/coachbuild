using CoachBuild.Desktop.Tray;

namespace CoachBuild.Desktop.Web;

public enum CompanionWindowAction
{
    None,

    /// <summary>Tear the companion window (and its Chromium tree) down.</summary>
    CloseForGame,
}

/// <summary>Who asked for the window that is currently open.</summary>
public enum CompanionWindowOpener
{
    /// <summary>Champ select, on the player's behalf. Torn down at load-in.</summary>
    ChampSelect,

    /// <summary>The tray Reopen item, or launching the app by hand. Never taken away.</summary>
    User,
}

/// <summary>
/// Whether the CoachBuild companion window should still be alive right now.
///
/// <para><b>Why this exists (measured, 1.0.9).</b> <c>GameflowPoller</c> →
/// <c>WindowDecisionService.OnChampSelectEntry</c> → <c>OpenDraft</c> opens a
/// WebView2 window during champ select, and <b>nothing closed it when the game
/// started</b>. PID-scoped to the app's own process tree, that is the difference
/// between <b>1 process / 48.7 MB</b> before champ select and <b>7 processes /
/// 728 MB / 16.6% of one core</b> while the user plays — against
/// <c>desktop/perf/README.md</c>'s own "whole-app working set under 120 MB"
/// target, which it missed by 6×. The overlay's own share of that was 1.66% of
/// one core; the rest was a browser running beside League.</para>
///
/// <para><b>The rule is deliberately stateless.</b> An earlier shape latched on
/// the ChampSelect→InProgress <i>edge</i>, which has two failure modes this one
/// does not: the phase drops to <c>None</c> for a tick whenever the LCU
/// connection blips (<c>GameflowPoller</c> reports <c>None</c> with no
/// credentials), so an edge rule re-fires mid-game; and the automatic open is
/// asynchronous, so a window that finishes opening a second <i>after</i> load-in
/// would miss the edge entirely and leak for the whole match. Asking the
/// question every tick has neither problem.</para>
///
/// <para><b>Ownership, not timing, is what protects the user's window.</b> The
/// window is only torn down when it was opened <i>for</i> them by champ select.
/// One they asked for — tray Reopen, or double-clicking the app — is never taken
/// away, which is also why launching the app by hand mid-game keeps its
/// window.</para>
/// </summary>
public static class CompanionWindowPolicy
{
    /// <summary>
    /// The phases during which a Chromium tree beside League is pure cost.
    ///
    /// <para><c>Reconnect</c> is in here with <c>InProgress</c>: it means a live
    /// game is waiting to be rejoined, so it is load-in, not lobby. Both are
    /// covered by the update busy gate — <c>InProgress</c> through
    /// <c>ComplianceRules.IsCompanionBusy</c> and <c>Reconnect</c> through
    /// <c>App.IsBusyPhase</c> — which is the property that keeps this teardown
    /// from handing the updater a restart mid-match.</para>
    ///
    /// <para><c>WaitingForStats</c> is deliberately absent. The game is over by
    /// then, the browser is cheap again, and the end-of-game window is exactly
    /// when a staged update should be free to apply.</para>
    /// </summary>
    public static bool IsInGame(CompanionPhase phase) =>
        phase is CompanionPhase.InProgress or CompanionPhase.Reconnect;

    /// <summary>
    /// Who owns the window after an open request. The latest open wins, in both
    /// directions — which is the part that is easy to get wrong, because the
    /// common case is an app launched once and left running: champ select
    /// navigating that already-open window to the draft page is what makes it
    /// champ select's, and a create-only rule would tear nothing down for
    /// exactly the user this fix is for.
    /// </summary>
    public static bool IsUserOwned(CompanionWindowOpener opener) =>
        opener == CompanionWindowOpener.User;

    /// <summary>
    /// Pure. <paramref name="windowOpen"/> is whether a companion window exists
    /// at all; <paramref name="windowOpenedByUser"/> is whether the user asked
    /// for the one that does.
    /// </summary>
    public static CompanionWindowAction Decide(
        CompanionPhase phase,
        bool windowOpen,
        bool windowOpenedByUser)
    {
        if (!IsInGame(phase)) return CompanionWindowAction.None;
        if (!windowOpen || windowOpenedByUser) return CompanionWindowAction.None;
        return CompanionWindowAction.CloseForGame;
    }
}
