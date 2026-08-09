using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
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
    ToggleSkillTable,
    SetLane,
    Calibrate,
    Adjust,
    CancelAdjust,
    RepairWebView2,
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
    private static readonly string[] Lanes = ["TOP", "JUNGLE", "MID", "BOT", "SUPPORT"];

    private readonly Dispatcher _dispatcher;
    private readonly string? _iconPath;
    private readonly Forms.NotifyIcon _icon;
    private readonly Forms.ContextMenuStrip _menu;
    private bool _disposed;
    private TrayMenuState _state = TrayMenuState.Default;

    public TrayController(Dispatcher dispatcher, string? iconPath = null)
    {
        _dispatcher = dispatcher ?? throw new ArgumentNullException(nameof(dispatcher));
        _iconPath = iconPath;
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
        _menu.Items.Add(MenuItem(
            _state.ShowSkillTable ? "Hide skill table" : "Show skill table",
            (_, _) => RaiseCommand(TrayCommand.ToggleSkillTable)));

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
        _menu.Items.Add(StatusItem($"Phase: {DisplayPhase(_state.Phase)}"));
        _menu.Items.Add(StatusItem(_state.IsCompanionBusy ? "Companion: busy" : "Companion: ready"));
        using (var process = Process.GetCurrentProcess())
        {
            _menu.Items.Add(StatusItem(TrayMenuState.FormatWorkingSet(process.WorkingSet64)));
        }
        if (!string.IsNullOrWhiteSpace(_state.Error)) _menu.Items.Add(StatusItem($"Error: {_state.Error}"));
        _menu.Items.Add(StatusItem($"Updates: {_state.Update.ToDisplayString()}"));

        if (!_state.WebView2Available)
        {
            _menu.Items.Add(MenuItem("Repair WebView2 runtime", (_, _) => RaiseCommand(TrayCommand.RepairWebView2)));
        }

        _menu.Items.Add(new Forms.ToolStripSeparator());
        if (!_state.IsAdjusting)
            _menu.Items.Add(MenuItem("Calibrate overlay", (_, _) => RaiseCommand(TrayCommand.Calibrate)));
        _menu.Items.Add(_state.IsAdjusting
            ? MenuItem("Cancel adjust", (_, _) => RaiseCommand(TrayCommand.CancelAdjust))
            : MenuItem("Adjust overlay position", (_, _) => RaiseCommand(TrayCommand.Adjust)));
        _menu.Items.Add(new Forms.ToolStripSeparator());
        _menu.Items.Add(MenuItem("Quit CoachBuild", (_, _) => RaiseCommand(TrayCommand.Quit)));
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
