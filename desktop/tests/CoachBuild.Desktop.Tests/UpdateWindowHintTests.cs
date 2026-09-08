using CoachBuild.Desktop.Updates;
using CoachBuild.Desktop.Web;
using Xunit;

namespace CoachBuild.Desktop.Tests;

/// <summary>
/// The companion window's status line doubles as the staged-update hint slot.
/// The projection below is the whole of what the window shows; the window
/// itself only decides whether the slot is idle enough to show it in.
/// </summary>
public sealed class UpdateWindowHintTests
{
    [Fact]
    public void A_staged_update_projects_the_hint_wording()
    {
        Assert.Equal(
            "Update 1.2.1 ready - restart from the tray to apply",
            UpdateWindowHint.For(UpdateTrayModel.For(UpdateStatus.Staged, "1.2.1")));
    }

    [Fact]
    public void A_mid_write_deferral_projects_the_same_hint()
    {
        Assert.Equal(
            "Update 1.2.1 ready - restart from the tray to apply",
            UpdateWindowHint.For(UpdateTrayModel.For(UpdateStatus.DeferredBusy, "1.2.1")));
    }

    [Theory]
    [InlineData(UpdateStatus.None)]
    [InlineData(UpdateStatus.Checking)]
    [InlineData(UpdateStatus.Downloading)]
    [InlineData(UpdateStatus.Ready)]
    [InlineData(UpdateStatus.Applying)]
    [InlineData(UpdateStatus.Error)]
    public void Leaving_staged_clears_the_hint(UpdateStatus status)
    {
        Assert.Null(UpdateWindowHint.For(UpdateTrayModel.For(status, "1.2.1")));
    }

    [Fact]
    public void A_staged_model_with_no_version_clears_the_hint()
    {
        Assert.Null(UpdateWindowHint.For(UpdateTrayModel.For(UpdateStatus.Staged)));
        Assert.Null(UpdateWindowHint.For(null));
    }

    [Theory]
    [InlineData("Ready")]
    [InlineData("Companion ready")]
    [InlineData("u.gg ready")]
    [InlineData("Coachless ready")]
    [InlineData("")]
    public void Idle_slots_accept_the_hint(string statusText)
    {
        Assert.True(WebView2Window.IsIdleStatusSlot(statusText, paintedHint: null));
    }

    [Fact]
    public void The_hints_own_paint_counts_as_idle_so_a_version_bump_repaints()
    {
        const string painted = "Update 1.2.1 ready - restart from the tray to apply";

        Assert.True(WebView2Window.IsIdleStatusSlot(painted, painted));
    }

    [Theory]
    [InlineData("Importing build from u.gg…")]
    [InlineData("Imported runes + 7-item set for Jhin (ADC) from u.gg")]
    [InlineData("External app links are blocked in the companion window.")]
    [InlineData("u.gg blocked a popup; this window stays focused.")]
    [InlineData("Loading u.gg…")]
    [InlineData("Coachless could not load this page (ConnectionAborted). Check your connection and try again.")]
    public void Site_status_text_wins_over_the_hint(string statusText)
    {
        Assert.False(WebView2Window.IsIdleStatusSlot(
            statusText,
            paintedHint: "Update 1.2.1 ready - restart from the tray to apply"));
    }
}
