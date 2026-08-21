using System.Drawing;
using System.Reflection;
using Forms = System.Windows.Forms;
using System.Windows.Threading;
using CoachBuild.Core;
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
            // 1.0.15 inserted the WEB build's own line between these two, so
            // this reads the app-version line by position relative to IT
            // rather than assuming the app version is immediately above Phase.
            var webItem = Assert.IsType<Forms.ToolStripMenuItem>(menu.Items[phaseIndex - 1]);
            var versionItem = Assert.IsType<Forms.ToolStripMenuItem>(menu.Items[phaseIndex - 2]);

            var informationalVersion = Assembly.GetEntryAssembly()?
                .GetCustomAttribute<AssemblyInformationalVersionAttribute>()?
                .InformationalVersion;
            var expectedVersion = string.IsNullOrWhiteSpace(informationalVersion)
                ? "unknown"
                : informationalVersion.Split('+', 2)[0];

            Assert.Equal($"CoachBuild v{expectedVersion}", versionItem.Text);
            Assert.False(versionItem.Enabled);

            // The two versions are DIFFERENT numbers and the menu must not
            // let them be confused: the desktop app's, and the web build the
            // hosted window is running. A fresh tray has no window.
            Assert.Equal("Web: no window open", webItem.Text);
            Assert.False(webItem.Enabled);
            Assert.NotEqual(versionItem.Text, webItem.Text);
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

    [Fact]
    public void My_Stats_pairing_is_reachable_from_the_tray()
    {
        using var tray = new TrayController(Dispatcher.CurrentDispatcher);
        var raised = new List<TrayCommand>();
        tray.CommandRequested += (_, e) => raised.Add(e.Command);
        tray.Start();
        var menu = tray.ContextMenuForTesting;

        menu.Show(new Point(0, 0));
        try
        {
            var pairing = menu.Items.OfType<Forms.ToolStripMenuItem>()
                .Single(item => item.Text == TrayMenuState.PairMyStatsVerb);

            pairing.PerformClick();

            Assert.Equal(TrayCommand.PairMyStats, Assert.Single(raised));
        }
        finally
        {
            menu.Close();
        }
    }

    /// <summary>
    /// The diagnostics upload is reachable, and it is reachable by CLICK.
    ///
    /// <para>The item is the entire consent story for this feature: a log the
    /// user pressed a button to send is diagnostics, and the same log on a timer
    /// is silent log shipping. A test that only checked the upload works would
    /// pass just as happily against a scheduled one.</para>
    /// </summary>
    [Fact]
    public void Sending_diagnostics_is_reachable_from_the_tray()
    {
        using var tray = new TrayController(Dispatcher.CurrentDispatcher);
        var raised = new List<TrayCommand>();
        tray.CommandRequested += (_, e) => raised.Add(e.Command);
        tray.Start();
        var menu = tray.ContextMenuForTesting;

        menu.Show(new Point(0, 0));
        try
        {
            var items = menu.Items.OfType<Forms.ToolStripMenuItem>().ToList();
            var send = items.Single(item => item.Text == TrayMenuState.SendDiagnosticsVerb);

            Assert.True(send.Enabled, "the item must never be a control that cannot be pressed");
            send.PerformClick();
            Assert.Equal(TrayCommand.SendDiagnostics, Assert.Single(raised));

            // Directly under the pairing item, which is what makes it useful.
            Assert.Equal(
                items.FindIndex(item => item.Text == TrayMenuState.PairMyStatsVerb) + 1,
                items.IndexOf(send));
        }
        finally
        {
            menu.Close();
        }
    }

    /// <summary>
    /// The "not paired yet" message tells the user to use a menu item BY NAME.
    /// Core cannot reference the WPF assembly, so the string is duplicated; this
    /// is what stops the duplicate becoming a lie.
    /// </summary>
    [Fact]
    public void The_unpaired_message_names_the_tray_item_that_fixes_it()
    {
        Assert.Equal(TrayMenuState.PairMyStatsVerb, DiagnosticsMessages.PairingVerb);
        Assert.Contains(
            TrayMenuState.PairMyStatsVerb,
            DiagnosticsMessages.Text(DiagnosticsUploadOutcome.NotPaired),
            StringComparison.Ordinal);
    }

    [Fact]
    public void Pairing_dialog_starts_empty_and_masks_every_pasted_character()
    {
        using var dialog = new RankSampleSecretDialog(replacingExisting: true);

        Assert.True(dialog.SecretInputForTesting.UseSystemPasswordChar);
        Assert.Equal(string.Empty, dialog.SecretInputForTesting.Text);
        Assert.False(dialog.SaveButtonForTesting.Enabled);

        dialog.SecretInputForTesting.Text = "fixture-shared-secret";

        Assert.True(dialog.SecretInputForTesting.UseSystemPasswordChar);
        Assert.True(dialog.SaveButtonForTesting.Enabled);
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
