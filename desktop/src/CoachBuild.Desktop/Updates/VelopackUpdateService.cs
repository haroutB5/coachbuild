using System.Reflection;

namespace CoachBuild.Desktop.Updates;

public sealed record AvailableUpdate(string Version, object NativeUpdate);

public interface IUpdateClient
{
    Task<AvailableUpdate?> CheckForUpdatesAsync(CancellationToken cancellationToken);

    Task DownloadUpdatesAsync(AvailableUpdate update, CancellationToken cancellationToken);

    Task ApplyUpdatesAndRestartAsync(AvailableUpdate update, CancellationToken cancellationToken);

    /// <summary>
    /// The installed version, when the host can report one. Used to refuse an
    /// apply that would not move the app forward, which is the only thing
    /// standing between a bad feed entry and a restart loop.
    /// </summary>
    string? CurrentVersion => null;

    /// <summary>
    /// A release already downloaded into the local package store by a previous
    /// run and still waiting for a restart, or null. Nothing in Velopack's
    /// startup path applies one of these on its own, so the app has to ask.
    /// </summary>
    AvailableUpdate? GetPendingRestartUpdate() => null;

    /// <summary>Why the client cannot update, when it cannot. Null when healthy.</summary>
    string? UnavailableReason => null;
}

/// <summary>
/// What the check loop should do on this tick. Pure so the schedule is testable
/// without a clock: the loop itself only turns wall time into a decision.
/// </summary>
public enum UpdateLoopAction
{
    Check,
    RetryPendingApply,
    Idle,
}

/// <summary>
/// Background update coordinator. Velopack owns release metadata, delta
/// selection, download staging, and transactional pending-update state; this
/// service owns the busy gate, the retry schedule, the tray projection and the
/// diagnostics.
/// </summary>
public sealed class VelopackUpdateService : IAsyncDisposable
{
    public static readonly TimeSpan DefaultCheckInterval = TimeSpan.FromHours(2);
    public static readonly TimeSpan DefaultApplyRetryInterval = TimeSpan.FromSeconds(60);

    private readonly IUpdateClient _client;
    private readonly Func<bool> _isCompanionBusy;
    private readonly Func<bool> _isRestartDisruptive;
    private readonly Action<string>? _diagnostics;
    private readonly TimeSpan _checkInterval;
    private readonly TimeSpan _applyRetryInterval;
    private readonly TimeProvider _time;
    private readonly SemaphoreSlim _operation = new(1, 1);
    private readonly CancellationTokenSource _shutdown = new();
    private AvailableUpdate? _pending;
    private Task? _loop;
    private bool _started;
    private int _busy;
    private bool _restartRequested;
    private string? _lastDeferralLogged;
    private UpdateTrayModel _model = UpdateTrayModel.None;

    public VelopackUpdateService(
        IUpdateClient? client = null,
        Func<bool>? isCompanionBusy = null,
        TimeSpan? checkInterval = null,
        Func<bool>? isRestartDisruptive = null,
        Action<string>? diagnostics = null,
        TimeSpan? applyRetryInterval = null,
        TimeProvider? timeProvider = null,
        string? feedUrl = null)
    {
        _diagnostics = diagnostics;
        _client = client ?? new ReflectionVelopackUpdateClient(
            feedUrl ?? UpdateBootstrapper.ReleaseFeed,
            diagnostics);
        _isCompanionBusy = isCompanionBusy ?? (() => IsBusy);
        _isRestartDisruptive = isRestartDisruptive ?? (static () => false);
        _checkInterval = checkInterval ?? DefaultCheckInterval;
        _applyRetryInterval = applyRetryInterval ?? DefaultApplyRetryInterval;
        _time = timeProvider ?? TimeProvider.System;
    }

    public event EventHandler<UpdateTrayModel>? StatusChanged;

    public UpdateTrayModel Current => _model;

    public bool IsBusy => Volatile.Read(ref _busy) != 0;

    public AvailableUpdate? PendingUpdate => _pending;

    /// <summary>Exposed for tests; production drives this from <see cref="StartAsync"/>.</summary>
    public Task? LoopTask => _loop;

    public Task StartAsync(CancellationToken cancellationToken = default)
    {
        if (_started) return Task.CompletedTask;
        _started = true;
        _loop = CheckLoopAsync(cancellationToken);
        return Task.CompletedTask;
    }

    /// <summary>
    /// Applies a release that a previous run already downloaded. Belt-and-braces:
    /// VelopackApp.Run was measured auto-applying a newer local package at
    /// startup ("Auto apply is true, so restarting to apply update"), so this
    /// normally never fires. It covers the cases that path does not — an asset
    /// that is not the newest local one, or an install where the startup
    /// auto-apply is disabled — and unlike that path it leaves a line in
    /// companion.log saying so.
    /// </summary>
    public async Task ApplyStagedFromDiskAsync(CancellationToken cancellationToken = default)
    {
        AvailableUpdate? staged;
        try
        {
            staged = _client.GetPendingRestartUpdate();
        }
        catch (Exception error)
        {
            Log($"update: FAILED to read the staged release from disk: {Describe(error)}");
            return;
        }

        if (staged is null) return;

        var current = SafeCurrentVersion();
        if (!UpdateVersion.IsNewer(staged.Version, current))
        {
            Log($"update: staged release {staged.Version} is not newer than the installed {current ?? "unknown"}; not applying");
            return;
        }

        Log($"update: {staged.Version} was already downloaded by an earlier run; applying it now");
        await _operation.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            _pending = staged;
            SetModel(UpdateTrayModel.For(UpdateStatus.Ready, staged.Version));
            await ApplyPendingCoreAsync(cancellationToken).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception error)
        {
            Log($"update: FAILED to apply the staged {staged.Version}: {Describe(error)}");
            SetModel(UpdateTrayModel.For(UpdateStatus.Error, staged.Version, error.Message));
        }
        finally
        {
            _operation.Release();
        }
    }

    public async Task CheckNowAsync(CancellationToken cancellationToken = default)
    {
        await _operation.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            if (_client.UnavailableReason is { } unavailable)
            {
                Log($"update: cannot check for updates: {unavailable}");
                SetModel(UpdateTrayModel.For(UpdateStatus.Error, null, unavailable));
                return;
            }

            var current = SafeCurrentVersion();
            Log($"update: checking {UpdateBootstrapper.ReleaseMetadataUrl} (installed {current ?? "unknown"})");
            SetModel(UpdateTrayModel.For(UpdateStatus.Checking));
            var update = await _client.CheckForUpdatesAsync(cancellationToken).ConfigureAwait(false);
            if (update is null)
            {
                _pending = null;
                _lastDeferralLogged = null;
                Log($"update: no newer release on the feed (installed {current ?? "unknown"})");
                SetModel(UpdateTrayModel.For(UpdateStatus.None));
                return;
            }

            _pending = null;
            Log($"update: {update.Version} available; downloading");
            SetModel(UpdateTrayModel.For(UpdateStatus.Downloading, update.Version));
            await _client.DownloadUpdatesAsync(update, cancellationToken).ConfigureAwait(false);
            _pending = update;
            Log($"update: {update.Version} downloaded and staged");
            SetModel(UpdateTrayModel.For(UpdateStatus.Ready, update.Version));
            await ApplyPendingCoreAsync(cancellationToken).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception error)
        {
            Log($"update: FAILED during check/download: {Describe(error)}");
            SetModel(UpdateTrayModel.For(UpdateStatus.Error, _pending?.Version, error.Message));
        }
        finally
        {
            _operation.Release();
        }
    }

    /// <summary>
    /// The user asked for it explicitly (tray "Restart to update"). This
    /// overrides the restart-is-disruptive gate — the whole point of that gate
    /// is that the user has not asked — but not the write-sensitive gate, which
    /// exists so an in-flight LCU write is never torn in half.
    /// </summary>
    public async Task ApplyPendingNowAsync(CancellationToken cancellationToken = default)
    {
        await _operation.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            if (_pending is null)
            {
                Log("update: restart requested but nothing is staged");
                return;
            }

            // Latched, not dropped. The log line below promises the restart
            // will happen once the write clears, so the request has to outlive
            // this call — otherwise the user clicks, is told "soon", and
            // nothing ever happens because the window gate is still up.
            _restartRequested = true;

            if (IsBusy || _isCompanionBusy())
            {
                Log($"update: restart requested for {_pending.Version} but the companion is mid-write; it will apply as soon as that clears");
                SetModel(UpdateTrayModel.For(UpdateStatus.DeferredBusy, _pending.Version));
                return;
            }

            await ApplyCoreAsync(_pending, cancellationToken).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception error)
        {
            Log($"update: FAILED to apply on request: {Describe(error)}");
            SetModel(UpdateTrayModel.For(UpdateStatus.Error, _pending?.Version, error.Message));
        }
        finally
        {
            _operation.Release();
        }
    }

    /// <summary>
    /// Re-attempts a staged apply without touching the network. 1.0.8 and
    /// earlier only ever retried on a busy-to-idle edge, so a missed edge
    /// stranded the update until the next process start (which also never
    /// applied it).
    /// </summary>
    public async Task RetryPendingApplyAsync(CancellationToken cancellationToken = default)
    {
        if (_pending is null) return;
        await _operation.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            await ApplyPendingCoreAsync(cancellationToken).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception error)
        {
            Log($"update: FAILED on a staged-apply retry: {Describe(error)}");
            SetModel(UpdateTrayModel.For(UpdateStatus.Error, _pending?.Version, error.Message));
        }
        finally
        {
            _operation.Release();
        }
    }

    /// <summary>
    /// Called by the LCU/phase owner whenever the companion enters or leaves a
    /// write-sensitive phase. Clearing busy immediately applies a staged
    /// Velopack update; no independent marker is written to disk.
    /// </summary>
    public async Task SetCompanionBusyAsync(bool busy, CancellationToken cancellationToken = default)
    {
        Interlocked.Exchange(ref _busy, busy ? 1 : 0);
        if (busy || _pending is null) return;
        await _operation.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            if (!IsBusy && !_isCompanionBusy() && _pending is not null)
            {
                await ApplyPendingCoreAsync(cancellationToken).ConfigureAwait(false);
            }
        }
        finally
        {
            _operation.Release();
        }
    }

    private async Task ApplyPendingCoreAsync(CancellationToken cancellationToken)
    {
        if (_pending is null) return;
        var update = _pending;

        if (IsBusy || _isCompanionBusy())
        {
            LogDeferralOnce(
                $"busy:{update.Version}",
                $"update: {update.Version} is staged; holding the restart while the companion is mid-write");
            SetModel(UpdateTrayModel.For(UpdateStatus.DeferredBusy, update.Version));
            return;
        }

        if (_isRestartDisruptive() && !_restartRequested)
        {
            LogDeferralOnce(
                $"window:{update.Version}",
                $"update: {update.Version} is staged; not restarting under the open CoachBuild window (tray: Restart to update)");
            SetModel(UpdateTrayModel.For(UpdateStatus.Staged, update.Version));
            return;
        }

        await ApplyCoreAsync(update, cancellationToken).ConfigureAwait(false);
    }

    private async Task ApplyCoreAsync(AvailableUpdate update, CancellationToken cancellationToken)
    {
        var current = SafeCurrentVersion();
        if (current is not null && !UpdateVersion.IsNewer(update.Version, current))
        {
            Log($"update: refusing to apply {update.Version} over the installed {current}; it is not newer");
            _pending = null;
            SetModel(UpdateTrayModel.For(UpdateStatus.None));
            return;
        }

        Log($"update: applying {update.Version} and restarting");
        SetModel(UpdateTrayModel.For(UpdateStatus.Applying, update.Version));
        await _client.ApplyUpdatesAndRestartAsync(update, cancellationToken).ConfigureAwait(false);
        // Velopack relaunches the new process. Do not retain a stale marker or
        // claim readiness after ApplyUpdatesAndRestart has handed off state.
        _pending = null;
        _lastDeferralLogged = null;
        _restartRequested = false;
    }

    /// <summary>
    /// Pure schedule. A staged-but-unapplied release is retried on the short
    /// interval; the network check only runs when it is due.
    /// </summary>
    public static UpdateLoopAction NextAction(
        DateTimeOffset now,
        DateTimeOffset checkDueAt,
        bool hasPending)
    {
        if (now >= checkDueAt) return UpdateLoopAction.Check;
        return hasPending ? UpdateLoopAction.RetryPendingApply : UpdateLoopAction.Idle;
    }

    private async Task CheckLoopAsync(CancellationToken callerToken)
    {
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(_shutdown.Token, callerToken);
        var token = linked.Token;

        try
        {
            await ApplyStagedFromDiskAsync(token).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested)
        {
            return;
        }
        catch (Exception error)
        {
            Log($"update: FAILED during the startup staged-apply: {Describe(error)}");
        }

        var checkDueAt = _time.GetUtcNow();
        while (!token.IsCancellationRequested)
        {
            try
            {
                switch (NextAction(_time.GetUtcNow(), checkDueAt, _pending is not null))
                {
                    case UpdateLoopAction.Check:
                        await CheckNowAsync(token).ConfigureAwait(false);
                        checkDueAt = _time.GetUtcNow() + _checkInterval;
                        break;
                    case UpdateLoopAction.RetryPendingApply:
                        await RetryPendingApplyAsync(token).ConfigureAwait(false);
                        break;
                }

                await Task.Delay(_applyRetryInterval, token).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (token.IsCancellationRequested)
            {
                break;
            }
            catch (Exception error)
            {
                Log($"update: FAILED in the update loop: {Describe(error)}");
                try
                {
                    await Task.Delay(_applyRetryInterval, token).ConfigureAwait(false);
                }
                catch (OperationCanceledException) { break; }
            }
        }
    }

    private string? SafeCurrentVersion()
    {
        try { return _client.CurrentVersion; }
        catch { return null; }
    }

    private void LogDeferralOnce(string key, string message)
    {
        if (string.Equals(_lastDeferralLogged, key, StringComparison.Ordinal)) return;
        _lastDeferralLogged = key;
        Log(message);
    }

    private static string Describe(Exception error)
    {
        var inner = error is TargetInvocationException { InnerException: { } wrapped } ? wrapped : error;
        return $"{inner.GetType().Name}: {inner.Message}";
    }

    private void Log(string message)
    {
        try { _diagnostics?.Invoke(message); } catch { }
    }

    private void SetModel(UpdateTrayModel model)
    {
        _model = model;
        StatusChanged?.Invoke(this, model);
    }

    public async ValueTask DisposeAsync()
    {
        _shutdown.Cancel();
        if (_loop is not null)
        {
            try { await _loop.ConfigureAwait(false); } catch (OperationCanceledException) { }
        }
        _operation.Dispose();
        _shutdown.Dispose();
    }
}

/// <summary>
/// Keeps the source checkout buildable even when Velopack is not loaded. An
/// installed package resolves the types/methods at runtime and the same
/// adapter uses Velopack's delta/update-manager APIs.
/// </summary>
public sealed class ReflectionVelopackUpdateClient : IUpdateClient
{
    private readonly object? _manager;
    private readonly Type? _managerType;
    private readonly Action<string>? _diagnostics;

    public ReflectionVelopackUpdateClient(string feedUrl, Action<string>? diagnostics = null)
    {
        _diagnostics = diagnostics;
        if (UpdateBootstrapper.UsesRateLimitedApi(feedUrl))
        {
            // Not reachable with the shipped constant, and asserted in a test.
            // A GitHub API feed would rate-limit unauthenticated clients to 60
            // requests/hour/IP and fail checks intermittently.
            Log($"update: feed {feedUrl} uses the rate-limited GitHub API rather than static release assets");
        }

        try
        {
            _managerType = Type.GetType("Velopack.UpdateManager, Velopack", throwOnError: false);
            if (_managerType is null)
            {
                UnavailableReason = "Velopack.UpdateManager could not be resolved; this build cannot self-update";
                Log($"update: {UnavailableReason}");
                return;
            }

            _manager = Activator.CreateInstance(_managerType, new object?[] { feedUrl, null, null });
            if (!IsInstalled)
            {
                UnavailableReason = "this is not an installed build (portable/source run); updates are disabled";
                Log($"update: {UnavailableReason}");
            }
        }
        catch (Exception error)
        {
            var inner = error is TargetInvocationException { InnerException: { } wrapped } ? wrapped : error;
            UnavailableReason = $"UpdateManager could not be created: {inner.GetType().Name}: {inner.Message}";
            Log($"update: {UnavailableReason}");
            _managerType = null;
            _manager = null;
        }
    }

    public string? UnavailableReason { get; }

    public string? CurrentVersion => GetManagerProperty("CurrentVersion")?.ToString();

    private bool IsInstalled => GetManagerProperty("IsInstalled") is bool installed && installed;

    public async Task<AvailableUpdate?> CheckForUpdatesAsync(CancellationToken cancellationToken)
    {
        if (_manager is null) return null;
        var method = _managerType!.GetMethod("CheckForUpdatesAsync", BindingFlags.Public | BindingFlags.Instance);
        if (method is null)
        {
            Log("update: Velopack.UpdateManager has no CheckForUpdatesAsync method");
            return null;
        }

        if (method.Invoke(_manager, null) is not Task task) return null;
        await task.WaitAsync(cancellationToken).ConfigureAwait(false);
        var result = task.GetType().GetProperty("Result")?.GetValue(task);
        if (result is null) return null;
        return Describe(result);
    }

    /// <summary>
    /// Velopack keeps a downloaded-but-unapplied release addressable through
    /// UpdatePendingRestart. Reading it is the only way to notice work a
    /// previous process left behind.
    /// </summary>
    public AvailableUpdate? GetPendingRestartUpdate()
    {
        if (_manager is null) return null;
        var asset = GetManagerProperty("UpdatePendingRestart");
        if (asset is null) return null;
        var version = asset.GetType().GetProperty("Version")?.GetValue(asset)?.ToString();
        return string.IsNullOrWhiteSpace(version) ? null : new AvailableUpdate(version!, asset);
    }

    public Task DownloadUpdatesAsync(AvailableUpdate update, CancellationToken cancellationToken)
    {
        return InvokeAsync("DownloadUpdatesAsync", update.NativeUpdate, cancellationToken);
    }

    public Task ApplyUpdatesAndRestartAsync(AvailableUpdate update, CancellationToken cancellationToken)
    {
        return InvokeAsync("ApplyUpdatesAndRestart", update.NativeUpdate, cancellationToken);
    }

    private static AvailableUpdate? Describe(object result)
    {
        var release = result.GetType().GetProperty("TargetFullRelease")?.GetValue(result) ?? result;
        var version = release.GetType().GetProperty("Version")?.GetValue(release)?.ToString();
        var availability = result.GetType().GetProperty("IsUpdateAvailable")?.GetValue(result);
        var isUpdate = availability is bool available
            ? available
            : !string.IsNullOrWhiteSpace(version);
        return isUpdate && !string.IsNullOrWhiteSpace(version) ? new AvailableUpdate(version!, result) : null;
    }

    private object? GetManagerProperty(string name)
    {
        if (_manager is null) return null;
        try { return _managerType!.GetProperty(name, BindingFlags.Public | BindingFlags.Instance)?.GetValue(_manager); }
        catch (Exception error) { Log($"update: could not read UpdateManager.{name}: {error.GetType().Name}"); return null; }
    }

    private async Task InvokeAsync(string methodName, object update, CancellationToken cancellationToken)
    {
        if (_manager is null) return;
        var method = _managerType!.GetMethod(methodName, BindingFlags.Public | BindingFlags.Instance);
        if (method is null)
        {
            Log($"update: Velopack.UpdateManager has no {methodName} method");
            return;
        }

        var parameters = method.GetParameters();
        var target = update;
        if (string.Equals(methodName, "ApplyUpdatesAndRestart", StringComparison.Ordinal))
        {
            target = update.GetType().GetProperty("TargetFullRelease")?.GetValue(update) ?? update;
        }
        var arguments = parameters.Length switch
        {
            1 => new object?[] { target },
            2 when parameters[1].ParameterType == typeof(CancellationToken) => new object?[] { target, cancellationToken },
            2 => new object?[] { target, null },
            3 when parameters[2].ParameterType == typeof(CancellationToken) => new object?[] { target, null, cancellationToken },
            3 => new object?[] { target, null, null },
            _ => new object?[] { target },
        };
        if (method.Invoke(_manager, arguments) is Task task)
        {
            await task.WaitAsync(cancellationToken).ConfigureAwait(false);
        }
    }

    private void Log(string message)
    {
        try { _diagnostics?.Invoke(message); } catch { }
    }
}
