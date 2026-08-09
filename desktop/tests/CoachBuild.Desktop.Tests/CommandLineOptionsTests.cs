using CoachBuild.Desktop;
using Xunit;

namespace CoachBuild.Desktop.Tests;

public sealed class CommandLineOptionsTests
{
    [Fact]
    public void Autostart_starts_in_tray_only_and_suppresses_the_launch_window()
    {
        var options = CommandLineOptions.Parse(["--autostart"]);

        Assert.True(options.Autostart);
        Assert.True(options.StartInTrayOnly);
        Assert.False(options.ShouldOpenWebViewOnLaunch);
    }

    [Fact]
    public void Ordinary_launch_keeps_the_initial_window_enabled()
    {
        var options = CommandLineOptions.Parse([]);

        Assert.False(options.Autostart);
        Assert.False(options.StartInTrayOnly);
        Assert.True(options.ShouldOpenWebViewOnLaunch);
    }
}
