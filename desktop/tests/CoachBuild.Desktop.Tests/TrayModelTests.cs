using CoachBuild.Desktop.Tray;
using CoachBuild.Desktop.Updates;
using Xunit;

namespace CoachBuild.Desktop.Tests;

public sealed class TrayModelTests
{
    [Theory]
    [InlineData("ChampSelect", ReopenDestination.Draft)]
    [InlineData("InProgress", ReopenDestination.Builds)]
    [InlineData("Reconnect", ReopenDestination.Home)]
    [InlineData("None", ReopenDestination.Home)]
    [InlineData("future-phase", ReopenDestination.Home)]
    public void ReopenIsPhaseAwareAndSafeForUnknownPhases(string phase, ReopenDestination expected)
    {
        var state = TrayMenuState.Default with { Phase = TrayMenuState.ParsePhase(phase) };

        Assert.Equal(expected, state.GetReopenTarget().Destination);
    }

    [Fact]
    public void KnownLastPageIsReusedOutsideActivePhases()
    {
        var last = new LastOpenPage(103, 2, DateTimeOffset.UtcNow, ReopenDestination.Builds);
        var state = TrayMenuState.Default with { LastOpen = last };

        var target = state.GetReopenTarget();

        Assert.Equal(ReopenDestination.Builds, target.Destination);
        Assert.Equal(103, target.ChampionId);
        Assert.Equal(2, target.RoleId);
    }

    [Theory]
    [InlineData("top", "TOP")]
    [InlineData("Support", "SUPPORT")]
    [InlineData("", null)]
    [InlineData("mid lane", null)]
    public void LaneOverrideIsNormalizedWithoutGuessing(string input, string? expected)
    {
        Assert.Equal(expected, TrayMenuState.NormalizeLane(input));
    }

    [Fact]
    public void UpdateStatusAndErrorRemainVisibleInTheProjection()
    {
        var state = TrayMenuState.Default with
        {
            Error = "bridge unavailable",
            Update = UpdateTrayModel.For(UpdateStatus.DeferredBusy, "1.2.0"),
        };

        Assert.Equal("bridge unavailable", state.Error);
        Assert.Contains("waiting for game", state.Update.ToDisplayString(), StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void SkillTableIsEnabledByDefaultAndWorkingSetLabelIsBounded()
    {
        Assert.True(TrayMenuState.Default.ShowSkillTable);
        Assert.Equal("Working set: 64 MB", TrayMenuState.FormatWorkingSet(64L * 1024 * 1024));
        Assert.Equal("Working set: 0 MB", TrayMenuState.FormatWorkingSet(-1));
    }
}
