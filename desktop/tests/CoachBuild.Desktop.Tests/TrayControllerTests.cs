using System.Drawing;
using Forms = System.Windows.Forms;
using System.Windows.Threading;
using CoachBuild.Desktop.Tray;
using Xunit;

namespace CoachBuild.Desktop.Tests;

public sealed class TrayControllerTests
{
    [Fact]
    public void Opening_populates_one_persistent_menu_and_updates_refresh_on_next_open()
    {
        using var tray = new TrayController(Dispatcher.CurrentDispatcher);
        var initialState = TrayMenuState.Default with
        {
            OverlayVisible = true,
            Phase = CompanionPhase.ChampSelect,
        };
        tray.Start(initialState);
        var menu = tray.ContextMenuForTesting;

        menu.Show(new Point(0, 0));
        try
        {
            Assert.Same(menu, tray.ContextMenuForTesting);
            Assert.Equal("Hide overlay", menu.Items[1].Text);
            Assert.Contains(
                menu.Items.OfType<Forms.ToolStripMenuItem>(),
                item => (item.Text ?? string.Empty).StartsWith("Working set:", StringComparison.Ordinal));

            var itemCountWhileOpen = menu.Items.Count;
            tray.UpdateState(initialState with
            {
                OverlayVisible = false,
                Error = "state changed while menu is open",
            });

            Assert.Same(menu, tray.ContextMenuForTesting);
            Assert.Equal(itemCountWhileOpen, menu.Items.Count);
            Assert.Equal("Hide overlay", menu.Items[1].Text);
        }
        finally
        {
            menu.Close();
        }

        menu.Show(new Point(0, 0));
        try
        {
            Assert.Equal("Show overlay", menu.Items[1].Text);
            Assert.Contains(
                menu.Items.OfType<Forms.ToolStripMenuItem>(),
                item => item.Text == "Error: state changed while menu is open");
        }
        finally
        {
            menu.Close();
        }
    }
}
