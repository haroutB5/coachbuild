namespace CoachBuild.Desktop;

public sealed record CommandLineOptions(
    bool SelfTest,
    bool RepairWebView2,
    bool NoUi,
    string? Feed = null)
{
    public static CommandLineOptions Parse(IEnumerable<string>? arguments)
    {
        var selfTest = false;
        var repair = false;
        var noUi = false;
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
            else if (arg.StartsWith("--feed=", StringComparison.OrdinalIgnoreCase)) feed = arg[7..];
        }
        return new CommandLineOptions(selfTest, repair, noUi, feed);
    }
}

