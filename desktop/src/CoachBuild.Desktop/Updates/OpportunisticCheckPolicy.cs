using CoachBuild.Desktop.Tray;

namespace CoachBuild.Desktop.Updates;

/// <summary>
/// Why an out-of-schedule update check was requested. The 2-hour loop in
/// <see cref="VelopackUpdateService"/> stays the fallback; these are the idle
/// moments worth checking at instead of waiting for the next tick.
/// </summary>
public enum OpportunisticCheckTrigger
{
    /// <summary>The game ended while the app was watching (post-game idle window).</summary>
    GameEnd,

    /// <summary>The companion window closed, so a restart stopped being disruptive.</summary>
    WindowClosed,

    /// <summary>The machine woke from sleep and may have slept past the 2-hour tick.</summary>
    SystemResume,
}

/// <summary>
/// Decides WHEN an opportunistic check runs. Pure so the schedule is testable
/// without a clock: callers turn phases, visibility flips and power events
/// into a trigger, and this turns the trigger plus the last-check timestamp
/// into a decision. The service owns the semaphore; this owns the cooldown.
/// </summary>
public static class OpportunisticCheckPolicy
{
    /// <summary>
    /// The quiet period after any completed check attempt. Short enough that a
    /// release published minutes after a check is still picked up soon, long
    /// enough that a phase blip plus a window close plus a resume cannot stack
    /// three feed hits in a minute.
    /// </summary>
    public static readonly TimeSpan Cooldown = TimeSpan.FromMinutes(10);

    /// <summary>
    /// True when a check for <paramref name="trigger"/> may run now. Every
    /// trigger shares the one cooldown: the question is only how long ago the
    /// last check ran, never which idle moment is asking.
    /// </summary>
    public static bool ShouldCheck(
        OpportunisticCheckTrigger trigger,
        DateTimeOffset now,
        DateTimeOffset? lastCheckAt)
    {
        _ = trigger;
        return lastCheckAt is null || (now - lastCheckAt) >= Cooldown;
    }

    /// <summary>
    /// True on the game-end edge: out of a live game (<c>InProgress</c> or
    /// <c>Reconnect</c>) into anything that is not itself write-sensitive.
    /// Post-game is the natural idle window — the busy gate is clear and, for
    /// the champ-select-owned window, the teardown has already taken the
    /// browser down with it.
    /// </summary>
    public static bool IsGameEndTransition(CompanionPhase previous, CompanionPhase next)
    {
        return previous is CompanionPhase.InProgress or CompanionPhase.Reconnect
            && !IsUpdateBusyPhase(next);
    }

    /// <summary>True on the companion window's 1 → 0 visibility flip.</summary>
    public static bool IsWindowCloseTransition(bool wasVisible, bool isVisible) =>
        wasVisible && !isVisible;

    /// <summary>
    /// The phases a restart must never land in. <see cref="App.IsBusyPhase"/>
    /// owns Matchmaking/ReadyCheck/Reconnect; <c>ComplianceRules</c> owns
    /// ChampSelect/InProgress. Both tables are restated here rather than split
    /// across two calls so the game-end target has one definition to drift
    /// from instead of two.
    /// </summary>
    internal static bool IsUpdateBusyPhase(CompanionPhase phase)
    {
        return App.IsBusyPhase(phase)
            || phase is CompanionPhase.ChampSelect or CompanionPhase.InProgress;
    }
}
