namespace CoachBuild.Desktop;

public sealed record CommandLineOptions(
    bool SelfTest,
    bool RepairWebView2,
    bool NoUi,
    string? Feed = null)
{
    public bool Autostart { get; init; }

    /// <summary>
    /// Restore WPF's hardware render path. Off by default since 2.1.1 — see
    /// <see cref="ChromeRenderPolicy"/> for the blank-chrome fault that made
    /// software rendering the default and why it costs this app almost nothing.
    /// </summary>
    public bool GpuRender { get; init; }

    /// <summary>
    /// Renders the lane-score card with FABRICATED data and writes nothing.
    ///
    /// <para>It exists because the feature is ranked-only by decision, which
    /// means the card cannot be reached in the practice tool — so without this
    /// flag the only way to look at the UI is to play a ranked game and lose
    /// twenty minutes per iteration.</para>
    ///
    /// <para><b>Why it is safe.</b> It is reachable only by typing this exact
    /// argument: there is no tray item, no settings key and no bridge parameter
    /// that turns it on. A service in demo mode never touches
    /// <see cref="CoachBuild.Core.LaneScoreStore"/> at all — not even to read —
    /// and its fabricated match id carries
    /// <see cref="CoachBuild.Core.LaneScoreService.DemoMatchIdPrefix"/>, which
    /// the real store rejects outright. Two independent locks, because the thing
    /// being protected is a history the user cannot rebuild.</para>
    /// </summary>
    public bool LaneScoreDemo { get; init; }

    public bool StartInTrayOnly => Autostart;

    public bool ShouldOpenWebViewOnLaunch => !StartInTrayOnly;

    public static CommandLineOptions Parse(IEnumerable<string>? arguments)
    {
        var selfTest = false;
        var repair = false;
        var noUi = false;
        var autostart = false;
        var gpuRender = false;
        var laneScoreDemo = false;
        string? feed = null;
        var args = arguments ?? [];
        foreach (var raw in args)
        {
            var arg = raw.Trim();
            if (arg.Equals("-SelfTest", StringComparison.OrdinalIgnoreCase) ||
                arg.Equals("--self-test", StringComparison.OrdinalIgnoreCase)) selfTest = true;
            else if (arg.Equals("-RepairWebView2", StringComparison.OrdinalIgnoreCase) ||
                     arg.Equals("--repair-webview2", StringComparison.OrdinalIgnoreCase)) repair = true;
            else if (arg.Equals("-NoUi", StringComparison.OrdinalIgnoreCase) ||
                     arg.Equals("--no-ui", StringComparison.OrdinalIgnoreCase)) noUi = true;
            else if (arg.Equals("--autostart", StringComparison.OrdinalIgnoreCase)) autostart = true;
            else if (arg.Equals("--gpu-render", StringComparison.OrdinalIgnoreCase)) gpuRender = true;
            // Ordinal, not OrdinalIgnoreCase, and no short form. Every other flag
            // here is forgiving on purpose; this one is not, because the cost of
            // reaching it by accident is a fabricated matchup in front of a user
            // who will reasonably believe it.
            else if (arg.Equals("--lane-score-demo", StringComparison.Ordinal)) laneScoreDemo = true;
            else if (arg.StartsWith("--feed=", StringComparison.OrdinalIgnoreCase)) feed = arg[7..];
        }
        return new CommandLineOptions(selfTest, repair, noUi, feed)
        {
            Autostart = autostart,
            GpuRender = gpuRender,
            LaneScoreDemo = laneScoreDemo,
        };
    }
}
