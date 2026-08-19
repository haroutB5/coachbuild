using System.Drawing;
using System.Runtime.ExceptionServices;
using System.Windows.Threading;
using CoachBuild.Core;
using CoachBuild.Desktop;
using CoachBuild.Desktop.Diagnostics;
using CoachBuild.Desktop.Overlay;
using CoachBuild.Desktop.Tray;
using Forms = System.Windows.Forms;
using Xunit;

namespace CoachBuild.Desktop.Tests;

/// <summary>
/// The two 1.0.14 additions, and the two ways each could be wrong.
///
/// <para><b>The tray item now names the shortcut.</b> 1.0.13 §15 left this
/// deliberately undone and flagged it: the item read "Adjust overlay position"
/// with no key, so the only discoverable route to adjust mode was the one that
/// makes you alt-tab out of the game. The hazard in fixing it is a second copy
/// of the string — a label reading "(Ctrl+Shift+A)" that outlives a change of
/// bind is worse than no label, because it is confidently wrong. So the label
/// is derived from <see cref="GlobalHotkeyService.AdjustBindings"/> filtered by
/// what Windows actually accepted, and asserted from both ends: with the real
/// binding (so mutating the table fails the test) and with an injected one (so
/// hardcoding the string fails the test too).</para>
///
/// <para><b>The second hazard is the failure case.</b> RegisterHotKey is
/// exclusive system-wide; a machine where another app owns Ctrl+Shift+A has no
/// shortcut at all. The menu must not promise one there — and this item is the
/// documented fallback for exactly that case, so it also carries the reason.</para>
///
/// <para><b>And the log folder.</b> Every diagnosis in this project since 1.0.9
/// has begun "open %LOCALAPPDATA%\CoachBuild\companion.log". The tray already
/// knows the path; the failure mode to guard is it knowing a *different* path
/// than the logger, which would open a real, empty, wrong folder and look like
/// it worked.</para>
/// </summary>
public sealed class TrayShortcutAndLogFolderTests
{
    private const int ErrorHotkeyAlreadyRegistered = 1409;

    // -------------------------------------------------- the shortcut, named

    /// <summary>
    /// The whole point of the change, end to end through the production types:
    /// a service that registered its accelerator, into the tray state, into the
    /// label the user reads.
    ///
    /// <para><b>This is the test that moves with the bind.</b> The literal is
    /// here on purpose: change <c>AdjustBindings</c> to any other combination
    /// and this fails, which is the guarantee that the menu cannot go on
    /// naming a key the app no longer registers.</para>
    /// </summary>
    [Fact]
    public void The_adjust_item_names_the_accelerator_that_was_actually_registered()
    {
        using var hotkeys = new GlobalHotkeyService(register: _ => 0, unregister: _ => { });
        hotkeys.Start(createWindow: false);

        var label = AdjustItemText(StateFor(hotkeys));

        Assert.Equal("Adjust overlay position (Ctrl+Shift+A)", label);
        Assert.Equal("Ctrl+Shift+A", hotkeys.RegisteredAdjustAccelerator);
    }

    /// <summary>
    /// The other end of the same claim: the label is <i>derived</i>, not a
    /// second spelling of the same string that happens to agree today. A
    /// service told to bind something else produces a menu that says something
    /// else, with no code change.
    ///
    /// <para>Without this, a hardcoded "(Ctrl+Shift+A)" would pass the test
    /// above forever — including on a build where the bind had moved.</para>
    /// </summary>
    [Fact]
    public void The_label_follows_the_binding_table_rather_than_a_hardcoded_string()
    {
        var invented = new HotkeyBinding(
            0x5AFE02,
            HotkeyModifiers.Control | HotkeyModifiers.Alt | HotkeyModifiers.NoRepeat,
            0x5A /* VK_Z */,
            "Ctrl+Alt+Z",
            "adjust overlay position");
        using var hotkeys = new GlobalHotkeyService(register: _ => 0, unregister: _ => { });
        hotkeys.Start([invented], createWindow: false);

        var label = AdjustItemText(StateFor(hotkeys));

        Assert.Equal("Adjust overlay position (Ctrl+Alt+Z)", label);
        Assert.DoesNotContain("Ctrl+Shift+A", label, StringComparison.Ordinal);
    }

    /// <summary>
    /// The honest half. Another application owning the combination is the
    /// documented, likely failure (1409), and on that machine the shortcut does
    /// not exist. Naming it in the menu would be the app lying: the user would
    /// press it, nothing would happen, and the menu would have told them to.
    ///
    /// <para>The reason does not vanish, it moves to the tooltip — and it is
    /// the same sentence <see cref="GlobalHotkeyService.FallbackAdviceOrNull"/>
    /// puts in the log and the startup balloon, not a fourth wording.</para>
    /// </summary>
    [Fact]
    public void An_accelerator_that_could_not_be_registered_is_not_promised_in_the_menu()
    {
        using var hotkeys = new GlobalHotkeyService(
            register: _ => ErrorHotkeyAlreadyRegistered,
            unregister: _ => { });
        hotkeys.Start(createWindow: false);
        var state = StateFor(hotkeys);

        var item = AdjustItem(state);

        Assert.Null(hotkeys.RegisteredAdjustAccelerator);
        Assert.Equal("Adjust overlay position", item.Text);
        Assert.DoesNotContain("(", item.Text!, StringComparison.Ordinal);
        Assert.Equal(hotkeys.FallbackAdviceOrNull(), item.ToolTipText);
        Assert.Contains("Ctrl+Shift+A", item.ToolTipText!, StringComparison.Ordinal);
    }

    /// <summary>
    /// A registered accelerator needs no tooltip; the label already says it.
    /// This pins that the failure text is not shown on a working machine.
    /// </summary>
    [Fact]
    public void A_working_shortcut_carries_no_failure_tooltip()
    {
        using var hotkeys = new GlobalHotkeyService(register: _ => 0, unregister: _ => { });
        hotkeys.Start(createWindow: false);

        var item = AdjustItem(StateFor(hotkeys));

        Assert.True(string.IsNullOrEmpty(item.ToolTipText));
    }

    /// <summary>
    /// The key is a toggle (1.0.12), so it is also how you leave. The cancel
    /// item names it for the same reason the enter item does.
    /// </summary>
    [Fact]
    public void Cancel_adjust_names_the_same_key_because_the_key_toggles()
    {
        using var hotkeys = new GlobalHotkeyService(register: _ => 0, unregister: _ => { });
        hotkeys.Start(createWindow: false);

        var text = AdjustItemText(StateFor(hotkeys) with { IsAdjusting = true });

        Assert.Equal("Cancel adjust (Ctrl+Shift+A)", text);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    public void No_accelerator_means_no_parenthesis(string? accelerator)
    {
        Assert.Equal(
            TrayMenuState.AdjustMenuVerb,
            TrayMenuState.WithAccelerator(TrayMenuState.AdjustMenuVerb, accelerator));
    }

    /// <summary>
    /// The advice quotes the menu item by name, so the two must be the same
    /// string. If the label were renamed and the advice not, the app would tell
    /// a user with no shortcut to click something that is not there.
    /// </summary>
    [Fact]
    public void The_fallback_advice_names_the_menu_item_that_actually_exists()
    {
        using var hotkeys = new GlobalHotkeyService(
            register: _ => ErrorHotkeyAlreadyRegistered,
            unregister: _ => { });
        hotkeys.Start(createWindow: false);

        Assert.Contains(TrayMenuState.AdjustMenuVerb, hotkeys.FallbackAdviceOrNull()!, StringComparison.Ordinal);
    }

    /// <summary>
    /// The real NotifyIcon menu, opened, not the projection helper: the item
    /// the user right-clicks carries the accelerator.
    /// </summary>
    [Fact]
    public void The_real_tray_menu_shows_the_named_shortcut()
    {
        using var hotkeys = new GlobalHotkeyService(register: _ => 0, unregister: _ => { });
        hotkeys.Start(createWindow: false);
        using var tray = new TrayController(Dispatcher.CurrentDispatcher);
        tray.Start(StateFor(hotkeys));
        var menu = tray.ContextMenuForTesting;

        menu.Show(new Point(0, 0));
        try
        {
            Assert.Contains(
                menu.Items.OfType<Forms.ToolStripMenuItem>(),
                item => item.Text == "Adjust overlay position (Ctrl+Shift+A)");
        }
        finally
        {
            menu.Close();
        }
    }

    // ------------------------------------------------------ the log folder

    /// <summary>
    /// The failure this item exists to avoid: opening a folder that is not the
    /// one being written to. There are two derivations of the log path in this
    /// app and they must agree — but only one of them is the file the app
    /// appends to, and App.OpenLogFolder uses that one.
    /// </summary>
    [Fact]
    public void Both_log_path_derivations_name_the_same_file()
    {
        var localAppData = Path.Combine(Path.GetTempPath(), $"cb-{Guid.NewGuid():N}");
        var paths = DesktopPaths.Create(localAppData);

        var loggerPath = new RedactedLog(paths.Root).FilePath;

        Assert.Equal(paths.LogFile, loggerPath);
        Assert.Equal("companion.log", Path.GetFileName(loggerPath));
        Assert.Equal(Path.Combine(localAppData, "CoachBuild"), Path.GetDirectoryName(loggerPath));
    }

    /// <summary>
    /// Steady state: the log exists, so Explorer opens its folder with the file
    /// highlighted rather than dumping the user in a directory listing.
    /// </summary>
    [Fact]
    public void An_existing_log_is_selected_in_its_folder()
    {
        var root = Path.Combine(Path.GetTempPath(), $"cb-{Guid.NewGuid():N}", "CoachBuild");
        Directory.CreateDirectory(root);
        var log = new RedactedLog(root);
        log.Info("a line, so the file exists");
        try
        {
            var plan = LogFolderReveal.Plan(log.FilePath, File.Exists, Directory.Exists);

            Assert.Equal(RevealKind.SelectFile, plan.Kind);
            Assert.Equal($"/select,\"{log.FilePath}\"", plan.Arguments);
            Assert.Equal(root, plan.Directory);
            Assert.Equal("tray: opened log folder (companion.log selected)", plan.LogLine);
        }
        finally
        {
            Directory.Delete(Path.GetDirectoryName(root)!, recursive: true);
        }
    }

    /// <summary>
    /// Fresh install. The folder is created by <see cref="DesktopPaths"/> at
    /// startup but the log does not exist until the first line is written, and
    /// a user who clicks this before then must not get a no-op. Opening the
    /// containing folder is the fallback; <c>/select</c> on a missing file makes
    /// Explorer quietly open Documents instead, which is the silent wrong
    /// answer this branch exists to avoid.
    /// </summary>
    [Fact]
    public void A_log_that_does_not_exist_yet_opens_the_folder_instead_of_nothing()
    {
        var root = Path.Combine(Path.GetTempPath(), $"cb-{Guid.NewGuid():N}", "CoachBuild");
        Directory.CreateDirectory(root);
        var missing = Path.Combine(root, "companion.log");
        try
        {
            Assert.False(File.Exists(missing));

            var plan = LogFolderReveal.Plan(missing, File.Exists, Directory.Exists);

            Assert.Equal(RevealKind.OpenFolder, plan.Kind);
            Assert.Equal($"\"{root}\"", plan.Arguments);
            Assert.DoesNotContain("/select", plan.Arguments, StringComparison.Ordinal);
            Assert.Equal("tray: opened log folder (no companion.log yet)", plan.LogLine);
        }
        finally
        {
            Directory.Delete(Path.GetDirectoryName(root)!, recursive: true);
        }
    }

    /// <summary>
    /// Neither the file nor the folder exists — a profile so fresh the app has
    /// not written anything, or one where the folder was deleted underneath it.
    /// The convention everywhere else in this app (RedactedLog, DesktopPaths)
    /// is to create it, so this does too, and says it did.
    /// </summary>
    [Fact]
    public void A_missing_folder_is_created_rather_than_reported_as_a_failure()
    {
        var root = Path.Combine(Path.GetTempPath(), $"cb-{Guid.NewGuid():N}", "CoachBuild");
        var created = new List<string>();
        var launcher = new RecordingLauncher();
        var revealer = new LogFolderRevealer(
            launcher,
            fileExists: _ => false,
            directoryExists: path => created.Contains(path),
            createDirectory: created.Add);

        var line = revealer.Reveal(Path.Combine(root, "companion.log"));

        Assert.Equal(root, Assert.Single(created));
        Assert.Equal("tray: opened log folder (created it; no companion.log yet)", line);
        Assert.Equal($"\"{root}\"", Assert.Single(launcher.Calls).Arguments);
    }

    /// <summary>
    /// The operand is quoted, and quoted exactly once.
    ///
    /// <para><b>Not because an unquoted one breaks.</b> That was the assumption
    /// and a live probe against real Explorer on Windows 11 disproved it: the
    /// unquoted <c>/select,C:\…\Some Person\CoachBuild\companion.log</c> opened
    /// the right folder too. The quoting is here so the command line does not
    /// depend on that leniency and the operand's extent is unambiguous — and,
    /// more usefully, so that a path which cannot be quoted can be refused (the
    /// test below) rather than handed over and hoped about.</para>
    /// </summary>
    [Fact]
    public void The_path_is_quoted_exactly_once_because_it_always_contains_spaces()
    {
        var spaced = @"C:\Users\Some Person\AppData\Local\CoachBuild\companion.log";

        var selected = LogFolderReveal.Plan(spaced, _ => true, _ => true);
        var folderOnly = LogFolderReveal.Plan(spaced, _ => false, _ => true);

        Assert.Equal(2, selected.Arguments.Count(character => character == '"'));
        Assert.Equal(2, folderOnly.Arguments.Count(character => character == '"'));
        Assert.Equal($"/select,\"{spaced}\"", selected.Arguments);
        Assert.Equal("\"C:\\Users\\Some Person\\AppData\\Local\\CoachBuild\"", folderOnly.Arguments);
    }

    /// <summary>
    /// A path that cannot be quoted unambiguously is refused before anything is
    /// launched. The arguments here are built by hand (Explorer's
    /// <c>/select,</c> syntax cannot survive ArgumentList's per-element
    /// quoting), so the refusal is what keeps that safe.
    /// </summary>
    [Theory]
    [InlineData("C:\\CoachBuild\\co\"mpanion.log", "cannot be quoted")]
    [InlineData("C:\\CoachBuild\\comp\nanion.log", "cannot be quoted")]
    [InlineData("companion.log", "not absolute")]
    [InlineData("", "no log path is configured")]
    [InlineData(null, "no log path is configured")]
    public void A_path_that_cannot_be_quoted_or_resolved_is_refused_not_launched(string? path, string expected)
    {
        var launcher = new RecordingLauncher();
        var revealer = new LogFolderRevealer(launcher, _ => true, _ => true, _ => { });

        var plan = LogFolderReveal.Plan(path, _ => true, _ => true);
        var line = revealer.Reveal(path);

        Assert.Equal(RevealKind.Refused, plan.Kind);
        Assert.Empty(launcher.Calls);
        Assert.StartsWith("tray: open log folder FAILED (", line, StringComparison.Ordinal);
        Assert.Contains(expected, line, StringComparison.Ordinal);
    }

    /// <summary>
    /// explorer.exe is taken from %WINDIR%, never resolved off PATH, and
    /// launched with UseShellExecute=false — so no PATH entry and no shell
    /// association can decide what this menu item runs.
    /// </summary>
    [Fact]
    public void Explorer_is_resolved_absolutely_and_exists_on_this_machine()
    {
        var explorer = LogFolderReveal.ExplorerPath();

        Assert.True(Path.IsPathFullyQualified(explorer));
        Assert.Equal("explorer.exe", Path.GetFileName(explorer));
        Assert.True(File.Exists(explorer), explorer);
        Assert.Equal(explorer, LogFolderReveal.Plan(@"C:\x\companion.log", _ => true, _ => true).Executable);
    }

    /// <summary>
    /// Diagnostics are fail-soft everywhere else in this app and this is no
    /// exception: a launch that throws produces a named line, not a crashed
    /// tray and not silence.
    /// </summary>
    [Fact]
    public void A_launch_that_throws_produces_a_named_failure_line_not_a_crash()
    {
        var revealer = new LogFolderRevealer(
            new ThrowingLauncher(),
            fileExists: _ => true,
            directoryExists: _ => true,
            createDirectory: _ => { });

        var line = revealer.Reveal(@"C:\Users\Someone\AppData\Local\CoachBuild\companion.log");

        Assert.StartsWith("tray: open log folder FAILED (", line, StringComparison.Ordinal);
        Assert.Contains("InvalidOperationException", line, StringComparison.Ordinal);
    }

    /// <summary>
    /// Every route out produces exactly one greppable line with the existing
    /// tray prefix. A silent no-op would be indistinguishable from a broken
    /// menu item in a user's log, which is the mistake 1.0.11's hotkey made.
    /// </summary>
    [Theory]
    [InlineData(true, true)]
    [InlineData(false, true)]
    [InlineData(false, false)]
    public void Every_outcome_is_one_greppable_line(bool fileExists, bool directoryExists)
    {
        var revealer = new LogFolderRevealer(
            new RecordingLauncher(),
            _ => fileExists,
            _ => directoryExists,
            _ => { });

        var line = revealer.Reveal(@"C:\Users\Someone\AppData\Local\CoachBuild\companion.log");

        Assert.StartsWith("tray: opened log folder (", line, StringComparison.Ordinal);
        Assert.DoesNotContain("FAILED", line, StringComparison.Ordinal);
        Assert.DoesNotContain('\n', line);
    }

    /// <summary>The real menu carries the item, and clicking it raises the command.</summary>
    [Fact]
    public void The_real_tray_menu_offers_the_log_folder_and_clicking_it_raises_the_command()
    {
        using var tray = new TrayController(Dispatcher.CurrentDispatcher);
        tray.Start();
        var raised = new List<TrayCommand>();
        tray.CommandRequested += (_, args) => raised.Add(args.Command);
        var menu = tray.ContextMenuForTesting;

        menu.Show(new Point(0, 0));
        try
        {
            var item = menu.Items.OfType<Forms.ToolStripMenuItem>()
                .Single(candidate => candidate.Text == "Open log folder");
            Assert.True(item.Enabled);

            item.PerformClick();
        }
        finally
        {
            menu.Close();
        }

        Assert.Equal(TrayCommand.OpenLogFolder, Assert.Single(raised));
    }

    /// <summary>
    /// The user reaches this item mid-game, possibly mid-adjustment. Adjust
    /// mode ends only on Enter, Escape or an explicit cancel — there is no
    /// deactivation handler — and the overlay is topmost, which Explorer (an
    /// ordinary window) cannot displace. Driven against a real window so the
    /// claim is about the window and not about the diff.
    /// </summary>
    [Fact]
    public void Opening_the_log_folder_leaves_adjust_mode_and_topmost_alone()
    {
        RunOnSta(() =>
        {
            var settingsPath = Path.Combine(Path.GetTempPath(), $"coachbuild-test-{Guid.NewGuid():N}.json");
            var window = new OverlayWindow(new OverlaySettingsStore(settingsPath));
            try
            {
                window.SetOverlayVisible(true);
                window.ShowInactive();
                window.BeginAdjustment();
                Assert.True(window.IsAdjusting, "adjust mode did not start; the assertion below would be vacuous");
                Assert.True(window.Topmost);

                var launcher = new RecordingLauncher();
                var line = new LogFolderRevealer(launcher, _ => true, _ => true, _ => { })
                    .Reveal(@"C:\Users\Someone\AppData\Local\CoachBuild\companion.log");

                Assert.Single(launcher.Calls);
                Assert.StartsWith("tray: opened log folder (", line, StringComparison.Ordinal);
                Assert.True(window.IsAdjusting);
                Assert.True(window.Topmost);
            }
            finally
            {
                window.Close();
                if (File.Exists(settingsPath)) File.Delete(settingsPath);
            }
        });
    }

    // ---------------------------------------------------------------- helpers

    /// <summary>Exactly what App.StartHotkeys hands the tray.</summary>
    private static TrayMenuState StateFor(GlobalHotkeyService hotkeys) => TrayMenuState.Default with
    {
        AdjustAccelerator = hotkeys.RegisteredAdjustAccelerator,
        AdjustHotkeyAdvice = hotkeys.FallbackAdviceOrNull(),
    };

    private static Forms.ToolStripMenuItem AdjustItem(TrayMenuState state)
    {
        using var tray = new TrayController(Dispatcher.CurrentDispatcher);
        tray.Start(state);
        var menu = tray.ContextMenuForTesting;
        menu.Show(new Point(0, 0));
        try
        {
            var verb = state.IsAdjusting ? TrayMenuState.CancelAdjustMenuVerb : TrayMenuState.AdjustMenuVerb;
            var item = menu.Items.OfType<Forms.ToolStripMenuItem>()
                .Single(candidate => (candidate.Text ?? string.Empty).StartsWith(verb, StringComparison.Ordinal));
            // Detached from the strip so it survives the Close() below.
            return new Forms.ToolStripMenuItem(item.Text) { ToolTipText = item.ToolTipText };
        }
        finally
        {
            menu.Close();
        }
    }

    private static string AdjustItemText(TrayMenuState state) => AdjustItem(state).Text!;

    private sealed class RecordingLauncher : IShellLauncher
    {
        public List<(string Executable, string Arguments)> Calls { get; } = [];

        public void Start(string executable, string arguments) => Calls.Add((executable, arguments));
    }

    private sealed class ThrowingLauncher : IShellLauncher
    {
        public void Start(string executable, string arguments) =>
            throw new InvalidOperationException("explorer refused");
    }

    private static void RunOnSta(Action action)
    {
        Exception? failure = null;
        var thread = new Thread(() =>
        {
            try { action(); }
            catch (Exception exception) { failure = exception; }
        });
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();
        thread.Join();
        if (failure is not null) ExceptionDispatchInfo.Capture(failure).Throw();
    }
}
