using System.Drawing;
using System.Reflection;
using Forms = System.Windows.Forms;
using System.Windows.Threading;
using CoachBuild.Desktop.Tray;
using Xunit;

namespace CoachBuild.Desktop.Tests;

public sealed class TrayControllerTests
{
    [Fact]
    public void Status_block_starts_with_disabled_assembly_version_line()
    {
        using var tray = new TrayController(Dispatcher.CurrentDispatcher);
        tray.Start();
        var menu = tray.ContextMenuForTesting;

        menu.Show(new Point(0, 0));
        try
        {
            var phaseItem = menu.Items.OfType<Forms.ToolStripMenuItem>()
                .Single(item => (item.Text ?? string.Empty).StartsWith("Phase: ", StringComparison.Ordinal));
            var phaseIndex = menu.Items.IndexOf(phaseItem);
            var versionItem = Assert.IsType<Forms.ToolStripMenuItem>(menu.Items[phaseIndex - 1]);

            var informationalVersion = Assembly.GetEntryAssembly()?
                .GetCustomAttribute<AssemblyInformationalVersionAttribute>()?
                .InformationalVersion;
            var expectedVersion = string.IsNullOrWhiteSpace(informationalVersion)
                ? "unknown"
                : informationalVersion.Split('+', 2)[0];

            Assert.Equal($"CoachBuild v{expectedVersion}", versionItem.Text);
            Assert.False(versionItem.Enabled);
        }
        finally
        {
            menu.Close();
        }
    }

    [Theory]
    [InlineData(WebView2Availability.Unknown, false)]
    [InlineData(WebView2Availability.Available, false)]
    [InlineData(WebView2Availability.Missing, true)]
    public void Repair_item_requires_a_proven_missing_runtime(
        WebView2Availability availability,
        bool expectedVisible)
    {
        using var tray = new TrayController(Dispatcher.CurrentDispatcher);
        tray.Start(TrayMenuState.Default with { WebView2Available = availability });
        var menu = tray.ContextMenuForTesting;

        menu.Show(new Point(0, 0));
        try
        {
            var repairVisible = menu.Items.OfType<Forms.ToolStripMenuItem>()
                .Any(item => item.Text == "Repair WebView2 runtime");
            Assert.Equal(expectedVisible, repairVisible);
        }
        finally
        {
            menu.Close();
        }
    }

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

    [Fact]
    public void Start_with_windows_item_is_checkable_and_toggles_the_injected_manager()
    {
        var startup = new RecordingStartupManager(enabled: true);
        using var tray = new TrayController(Dispatcher.CurrentDispatcher, startupManager: startup);
        tray.Start();
        var menu = tray.ContextMenuForTesting;

        menu.Show(new Point(0, 0));
        try
        {
            var item = menu.Items.OfType<Forms.ToolStripMenuItem>()
                .Single(menuItem => menuItem.Text == "Start with Windows");
            Assert.True(item.CheckOnClick);
            Assert.True(item.Checked);

            item.PerformClick();
            Assert.Equal(1, startup.DisableCalls);
            Assert.False(startup.IsEnabled);
        }
        finally
        {
            menu.Close();
        }

        menu.Show(new Point(0, 0));
        try
        {
            var item = menu.Items.OfType<Forms.ToolStripMenuItem>()
                .Single(menuItem => menuItem.Text == "Start with Windows");
            Assert.False(item.Checked);

            item.PerformClick();
            Assert.Equal(1, startup.EnableCalls);
            Assert.True(startup.IsEnabled);
        }
        finally
        {
            menu.Close();
        }
    }

    private sealed class RecordingStartupManager(bool enabled) : IStartupManager
    {
        public bool IsEnabled { get; private set; } = enabled;

        public int EnableCalls { get; private set; }

        public int DisableCalls { get; private set; }

        public void Enable()
        {
            EnableCalls++;
            IsEnabled = true;
        }

        public void Disable()
        {
            DisableCalls++;
            IsEnabled = false;
        }
    }
}
