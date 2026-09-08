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

    public bool StartInTrayOnly => Autostart;

    public bool ShouldOpenWebViewOnLaunch => !StartInTrayOnly;

    public static CommandLineOptions Parse(IEnumerable<string>? arguments)
    {
        var selfTest = false;
        var repair = false;
        var noUi = false;
        var autostart = false;
        var gpuRender = false;
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
            else if (arg.StartsWith("--feed=", StringComparison.OrdinalIgnoreCase)) feed = arg[7..];
        }
        return new CommandLineOptions(selfTest, repair, noUi, feed)
        {
            Autostart = autostart,
            GpuRender = gpuRender,
        };
    }
}
