using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Windows.Threading;
using Forms = System.Windows.Forms;

[assembly: InternalsVisibleTo("CoachBuild.Desktop.Tests")]

namespace CoachBuild.Desktop.Tray;

public enum TrayCommand
{
    Reopen,
    ToggleOverlay,
    ToggleInteractive,
    SetLane,
    Calibrate,
    Adjust,
    CancelAdjust,
    AdjustItems,
    ToggleItemNumbers,
    RepairWebView2,
    OpenLogFolder,
    PairMyStats,
    SendDiagnostics,
    ApplyUpdate,
    Quit,
}

public sealed class TrayCommandEventArgs : EventArgs
{
    public TrayCommandEventArgs(TrayCommand command, string? lane = null)
    {
        Command = command;
        Lane = lane;
    }

    public TrayCommand Command { get; }

    public string? Lane { get; }
}

/// <summary>
/// The only NotifyIcon owner in the process. It keeps one persistent menu and
/// populates its items when the menu opens. State updates are marshalled to
/// WPF's dispatcher, while command handlers are events so network/LCU work can
/// be performed by the application off the UI thread.
/// </summary>
public sealed class TrayController : IDisposable
{
    private static readonly string AppVersion = ResolveAppVersion();
    private static readonly string[] Lanes = ["TOP", "JUNGLE", "MID", "BOT", "SUPPORT"];

    private readonly Dispatcher _dispatcher;
    private readonly string? _iconPath;
    private readonly IStartupManager _startupManager;
    private readonly Forms.NotifyIcon _icon;
    private readonly Forms.ContextMenuStrip _menu;
    private bool _disposed;
    private TrayMenuState _state = TrayMenuState.Default;

    public TrayController(
        Dispatcher dispatcher,
        string? iconPath = null,
        IStartupManager? startupManager = null)
    {
        _dispatcher = dispatcher ?? throw new ArgumentNullException(nameof(dispatcher));
        _iconPath = iconPath;
        _startupManager = startupManager ?? new StartupManager();
        _menu = new Forms.ContextMenuStrip
        {
            ShowImageMargin = false,
            AutoClose = true,
        };
        _menu.Opening += OnMenuOpening;
        _icon = new Forms.NotifyIcon
        {
            Visible = false,
            Text = "CoachBuild",
            Icon = LoadIcon(iconPath),
            ContextMenuStrip = _menu,
        };
        _icon.MouseClick += OnMouseClick;
    }

    public event EventHandler<TrayCommandEventArgs>? CommandRequested;

    public TrayMenuState State => _state;

    internal Forms.ContextMenuStrip ContextMenuForTesting => _menu;

    public void Start(TrayMenuState? initialState = null)
    {
        InvokeOnDispatcher(() =>
        {
            ThrowIfDisposed();
            _state = initialState ?? TrayMenuState.Default;
            _icon.Visible = true;
        });
    }

    public void UpdateState(TrayMenuState state)
    {
        ArgumentNullException.ThrowIfNull(state);
        InvokeOnDispatcher(() =>
        {
            if (_disposed) return;
            _state = state;
        });
    }

    public void ShowBalloon(string title, string text, Forms.ToolTipIcon icon = Forms.ToolTipIcon.Info)
    {
        if (string.IsNullOrWhiteSpace(title) || string.IsNullOrWhiteSpace(text)) return;
        InvokeOnDispatcher(() =>
        {
            if (_disposed || !_icon.Visible) return;
            _icon.ShowBalloonTip(3500, title, text, icon);
        });
    }

    private void OnMouseClick(object? sender, Forms.MouseEventArgs e)
    {
        if (e.Button == Forms.MouseButtons.Left) RaiseCommand(TrayCommand.Reopen);
    }

    private void OnMenuOpening(object? sender, CancelEventArgs e)
    {
        if (_disposed)
        {
            e.Cancel = true;
            return;
        }

        // Opening is the only rebuild point. The strip itself remains attached
        // to NotifyIcon for the whole app lifetime, so an already visible menu
        // is never cleared or disposed by a 750ms state update.
        _menu.Items.Clear();
        _menu.Items.Add(MenuItem("Reopen CoachBuild", (_, _) => RaiseCommand(TrayCommand.Reopen)));
        _menu.Items.Add(MenuItem(
            _state.OverlayVisible ? "Hide overlay" : "Show overlay",
            (_, _) => RaiseCommand(TrayCommand.ToggleOverlay)));
        _menu.Items.Add(MenuItem(
            _state.Interactive ? "Disable interactive mode" : "Enable interactive mode",
            (_, _) => RaiseCommand(TrayCommand.ToggleInteractive)));
        var lane = new Forms.ToolStripMenuItem(
            _state.LaneOverride is null ? "Lane: Auto" : $"Lane: {DisplayLane(_state.LaneOverride)}");
        foreach (var option in Lanes.Append(string.Empty))
        {
            var label = string.IsNullOrEmpty(option) ? "Auto" : DisplayLane(option);
            var item = new Forms.ToolStripMenuItem(label)
            {
                Checked = string.Equals(_state.LaneOverride, option, StringComparison.OrdinalIgnoreCase),
                CheckOnClick = false,
            };
            var chosenLane = string.IsNullOrEmpty(option) ? null : option;
            item.Click += (_, _) => RaiseCommand(TrayCommand.SetLane, chosenLane);
            lane.DropDownItems.Add(item);
        }
        _menu.Items.Add(lane);

        _menu.Items.Add(new Forms.ToolStripSeparator());
        _menu.Items.Add(StatusItem($"CoachBuild v{AppVersion}"));
        // The WEB build the open window is running — a different number from
        // the line above it, and the one nobody could answer on 2026-08-19.
        _menu.Items.Add(StatusItem(_state.WebVersionLine));
        _menu.Items.Add(StatusItem($"Phase: {DisplayPhase(_state.Phase)}"));
        _menu.Items.Add(StatusItem(_state.IsCompanionBusy ? "Companion: busy" : "Companion: ready"));
        using (var process = Process.GetCurrentProcess())
        {
            _menu.Items.Add(StatusItem(TrayMenuState.FormatWorkingSet(process.WorkingSet64)));
        }
        if (!string.IsNullOrWhiteSpace(_state.Error)) _menu.Items.Add(StatusItem($"Error: {_state.Error}"));
        _menu.Items.Add(StatusItem($"Updates: {_state.Update.ToDisplayString()}"));

        // A downloaded release must be actionable from here. Before 1.0.9 the
        // only trace of a staged update was the disabled status line above,
        // and the restart it was waiting for had no trigger the user could reach.
        if (_state.Update.CanRestartToUpdate)
        {
            _menu.Items.Add(MenuItem(
                $"Restart to update to {_state.Update.Version}",
                (_, _) => RaiseCommand(TrayCommand.ApplyUpdate)));
        }

        if (_state.WebView2Available == WebView2Availability.Missing)
        {
            _menu.Items.Add(MenuItem("Repair WebView2 runtime", (_, _) => RaiseCommand(TrayCommand.RepairWebView2)));
        }

        // Every diagnosis in this project starts with companion.log, and until
        // 1.0.14 reaching it meant pasting %LOCALAPPDATA%\CoachBuild into an
        // address bar. It sits with the status lines it explains.
        _menu.Items.Add(MenuItem(
            TrayMenuState.OpenLogFolderVerb,
            (_, _) => RaiseCommand(TrayCommand.OpenLogFolder)));
        _menu.Items.Add(MenuItem(
            TrayMenuState.PairMyStatsVerb,
            (_, _) => RaiseCommand(TrayCommand.PairMyStats)));
        // Directly under the pairing item: it needs the same secret, and the
        // "not paired yet" message names that item above by its exact string.
        _menu.Items.Add(MenuItem(
            TrayMenuState.SendDiagnosticsVerb,
            (_, _) => RaiseCommand(TrayCommand.SendDiagnostics)));

        _menu.Items.Add(new Forms.ToolStripSeparator());
        if (!_state.IsAdjusting)
            _menu.Items.Add(MenuItem("Calibrate overlay", (_, _) => RaiseCommand(TrayCommand.Calibrate)));
        // The accelerator is named here rather than spelled out, so the label
        // follows GlobalHotkeyService's binding table and disappears when
        // nothing could be registered. The same key toggles back out, so the
        // cancel item names it too.
        _menu.Items.Add(AdjustItem());
        if (!_state.IsAdjusting)
        {
            _menu.Items.Add(MenuItem(
                TrayMenuState.AdjustItemsMenuVerb,
                (_, _) => RaiseCommand(TrayCommand.AdjustItems)));
            var showNumbers = new Forms.ToolStripMenuItem(TrayMenuState.ShowItemNumbersVerb)
            {
                Checked = _state.ForceItemNumbers,
                CheckOnClick = true,
                // Only meaningful in a game: there is no shop to sit over
                // otherwise, and an item that can be ticked to no effect is a
                // control that lies about what it does.
                Enabled = _state.IsInGame,
            };
            showNumbers.Click += (_, _) => RaiseCommand(TrayCommand.ToggleItemNumbers);
            _menu.Items.Add(showNumbers);
        }

        _menu.Items.Add(new Forms.ToolStripSeparator());
        var startWithWindows = new Forms.ToolStripMenuItem("Start with Windows")
        {
            Checked = _startupManager.IsEnabled,
            CheckOnClick = true,
        };
        startWithWindows.Click += (_, _) =>
        {
            if (startWithWindows.Checked) _startupManager.Enable();
            else _startupManager.Disable();
        };
        _menu.Items.Add(startWithWindows);
        _menu.Items.Add(MenuItem("Quit CoachBuild", (_, _) => RaiseCommand(TrayCommand.Quit)));
    }

    /// <summary>
    /// The adjust item, named after the accelerator that is actually
    /// registered.
    ///
    /// <para>When none is — another application owns Ctrl+Shift+A, which
    /// <c>RegisterHotKey</c>'s system-wide exclusivity makes entirely possible —
    /// the label stays bare rather than naming a key that does nothing, and the
    /// tooltip carries <see cref="Overlay.GlobalHotkeyService.FallbackAdviceOrNull"/>,
    /// the same sentence the log and the startup balloon use. This item is the
    /// documented fallback for that case, so it is the right place to say
    /// so.</para>
    /// </summary>
    private Forms.ToolStripMenuItem AdjustItem()
    {
        var item = _state.IsAdjusting
            ? MenuItem(
                TrayMenuState.WithAccelerator(TrayMenuState.CancelAdjustMenuVerb, _state.AdjustAccelerator),
                (_, _) => RaiseCommand(TrayCommand.CancelAdjust))
            : MenuItem(
                TrayMenuState.WithAccelerator(TrayMenuState.AdjustMenuVerb, _state.AdjustAccelerator),
                (_, _) => RaiseCommand(TrayCommand.Adjust));
        if (_state.AdjustAccelerator is null && !string.IsNullOrWhiteSpace(_state.AdjustHotkeyAdvice))
            item.ToolTipText = _state.AdjustHotkeyAdvice;
        return item;
    }

    private static Forms.ToolStripMenuItem MenuItem(string text, EventHandler action)
    {
        var item = new Forms.ToolStripMenuItem(text);
        item.Click += action;
        return item;
    }

    private static Forms.ToolStripMenuItem StatusItem(string text)
    {
        return new Forms.ToolStripMenuItem(text) { Enabled = false };
    }

    private static string ResolveAppVersion()
    {
        var informationalVersion = Assembly.GetEntryAssembly()?
            .GetCustomAttribute<AssemblyInformationalVersionAttribute>()?
            .InformationalVersion;
        if (string.IsNullOrWhiteSpace(informationalVersion)) return "unknown";

        var metadataStart = informationalVersion.IndexOf('+');
        return metadataStart >= 0
            ? informationalVersion[..metadataStart]
            : informationalVersion;
    }

    private void RaiseCommand(TrayCommand command, string? lane = null)
    {
        if (_disposed) return;
        CommandRequested?.Invoke(this, new TrayCommandEventArgs(command, lane));
    }

    private void InvokeOnDispatcher(Action action)
    {
        if (_dispatcher.CheckAccess()) action();
        else _dispatcher.BeginInvoke(action, DispatcherPriority.Normal);
    }

    private static string DisplayLane(string lane) => lane switch
    {
        "TOP" => "Top",
        "JUNGLE" => "Jungle",
        "MID" => "Mid",
        "BOT" => "Bot",
        "SUPPORT" => "Support",
        _ => "Auto",
    };

    private static string DisplayPhase(CompanionPhase phase) => phase switch
    {
        CompanionPhase.ChampSelect => "Champ Select",
        CompanionPhase.InProgress => "In progress",
        CompanionPhase.WaitingForStats => "Waiting for stats",
        _ => phase.ToString(),
    };

    private static Icon LoadIcon(string? iconPath)
    {
        try
        {
            if (!string.IsNullOrWhiteSpace(iconPath) && File.Exists(iconPath))
            {
                using var stream = File.OpenRead(iconPath);
                return new Icon(stream);
            }
        }
        catch
        {
            // A missing/corrupt optional asset must never prevent the tray from
            // starting. SystemIcons.Application is always available on Windows.
        }

        return SystemIcons.Application;
    }

    private void ThrowIfDisposed()
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        if (_dispatcher.CheckAccess()) DisposeCore();
        else _dispatcher.BeginInvoke(DisposeCore, DispatcherPriority.Send);
        GC.SuppressFinalize(this);
    }

    private void DisposeCore()
    {
        _icon.Visible = false;
        _icon.MouseClick -= OnMouseClick;
        _menu.Opening -= OnMenuOpening;
        _icon.ContextMenuStrip = null;
        _menu.Dispose();
        _icon.Dispose();
    }
}
