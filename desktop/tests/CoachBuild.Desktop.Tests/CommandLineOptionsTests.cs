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

    /// <summary>
    /// The lane-score demo exists because the feature is ranked-only, so the
    /// card cannot be reached in the practice tool. It fabricates a matchup, and
    /// a user who saw one would reasonably believe it — so the flag is off
    /// unless it is asked for exactly.
    /// </summary>
    [Fact]
    public void TheLaneScoreDemoIsOffUnlessAskedForExactly()
    {
        Assert.False(CommandLineOptions.Parse([]).LaneScoreDemo);
        Assert.False(CommandLineOptions.Parse(["--autostart"]).LaneScoreDemo);
        Assert.True(CommandLineOptions.Parse(["--lane-score-demo"]).LaneScoreDemo);
        Assert.True(CommandLineOptions.Parse(["--autostart", "--lane-score-demo"]).LaneScoreDemo);
    }

    /// <summary>
    /// Deliberately NOT case-insensitive and deliberately without a short form,
    /// unlike every other flag here. Near-misses must miss.
    /// </summary>
    [Theory]
    [InlineData("--Lane-Score-Demo")]
    [InlineData("--LANE-SCORE-DEMO")]
    [InlineData("-lane-score-demo")]
    [InlineData("--lane-score-demo=1")]
    [InlineData("--lanescoredemo")]
    [InlineData("--lane-scores-demo")]
    [InlineData("--demo")]
    public void ANearMissDoesNotEnableTheDemo(string argument)
    {
        Assert.False(CommandLineOptions.Parse([argument]).LaneScoreDemo);
    }

    /// <summary>The demo flag changes nothing else about how the app starts.</summary>
    [Fact]
    public void TheDemoFlagDoesNotDisturbAnyOtherOption()
    {
        var options = CommandLineOptions.Parse(["--lane-score-demo"]);

        Assert.False(options.SelfTest);
        Assert.False(options.RepairWebView2);
        Assert.False(options.NoUi);
        Assert.False(options.Autostart);
        Assert.False(options.GpuRender);
        Assert.Null(options.Feed);
        Assert.True(options.ShouldOpenWebViewOnLaunch);
    }
}
