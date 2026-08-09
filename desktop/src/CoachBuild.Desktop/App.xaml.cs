global using System.IO;
global using System.Net.Http;

using System.Security.Cryptography;
using System.Text;
using System.Globalization;
using System.Windows;
using System.Windows.Threading;
using System.Text.Json;
using CoachBuild.Core;
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

public sealed record DesktopPhaseSnapshot(
    string? Phase,
    LastOpenPage? LastOpen = null,
    bool IsCompanionBusy = false,
    string? Error = null,
    OverlayState? Overlay = null);

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
    public const string AppOrigin = "https://coachbuild.vercel.app";

    private readonly CancellationTokenSource _shutdown = new();
    private Mutex? _companionMutex;
    private TrayController? _tray;
    private OverlayWindow? _overlay;
    private WebView2Window? _webView;
    private WebView2EnvironmentService? _webViewEnvironment;
    private RedactedLog? _log;
    private VelopackUpdateService? _updates;
    private Task? _pollTask;
    private TrayMenuState _trayState = TrayMenuState.Default;
    private IDesktopHostServices _services = new NullDesktopHostServices();
    private int _snapshotBusy;
    private int _phaseBusy;
    private int _webViewVisible;
    private int _updateBusy;
    private int _lastWebView2ProbeState = -1;
    private bool _isShuttingDown;

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

        if (_services is NullDesktopHostServices)
        {
            var nativeServices = new CoreDesktopHostServices(SessionToken, Paths.Root, log: _log);
            nativeServices.PageRequested += OnNativePageRequested;
            _services = nativeServices;
        }

        _tray = new TrayController(Dispatcher, Path.Combine(AppContext.BaseDirectory, "Assets", "tray-icon.ico"));
        _tray.CommandRequested += OnTrayCommand;

        _overlay = new OverlayWindow(new OverlaySettingsStore(Paths.SettingsFile));
        _overlay.AdjustmentStateChanged += OnAdjustmentStateChanged;
        if (_services is ILaneOverrideHostServices laneOverrideServices)
            laneOverrideServices.SetLaneOverride(_overlay.LaneOverrideSetting);
        _trayState = _trayState with
        {
            OverlayVisible = _overlay.OverlayVisibleSetting,
            ShowSkillTable = _overlay.ShowSkillTableSetting,
            LaneOverride = _overlay.LaneOverrideSetting,
        };
        _overlay.Hide();
        _tray.Start(_trayState);
        _webViewEnvironment = new WebView2EnvironmentService(Paths.WebView2UserDataFolder);
        _ = ProbeWebView2AvailabilityAsync(_shutdown.Token);
        _updates = new VelopackUpdateService(isCompanionBusy: IsUpdateBusyForService);
        _updates.StatusChanged += OnUpdateStatusChanged;
        _ = _updates.StartAsync(_shutdown.Token);
        if (_services is IDesktopHostLifecycle lifecycle)
            _ = Task.Run(() => lifecycle.StartAsync(_shutdown.Token));
        _pollTask = PollAsync(_shutdown.Token);
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
                await Dispatcher.InvokeAsync(() => ApplySnapshot(snapshot), DispatcherPriority.Background, cancellationToken);
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

    private void ApplySnapshot(DesktopPhaseSnapshot snapshot)
    {
        var phase = TrayMenuState.ParsePhase(snapshot.Phase);
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

        if (snapshot.Overlay is not null)
        {
            _overlay?.ApplyState(snapshot.Overlay);
            if (_trayState.OverlayVisible) _overlay?.ShowInactive();
        }
        else if (phase is not CompanionPhase.InProgress)
        {
            _overlay?.Hide();
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
        }, DispatcherPriority.Background);
    }

    private void OnNativePageRequested(ReopenTarget target)
    {
        if (_isShuttingDown) return;
        Dispatcher.BeginInvoke(() => _ = OpenTargetAsync(target), DispatcherPriority.Background);
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
            case TrayCommand.ToggleSkillTable:
                _trayState = _trayState with { ShowSkillTable = !_trayState.ShowSkillTable };
                _overlay?.SetShowSkillTable(_trayState.ShowSkillTable);
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
            case TrayCommand.Reopen:
                _ = ReopenAsync();
                break;
            case TrayCommand.Quit:
                Shutdown();
                break;
        }
    }

    private void OnAdjustmentStateChanged(bool adjusting)
    {
        if (_isShuttingDown) return;
        _trayState = _trayState with { IsAdjusting = adjusting };
        _tray?.UpdateState(_trayState);
    }

    private void OnWebViewClosed(object? sender, EventArgs e)
    {
        Volatile.Write(ref _webViewVisible, 0);
        if (sender is WebView2Window closed && ReferenceEquals(_webView, closed))
        {
            closed.Closed -= OnWebViewClosed;
            _webView = null;
        }
        if (_isShuttingDown) return;
        SetUpdateBusy(IsUpdateBusyContext());
    }

    private bool IsUpdateBusyForService()
    {
        return Volatile.Read(ref _updateBusy) != 0 || _services.IsCompanionBusy;
    }

    private bool IsUpdateBusyContext()
    {
        return Volatile.Read(ref _snapshotBusy) != 0
            || Volatile.Read(ref _phaseBusy) != 0
            || Volatile.Read(ref _webViewVisible) != 0;
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

    private static bool IsBusyPhase(CompanionPhase phase)
    {
        return phase is CompanionPhase.Matchmaking or CompanionPhase.ReadyCheck or CompanionPhase.Reconnect;
    }

    private async Task ReopenAsync()
    {
        await OpenTargetAsync(_trayState.GetReopenTarget()).ConfigureAwait(true);
    }

    private async Task OpenTargetAsync(ReopenTarget target)
    {
        if (_webView is null)
        {
            var runtimeAvailable = _webViewEnvironment is not null
                && await _webViewEnvironment.IsRuntimeAvailableAsync(_shutdown.Token).ConfigureAwait(false);
            if (_webViewEnvironment is null)
            {
                await Dispatcher.InvokeAsync(SetWebViewUnavailable).Task.ConfigureAwait(false);
                return;
            }

            await Dispatcher.InvokeAsync(() => _webView = new WebView2Window(
                _webViewEnvironment,
                AppOrigin,
                SessionToken,
                Paths.WebView2UserDataFolder,
                OnWebViewRepairCompleted)).Task.ConfigureAwait(false);
            _webView!.Closed += OnWebViewClosed;
            Volatile.Write(ref _webViewVisible, 1);
            SetUpdateBusy(IsUpdateBusyContext());

            if (!runtimeAvailable)
            {
                await Dispatcher.InvokeAsync(() => _webView!.ShowRuntimeFallback(target)).Task.ConfigureAwait(false);
                SetWebViewUnavailable();
                return;
            }
        }

        var openOperation = Dispatcher.InvokeAsync(new Func<Task>(() => _webView!.OpenAsync(target)));
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

        // Close UI resources synchronously before waiting on background work.
        // This prevents a canceled dispatcher task from leaving a ghost tray
        // icon or a topmost overlay behind during process teardown.
        var webView = _webView;
        if (webView is not null) webView.Closed -= OnWebViewClosed;
        _webView = null;
        webView?.Close();
        _overlay?.Close();
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
        _shutdown.Dispose();
        base.OnExit(e);
    }
}

/// <summary>
/// Production adapter for the lane-a Core services. It keeps the loopback
/// bridge, LCU/gameflow poller, and Live Client Data workers off WPF's
/// dispatcher while exposing only immutable UI snapshots to App.
/// </summary>
public sealed class CoreDesktopHostServices : IDesktopHostServices, IDesktopHostLifecycle, ILaneOverrideHostServices, IAsyncDisposable
{
    private readonly object _gate = new();
    private readonly CompanionState _state;
    private readonly LcuCredentialResolver _credentials;
    private readonly LcuHttpClient _lcu;
    private readonly LiveClientDataClient _live;
    private readonly CoreSkillOrderProvider _skillOrders;
    private readonly RedactedLog _log;
    private readonly CompanionHttpServer _bridge;
    private readonly WindowDecisionService _windowDecisions;
    private readonly GameflowPoller _gameflow;
    private readonly LivePollingCoordinator _livePolling;
    private readonly CancellationTokenSource _stop = new();
    private Task? _gameflowTask;
    private Task? _liveTask;
    private bool _started;
    private bool _stopped;
    private string? _localRiotId;
    private int? _championId;
    private string? _championName;
    private string? _detectedPosition;
    private string? _laneOverride;
    private LiveSkillState? _skill;
    private string? _skillOrderKey;
    private CoreSkillOrderResult? _skillOrder;
    private string? _skillOrderLane;
    private bool _skillOrderLaneIsAuto = true;
    private string? _lastOverlayPhase;

    public CoreDesktopHostServices(
        string sessionToken,
        string logDirectory,
        CoreSkillOrderProvider? skillOrders = null,
        IEnumerable<int>? bridgePorts = null,
        RedactedLog? log = null)
    {
        if (!SessionTokenStore.IsValid(sessionToken))
            throw new ArgumentException("A valid persistent session token is required.", nameof(sessionToken));

        _state = new CompanionState();
        _log = log ?? new RedactedLog(logDirectory);
        _credentials = new LcuCredentialResolver(diagnosticSink: message => _log.Info(message));
        _lcu = new LcuHttpClient(_credentials);
        _live = new LiveClientDataClient();
        _windowDecisions = new WindowDecisionService(
            sessionToken,
            attachments: _state.FollowAttachments);
        _bridge = new CompanionHttpServer(
            sessionToken,
            _state,
            _lcu,
            _live,
            skillOrders: skillOrders,
            credentials: _credentials,
            log: _log,
            ports: bridgePorts);
        _skillOrders = _bridge.SkillOrderProvider;
        _gameflow = new GameflowPoller(
            _credentials,
            _lcu,
            _state,
            _windowDecisions,
            _log);
        _livePolling = new LivePollingCoordinator(
            _live,
            _state,
            allGameData: CaptureAllGameData,
            playerList: CapturePlayerList,
            skills: CaptureSkills);
    }

    public event Action<ReopenTarget>? PageRequested;

    public int BridgePort => _bridge.Port;

    public CompanionState State => _state;

    public WindowDecisionService WindowDecisions => _windowDecisions;

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
        _gameflowTask = RunGameflowAsync(_stop.Token);
        _liveTask = RunLivePollingAsync(_stop.Token);
    }

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
            BuildOverlayState()));
    }

    public Task<bool> RepairWebView2Async(CancellationToken cancellationToken)
    {
        // App owns the WebView2 environment/bootstrapper. The host service
        // keeps this method for injectable test hosts and returns false by
        // default rather than launching anything off-policy.
        cancellationToken.ThrowIfCancellationRequested();
        return Task.FromResult(false);
    }

    private async Task RunGameflowAsync(CancellationToken cancellationToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromMilliseconds(LivePollingCoordinator.GameflowPollMs));
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
                if (!await timer.WaitForNextTickAsync(cancellationToken).ConfigureAwait(false)) break;
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                break;
            }
        }
    }

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
        if (data.ValueKind != JsonValueKind.Object || !data.TryGetProperty("activePlayer", out var active)) return;
        if (active.ValueKind != JsonValueKind.Object || !active.TryGetProperty("riotId", out var riotId)) return;
        if (riotId.ValueKind != JsonValueKind.String) return;
        var value = riotId.GetString()?.Trim();
        if (string.IsNullOrWhiteSpace(value)) return;
        lock (_gate) _localRiotId = value;
    }

    private void CapturePlayerList(JsonElement data)
    {
        if (data.ValueKind != JsonValueKind.Array) return;
        string? localId;
        lock (_gate) localId = _localRiotId;
        if (string.IsNullOrWhiteSpace(localId)) return;

        var championId = LivePlayerListResolver.ResolveOwnChampionId(data, localId);

        foreach (var player in data.EnumerateArray())
        {
            if (player.ValueKind != JsonValueKind.Object ||
                !player.TryGetProperty("riotId", out var riotId) ||
                !string.Equals(riotId.GetString(), localId, StringComparison.Ordinal)) continue;

            string? champion = null;
            if (player.TryGetProperty("rawChampionName", out var raw) && raw.ValueKind == JsonValueKind.String)
            {
                champion = raw.GetString();
                const string prefix = "game_character_displayname_";
                if (champion?.StartsWith(prefix, StringComparison.Ordinal) == true)
                    champion = champion[prefix.Length..];
            }
            if (string.IsNullOrWhiteSpace(champion) && player.TryGetProperty("championName", out var name))
                champion = name.ValueKind == JsonValueKind.String ? name.GetString() : null;
            var position = player.TryGetProperty("position", out var positionValue) && positionValue.ValueKind == JsonValueKind.String
                ? positionValue.GetString()
                : null;
            string? effectivePosition;
            lock (_gate)
            {
                _championId = championId;
                _championName = string.IsNullOrWhiteSpace(champion) ? _championName : champion;
                _detectedPosition = string.IsNullOrWhiteSpace(position) ? _detectedPosition : position;
                effectivePosition = _detectedPosition;
            }

            if (championId is > 0 && string.Equals(_state.Phase, "InProgress", StringComparison.Ordinal))
                RequestSkillOrderIfNeeded(championId.Value, effectivePosition);
            break;
        }
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
            if (string.Equals(_skillOrderKey, key, StringComparison.Ordinal)) return;
            _skillOrderKey = key;
            _skillOrder = null;
            _skillOrderLane = laneOverride ?? detectedLane;
            _skillOrderLaneIsAuto = laneOverride is null;
        }

        _ = FetchSkillOrderAsync(championId, laneOverride, detectedPosition, key);
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

            lock (_gate)
            {
                if (string.Equals(_skillOrderKey, key, StringComparison.Ordinal))
                {
                    _skillOrder = selection.Result;
                    _skillOrderLane = selection.Lane;
                    _skillOrderLaneIsAuto = selection.IsLaneAuto;
                }
            }
        }
        catch (OperationCanceledException) when (_stop.IsCancellationRequested)
        {
            return;
        }
        catch
        {
            lock (_gate)
            {
                if (string.Equals(_skillOrderKey, key, StringComparison.Ordinal))
                {
                    _skillOrder = new CoreSkillOrderResult(
                        CoreSkillOrderStatus.Error,
                        CoreOverlaySkillOrder.Empty,
                        championId);
                    _skillOrderLane = null;
                    _skillOrderLaneIsAuto = laneOverride is null;
                }
            }
        }
    }

    private void CaptureSkills(LiveSkillState skill)
    {
        lock (_gate) _skill = skill;
    }

    private OverlayState? BuildOverlayState()
    {
        var phase = _state.Phase;
        lock (_gate)
        {
            if (!string.Equals(_lastOverlayPhase, phase, StringComparison.Ordinal)
                && string.Equals(phase, "InProgress", StringComparison.Ordinal))
            {
                _championId = null;
                _championName = null;
                _detectedPosition = null;
                _skill = null;
                _skillOrderKey = null;
                _skillOrder = null;
                _skillOrderLane = null;
                _skillOrderLaneIsAuto = true;
            }
            _lastOverlayPhase = phase;
        }
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
        if (skill is null || string.IsNullOrWhiteSpace(champion)) return null;
        if (championId is > 0)
            RequestSkillOrderIfNeeded(championId.Value, position);

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
        _live.Dispose();
        _lcu.Dispose();
        _stop.Dispose();
    }

    public async ValueTask DisposeAsync()
    {
        await StopAsync(CancellationToken.None).ConfigureAwait(false);
    }
}
