using System.Runtime.InteropServices;

namespace CoachBuild.Desktop.Overlay;

/// <summary>Shell user-notification state (<c>QUERY_USER_NOTIFICATION_STATE</c>).</summary>
public enum UserNotificationState
{
    NotPresent = 1,
    Busy = 2,
    RunningD3dFullScreen = 3,
    PresentationMode = 4,
    AcceptsNotifications = 5,
    QuietTime = 6,
    App = 7,
}

/// <summary>What the advisor wants done about the current fullscreen state.</summary>
public sealed record FullscreenAdvice(string? LogLine, bool ShowHint)
{
    public static FullscreenAdvice None { get; } = new(null, false);
}

/// <summary>
/// Turns the shell's fullscreen state into at most one log line per transition
/// and at most one user-visible hint per app run.
///
/// <para>Measured, not inferred: the overlay's HWND ex-style is
/// <c>0x080800A8</c>, i.e. <c>WS_EX_LAYERED</c>. That comes from
/// <c>AllowsTransparency="True"</c> and is not optional — WPF requires it for
/// per-pixel transparency. A layered window is drawn by DWM, and a true
/// exclusive-fullscreen D3D app owns the display's flip chain with DWM out of
/// the presentation path. CoachBuild hooks no present chain, so in that state
/// it cannot draw, and it says <c>highlight Q at … visible=True</c> while
/// failing: the app genuinely did draw, the pixels just never reached the
/// screen.</para>
///
/// <para>Deliberately NOT keyed on League's "Window Mode" setting. Windows 10
/// 1709+ Fullscreen Optimizations silently converts most exclusive-fullscreen
/// D3D apps to borderless-flip, which puts DWM back in the path and makes the
/// overlay work — so the setting's NAME predicts nothing. The hint is gated on
/// the measured shell state AND on the overlay believing it is currently
/// drawing a highlight, so the user is only told about pixels they should be
/// seeing, and its wording stays conditional in case FSO is in play.</para>
/// </summary>
public sealed class FullscreenAdvisor
{
    public const string HintTitle = "CoachBuild overlay";

    public const string HintMessage =
        "If the pink next-ability box is not visible, League is running in exclusive fullscreen "
        + "and no transparent overlay can draw over it. Set League: Settings > Video > "
        + "Window Mode = Borderless.";

    private bool _exclusive;
    private bool _hinted;

    /// <param name="inGame">The LCU phase is InProgress.</param>
    /// <param name="state">The shell's current state, or null if unavailable.</param>
    /// <param name="canDrawHighlight">
    /// The overlay has everything it needs to draw a highlight for this game.
    /// NOT "is drawing one right now": since 1.0.12 the highlight only appears
    /// while a skill point is unspent, so gating the hint on the instantaneous
    /// render decision would make it fire for a fraction of a second per
    /// level-up, if ever. See OverlayWindow.HasRenderableSkillOrder.
    /// </param>
    public FullscreenAdvice Observe(bool inGame, UserNotificationState? state, bool canDrawHighlight)
    {
        var exclusive = inGame && state == UserNotificationState.RunningD3dFullScreen;
        string? line = null;
        if (exclusive != _exclusive)
        {
            _exclusive = exclusive;
            line = exclusive
                ? "fullscreen: exclusive D3D fullscreen reported by the shell; a layered overlay cannot composite over a true exclusive swapchain"
                : "fullscreen: exclusive D3D fullscreen state cleared";
        }

        var hint = exclusive && canDrawHighlight && !_hinted;
        if (hint) _hinted = true;
        return line is null && !hint ? FullscreenAdvice.None : new FullscreenAdvice(line, hint);
    }
}

/// <summary>Thin P/Invoke wrapper; all decisions live in <see cref="FullscreenAdvisor"/>.</summary>
public static class ShellNotificationState
{
    /// <summary>The shell's current state, or null when the query fails.</summary>
    public static UserNotificationState? Query()
    {
        try
        {
            return SHQueryUserNotificationState(out var state) == 0
                ? (UserNotificationState)state
                : null;
        }
        catch
        {
            return null;
        }
    }

    [DllImport("shell32.dll")]
    private static extern int SHQueryUserNotificationState(out int state);
}
