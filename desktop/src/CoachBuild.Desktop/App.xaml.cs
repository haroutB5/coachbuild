global using System.IO;
global using System.Net.Http;

using System.Security.Cryptography;
using System.Text;
using System.Globalization;
using System.Windows;
using System.Windows.Threading;
using System.Text.Json;
using Microsoft.Win32;
using CoachBuild.Core;
using CoachBuild.Desktop.Diagnostics;
using CoachBuild.Desktop.Overlay;
using CoachBuild.Desktop.Tray;
using CoachBuild.Desktop.Updates;
using CoachBuild.Desktop.Web;
using CoreSkillOrderProvider = CoachBuild.Core.ISkillOrderProvider;
using CoreSkillOrderResult = CoachBuild.Core.SkillOrderResult;
using CoreSkillOrderStatus = CoachBuild.Core.SkillOrderStatus;
using CoreOverlaySkillOrder = CoachBuild.Core.OverlaySkillOrder;
using OverlayAbility = CoachBuild.Desktop.Overlay.OverlayAbility;
using OverlaySkillOrder = CoachBuild.Desktop.Overlay.OverlaySkillOrder;
using WpfApplication = System.Windows.Application;
using WpfMessageBox = System.Windows.MessageBox;

namespace CoachBuild.Desktop;

/// <summary>
/// The native services lane-a supplies to the WPF lifetime. The default
/// implementation is intentionally inert so the tray/overlay can still start
/// when League is closed; production wiring replaces it before startup.
/// </summary>
public interface IDesktopHostServices
{
    Task<DesktopPhaseSnapshot> ReadSnapshotAsync(CancellationToken cancellationToken);

    Task<bool> RepairWebView2Async(CancellationToken cancellationToken);

    bool IsCompanionBusy { get; }

    Task StopAsync(CancellationToken cancellationToken);
}

public interface IDesktopHostLifecycle
{
    Task StartAsync(CancellationToken cancellationToken);
}

public interface ILaneOverrideHostServices
{
    void SetLaneOverride(string? lane);
}

/// <summary>
/// A host that can upload the companion log to My Stats on request.
///
/// <para>Its own interface rather than a member of
/// <see cref="IDesktopHostServices"/> so that a host which cannot do it
/// (the inert default) is distinguishable AT THE CALL SITE from one that can.
/// The tray item must never be able to produce nothing: an
/// <c>is not IDiagnosticsUploadHost</c> miss has to report a failure the user
/// can see, and it cannot do that if the method exists and silently no-ops.</para>
/// </summary>
public interface IDiagnosticsUploadHost
{
    /// <summary>
    /// Returns immediately. <paramref name="report"/> is invoked exactly once,
    /// off the UI thread; the caller marshals it.
    /// </summary>
    void SendDiagnostics(Action<DiagnosticsUploadOutcome>? report = null);
}

/// <summary>
/// A host that can hand the overlay a new state the moment the live game
/// produces one, instead of waiting to be asked.
///
/// <para>The 750 ms snapshot poll is a fine cadence for a phase or a champion
/// name. It is not one for a skill point: added to the live poll in front of
/// it, the worst case from "the user levelled up" to "the box is on screen"
/// was 1.75 s in 1.0.11, against an unspent window that is frequently shorter
/// than that. This seam removes the second half of that number.</para>
/// </summary>
public interface ILiveOverlayPushSource
{
    /// <summary>Raised off the UI thread; the payload is null when there is nothing to show.</summary>
    event Action<OverlayState?>? OverlayStateChanged;

    /// <summary>
    /// Which game is running, as allgamedata last reported it, or null before
    /// the first body arrives. Read on the UI thread and written on the poll
    /// thread, so the implementation owns the lock.
    /// </summary>
    LiveGameMode? CurrentGameMode { get; }
}

public sealed record DesktopPhaseSnapshot(
    string? Phase,
    LastOpenPage? LastOpen = null,
    bool IsCompanionBusy = false,
    string? Error = null,
    OverlayState? Overlay = null,
    /// <summary>
    /// Who champ select says the player is on, projected for automatic site
    /// imports. Null outside champ select, and null inside it until the
    /// champion roster has been fetched — imports need a NAME and a ddragon
    /// KEY, and a numeric id alone can build neither a label nor a slug.
    /// </summary>
    ChampSelectContext? ChampSelect = null,
    /// <summary>
    /// Whether the League client is currently connected (credentials present).
    /// Automatic imports need it before any write; it rides the
    /// existing 750 ms push rather than a new poll.
    /// </summary>
    bool LcuConnected = false);

public sealed class NullDesktopHostServices : IDesktopHostServices
{
    public bool IsCompanionBusy => false;

    public Task<DesktopPhaseSnapshot> ReadSnapshotAsync(CancellationToken cancellationToken)
    {
        return Task.FromResult(new DesktopPhaseSnapshot("None"));
    }

    public Task<bool> RepairWebView2Async(CancellationToken cancellationToken)
    {
        return Task.FromResult(false);
    }

    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;
}

public sealed record DesktopPaths(
    string Root,
    string SettingsFile,
    string SessionTokenFile,
    string LogFile,
    string WebView2UserDataFolder)
{
    public static DesktopPaths Create(string? localAppData = null)
    {
        var basePath = localAppData
            ?? Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        var root = Path.Combine(basePath, "CoachBuild");
        return new DesktopPaths(
            root,
            Path.Combine(root, "desktop-settings.json"),
            // Keep the existing companion path so a browser/PWA pairing is
            // durable across native migration.
            Path.Combine(root, CompanionWire.SessionFileName),
            Path.Combine(root, "companion.log"),
            Path.Combine(root, "WebView2"));
    }

    public void EnsureCreated()
    {
        Directory.CreateDirectory(Root);
        Directory.CreateDirectory(WebView2UserDataFolder);
    }
}

public sealed class SessionTokenStore
{
    public SessionTokenStore(string? baseDirectory = null)
    {
        var root = baseDirectory
            ?? Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "CoachBuild");
        FilePath = Path.Combine(root, CompanionWire.SessionFileName);
    }

    public string FilePath { get; }

    public string GetOrCreate() => ReadOrCreate(FilePath);

    public static string ReadOrCreate(string path)
    {
        try
        {
            if (File.Exists(path))
            {
                var existing = File.ReadAllText(path, Encoding.UTF8).Trim();
                if (IsValid(existing)) return existing;
            }

            var token = Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();
            var directory = Path.GetDirectoryName(path);
            if (!string.IsNullOrWhiteSpace(directory)) Directory.CreateDirectory(directory);
            var temporary = path + ".tmp-" + Guid.NewGuid().ToString("N");
            File.WriteAllText(temporary, token, new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
            File.Move(temporary, path, overwrite: true);
            return token;
        }
        catch
        {
            // A read-only profile should not prevent the app from running. The
            // in-memory fallback is session-scoped; the next launch retries.
            return Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();
        }
    }

    public static bool IsValid(string? token)
    {
        return !string.IsNullOrWhiteSpace(token)
            && token.Length >= 32
            && token.All(static c => c is >= '0' and <= '9' or >= 'a' and <= 'f' or >= 'A' and <= 'F');
    }
}

public partial class App : WpfApplication
{
    public const string CompanionMutexName = "Local\\CoachBuildCompanion";
    public const string AppOrigin = CompanionWire.AppOrigin;

    private readonly CancellationTokenSource _shutdown = new();
    private Mutex? _companionMutex;
    private TrayController? _tray;
    private OverlayWindow? _overlay;
    private OverlaySettingsStore? _settingsStore;
    private WebView2Window? _webView;
    private WebView2EnvironmentService? _webViewEnvironment;
    private RedactedLog? _log;
    private GlobalHotkeyService? _hotkeys;
    private VelopackUpdateService? _updates;
    private Task? _pollTask;
    private TrayMenuState _trayState = TrayMenuState.Default;
    private IDesktopHostServices _services = new NullDesktopHostServices();
    private IStartupManager? _startupManager;
    private int _snapshotBusy;
    private int _phaseBusy;
    private int _webViewVisible;
    // Whether the window that is open is one the USER asked for. Champ select
    // opens one on the player's behalf and that one is torn down at load-in;
    // tray Reopen and a hand-launched app are not. See CompanionWindowPolicy.
    private int _webViewUserOpened;
    private int _updateBusy;
    private int _lastWebView2ProbeState = -1;
    private string? _announcedUpdateVersion;
    private bool _isShuttingDown;
    private readonly FullscreenAdvisor _fullscreen = new();
    private string? _lastPolledPhase;

    public static App? CurrentApp => Current as App;

    public DesktopPaths Paths { get; private set; } = DesktopPaths.Create();

    public string SessionToken { get; private set; } = string.Empty;

    public IDesktopHostServices Services
    {
        get => _services;
        set => _services = value ?? new NullDesktopHostServices();
    }

    public void ConfigureServices(IDesktopHostServices services)
    {
        if (HasStarted) throw new InvalidOperationException("Services must be configured before App startup.");
        Services = services;
    }

    public bool HasStarted { get; private set; }

    public CommandLineOptions Options { get; private set; } = CommandLineOptions.Parse([]);

    public void ConfigureOptions(CommandLineOptions options)
    {
        ArgumentNullException.ThrowIfNull(options);
        if (HasStarted) throw new InvalidOperationException("Options must be configured before App startup.");
        Options = options;
    }

    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);
        HasStarted = true;
        ShutdownMode = ShutdownMode.OnExplicitShutdown;

        Paths = DesktopPaths.Create();
        Paths.EnsureCreated();
        _log = new RedactedLog(Paths.Root);
        SessionToken = SessionTokenStore.ReadOrCreate(Paths.SessionTokenFile);

        if (!TryAcquireMutex())
        {
            WpfMessageBox.Show(
                "CoachBuild is already running (or the legacy companion is still active). Close the existing tray app and try again.",
                "CoachBuild already running",
                MessageBoxButton.OK,
                MessageBoxImage.Information);
            Shutdown(2);
            return;
        }

        // Built before the host services so the LP capture can read the account
        // secret out of it. The constructor touches no disk, so moving it up
        // costs nothing and changes no behaviour for anything below.
        var settingsStore = new OverlaySettingsStore(Paths.SettingsFile);
        _settingsStore = settingsStore;

        if (_services is NullDesktopHostServices)
        {
            var skillReader = new UggSkillOrderReader(Dispatcher, Paths.WebView2UserDataFolder,
                () => (_services as CoreDesktopHostServices)?.ChampionDirectory,
                line => _log?.Info(line));
            var nativeServices = new CoreDesktopHostServices(
                SessionToken,
                Paths.Root,
                log: _log,
                skillOrderFetch: skillReader.FetchAsync,
                rankSampleSecret: () => ResolveRankSampleSecret(settingsStore),
                laneScoreDemo: Options.LaneScoreDemo);
            if (Options.LaneScoreDemo)
                _log?.Info("lane-score: DEMO MODE -- the card is fabricated and NOTHING will be written");
            nativeServices.PageRequested += OnNativePageRequested;
            _services = nativeServices;
        }

        _startupManager = new StartupManager();
        AutostartConfiguration.EnsureConfigured(settingsStore, _startupManager);

        _tray = new TrayController(
            Dispatcher,
            Path.Combine(AppContext.BaseDirectory, "Assets", "tray-icon.ico"),
            _startupManager);
        _tray.CommandRequested += OnTrayCommand;

        _overlay = new OverlayWindow(settingsStore);
        _overlay.Diagnostics = message => _log?.Info(message);
        // A pull, not a pushed property: the mode is captured on the poll
        // thread and read here on the render thread, and one lock at the point
        // of use is cheaper to reason about than a second copy kept in sync.
        _overlay.GameMode = () => (_services as ILiveOverlayPushSource)?.CurrentGameMode;
        _overlay.AdjustmentStateChanged += OnAdjustmentStateChanged;
        if (_services is ILiveOverlayPushSource push) push.OverlayStateChanged += OnLiveOverlayPush;
        if (_services is ILaneOverrideHostServices laneOverrideServices)
            laneOverrideServices.SetLaneOverride(_overlay.LaneOverrideSetting);
        _trayState = _trayState with
        {
            OverlayVisible = _overlay.OverlayVisibleSetting,
            LaneOverride = _overlay.LaneOverrideSetting,
        };
        _overlay.Hide();
        _tray.Start(_trayState);
        StartHotkeys();
        _webViewEnvironment = new WebView2EnvironmentService(Paths.WebView2UserDataFolder);
        _ = ProbeWebView2AvailabilityAsync(_shutdown.Token);
        _updates = new VelopackUpdateService(
            isCompanionBusy: IsUpdateBusyForService,
            diagnostics: message => _log?.Info(message),
            feedUrl: Options.Feed);
        _updates.StatusChanged += OnUpdateStatusChanged;
        // A laptop asleep past the 2-hour tick misses releases entirely, so a
        // resume is an idle moment worth checking at. Unsubscribed in OnExit.
        SystemEvents.PowerModeChanged += OnPowerModeChanged;
        _ = _updates.StartAsync(_shutdown.Token);
        if (_services is IDesktopHostLifecycle lifecycle)
            _ = Task.Run(() => lifecycle.StartAsync(_shutdown.Token));
        _pollTask = PollAsync(_shutdown.Token);
        if (Options.ShouldOpenWebViewOnLaunch)
            _ = ReopenAsync();
    }

    /// <summary>
    /// The shared account secret the ranked-LP capture posts with, or null.
    ///
    /// <para>Two sources, environment first: <c>COACHBUILD_MYSTATS_SECRET</c>
    /// then <c>rankSampleSecret</c> in <c>desktop-settings.json</c>. The
    /// environment wins so a support session can turn capture on for one launch
    /// without writing a secret into a file that stays there afterwards.</para>
    ///
    /// <para>Null means the desktop has not been paired and capture is INERT. It
    /// never degrades into an unauthenticated POST — that is the same fail-closed
    /// rule <c>lib/mystats/accountAuth.ts</c> states for the server half.</para>
    /// </summary>
    internal static string? ResolveRankSampleSecret(OverlaySettingsStore store)
    {
        try
        {
            var fromEnvironment = Environment.GetEnvironmentVariable("COACHBUILD_MYSTATS_SECRET")?.Trim();
            if (!string.IsNullOrEmpty(fromEnvironment)) return fromEnvironment;
            var fromSettings = store.Read().RankSampleSecret?.Trim();
            return string.IsNullOrEmpty(fromSettings) ? null : fromSettings;
        }
        catch
        {
            // A settings file that cannot be read is a capture that does not
            // happen, never a startup that does not happen.
            return null;
        }
    }

    /// <summary>
    /// Binds the adjust hotkey and writes one line per attempt.
    ///
    /// <para>Through 1.0.11 this app registered no global hotkey at all — the
    /// feature was lost in the Electron→WPF rewrite, and because nothing was
    /// ever attempted, nothing was ever logged either. The outcome lines are
    /// therefore as much of the fix as the registration is: the next report of
    /// "the hotkey does nothing" is answerable from companion.log.</para>
    ///
    /// <para>1.0.13 binds <c>Ctrl+Shift+A</c> only. 1.0.12 also bound
    /// <c>Ctrl+Shift+S</c>; the user dropped it because a global hotkey takes
    /// that combination away from every app that uses it as "Save As".</para>
    ///
    /// <para>1.0.14 feeds the outcome to the tray, so the menu item names the
    /// accelerator that was actually registered — and names none when the
    /// registration failed. Every string that mentions the key (the log line,
    /// the balloon, the menu label, the tooltip) is derived from
    /// <see cref="GlobalHotkeyService.AdjustBindings"/>; none of them is a
    /// second copy that could survive a change of bind.</para>
    /// </summary>
    private void StartHotkeys()
    {
        _hotkeys = new GlobalHotkeyService();
        _hotkeys.Pressed += OnHotkeyPressed;
        foreach (var outcome in _hotkeys.Start()) _log?.Info(outcome.ToLogLine());
        var advice = _hotkeys.FallbackAdviceOrNull();
        _trayState = _trayState with
        {
            AdjustAccelerator = _hotkeys.RegisteredAdjustAccelerator,
            AdjustHotkeyAdvice = advice,
        };
        _tray?.UpdateState(_trayState);
        if (advice is not null)
        {
            _log?.Info(advice);
            // The tray item is always present, but a user who only knows the
            // hotkey has no way to discover that. Say so once, out loud.
            _tray?.ShowBalloon(
                "CoachBuild overlay",
                $"The overlay adjust shortcut ({_hotkeys.AttemptedAdjustAccelerators}) could not be registered "
                + $"(another app owns it). Right-click the CoachBuild tray icon and choose “{TrayMenuState.AdjustMenuVerb}” instead.",
                System.Windows.Forms.ToolTipIcon.Warning);
        }
    }

    /// <summary>
    /// Toggles adjust mode. Deliberately a toggle rather than an enter: in a
    /// borderless game the same key has to get the user back out, and reaching
    /// the tray to cancel means alt-tabbing out of the game they are aligning
    /// the overlay against.
    /// </summary>
    private void OnHotkeyPressed(HotkeyBinding binding)
    {
        if (_isShuttingDown || _overlay is null) return;
        var adjusting = _overlay.IsAdjusting;
        _log?.Info($"hotkey: {binding.Accelerator} pressed; {(adjusting ? "leaving" : "entering")} adjust mode");
        if (adjusting) _overlay.CancelAdjustment();
        else _overlay.BeginAdjustment();
    }

    private bool TryAcquireMutex()
    {
        try
        {
            _companionMutex = new Mutex(true, CompanionMutexName, out var createdNew);
            if (createdNew) return true;
            _companionMutex.Dispose();
            _companionMutex = null;
            return false;
        }
        catch
        {
            _companionMutex?.Dispose();
            _companionMutex = null;
            return false;
        }
    }

    private async Task PollAsync(CancellationToken cancellationToken)
    {
        // This loop is deliberately not a DispatcherTimer: LCU/bridge work
        // must never block the WPF dispatcher or tray menu interaction.
        while (!cancellationToken.IsCancellationRequested)
        {
            try
            {
                var snapshot = await Services.ReadSnapshotAsync(cancellationToken).ConfigureAwait(false);
                // Queried off the dispatcher: SHQueryUserNotificationState is
                // an RPC to the shell and must never sit in front of a WPF
                // render pass. Only asked in game, where the answer matters.
                var shellState = string.Equals(snapshot.Phase, "InProgress", StringComparison.Ordinal)
                    ? ShellNotificationState.Query()
                    : null;
                await Dispatcher.InvokeAsync(() => ApplySnapshot(snapshot, shellState), DispatcherPriority.Background, cancellationToken);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                await Dispatcher.InvokeAsync(() => SetError(ex.Message), DispatcherPriority.Background);
            }

            try
            {
                await Task.Delay(TimeSpan.FromMilliseconds(750), cancellationToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                break;
            }
        }
    }

    /// <summary>
    /// A live skill change, applied without waiting for the next snapshot tick.
    ///
    /// <para>This is the second half of the appearance latency. The live poll
    /// samples the game every 250 ms; before 1.0.12 its result then sat until
    /// the 750 ms projection collected it, so the worst case from level-up to
    /// pixels was the sum of the two. It carries no phase bookkeeping - the
    /// snapshot poll still owns that - so the two cannot race over a
    /// transition.</para>
    /// </summary>
    private void OnLiveOverlayPush(OverlayState? state)
    {
        if (_isShuttingDown) return;
        Dispatcher.BeginInvoke(
            () =>
            {
                if (_isShuttingDown || _overlay is null) return;
                if (state is null)
                {
                    _overlay.ClearForNoGame("live feed produced no state");
                    return;
                }

                _overlay.ApplyState(state);
                if (_trayState.OverlayVisible) _overlay.ShowInactive();
            },
            DispatcherPriority.Normal);
    }

    private void ApplySnapshot(
        DesktopPhaseSnapshot snapshot,
        UserNotificationState? shellState = null)
    {
        var phase = TrayMenuState.ParsePhase(snapshot.Phase);
        var previousPhase = _trayState.Phase;
        LogPollLiveness(snapshot.Phase);
        Volatile.Write(ref _snapshotBusy, snapshot.IsCompanionBusy ? 1 : 0);
        Volatile.Write(ref _phaseBusy, IsBusyPhase(phase) ? 1 : 0);
        var effectiveBusy = IsUpdateBusyContext();
        _trayState = _trayState with
        {
            Phase = phase,
            IsCompanionBusy = effectiveBusy,
            LastOpen = snapshot.LastOpen ?? _trayState.LastOpen,
            Error = snapshot.Error,
            Update = _updates?.Current ?? _trayState.Update,
        };
        _tray?.UpdateState(_trayState);
        SetUpdateBusy(effectiveBusy);

        // The connection edge lets an already-open MyStats tab retry its
        // account-specific op.gg destination once LCU becomes available.
        _webView?.UpdateSiteImportAvailability(snapshot.LcuConnected);
        // The automatic item+runes import trigger, on the same tick. This only
        // OFFERS the snapshot to the window's auto-import service (which
        // debounces, single-flights, and fetches through background/hidden
        // webviews without moving the user's tab); the 750 ms cadence is the
        // existing poll, not a new timer.
        _webView?.NotifySnapshotForAutoImport(snapshot.ChampSelect, snapshot.LcuConnected);

        // AFTER SetUpdateBusy, never before. Closing the window clears the
        // restart-is-disruptive gate and kicks a staged-apply retry, and the
        // only thing that then keeps the app from restarting into the game is
        // the busy state this line has just published.
        if (CompanionWindowPolicy.Decide(
                phase,
                _webView is not null,
                Volatile.Read(ref _webViewUserOpened) != 0) == CompanionWindowAction.CloseForGame)
        {
            CloseCompanionWindowForGame();
        }

        // Champ select ended WITHOUT a game (a dodge: back to None/Lobby,
        // 2.1.2). An import run still in flight is fetching for a draft that
        // no longer exists, so it is cancelled and its debounce rolls back;
        // the next lock re-imports from scratch. This is deliberately NOT
        // the game-start path above, whose runs finish and write first.
        if (previousPhase == CompanionPhase.ChampSelect &&
            (phase == CompanionPhase.None || phase == CompanionPhase.Lobby))
        {
            _webView?.CancelAutoImportForChampSelectEnd();
        }

        // Post-game is the natural idle window: the busy gate just cleared
        // and the player is reading stats, not playing. Fire-and-forget off
        // the dispatcher; the service's semaphore serialises with any running
        // check and the 10-minute cooldown absorbs phase blips.
        if (OpportunisticCheckPolicy.IsGameEndTransition(previousPhase, phase))
        {
            _log?.Info($"update: game ended ({previousPhase} -> {phase}); checking for a release now");
            var updates = _updates;
            if (updates is not null)
                _ = Task.Run(() => updates.RequestOpportunisticCheckAsync(OpportunisticCheckTrigger.GameEnd));
        }

        if (snapshot.Overlay is not null)
        {
            _overlay?.ApplyState(snapshot.Overlay);
            if (_trayState.OverlayVisible) _overlay?.ShowInactive();
        }
        else
        {
            // ClearForNoGame, not HideOverlay: hiding leaves the last in-game
            // state loaded, and several paths re-render it later - the user's
            // 1.0.11 log has the highlight re-asserted TWO MINUTES after the
            // match ended, on the overlay's own monitor because League was
            // gone. It also drops the `is not InProgress` condition: a live
            // feed that dies mid-game produces a null overlay while the phase
            // is still InProgress, and 1.0.11 answered that by leaving the
            // stale highlight on screen indefinitely. Same hole, twice.
            //
            // Still never a raw Hide(): ClearForNoGame honours adjust mode for
            // the same reason HideOverlay does.
            _overlay?.ClearForNoGame(phase is CompanionPhase.InProgress
                ? "live feed produced no state"
                : $"phase {phase}");
        }

        ApplyFullscreenAdvice(phase is CompanionPhase.InProgress, shellState);
    }

    /// <summary>
    /// One line per phase transition observed by the 750 ms SNAPSHOT poll,
    /// which is a different instrument from GameflowPoller's own `phase:` line.
    ///
    /// Without it, "no overlay: lines at all" could still mean the poll loop
    /// itself had died — GameflowPoller runs on its own task and would keep
    /// logging phases from a process whose render path was no longer ticking.
    /// </summary>
    private void LogPollLiveness(string? phase)
    {
        var value = string.IsNullOrWhiteSpace(phase) ? "None" : phase;
        if (string.Equals(_lastPolledPhase, value, StringComparison.Ordinal)) return;
        var previous = _lastPolledPhase ?? "start";
        _lastPolledPhase = value;
        _log?.Info($"poll: phase {previous} -> {value}");
    }

    private void ApplyFullscreenAdvice(bool inGame, UserNotificationState? shellState)
    {
        var advice = _fullscreen.Observe(
            inGame,
            shellState,
            // HasRenderableSkillOrder, not IsDrawingHighlight: since 1.0.12 the
            // highlight is on screen only while a point is unspent, so the
            // instantaneous render decision is almost always false and the
            // hint would essentially never fire. The question this asks is
            // "should this user be seeing our pixels during this game".
            _overlay?.HasRenderableSkillOrder ?? false);
        if (advice.LogLine is { } line) _log?.Info(line);
        if (advice.ShowHint)
        {
            _tray?.ShowBalloon(
                FullscreenAdvisor.HintTitle,
                FullscreenAdvisor.HintMessage,
                System.Windows.Forms.ToolTipIcon.Info);
        }
    }

    private void SetError(string message)
    {
        _trayState = _trayState with { Error = message };
        _tray?.UpdateState(_trayState);
    }

    private void OnUpdateStatusChanged(object? sender, UpdateTrayModel model)
    {
        if (_isShuttingDown) return;
        Dispatcher.BeginInvoke(() =>
        {
            _trayState = _trayState with { Update = model };
            _tray?.UpdateState(_trayState);
            AnnounceUpdate(model);
            // The staged-update hint lives in the window's own status line;
            // the window decides whether the slot is idle enough to show it.
            _webView?.UpdateStagedUpdateHint(model);
        }, DispatcherPriority.Background);
    }

    /// <summary>
    /// One balloon per version, only for a release that is downloaded and
    /// waiting on the user. An update that applies on its own is never
    /// announced — the app just restarts into it.
    /// </summary>
    private void AnnounceUpdate(UpdateTrayModel model)
    {
        if (model.Status != UpdateStatus.Staged || model.Version is null) return;
        if (string.Equals(_announcedUpdateVersion, model.Version, StringComparison.Ordinal)) return;
        _announcedUpdateVersion = model.Version;
        _tray?.ShowBalloon(
            $"CoachBuild {model.Version} is ready",
            "Right-click the tray icon and choose “Restart to update”, or close this window and it will apply on its own.");
    }

    /// <summary>
    /// A resume may have slept straight past the 2-hour tick. The cooldown
    /// keeps a flapping power state to one check per 10 minutes; the service
    /// owns the rest.
    /// </summary>
    private void OnPowerModeChanged(object? sender, PowerModeChangedEventArgs e)
    {
        if (_isShuttingDown || e.Mode != PowerModes.Resume) return;
        _log?.Info("update: system resumed from sleep; checking for releases missed while asleep");
        var updates = _updates;
        if (updates is not null)
            _ = Task.Run(() => updates.RequestOpportunisticCheckAsync(OpportunisticCheckTrigger.SystemResume));
    }

    /// <summary>
    /// The automatic champ-select open. Not user-initiated: this window is
    /// opened on the player's behalf and is the one torn down at load-in.
    /// </summary>
    private void OnNativePageRequested(ReopenTarget target)
    {
        if (_isShuttingDown) return;
        Dispatcher.BeginInvoke(
            () => _ = OpenTargetAsync(target, userInitiated: false),
            DispatcherPriority.Background);
    }

    private void OnTrayCommand(object? sender, TrayCommandEventArgs e)
    {
        if (_isShuttingDown) return;

        switch (e.Command)
        {
            case TrayCommand.ToggleOverlay:
                _trayState = _trayState with { OverlayVisible = !_trayState.OverlayVisible };
                _overlay?.SetOverlayVisible(_trayState.OverlayVisible);
                if (_trayState.OverlayVisible) _overlay?.ShowInactive();
                else _overlay?.Hide();
                _tray?.UpdateState(_trayState);
                break;
            case TrayCommand.ToggleInteractive:
                _trayState = _trayState with { Interactive = !_trayState.Interactive };
                _overlay?.SetInteractive(_trayState.Interactive);
                _tray?.UpdateState(_trayState);
                break;
            case TrayCommand.SetLane:
                _trayState = _trayState with { LaneOverride = TrayMenuState.NormalizeLane(e.Lane) };
                if (_services is ILaneOverrideHostServices laneOverrideServices)
                    laneOverrideServices.SetLaneOverride(_trayState.LaneOverride);
                _overlay?.SetLaneOverride(_trayState.LaneOverride);
                _tray?.UpdateState(_trayState);
                break;
            case TrayCommand.Calibrate:
                _overlay?.BeginCalibration();
                break;
            case TrayCommand.Adjust:
                _overlay?.BeginAdjustment();
                break;
            case TrayCommand.CancelAdjust:
                _overlay?.CancelAdjustment();
                break;
            case TrayCommand.RepairWebView2:
                _ = RepairWebView2Async();
                break;
            case TrayCommand.OpenLogFolder:
                OpenLogFolder();
                break;
            case TrayCommand.PairMyStats:
                PairDesktopWithMyStats();
                break;
            case TrayCommand.SendDiagnostics:
                SendDiagnosticsToMyStats();
                break;
            case TrayCommand.ApplyUpdate:
                _log?.Info("update: restart requested from the tray");
                var updates = _updates;
                if (updates is not null) _ = Task.Run(() => updates.ApplyPendingNowAsync());
                break;
            case TrayCommand.Reopen:
                _ = ReopenAsync();
                break;
            case TrayCommand.Quit:
                Shutdown();
                break;
        }
    }

    /// <summary>
    /// Accepts the browser's shared secret through a masked, one-way paste
    /// dialog and writes it through the app's existing settings store.
    ///
    /// <para>The stored value is deliberately never read into the dialog: the
    /// prompt receives only whether it is replacing a saved credential. No log
    /// line contains the pasted value, and a save failure reports only the
    /// exception type.</para>
    /// </summary>
    private void PairDesktopWithMyStats()
    {
        var settingsStore = _settingsStore;
        if (settingsStore is null) return;

        try
        {
            var replacingExisting = !string.IsNullOrWhiteSpace(settingsStore.Read().RankSampleSecret);
            var pastedSecret = RankSampleSecretDialog.Prompt(replacingExisting);
            if (pastedSecret is null) return;

            settingsStore.SetRankSampleSecret(pastedSecret);
            _tray?.ShowBalloon(
                "CoachBuild My Stats",
                "Desktop pairing saved. Ranked LP capture will use it at the next capture point.");
        }
        catch (Exception error)
        {
            _log?.Error(
                "rank-sample-pairing-save",
                $"rank-sample: desktop pairing could not be saved ({error.GetType().Name})");
            WpfMessageBox.Show(
                "CoachBuild could not save the desktop pairing. Please try again.",
                "My Stats pairing",
                MessageBoxButton.OK,
                MessageBoxImage.Error);
        }
    }

    /// <summary>
    /// Uploads the tail of companion.log to My Stats, because the user asked
    /// for it from the tray.
    ///
    /// <para><b>Every route out of here is visible.</b> A diagnostics button
    /// that can be pressed and produce nothing is the exact failure mode that
    /// makes people stop trusting one -- and the user pressing it is on a
    /// machine they cannot copy a file off, so "look in the log" is not a
    /// recovery for them. There are three outcomes and all three say something:
    /// an acknowledgement on the click, a balloon on success, and a MODAL on
    /// every failure.</para>
    ///
    /// <para><b>Why a modal for failures specifically.</b> Windows suppresses
    /// balloon tips under focus assist, which a fullscreen game turns on. The
    /// one case that must never be swallowed is therefore the one case that
    /// does not use a balloon. A modal is also the honest shape for a failure:
    /// it names the next action and waits to be acknowledged, and the click
    /// that opened the tray already took the foreground.</para>
    ///
    /// <para>It cannot disturb a game beyond that. Nothing here touches
    /// <c>_overlay</c>; adjust mode ends only on Enter, Escape or a tray
    /// cancel, and there is no deactivation handler for a dialog to trip.</para>
    /// </summary>
    private void SendDiagnosticsToMyStats()
    {
        if (_services is not IDiagnosticsUploadHost host)
        {
            // The inert host. Reported rather than ignored: from the tray this
            // is indistinguishable from a broken button.
            ReportDiagnosticsOutcome(DiagnosticsUploadOutcome.Failed);
            return;
        }

        // The upload can take an LCU read plus a 5 s HTTP timeout. Without this
        // the click looks dead for as long as it takes.
        _tray?.ShowBalloon(DiagnosticsMessages.Title, "Sending your companion log to My Stats…");
        host.SendDiagnostics(outcome =>
            Dispatcher.BeginInvoke(new Action(() => ReportDiagnosticsOutcome(outcome))));
    }

    /// <summary>
    /// One outcome, one message. The wording lives in
    /// <see cref="DiagnosticsMessages"/> (pure, in Core, tested) so the balloon
    /// and the modal cannot come to describe the same outcome differently, and
    /// so the "not paired" sentence keeps naming the tray item that fixes it.
    /// The companion.log line is written by the service, not here.
    /// </summary>
    private void ReportDiagnosticsOutcome(DiagnosticsUploadOutcome outcome)
    {
        if (_isShuttingDown) return;
        var text = DiagnosticsMessages.Text(outcome);
        if (DiagnosticsMessages.IsSuccess(outcome))
        {
            _tray?.ShowBalloon(DiagnosticsMessages.Title, text);
            return;
        }
        WpfMessageBox.Show(
            text,
            DiagnosticsMessages.Title,
            MessageBoxButton.OK,
            MessageBoxImage.Warning);
    }

    /// <summary>
    /// Takes the user to <c>companion.log</c> in File Explorer, with the file
    /// selected.
    ///
    /// <para><b>The path comes from the log instance that is writing</b>
    /// (<see cref="RedactedLog.FilePath"/>), not from a second copy of
    /// <c>%LOCALAPPDATA%\CoachBuild\companion.log</c>. The two derivations in
    /// this app — <see cref="DesktopPaths.LogFile"/> and the one inside
    /// <see cref="RedactedLog"/> — agree today and a test pins that they do,
    /// but only one of them is the file the app appends to, and that is the one
    /// this opens.</para>
    ///
    /// <para><b>It cannot disturb a game.</b> Explorer takes the foreground —
    /// the tray click already had it — but it is not a topmost window, and the
    /// overlay is, so it cannot cover it. Adjust mode ends only on Enter,
    /// Escape or a tray cancel; there is no deactivation handler for an
    /// Explorer window to trip. Nothing here touches <c>_overlay</c>.</para>
    /// </summary>
    private void OpenLogFolder()
    {
        var path = _log?.FilePath ?? Paths.LogFile;
        _log?.Info(new LogFolderRevealer().Reveal(path));
    }

    private void OnAdjustmentStateChanged(bool adjusting)
    {
        if (_isShuttingDown) return;
        _trayState = _trayState with { IsAdjusting = adjusting };
        _tray?.UpdateState(_trayState);
    }

    /// <summary>
    /// Ends the browser that champ select opened, now that the player is in the
    /// game and only the skill-order overlay matters.
    ///
    /// <para>2.1.2: this no longer closes the window synchronously. An import
    /// run is usually still in flight at load-in (the lock fires it, the
    /// game starts seconds later), and the old close aborted the Coachless
    /// walk mid-run. <see cref="WebView2Window.CloseForGameStart"/> hides
    /// the window now, lets the in-flight run finish and write, then closes.
    /// </para>
    ///
    /// <para>The teardown deliberately does <b>not</b> touch the updater beyond
    /// letting <see cref="OnWebViewClosed"/> run its normal course. That handler
    /// kicks a staged-apply retry, and in game that retry <b>must</b> be refused
    /// — by the write-sensitive busy gate, which is true twice over here
    /// (<c>_updateBusy</c> from this tick's <c>SetUpdateBusy</c>, and
    /// <c>CompanionState.IsCompanionBusy</c> from the InProgress phase). It
    /// never sets <c>_restartRequested</c>: only the user clicking the tray item
    /// may do that, because that latch is what overrides the window gate.</para>
    /// </summary>
    private void CloseCompanionWindowForGame()
    {
        var webView = _webView;
        if (webView is null) return;
        _log?.Info("window: closing the CoachBuild window for the game (WebView2 teardown)");
        webView.CloseForGameStart();
    }

    private void OnWebViewClosed(object? sender, EventArgs e)
    {
        var wasVisible = Volatile.Read(ref _webViewVisible) != 0;
        Volatile.Write(ref _webViewVisible, 0);
        Volatile.Write(ref _webViewUserOpened, 0);
        if (sender is WebView2Window closed && ReferenceEquals(_webView, closed))
        {
            closed.Closed -= OnWebViewClosed;
            _webView = null;
            (_services as CoreDesktopHostServices)?.OnCompanionWindowClosed();
            // The tray must not keep advertising the version of a window that
            // no longer exists (the game-start teardown closes it every match).
            _tray?.UpdateState(_trayState);
        }
        if (_isShuttingDown) return;
        SetUpdateBusy(IsUpdateBusyContext());
        // The window closing is the moment a restart stops being disruptive.
        // It is no longer part of the busy context, so nothing else would
        // notice; ask explicitly rather than wait for the next loop tick.
        var updates = _updates;
        if (updates is not null) _ = Task.Run(() => updates.RetryPendingApplyAsync());
        // Closing is also an idle moment worth checking at: the last check
        // may be up to 2 hours old and the cooldown keeps this to one hit.
        if (OpportunisticCheckPolicy.IsWindowCloseTransition(wasVisible, isVisible: false) && updates is not null)
            _ = Task.Run(() => updates.RequestOpportunisticCheckAsync(OpportunisticCheckTrigger.WindowClosed));
    }

    private bool IsUpdateBusyForService()
    {
        return Volatile.Read(ref _updateBusy) != 0 || _services.IsCompanionBusy;
    }

    /// <summary>
    /// Write-sensitive only: a restart here could tear an in-flight LCU write.
    /// The open CoachBuild window used to be part of this and must not be: the
    /// window is opened on every non-autostart launch, so including it made the
    /// app permanently ineligible to apply its own update, and whether an
    /// update landed came down to a race between the download and WebView2's
    /// window creation. Window visibility does not defer automatic updates:
    /// only active game phases and client writes hold the restart.
    /// </summary>
    private bool IsUpdateBusyContext()
    {
        return Volatile.Read(ref _snapshotBusy) != 0
            || Volatile.Read(ref _phaseBusy) != 0;
    }

    private void SetUpdateBusy(bool busy)
    {
        var next = busy ? 1 : 0;
        var previous = Interlocked.Exchange(ref _updateBusy, next);
        if (previous != next && !_isShuttingDown && Dispatcher.CheckAccess())
        {
            _trayState = _trayState with { IsCompanionBusy = busy };
            _tray?.UpdateState(_trayState);
        }
        if (previous == next || _updates is null) return;

        // Applying a staged update can invoke Velopack process work; keep it
        // off the dispatcher even though this snapshot was just projected here.
        _ = Task.Run(() => _updates.SetCompanionBusyAsync(busy));
    }

    /// <summary>
    /// The phases this app treats as write-sensitive on top of the ones
    /// <c>ComplianceRules.IsCompanionBusy</c> already covers (ChampSelect,
    /// InProgress, an in-flight LCU write).
    ///
    /// <para>Public because it is half of an invariant that has to be assertable:
    /// every phase <see cref="CompanionWindowPolicy.IsInGame"/> tears the window
    /// down in must still be busy in one of the two tables, or the teardown
    /// would hand the updater a restart mid-match. See
    /// <c>CompanionWindowPolicyTests</c>.</para>
    /// </summary>
    public static bool IsBusyPhase(CompanionPhase phase)
    {
        return phase is CompanionPhase.Matchmaking or CompanionPhase.ReadyCheck or CompanionPhase.Reconnect;
    }

    /// <summary>
    /// Every caller of this is the user: the tray Reopen item, and the launch
    /// path (<c>ShouldOpenWebViewOnLaunch</c> is false only for the Windows
    /// autostart run, so a window from here means someone started the app by
    /// hand). Windows opened this way survive load-in.
    /// </summary>
    private async Task ReopenAsync()
    {
        await OpenTargetAsync(_trayState.GetReopenTarget(), userInitiated: true).ConfigureAwait(true);
    }

    private async Task OpenTargetAsync(ReopenTarget target, bool userInitiated)
    {
        if (_isShuttingDown) return;
        // The LATEST open decides ownership, and it is written on every open —
        // not only when a window is created. Both directions matter:
        //
        //   * champ select navigating an existing window to the draft page makes
        //     it champ select's window, so a hand-launch an hour earlier is not
        //     treated as a standing request to keep a browser running through the
        //     game that follows (this is the common case: the app is launched
        //     once and left alone, so a create-only write would tear nothing down
        //     for exactly the user this fix is for);
        //   * bringing it forward from the tray adopts it, so a window the user
        //     has since asked for is not taken away at load-in.
        Volatile.Write(ref _webViewUserOpened, userInitiated ? 1 : 0);

        var window = _webView;
        var created = window is null;
        if (window is null)
        {
            var environment = _webViewEnvironment;
            if (environment is null)
            {
                await Dispatcher.InvokeAsync(SetWebViewUnavailable).Task.ConfigureAwait(false);
                return;
            }
            var runtimeAvailable = await environment
                .IsRuntimeAvailableAsync(_shutdown.Token)
                .ConfigureAwait(false);
            if (_isShuttingDown) return;

            // The preference snapshot is READ at creation and written back
            // through the store's merge path, never held as a second copy: the
            // store is the one that knows how to fold a tab/zoom change into a
            // settings document that also carries calibration and the account
            // secret (OverlaySettingsStore.Save serialises the whole modelled
            // type, so a blind overwrite from here would drop them).
            var preferenceStore = _settingsStore as ICompanionTabsPreferencesStore;
            window = await Dispatcher.InvokeAsync(() =>
            {
                if (_isShuttingDown) return (WebView2Window?)null;
                var coreServices = _services as CoreDesktopHostServices;
                var createdWindow = new WebView2Window(
                    environment,
                    AppOrigin,
                    SessionToken,
                    Paths.WebView2UserDataFolder,
                    OnWebViewRepairCompleted,
                    preferenceStore?.Read(),
                    preferenceStore is null ? null : preferenceStore.Save,
                    coreServices is null
                        ? null
                        : new Func<CancellationToken, Task<Uri?>>(coreServices.ResolveOpGgProfileAsync));
                if (coreServices is not null)
                {
                    // The automatic item import rides the window (the only
                    // place that may touch a WebView) and the bridge's
                    // item-set service. Attached, never constructed here, so
                    // a window without host services still opens.
                    createdWindow.AttachAutoImport(
                        coreServices.AutoImportItemSets,
                        coreServices.ChampionDirectory,
                        line => _log?.Info(line),
                        coreServices.AutoImportRunes,
                        coreServices.AutoImportProBuilds);
                }
                _webView = createdWindow;
                createdWindow.Closed += OnWebViewClosed;
                return createdWindow;
            }).Task.ConfigureAwait(false);
            if (window is null || _isShuttingDown) return;
            Volatile.Write(ref _webViewVisible, 1);
            SetUpdateBusy(IsUpdateBusyContext());

            if (!runtimeAvailable)
            {
                await Dispatcher.InvokeAsync(() =>
                {
                    if (_isShuttingDown || !ReferenceEquals(_webView, window)) return;
                    window.ShowRuntimeFallback(target);
                }).Task.ConfigureAwait(false);
                if (_isShuttingDown || !ReferenceEquals(_webView, window)) return;
                SetWebViewUnavailable();
                return;
            }
        }

        // Which of the two open paths runs is decided by WHO asked, and the
        // difference is the "never redirect a reader" rule from the tab design:
        //
        //   * The user (tray Reopen, a hand launch) gets OpenAsync, which shows
        //     the window on the tab they left it on. Restoring u.gg here is the
        //     point of remembering it.
        //   * Champ select and the web-freshness check get OpenCompanionAsync,
        //     which loads/refreshes the hosted page but leaves the SELECTED tab
        //     alone. On a brand-new window that lands on Companion (the draft
        //     page is why the window opened); on a window the user already has
        //     open on u.gg mid-champ-select it refreshes Companion underneath
        //     and does not yank the page they are reading out from under them.
        //     That path does not raise the window itself, so a newly created
        //     one is shown here.
        if (_isShuttingDown) return;
        var openOperation = userInitiated
            ? Dispatcher.InvokeAsync(new Func<Task>(() =>
                _isShuttingDown || !ReferenceEquals(_webView, window)
                    ? Task.CompletedTask
                    : window!.OpenAsync(target)))
            : Dispatcher.InvokeAsync(new Func<Task>(async () =>
            {
                if (_isShuttingDown || !ReferenceEquals(_webView, window)) return;
                if (created)
                {
                    window!.Show();
                    window.Activate();
                }
                await window!.OpenCompanionAsync(target).ConfigureAwait(true);
            }));
        await openOperation.Task.Unwrap().ConfigureAwait(false);
    }

    private async Task RepairWebView2Async()
    {
        var result = _webViewEnvironment is { } environment
            ? await environment.RepairAsync(_shutdown.Token).ConfigureAwait(false)
            : new RepairResult(false, null, false, TimeSpan.Zero);
        OnWebViewRepairCompleted(result);
    }

    private void OnWebViewRepairCompleted(RepairResult result)
    {
        LogWebView2Repair(result);
        if (_isShuttingDown) return;

        if (Dispatcher.CheckAccess())
        {
            ApplyWebView2RepairResult(result);
            return;
        }

        Dispatcher.BeginInvoke(
            () => ApplyWebView2RepairResult(result),
            DispatcherPriority.Background);
    }

    private void ApplyWebView2RepairResult(RepairResult result)
    {
        _trayState = _trayState with
        {
            WebView2Available = result.IsSuccess
                ? WebView2Availability.Available
                : WebView2Availability.Missing,
        };
        _tray?.UpdateState(_trayState);
    }

    private async Task ProbeWebView2AvailabilityAsync(CancellationToken cancellationToken)
    {
        if (_webViewEnvironment is null) return;

        try
        {
            var version = _webViewEnvironment.AvailableVersion;
            var available = !string.IsNullOrWhiteSpace(version);
            LogWebView2Probe(_webViewEnvironment, version);
            await Dispatcher.InvokeAsync(() =>
            {
                if (_isShuttingDown) return;
                _trayState = _trayState with
                {
                    WebView2Available = available
                        ? WebView2Availability.Available
                        : WebView2Availability.Missing,
                };
                _tray?.UpdateState(_trayState);
            });
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
        }
        catch
        {
            // A failed probe is not proof that the runtime is missing. Keep
            // the tray in Unknown so Repair cannot flash before a verdict.
        }
    }

    private void LogWebView2Probe(WebView2EnvironmentService environment, string? version)
    {
        var available = !string.IsNullOrWhiteSpace(version);
        var state = available ? 1 : 0;
        if (Interlocked.Exchange(ref _lastWebView2ProbeState, state) == state) return;

        if (available)
        {
            _log?.Info($"webview2 probe: available {version}");
            return;
        }

        var message = $"webview2 probe: missing ({environment.LastProbeFailure ?? "unknown"})";
        if (environment.LastProbeFailure is not null && !environment.LastProbeFailureWasRuntimeNotFound)
            _log?.Error("webview2-probe", message, throttle: TimeSpan.Zero);
        else
            _log?.Info(message);
    }

    private void LogWebView2Repair(RepairResult result)
    {
        if (result.IsSuccess)
        {
            var exit = result.ExitCode?.ToString(CultureInfo.InvariantCulture) ?? "none";
            _log?.Info($"webview2 repair: ok in {FormatElapsed(result.Elapsed)}s (exit={exit})");
            return;
        }

        var failureExit = RepairResult.FormatExitCode(result.ExitCode);
        var probe = _webViewEnvironment?.LastProbeFailure ?? "none";
        _log?.Info($"webview2 repair: FAILED exit={failureExit} bootstrapperFound={result.BootstrapperFound} elapsed={FormatElapsed(result.Elapsed)}s probe={probe}");
    }

    private static string FormatElapsed(TimeSpan elapsed)
    {
        return elapsed.TotalSeconds.ToString("0.0", CultureInfo.InvariantCulture);
    }

    private void SetWebViewUnavailable()
    {
        _trayState = _trayState with { WebView2Available = WebView2Availability.Missing };
        _tray?.UpdateState(_trayState);
        _tray?.ShowBalloon("CoachBuild", "WebView2 is required. Use Repair WebView2 runtime from the tray.", System.Windows.Forms.ToolTipIcon.Warning);
    }

    protected override void OnExit(ExitEventArgs e)
    {
        if (_isShuttingDown)
        {
            base.OnExit(e);
            return;
        }

        _isShuttingDown = true;
        _shutdown.Cancel();
        SystemEvents.PowerModeChanged -= OnPowerModeChanged;

        // Close UI resources synchronously before waiting on background work.
        // This prevents a canceled dispatcher task from leaving a ghost tray
        // icon or a topmost overlay behind during process teardown.
        var webView = _webView;
        if (webView is not null) webView.Closed -= OnWebViewClosed;
        _webView = null;
        webView?.Close();
        _overlay?.Close();
        _hotkeys?.Dispose();
        _hotkeys = null;
        _tray?.Dispose();
        try { _companionMutex?.ReleaseMutex(); } catch { }
        _companionMutex?.Dispose();

        var shutdownTasks = new List<Task>();
        try
        {
            shutdownTasks.Add(Services.StopAsync(CancellationToken.None));
            if (_pollTask is not null) shutdownTasks.Add(_pollTask);
            if (_updates is not null) shutdownTasks.Add(_updates.DisposeAsync().AsTask());
        }
        catch
        {
            // Shutdown is best-effort. UI resources and the mutex are already
            // released before this bounded wait.
        }

        try
        {
            Task.WhenAll(shutdownTasks).Wait(TimeSpan.FromSeconds(2));
        }
        catch
        {
            // Do not keep the WPF dispatcher alive indefinitely during quit.
        }

        if (_overlay is not null) _overlay.AdjustmentStateChanged -= OnAdjustmentStateChanged;
        if (_services is ILiveOverlayPushSource push) push.OverlayStateChanged -= OnLiveOverlayPush;
        _shutdown.Dispose();
        base.OnExit(e);
    }
}

/// <summary>
/// Production adapter for the lane-a Core services. It keeps the loopback
/// bridge, LCU/gameflow poller, and Live Client Data workers off WPF's
/// dispatcher while exposing only immutable UI snapshots to App.
/// </summary>
public sealed class CoreDesktopHostServices : IDesktopHostServices, IDesktopHostLifecycle, ILaneOverrideHostServices, ILiveOverlayPushSource, IDiagnosticsUploadHost, IAsyncDisposable
{
    private readonly object _gate = new();
    private readonly CompanionState _state;
    private readonly LcuCredentialResolver _credentials;
    private readonly LcuHttpClient _lcu;
    private readonly LiveClientDataClient _live;
    private readonly CoreSkillOrderProvider _skillOrders;
    private readonly IChampionDirectory _champions;
    private readonly bool _ownsChampions;
    private readonly RedactedLog _log;
    private readonly CompanionHttpServer _bridge;
    private readonly WindowDecisionService _windowDecisions;
    private readonly GameflowPoller _gameflow;
    private readonly LivePollingCoordinator _livePolling;
    private readonly RankCaptureService _rankCapture;
    private readonly LaneScoreService _laneScores;
    private readonly IRankSampleSink _rankSink;
    private readonly DiagnosticsUploadService _diagnostics;
    /// <summary>The one client this instance built, if it built one. Disposed on teardown.</summary>
    private readonly CancellationTokenSource _stop = new();
    private Task? _gameflowTask;
    private Task? _liveTask;
    private bool _started;
    private bool _stopped;
    private LiveLocalIdentity? _localIdentity;
    // Which game this is. Read off allgamedata, which the poller already
    // fetches every 3 s, and printed once per game plus into the kit-anomaly
    // line. Nothing read this field's source before 1.0.20, which is why the
    // 2026-08-19 Kennen anomaly could not be tested against "the mode granted
    // a point" - see KitAnomalyLine.
    private LiveGameMode? _gameMode;
    private string? _lastGameModeLine;

    private int? _championId;
    private ChampionIdSource _championIdSource = ChampionIdSource.None;
    private string? _championName;
    private string? _championRawKey;
    private string? _championDisplayName;
    // The champion the LCU watched us lock in, captured ONLY on a
    // ChampSelect -> InProgress transition this instance actually saw.
    // Exact and network-free, but it says what was picked rather than what
    // is on screen, so it is a fallback behind the roster lookup.
    private int? _champSelectChampionId;
    private string? _detectedPosition;
    private string? _laneOverride;
    private LiveSkillState? _skill;
    // Consecutive unanswered activeplayer polls. The only thing that
    // distinguishes "the player has not levelled" from "2999 is gone".
    private int _skillMisses;
    private string? _skillOrderKey;
    private CoreSkillOrderResult? _skillOrder;
    private string? _skillOrderLane;
    private bool _skillOrderLaneIsAuto = true;
    // Retry bookkeeping for a FAILED skill-order fetch. Without it, one
    // transient network failure at load-in latched the overlay blank for the
    // whole match: the key was already stored, so every later tick
    // short-circuited and nothing ever asked again. Since v1.0.6 removed the
    // message panel, that failure is also completely silent on screen.
    private DateTimeOffset? _skillOrderRetryAt;
    private int _skillOrderAttempts;
    private Task? _skillOrderFetch;

    // 1.0.8: both schedules must clear SkillOrderProvider's OWN failure
    // cooldown, or the retry is served the cached failure and burns an attempt
    // without touching the network. 1.0.7 retried at 3 s and 8 s against a 15 s
    // error cooldown, so the first two attempts were guaranteed no-ops even
    // once the retry armed at all.
    private static readonly TimeSpan[] SkillOrderErrorBackoff =
    [
        TimeSpan.FromSeconds(20),
        TimeSpan.FromSeconds(45),
        TimeSpan.FromSeconds(90),
    ];

    // NoData is a verdict, not a failure: the endpoint answered and said this
    // champion+lane has no published order. One confirmation past the 60 s
    // no-data cooldown is enough — anything more is hammering a healthy
    // endpoint for an answer it already gave.
    private static readonly TimeSpan[] SkillOrderNoDataBackoff =
    [
        TimeSpan.FromSeconds(75),
    ];

    private string? _lastOverlayPhase;
    private readonly TimeProvider _time;
    private readonly LiveReachabilityReporter _reachability;
    private string? _lastIdentityLine;
    private string? _lastChampionLine;
    private string? _lastOverlayInputReason;
    private Task? _championDirectoryFetch;
    private bool _championDirectoryLoading;

    public CoreDesktopHostServices(
        string sessionToken,
        string logDirectory,
        CoreSkillOrderProvider? skillOrders = null,
        IEnumerable<int>? bridgePorts = null,
        RedactedLog? log = null,
        HttpMessageHandler? liveHandler = null,
        TimeProvider? timeProvider = null,
        LiveClientDataOptions? liveOptions = null,
        IChampionDirectory? championDirectory = null,
        // Where the shared account secret comes from. Null means "there is no
        // secret", which makes LP capture INERT rather than unauthenticated --
        // see RankSampleClient's remarks and HANDOFF-lp-capture.md.
        Func<string?>? rankSampleSecret = null,
        // Test seam. Production always builds a RankSampleClient against the
        // real origin; a test that wanted one would need a socket.
        IRankSampleSink? rankSampleSink = null,
        // The other half of the same seam. Production leaves BOTH null and one
        // RankSampleClient serves both POSTs; see the construction below.
        IDiagnosticsSink? diagnosticsSink = null,
        RankCaptureOptions? rankCaptureOptions = null,
        Func<int, int, CancellationToken, Task<SkillOrderResult>>? skillOrderFetch = null,
        // --lane-score-demo. Fabricated card, writes nothing, reachable only by
        // typing the exact flag; see CommandLineOptions.LaneScoreDemo.
        bool laneScoreDemo = false,
        // Test seam: a store over a temp directory. Production writes to
        // %LOCALAPPDATA%\CoachBuild\lane-scores.json, next to companion.log.
        LaneScoreStore? laneScoreStore = null)
    {
        if (!SessionTokenStore.IsValid(sessionToken))
            throw new ArgumentException("A valid persistent session token is required.", nameof(sessionToken));

        _state = new CompanionState();
        _log = log ?? new RedactedLog(logDirectory);
        _time = timeProvider ?? TimeProvider.System;
        _credentials = new LcuCredentialResolver(diagnosticSink: message => _log.Info(message));
        _lcu = new LcuHttpClient(_credentials);
        _live = new LiveClientDataClient(liveOptions, liveHandler);
        _reachability = new LiveReachabilityReporter(_live.Port);
        _live.ProbeObserved = probe =>
        {
            if (_reachability.Observe(probe) is { } line) _log.Info(line);
        };
        _windowDecisions = new WindowDecisionService(
            sessionToken,
            attachments: _state.FollowAttachments);
        _laneScores = new LaneScoreService(
            _lcu,
            laneScoreStore ?? new LaneScoreStore(Path.Combine(logDirectory, LaneScoreStore.FileName)),
            _log,
            _time,
            demo: laneScoreDemo,
            // The NON-YANKING open, and the reason this is a callback rather
            // than a direct call: Core does not know what a window is, and the
            // host already routes PageRequested through OpenTargetAsync with
            // userInitiated:false -- which refreshes the hosted page underneath
            // whatever tab the user is reading instead of dragging them off it.
            // A scoring prompt is the least urgent thing this app does; it does
            // not get to steal focus. If they ignore it the game stays on disk
            // and the card is waiting next time.
            prompt: () => PageRequested?.Invoke(
                new ReopenTarget(ReopenDestination.Draft, null, null)));
        _bridge = new CompanionHttpServer(
            sessionToken,
            _state,
            _lcu,
            _live,
            skillOrders: skillOrders,
            skillOrderFetch: skillOrderFetch,
            credentials: _credentials,
            log: _log,
            ports: bridgePorts,
            laneScores: _laneScores);
        _skillOrders = _bridge.SkillOrderProvider;
        // Hosted collection is retired; injection remains for contract replay tests.
        _rankSink = rankSampleSink ?? RetiredHostedSink.Instance;
        _rankCapture = new RankCaptureService(
            _lcu,
            _rankSink,
            rankSampleSink is null && diagnosticsSink is null ? (static () => null) : rankSampleSecret ?? (static () => null),
            _log,
            _time,
            rankCaptureOptions);
        // The log PATH comes from the log instance that is actually writing,
        // never from a second derivation of %LOCALAPPDATA%\CoachBuild -- the
        // same argument App.OpenLogFolder makes. Note it is only ever READ
        // here; RedactedLog.Discarding remains the write-side default that
        // BridgeLogIsolationTests guards.
        _diagnostics = new DiagnosticsUploadService(
            _lcu,
            diagnosticsSink ?? RetiredHostedSink.Instance,
            rankSampleSink is null && diagnosticsSink is null ? (static () => null) : rankSampleSecret ?? (static () => null),
            () => _log.FilePath,
            _log);
        _gameflow = new GameflowPoller(
            _credentials,
            _lcu,
            _state,
            _windowDecisions,
            _log,
            // Fire-and-forget by construction. The gameflow loop drives champ
            // select; nothing it calls may take time, and Fire() returns before
            // the first LCU byte is sent.
            rankCapture: trigger =>
            {
                _rankCapture.Fire(trigger, _stop.Token);
                // Same moment, same fire-and-forget contract. Reusing this
                // callback rather than adding a second one keeps ONE definition
                // of "a game ended" -- RankCaptureService.LeftGame, which counts
                // Reconnect as still in-game so a mid-game drop is not mistaken
                // for the end. That predicate matters more than it looks: the
                // app's own log shows every game on this machine finishing
                // InProgress -> Reconnect -> None and never touching
                // PreEndOfGame or EndOfGame at all, so a trigger written against
                // those two phase names would simply never fire.
                if (trigger == RankCaptureTrigger.GameEnd) _laneScores.FireGameEnd(_stop.Token);
            });
        // Live Client Data names the local player's champion; /api/skill-order
        // is keyed by numeric id. Nothing bridged that gap before 1.0.11.
        _ownsChampions = championDirectory is null;
        _champions = championDirectory ?? new ChampionDirectory(timeProvider: _time);
        _livePolling = new LivePollingCoordinator(
            _live,
            _state,
            allGameData: CaptureAllGameData,
            playerList: CapturePlayerList,
            skills: CaptureSkills,
            activePlayerName: CaptureActivePlayerName,
            identityMissing: () => { lock (_gate) return _localIdentity is null; });
    }

    public event Action<ReopenTarget>? PageRequested;

    /// <summary>The lane-score feature, exposed so tests can drive a capture without a socket.</summary>
    public LaneScoreService LaneScoreService => _laneScores;

    /// <inheritdoc />

    public event Action<OverlayState?>? OverlayStateChanged;

    /// <summary>
    /// The mode captured off the last allgamedata body. Exposed rather than
    /// pushed because only one caller wants it, and only when something has
    /// already gone wrong.
    /// </summary>
    public LiveGameMode? CurrentGameMode
    {
        get { lock (_gate) return _gameMode; }
    }

    public int BridgePort => _bridge.Port;

    public CompanionState State => _state;

    /// <summary>
    /// Resolves the account-specific op.gg destination through the bridge-owned
    /// LCU client. Null is intentional: the window opens op.gg home whenever
    /// League is closed or either identity field is unavailable.
    /// </summary>
    public Task<Uri?> ResolveOpGgProfileAsync(CancellationToken cancellationToken) =>
        new OpGgProfileResolver(_lcu).ResolveAsync(cancellationToken);

    /// <summary>
    /// The bridge's item-set service for the window's automatic import.
    /// </summary>
    public ItemSetApplyService AutoImportItemSets => _bridge.ItemSetApplyService;

    /// <summary>
    /// The bridge's rune service for the automatic u.gg and Coachless rune
    /// pages. Both use the same validated, capacity-aware owned-page writer.
    /// </summary>
    public RuneApplyService AutoImportRunes => _bridge.RuneApplyService;

    /// <summary>
    /// The probuildstats client for the automatic third ("Pro") rune page
    /// and item set (2.4.0). One app-lifetime <see cref="HttpClient"/>: the
    /// fetch is a plain GET of an SSR page, fully parallel with the worker
    /// fetches and sharing no browser core with them.
    /// </summary>
    public IProBuildsClient AutoImportProBuilds => _proBuilds;

    private readonly ProBuildsClient _proBuilds = new(ProBuildsClient.CreateHttpClient());

    /// <summary>
    /// The roster the auto-import resolves payload slugs through (by id, so
    /// site URL aliases like coachless's <c>wukong</c> redirect still meet
    /// the <c>MonkeyKing</c> context).
    /// </summary>
    public IChampionDirectory ChampionDirectory => _champions;

    public WindowDecisionService WindowDecisions => _windowDecisions;

    /// <summary>
    /// The CoachBuild window closed (game-start teardown or the user). Its page
    /// can no longer poll <c>/status</c>, so its last follow must stop counting
    /// as an attached window. Without this, a champ select within
    /// <see cref="CompanionWire.AttachWindowSeconds"/> of the close (a short
    /// practice game, a remake) opened no window and so imported nothing
    /// (field log 2026-09-11 10:41).
    /// </summary>
    public void OnCompanionWindowClosed()
    {
        _state.FollowAttachments.RecordDetach(FollowKind.Draft);
        _state.FollowAttachments.RecordDetach(FollowKind.Builds);
    }

    /// <summary>
    /// The Live Client Data workers. Exposed so a test can drive one tick
    /// deterministically instead of waiting on the 1 s/3 s/4 s production
    /// timers; production always goes through <see cref="StartAsync"/>.
    /// </summary>
    public LivePollingCoordinator LivePolling => _livePolling;

    /// <summary>
    /// The most recent skill-order fetch. Exposed so a test can settle the
    /// pipeline deterministically rather than sleeping; production never reads
    /// it. Before 1.0.8 this task was discarded outright, which is part of why
    /// a failed fetch left no handle and no trace anywhere.
    /// </summary>
    public Task? PendingSkillOrderFetch { get { lock (_gate) return _skillOrderFetch; } }

    /// <summary>
    /// The most recent champion-roster fetch. Exposed for the same reason as
    /// <see cref="PendingSkillOrderFetch"/>: a test settles the pipeline
    /// instead of sleeping. Production never reads it.
    /// </summary>
    public Task? PendingChampionDirectoryFetch { get { lock (_gate) return _championDirectoryFetch; } }

    /// <summary>The champion id the overlay is currently using, and where it came from.</summary>
    public (int? Id, ChampionIdSource Source) ResolvedChampion
    {
        get { lock (_gate) return (_championId, _championIdSource); }
    }

    public string? LaneOverride
    {
        get { lock (_gate) return _laneOverride; }
    }

    public bool IsCompanionBusy => _state.IsCompanionBusy;

    public void SetLaneOverride(string? lane)
    {
        var normalized = SkillOrderLaneResolver.NormalizeLane(lane);
        int? championId;
        string? detectedPosition;
        lock (_gate)
        {
            if (string.Equals(_laneOverride, normalized, StringComparison.Ordinal)) return;
            _laneOverride = normalized;
            _skillOrderKey = null;
            _skillOrder = null;
            _skillOrderLane = null;
            _skillOrderLaneIsAuto = normalized is null;
            championId = _championId;
            detectedPosition = _detectedPosition;
        }

        if (championId is > 0 && string.Equals(_state.Phase, "InProgress", StringComparison.Ordinal))
            RequestSkillOrderIfNeeded(championId.Value, detectedPosition);
    }

    public async Task StartAsync(CancellationToken cancellationToken)
    {
        lock (_gate)
        {
            if (_started) return;
            _started = true;
        }

        await _bridge.StartAsync(cancellationToken).ConfigureAwait(false);
        // Warm the champion roster at startup (2.3.5): the first champ
        // select after launch used to wait out the first lazy kick before a
        // hover could even be recognised. Retries itself; the lazy kick in
        // the champ-select path stays as the fallback.
        KickChampionDirectory();
        // Spec §5's first moment. Raised here rather than in the gameflow loop
        // because "the app just started" is the one transition the phase poller
        // cannot see: it observes None -> None and has nothing to compare.
        // Detached, so a client that is not running yet costs startup nothing.
        _rankCapture.Fire(RankCaptureTrigger.AppStart, _stop.Token);
        _gameflowTask = RunGameflowAsync(_stop.Token);
        _liveTask = RunLivePollingAsync(_stop.Token);
    }

    /// <summary>
    /// The most recent LP capture, for tests to settle on. Production never
    /// reads it — see <see cref="RankCaptureService.PendingCapture"/>.
    /// </summary>
    public Task? PendingRankCapture => _rankCapture.PendingCapture;

    /// <summary>
    /// Uploads the tail of companion.log to My Stats, because the user clicked
    /// the tray item. Returns immediately; <paramref name="report"/> is invoked
    /// once on a thread-pool thread and the caller marshals it.
    ///
    /// <para>There is no other caller and there must not be one. See
    /// <see cref="DiagnosticsUploadService"/> on why an automatic upload is a
    /// different product.</para>
    /// </summary>
    public void SendDiagnostics(Action<DiagnosticsUploadOutcome>? report = null) =>
        _diagnostics.Fire(report, _stop.Token);

    /// <summary>
    /// The most recent diagnostics upload, for tests to settle on. Production
    /// never reads it -- see <see cref="DiagnosticsUploadService.PendingUpload"/>.
    /// </summary>
    public Task? PendingDiagnosticsUpload => _diagnostics.PendingUpload;

    public Task<DesktopPhaseSnapshot> ReadSnapshotAsync(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        CompanionStatus status = _state.ToStatus(_bridge.Port);
        LastOpenPage? lastOpen = null;
        if (status.LastOpen is { } open)
        {
            _ = DateTimeOffset.TryParse(open.At, out var openedAt);
            lastOpen = new LastOpenPage(open.ChampionId, open.RoleId, openedAt, ReopenDestination.Builds);
        }

        return Task.FromResult(new DesktopPhaseSnapshot(
            status.Phase,
            lastOpen,
            _state.IsCompanionBusy,
            status.LastError,
            BuildOverlayState(),
            BuildChampSelectContext(status.ChampSelect),
            _state.ClientConnected));
    }

    /// <summary>
    /// Projects the champ-select snapshot into the automatic-import context.
    ///
    /// <para><c>CompanionState.ToStatus</c> already returns null here for every
    /// phase but ChampSelect, so stale picks cannot trigger imports in game.</para>
    ///
    /// <para><b>Locked and hovered are both offered, and the difference is
    /// carried rather than flattened.</b> <c>cellChampionId</c> is the locked
    /// pick; <c>championPickIntent</c> is the hover. A hover is exactly when a
    /// player wants to read a champion's page — flattening the two would claim
    /// a pick that has not happened, and dropping the hover would withhold the
    /// page-change trigger at the only moment it changes a decision.</para>
    ///
    /// <para>Returns null when the roster has not loaded. That is deliberate:
    /// the link slug and display label both come from the roster entry. A bare
    /// id cannot safely form either, so no import is better than a wrong one.</para>
    /// </summary>
    private ChampSelectContext? BuildChampSelectContext(CompanionChampSelectSnapshot? champSelect)
    {
        if (champSelect is null) return null;
        var locked = champSelect.CellChampionId is > 0;
        // The LCU wire uses 0 as the "not selected" sentinel. The normal
        // resolver already strips it, but this boundary also receives state
        // restored by tests and older bridge payloads, so choose the first
        // positive candidate rather than letting a zero suppress a valid hover
        // or in-progress action.
        int? championId = champSelect.CellChampionId is > 0
            ? champSelect.CellChampionId
            : champSelect.PickIntent is > 0
                ? champSelect.PickIntent
                : champSelect.ActionChampionId is > 0
                    ? champSelect.ActionChampionId
                    : null;
        if (championId is not > 0) return null;

        var roster = _champions.Cached;
        if (roster is null)
        {
            // Champ select is the first surface that needs the roster on a
            // fresh launch. The in-game player-list path also warms it, but
            // waiting for that path means a first game's offer can never
            // appear before the phase is cleared at load-in.
            KickChampionDirectory();
            return null;
        }
        var champion = roster.FirstOrDefault(entry => entry.Id == championId.Value);
        if (champion is null) return null;

        return new ChampSelectContext(
            champion.Id,
            champion.Key,
            champion.Name,
            champSelect.RoleId,
            locked);
    }

    public Task<bool> RepairWebView2Async(CancellationToken cancellationToken)
    {
        // App owns the WebView2 environment/bootstrapper. The host service
        // keeps this method for injectable test hosts and returns false by
        // default rather than launching anything off-policy.
        cancellationToken.ThrowIfCancellationRequested();
        return Task.FromResult(false);
    }

    /// <summary>
    /// The LCU gameflow loop, at a cadence that follows the phase.
    ///
    /// <para>Champ select gets <see cref="LivePollingCoordinator.ChampSelectGameflowPollMs"/>
    /// because that is the one phase where the user changes something several
    /// times a second and then looks at the app for the answer; Lane B measured
    /// this 1500 ms tick as the remaining floor under an otherwise ~0.1-0.8 s
    /// web path. Every other phase keeps 1500 ms - the LCU is shared with the
    /// client itself and there is nothing outside champ select that moves
    /// faster than a person can notice.</para>
    ///
    /// <para>Not a <c>PeriodicTimer</c> any more: its interval is fixed at
    /// construction, so it cannot express "faster while picking".</para>
    /// </summary>
    private async Task RunGameflowAsync(CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            try
            {
                var decision = await _gameflow.TickAsync(cancellationToken).ConfigureAwait(false);
                if (decision is { Kind: WindowDecisionKind.OpenDraft })
                {
                    PageRequested?.Invoke(new ReopenTarget(
                        ReopenDestination.Draft,
                        decision.ChampionId,
                        decision.RoleId));
                }
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception error)
            {
                _state.SetLastError(error.Message);
            }

            try
            {
                await Task.Delay(GameflowDelayForPhase(_state.Phase), cancellationToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                break;
            }
        }
    }

    /// <summary>The delay after a tick that observed <paramref name="phase"/>.</summary>
    internal static TimeSpan GameflowDelayForPhase(string? phase) => TimeSpan.FromMilliseconds(
        string.Equals(phase, "ChampSelect", StringComparison.Ordinal)
            ? LivePollingCoordinator.ChampSelectGameflowPollMs
            : LivePollingCoordinator.GameflowPollMs);

    private async Task RunLivePollingAsync(CancellationToken cancellationToken)
    {
        try
        {
            await _livePolling.RunAsync(cancellationToken).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
        }
        catch (Exception error)
        {
            _state.SetLastError($"live polling failed: {error.GetType().Name}");
        }
    }

    private void CaptureAllGameData(JsonElement data)
    {
        // Before the activePlayer gate on purpose: a body that fails to publish
        // an identity still names the mode, and a game whose identity never
        // resolves is exactly a game whose mode is worth knowing.
        CaptureGameMode(data);
        if (data.ValueKind != JsonValueKind.Object || !data.TryGetProperty("activePlayer", out var active)) return;
        // Through 1.0.10 this read activePlayer.riotId and nothing else, so a
        // client build that publishes the parts (riotIdGameName +
        // riotIdTagLine) but not the whole string left the pipeline with no
        // identity at all and no way to say so.
        var identity = LiveLocalPlayerResolver.ReadActivePlayer(active);
        if (identity is null) return;
        lock (_gate) _localIdentity = LiveLocalPlayerResolver.Merge(_localIdentity, identity);
    }

    /// <summary>
    /// Names the mode once per game, and holds it for the kit-anomaly line.
    ///
    /// <para>Deduped on the rendered line rather than fired per poll: this runs
    /// every 3 s for a whole game, and a log that repeats the same fact 300
    /// times is a log nobody reads to the end of. Reset on the phase
    /// transition alongside the champion, so a second game in one session
    /// prints its own line rather than inheriting the first game's.</para>
    /// </summary>
    private void CaptureGameMode(JsonElement data)
    {
        var mode = LiveGameModeReader.TryRead(data);
        if (mode is null) return;

        string line;
        lock (_gate)
        {
            _gameMode = mode;
            line = $"live: {mode.Describe()}";
            if (string.Equals(_lastGameModeLine, line, StringComparison.Ordinal)) return;
            _lastGameModeLine = line;
        }
        _log?.Info(line);
    }

    /// <summary>
    /// Last-resort identity, polled only while allgamedata has produced none.
    /// </summary>
    private void CaptureActivePlayerName(JsonElement value)
    {
        var identity = LiveLocalPlayerResolver.ReadActivePlayerName(value);
        if (identity is null) return;
        lock (_gate)
        {
            if (_localIdentity is not null) return;
            _localIdentity = identity;
        }
        _log?.Info("live: identity taken from activeplayername (allgamedata published none)");
    }

    private void CapturePlayerList(JsonElement data)
    {
        if (data.ValueKind != JsonValueKind.Array) return;
        LiveLocalIdentity? identity;
        lock (_gate) identity = _localIdentity;

        var match = LiveLocalPlayerResolver.Match(data, identity);
        if (match is null)
        {
            // Name what was compared. 1.0.10 logged only that the match failed,
            // which cannot separate "activeplayer published no identity" from
            // "the two endpoints spell it differently" from "the schema moved".
            // The values are masked because RedactedLog rewrites anything
            // Riot-ID shaped anyway - see LiveLocalIdentity.Describe.
            ReportIdentity(identity is null
                ? $"live: identity unknown (activeplayer published no riotId/gameName/summonerName); playerlist {LiveLocalPlayerResolver.Describe(data)}"
                : $"live: identity unmatched (me {identity.Describe()}; tried riotId,gameName+tag,gameName,summonerName,sole-entry; playerlist {LiveLocalPlayerResolver.Describe(data)})");
            return;
        }

        var champion = LiveLocalPlayerResolver.ReadChampion(match.Player);
        lock (_gate)
        {
            if (champion.PreferredName is { } preferred) _championName = preferred;
            if (champion.RawKey is not null) _championRawKey = champion.RawKey;
            if (champion.DisplayName is not null) _championDisplayName = champion.DisplayName;
            if (!string.IsNullOrWhiteSpace(champion.Position)) _detectedPosition = champion.Position;
        }

        ReportIdentity($"live: identity matched by {match.MatchedBy}");
        ResolveChampionIdIfNeeded();
    }

    /// <summary>
    /// Turns the champion NAME Live Client Data publishes into the numeric id
    /// /api/skill-order is keyed by.
    ///
    /// <para>This is the step 1.0.10 did not have. It read a
    /// <c>championId</c> property straight off the player-list entry - a field
    /// Riot has never published - so the id was null for every champion in
    /// every game and the skill order was never requested at all.</para>
    ///
    /// <para>Rungs, strongest first: the locale-independent
    /// <c>rawChampionName</c> against the roster key, the localised
    /// <c>championName</c> against the roster display name, then the champion
    /// the LCU saw locked in during the champ select this game came out of.
    /// The roster wins over champ select when both answer, because the player
    /// list states what is actually on screen.</para>
    /// </summary>
    private void ResolveChampionIdIfNeeded()
    {
        string? rawKey;
        string? displayName;
        string? name;
        int? current;
        int? lockedIn;
        ChampionIdSource source;
        lock (_gate)
        {
            rawKey = _championRawKey;
            displayName = _championDisplayName;
            name = _championName;
            current = _championId;
            source = _championIdSource;
            lockedIn = _champSelectChampionId;
        }
        if (rawKey is null && displayName is null) return;
        // A name-resolved id is ground truth for this game. Stop asking.
        if (current is > 0 && source is ChampionIdSource.RawChampionName or ChampionIdSource.ChampionName)
            return;

        var roster = _champions.Cached;
        if (roster is not null)
        {
            var (resolved, resolvedSource) = ChampionIdLookup.Resolve(roster, rawKey, displayName);
            if (resolved is > 0)
            {
                PublishChampionId(resolved.Value, resolvedSource);
                return;
            }
            ReportChampion(
                $"live: champion \"{name ?? "?"}\" is not in the roster ({roster.Count.ToString(CultureInfo.InvariantCulture)} entries)");
        }
        else
        {
            KickChampionDirectory();
        }

        // Nothing from the roster yet. Champ select's id gets the overlay
        // drawing on the first tick; if the roster later disagrees, the key
        // changes and the skill order is refetched for the right champion.
        if (current is not > 0 && lockedIn is > 0)
            PublishChampionId(lockedIn.Value, ChampionIdSource.ChampSelect);
    }

    private void PublishChampionId(int championId, ChampionIdSource source)
    {
        string? name;
        string? position;
        lock (_gate)
        {
            _championId = championId;
            _championIdSource = source;
            name = _championName;
            position = _detectedPosition;
        }

        // Separates matrix row 7 ("2999 answered but the local player's identity
        // never resolved") from row 6 ("2999 never answered"), and now also says
        // WHICH rung produced the id - so a wrong overlay is traceable to a rung
        // rather than to the whole pipeline.
        ReportChampion(
            $"live: champion={name ?? "none"} id={championId.ToString(CultureInfo.InvariantCulture)} via={source} position={position ?? "none"}");

        if (string.Equals(_state.Phase, "InProgress", StringComparison.Ordinal))
            RequestSkillOrderIfNeeded(championId, position);
    }

    /// <summary>
    /// Starts at most one roster fetch. The task is started OUTSIDE the state
    /// lock: in production the first await is the socket, so the continuation
    /// never runs under the lock, and a test double that completes
    /// synchronously must not be the one path that does.
    /// </summary>
    private void KickChampionDirectory()
    {
        lock (_gate)
        {
            if (_championDirectoryLoading) return;
            _championDirectoryLoading = true;
        }
        var fetch = LoadChampionDirectoryAsync();
        lock (_gate) _championDirectoryFetch = fetch;
    }

    private async Task LoadChampionDirectoryAsync()
    {
        var loaded = false;
        try
        {
            var roster = await _champions.LoadAsync(_stop.Token).ConfigureAwait(false);
            if (roster is null)
            {
                // Deliberately not latched: ChampionDirectory backs off, and the
                // 4 s player-list tick and the 750 ms snapshot tick both re-enter
                // here, so a blip at load-in cannot blank the match.
                ReportChampion($"live: champion roster unavailable ({_champions.LastFailure ?? "unknown"}); will retry");
            }
            else
            {
                ReportChampion($"live: champion roster loaded ({roster.Count.ToString(CultureInfo.InvariantCulture)} entries)");
                loaded = true;
            }
        }
        catch (OperationCanceledException)
        {
        }
        catch (Exception error)
        {
            ReportChampion($"live: champion roster failed ({error.GetType().Name}); will retry");
        }
        finally
        {
            lock (_gate) _championDirectoryLoading = false;
        }

        if (loaded) ResolveChampionIdIfNeeded();
    }

    private void RequestSkillOrderIfNeeded(int championId, string? detectedPosition)
    {
        string? laneOverride;
        string? key;
        lock (_gate)
        {
            laneOverride = _laneOverride;
            var detectedLane = SkillOrderLaneResolver.MapPositionToLane(detectedPosition);
            key = laneOverride is not null
                ? $"{championId}:manual:{laneOverride}"
                : detectedLane is not null
                    ? $"{championId}:auto:{detectedLane}"
                    : $"{championId}:auto-fallback";
            if (string.Equals(_skillOrderKey, key, StringComparison.Ordinal))
            {
                // Same key: normally nothing to do. The ONE exception is a
                // previous attempt that did not return Ok and whose backoff has
                // elapsed — otherwise a single blip at load-in blanks the
                // overlay for the rest of the game with no way for the user to
                // recover short of switching lane.
                //
                // `not Ok`, not `Error`: NoData latched exactly the same way,
                // and a NoData produced by the auto-fallback path before the
                // Live Client Data position arrived could never be revisited.
                var retryDue = _skillOrder is { Status: not CoreSkillOrderStatus.Ok }
                    && _skillOrderRetryAt is { } due
                    && _time.GetUtcNow() >= due;
                if (!retryDue) return;
                _skillOrderRetryAt = null;
                _log?.Info($"skill-order: champion {championId} retrying (attempt {_skillOrderAttempts + 1})");
            }
            else
            {
                _skillOrderKey = key;
                _skillOrder = null;
                _skillOrderAttempts = 0;
                _skillOrderRetryAt = null;
                _skillOrderLane = laneOverride ?? detectedLane;
                _skillOrderLaneIsAuto = laneOverride is null;
            }
        }

        var fetch = FetchSkillOrderAsync(championId, laneOverride, detectedPosition, key);
        lock (_gate) _skillOrderFetch = fetch;
    }

    private async Task FetchSkillOrderAsync(
        int championId,
        string? laneOverride,
        string? detectedPosition,
        string key)
    {
        try
        {
            var selection = await SkillOrderLaneResolver.ResolveAsync(
                    _skillOrders,
                    championId,
                    laneOverride,
                    detectedPosition,
                    _stop.Token)
                .ConfigureAwait(false);

            TimeSpan? scheduled = null;
            int attempt;
            var recoveredAfter = 0;
            lock (_gate)
            {
                if (!string.Equals(_skillOrderKey, key, StringComparison.Ordinal)) return;

                _skillOrder = selection.Result;
                _skillOrderLane = selection.Lane;
                _skillOrderLaneIsAuto = selection.IsLaneAuto;
                attempt = _skillOrderAttempts;

                if (selection.Result.Status == CoreSkillOrderStatus.Ok)
                {
                    recoveredAfter = _skillOrderAttempts;
                    _skillOrderRetryAt = null;
                    _skillOrderAttempts = 0;
                }
                else
                {
                    // THE 1.0.7 BUG. Every realistic failure on this path
                    // arrives as a VALUE, never an exception:
                    // SkillOrderProvider.FetchAsync ends in a bare catch and
                    // SkillOrderLaneResolver.GetSafelyAsync wraps a second one
                    // on top of it. 1.0.7 armed the backoff only from the
                    // `catch` below, so it never armed, so the retry it shipped
                    // never fired once — measured across seven injected failure
                    // modes, zero throws. The success branch then actively
                    // DISARMED the retry it was supposed to arm.
                    //
                    // Arm from the returned status. The exception path stays as
                    // belt and braces; nothing depends on it any more.
                    scheduled = ScheduleSkillOrderRetry(selection.Result.Status);
                }
            }

            if (selection.Result is { Status: not CoreSkillOrderStatus.Ok } bad)
            {
                _log?.Info(scheduled is { } backoff
                    ? $"skill-order: champion {championId} returned {bad.Status}; retry in {backoff.TotalSeconds:0}s (attempt {attempt + 1})"
                    : $"skill-order: champion {championId} returned {bad.Status}; no further retry");
            }
            else if (recoveredAfter > 0)
            {
                _log?.Info($"skill-order: champion {championId} recovered after {recoveredAfter} failed attempt(s)");
            }
        }
        catch (OperationCanceledException) when (_stop.IsCancellationRequested)
        {
            return;
        }
        catch (Exception error)
        {
            TimeSpan? backoff;
            int attempt;
            lock (_gate)
            {
                if (!string.Equals(_skillOrderKey, key, StringComparison.Ordinal)) return;
                _skillOrder = new CoreSkillOrderResult(
                    CoreSkillOrderStatus.Error,
                    CoreOverlaySkillOrder.Empty,
                    championId);
                _skillOrderLane = null;
                _skillOrderLaneIsAuto = laneOverride is null;
                attempt = _skillOrderAttempts;
                backoff = ScheduleSkillOrderRetry(CoreSkillOrderStatus.Error);
            }

            _log?.Error(
                "skill-order-fetch",
                backoff is { } delay
                    ? $"skill-order: champion {championId} fetch failed ({error.GetType().Name}); retry in {delay.TotalSeconds:0}s (attempt {attempt + 1})"
                    : $"skill-order: champion {championId} fetch failed ({error.GetType().Name}); no further retry");
        }
    }

    /// <summary>
    /// Arms the next retry for a non-Ok result and returns the delay, or null
    /// when the schedule for that status is exhausted. Caller must hold
    /// <c>_gate</c>.
    /// </summary>
    private TimeSpan? ScheduleSkillOrderRetry(CoreSkillOrderStatus status)
    {
        var schedule = status == CoreSkillOrderStatus.NoData
            ? SkillOrderNoDataBackoff
            : SkillOrderErrorBackoff;
        var attempt = _skillOrderAttempts;
        if (attempt >= schedule.Length)
        {
            _skillOrderRetryAt = null;
            return null;
        }

        var backoff = schedule[attempt];
        _skillOrderAttempts = attempt + 1;
        _skillOrderRetryAt = _time.GetUtcNow() + backoff;
        return backoff;
    }

    /// <summary>
    /// Records one activeplayer read - including one that did not answer - and,
    /// when the live skill state actually moved, pushes a fresh overlay state
    /// immediately rather than waiting for the next 750 ms snapshot.
    ///
    /// <para>The push is gated on a real change, so a healthy game produces
    /// about 36 of them (one per level-up and one per point spent) rather than
    /// four a second. Cost at rest is unchanged; latency at the only moments
    /// that matter drops by the whole snapshot interval.</para>
    /// </summary>
    private void CaptureSkills(LiveSkillState? skill)
    {
        var changed = false;
        var dropped = false;
        lock (_gate)
        {
            if (skill is null)
            {
                _skillMisses++;
                // Silence is a verdict once it lasts. Holding the last snapshot
                // for the rest of time is what let a finished game keep an
                // overlay on screen; dropping it turns that into a hide with a
                // reason attached.
                if (_skillMisses >= LivePollingCoordinator.SkillMissesBeforeDrop && _skill is not null)
                {
                    _skill = null;
                    dropped = true;
                }
            }
            else
            {
                _skillMisses = 0;
                changed = _skill is null
                    || _skill.Level != skill.Level
                    || !_skill.Abilities.Equals(skill.Abilities);
                _skill = skill;
            }
        }

        if (dropped)
        {
            _log?.Info(
                $"live: skill feed silent for {LivePollingCoordinator.SkillMissesBeforeDrop} polls; dropping the retained snapshot");
        }

        if (!changed && !dropped) return;
        if (!string.Equals(_state.Phase, "InProgress", StringComparison.Ordinal)) return;
        PublishOverlayState();
    }

    /// <summary>
    /// Projects and raises the current overlay state on the push seam. Never
    /// throws into the poll loop that called it.
    /// </summary>
    private void PublishOverlayState()
    {
        var sink = OverlayStateChanged;
        if (sink is null) return;
        try { sink(ProjectOverlayState()); }
        catch { /* A diagnostic push must never break the poll it rides on. */ }
    }

    /// <summary>
    /// The 750 ms snapshot projection: phase bookkeeping first, then the same
    /// projection the fast push path uses.
    /// </summary>
    private OverlayState? BuildOverlayState()
    {
        ObservePhaseForOverlay();
        return ProjectOverlayState();
    }

    /// <summary>
    /// Resets the per-game state on ENTERING and on LEAVING a live game.
    ///
    /// <para>1.0.11 reset only on entry, which is enough for correctness of the
    /// NEXT game and not enough for the end of THIS one: every champion, skill
    /// order and skill snapshot from the finished match stayed loaded until the
    /// next one started. Combined with a window that was hidden rather than
    /// cleared, that is exactly how the user's log shows a highlight being
    /// re-asserted two minutes after the game ended.</para>
    ///
    /// <para>Only called by the snapshot poll, which is the one caller that
    /// owns phase transitions; the push path must never race it here.</para>
    /// </summary>
    private void ObservePhaseForOverlay()
    {
        var phase = _state.Phase;
        var lockedInChampionId = _windowDecisions.LastOpenedChampionId;
        lock (_gate)
        {
            var entering = !string.Equals(_lastOverlayPhase, phase, StringComparison.Ordinal)
                && string.Equals(phase, "InProgress", StringComparison.Ordinal);
            var leaving = !string.Equals(_lastOverlayPhase, phase, StringComparison.Ordinal)
                && string.Equals(_lastOverlayPhase, "InProgress", StringComparison.Ordinal);
            if (entering || leaving)
            {
                // Adopt champ select's champion ONLY when this instance saw
                // the champ select that produced this game.
                // LastOpenedChampionId is not cleared when a match ends, so
                // on any other entry into InProgress (app started mid-game,
                // custom game, reconnect) it is a stale champion from an
                // earlier queue, and confidently wrong beats blank only for
                // whoever wrote the code.
                _champSelectChampionId = entering
                    && string.Equals(_lastOverlayPhase, "ChampSelect", StringComparison.Ordinal)
                    && lockedInChampionId is > 0
                        ? lockedInChampionId
                        : null;
                _championId = null;
                _championIdSource = ChampionIdSource.None;
                _championName = null;
                _championRawKey = null;
                _championDisplayName = null;
                _detectedPosition = null;
                _skill = null;
                _skillMisses = 0;
                _skillOrderKey = null;
                _skillOrder = null;
                _skillOrderLane = null;
                _skillOrderLaneIsAuto = true;
                _lastIdentityLine = null;
                _lastChampionLine = null;
                _lastOverlayInputReason = null;
                _gameMode = null;
                _lastGameModeLine = null;
            }
            _lastOverlayPhase = phase;
        }
    }

    /// <summary>
    /// The overlay state as it is right now, with no phase-transition side
    /// effects. Safe to call from the live poll as well as the snapshot poll.
    /// </summary>
    private OverlayState? ProjectOverlayState()
    {
        var phase = _state.Phase;
        if (!string.Equals(phase, "InProgress", StringComparison.Ordinal)) return null;

        LiveSkillState? skill;
        int? championId;
        string? champion;
        string? position;
        CoreSkillOrderResult? skillOrderResult;
        string? skillOrderLane;
        bool skillOrderLaneIsAuto;
        lock (_gate)
        {
            skill = _skill;
            championId = _championId;
            champion = _championName;
            position = _detectedPosition;
            skillOrderResult = _skillOrder;
            skillOrderLane = _skillOrderLane;
            skillOrderLaneIsAuto = _skillOrderLaneIsAuto;
        }
        // Heartbeat the null path. In 1.0.7 an InProgress game whose live
        // inputs never arrived produced NO overlay: line at all, which is the
        // same evidence as "the snapshot poll is dead" and "2999 is
        // unreachable". Naming the missing input collapses that three-way
        // ambiguity to one answer.
        if (skill is null)
        {
            ReportOverlayInput("waiting-live-skill (activeplayer has not produced level+QWER)");
            return null;
        }
        if (string.IsNullOrWhiteSpace(champion))
        {
            ReportOverlayInput("waiting-champion (playerlist has not matched the local player; see the live: identity line)");
            return null;
        }

        if (championId is > 0)
        {
            ReportOverlayInput("live inputs ready");
            RequestSkillOrderIfNeeded(championId.Value, position);
        }
        else
        {
            // The champion is known by NAME and still has no id. That was
            // permanently true before 1.0.11 and logged as nothing at all;
            // now it is a named state, and this tick is one of the two things
            // that keeps retrying it for the whole early-game window.
            ReportOverlayInput("waiting-champion-id (champion name known, numeric id not resolved yet)");
            ResolveChampionIdIfNeeded();
        }

        lock (_gate)
        {
            skillOrderResult = _skillOrder;
            skillOrderLane = _skillOrderLane;
            skillOrderLaneIsAuto = _skillOrderLaneIsAuto;
        }

        var ranks = new Dictionary<OverlayAbility, int>
        {
            [OverlayAbility.Q] = skill.Abilities.Q,
            [OverlayAbility.W] = skill.Abilities.W,
            [OverlayAbility.E] = skill.Abilities.E,
            [OverlayAbility.R] = skill.Abilities.R,
        };
        var snapshot = new LiveClientDataSkillSnapshot(skill.Level, ranks);
        var skillOrder = skillOrderResult is { Status: CoreSkillOrderStatus.Ok } result
            ? OverlaySkillOrder.FromTokens(
                result.Order.Order,
                result.Order.ObservedLevels,
                result.Order.Completed,
                result.Order.CompletionBasis)
            : OverlaySkillOrder.Empty;
        var resolvedChampionId = skillOrderResult is { ChampionId: > 0 } resolved
            ? resolved.ChampionId
            : championId;
        return OverlayStateAdapter.FromLiveSnapshot(
            snapshot,
            champion,
            championId: resolvedChampionId,
            skillOrder: skillOrder,
            lane: skillOrderLane,
            laneIsAuto: skillOrderLaneIsAuto);
    }

    /// <summary>
    /// One deduped line per transition, sharing the `overlay:` prefix the
    /// window's own render decision uses so a single grep tells the whole
    /// story of why nothing is on screen.
    /// </summary>
    /// <summary>One deduped line per change of identity-resolution outcome.</summary>
    private void ReportIdentity(string line)
    {
        lock (_gate)
        {
            if (string.Equals(_lastIdentityLine, line, StringComparison.Ordinal)) return;
            _lastIdentityLine = line;
        }
        _log?.Info(line);
    }

    /// <summary>
    /// One deduped line per change of champion-id outcome. Kept on its own
    /// slot rather than sharing the identity slot, or two alternating states
    /// would each re-log every 4 s poll and drown the file they exist to
    /// make readable.
    /// </summary>
    private void ReportChampion(string line)
    {
        lock (_gate)
        {
            if (string.Equals(_lastChampionLine, line, StringComparison.Ordinal)) return;
            _lastChampionLine = line;
        }
        _log?.Info(line);
    }

    private void ReportOverlayInput(string reason)
    {
        lock (_gate)
        {
            if (string.Equals(_lastOverlayInputReason, reason, StringComparison.Ordinal)) return;
            _lastOverlayInputReason = reason;
        }
        _log?.Info($"overlay: {reason}");
    }

    public async Task StopAsync(CancellationToken cancellationToken)
    {
        lock (_gate)
        {
            if (_stopped) return;
            _stopped = true;
        }
        _stop.Cancel();
        try
        {
            if (_gameflowTask is not null) await _gameflowTask.ConfigureAwait(false);
            if (_liveTask is not null) await _liveTask.ConfigureAwait(false);
        }
        catch (OperationCanceledException) { }
        await _bridge.DisposeAsync().ConfigureAwait(false);
        if (_ownsChampions && _champions is IDisposable disposableChampions)
            disposableChampions.Dispose();
        _live.Dispose();
        _lcu.Dispose();
        _stop.Dispose();
    }

    public async ValueTask DisposeAsync()
    {
        await StopAsync(CancellationToken.None).ConfigureAwait(false);
    }
}
