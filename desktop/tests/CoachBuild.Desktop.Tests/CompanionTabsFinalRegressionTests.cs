using System.Windows;
using CoachBuild.Core;
using CoachBuild.Desktop.Web;
using Xunit;

namespace CoachBuild.Desktop.Tests;

/// <summary>
/// Focused regressions for the final browser-tab wiring. These tests stay at
/// the policy/projection seams so they do not require a WebView2 HWND or a
/// running League client.
/// </summary>
public sealed class CompanionTabsFinalRegressionTests
{
    [Fact]
    public void A_browser_is_hidden_until_its_active_tab_has_a_ready_core()
    {
        Assert.Equal(
            Visibility.Collapsed,
            WebView2Window.BrowserVisibilityFor(isActiveTab: false, hasReadyBrowser: false));
        Assert.Equal(
            Visibility.Collapsed,
            WebView2Window.BrowserVisibilityFor(isActiveTab: false, hasReadyBrowser: true));
        Assert.Equal(
            Visibility.Collapsed,
            WebView2Window.BrowserVisibilityFor(isActiveTab: true, hasReadyBrowser: false));
        Assert.Equal(
            Visibility.Visible,
            WebView2Window.BrowserVisibilityFor(isActiveTab: true, hasReadyBrowser: true));
    }

    [Fact]
    public async Task A_zero_cell_sentinel_does_not_hide_a_valid_hover_offer()
    {
        var root = Path.Combine(
            Path.GetTempPath(),
            "CoachBuild-FinalTabTests",
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);

        try
        {
            await using var host = new CoreDesktopHostServices(
                new string('a', 64),
                root,
                championDirectory: new FakeChampionDirectory());
            host.State.SetPhase("ChampSelect");
            host.State.SetChampSelect(new CompanionChampSelectSnapshot(
                LocalPlayerCellId: 0,
                CellChampionId: 0,
                PickIntent: 103,
                ActionChampionId: 0,
                RoleId: 2,
                TheirTeam: [],
                TimerPhase: "BAN_PICK"));

            var offer = (await host.ReadSnapshotAsync(CancellationToken.None)).ChampSelect;

            Assert.NotNull(offer);
            Assert.Equal(103, offer!.ChampionId);
            Assert.Equal("Ahri", offer.ChampionName);
            Assert.False(offer.Locked);
        }
        finally
        {
            if (Directory.Exists(root)) Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public async Task Champ_select_snapshot_warms_the_roster_for_a_first_launch_offer()
    {
        var root = Path.Combine(
            Path.GetTempPath(),
            "CoachBuild-FinalTabTests",
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);

        try
        {
            var roster = new FakeChampionDirectory(preloaded: false);
            await using var host = new CoreDesktopHostServices(
                new string('a', 64),
                root,
                championDirectory: roster);
            host.State.SetPhase("ChampSelect");
            host.State.SetChampSelect(new CompanionChampSelectSnapshot(
                LocalPlayerCellId: 0,
                CellChampionId: 103,
                PickIntent: null,
                ActionChampionId: null,
                RoleId: 2,
                TheirTeam: [],
                TimerPhase: "BAN_PICK"));

            Assert.Null((await host.ReadSnapshotAsync(CancellationToken.None)).ChampSelect);
            if (host.PendingChampionDirectoryFetch is { } fetch) await fetch;

            var offer = (await host.ReadSnapshotAsync(CancellationToken.None)).ChampSelect;

            Assert.NotNull(offer);
            Assert.Equal("Ahri", offer!.ChampionName);
            Assert.Equal(1, roster.Loads);
        }
        finally
        {
            if (Directory.Exists(root)) Directory.Delete(root, recursive: true);
        }
    }
}
