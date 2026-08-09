using System.Reflection;

namespace CoachBuild.Desktop.Updates;

public sealed record AvailableUpdate(string Version, object NativeUpdate);

public interface IUpdateClient
{
    Task<AvailableUpdate?> CheckForUpdatesAsync(CancellationToken cancellationToken);

    Task DownloadUpdatesAsync(AvailableUpdate update, CancellationToken cancellationToken);

    Task ApplyUpdatesAndRestartAsync(AvailableUpdate update, CancellationToken cancellationToken);
}

/// <summary>
/// Background update coordinator. Velopack owns release metadata, delta
/// selection, download staging, and transactional pending-update state; this
/// service owns only the busy-phase gate and tray projection.
/// </summary>
public sealed class VelopackUpdateService : IAsyncDisposable
{
    private readonly IUpdateClient _client;
    private readonly Func<bool> _isCompanionBusy;
    private readonly TimeSpan _checkInterval;
    private readonly SemaphoreSlim _operation = new(1, 1);
    private readonly CancellationTokenSource _shutdown = new();
    private AvailableUpdate? _pending;
    private Task? _loop;
    private bool _started;
    private int _busy;
    private UpdateTrayModel _model = UpdateTrayModel.None;

    public VelopackUpdateService(
        IUpdateClient? client = null,
        Func<bool>? isCompanionBusy = null,
        TimeSpan? checkInterval = null)
    {
        _client = client ?? new ReflectionVelopackUpdateClient(UpdateBootstrapper.ReleaseFeed);
        _isCompanionBusy = isCompanionBusy ?? (() => IsBusy);
        _checkInterval = checkInterval ?? TimeSpan.FromHours(6);
    }

    public event EventHandler<UpdateTrayModel>? StatusChanged;

    public UpdateTrayModel Current => _model;

    public bool IsBusy => Volatile.Read(ref _busy) != 0;

    public AvailableUpdate? PendingUpdate => _pending;

    public Task StartAsync(CancellationToken cancellationToken = default)
    {
        if (_started) return Task.CompletedTask;
        _started = true;
        _loop = CheckLoopAsync(cancellationToken);
        return Task.CompletedTask;
    }

    public async Task CheckNowAsync(CancellationToken cancellationToken = default)
    {
        await _operation.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            SetModel(UpdateTrayModel.For(UpdateStatus.Checking));
            var update = await _client.CheckForUpdatesAsync(cancellationToken).ConfigureAwait(false);
            if (update is null)
            {
                _pending = null;
                SetModel(UpdateTrayModel.For(UpdateStatus.None));
                return;
            }

            _pending = null;
            SetModel(UpdateTrayModel.For(UpdateStatus.Downloading, update.Version));
            await _client.DownloadUpdatesAsync(update, cancellationToken).ConfigureAwait(false);
            _pending = update;
            SetModel(UpdateTrayModel.For(UpdateStatus.Ready, update.Version));
            if (IsBusy || _isCompanionBusy())
            {
                SetModel(UpdateTrayModel.For(UpdateStatus.DeferredBusy, update.Version));
                return;
            }

            await ApplyPendingCoreAsync(cancellationToken).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception error)
        {
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
        if (_pending is null || IsBusy || _isCompanionBusy()) return;
        var update = _pending;
        SetModel(UpdateTrayModel.For(UpdateStatus.Applying, update.Version));
        await _client.ApplyUpdatesAndRestartAsync(update, cancellationToken).ConfigureAwait(false);
        // Velopack relaunches the new process. Do not retain a stale marker or
        // claim readiness after ApplyUpdatesAndRestart has handed off state.
        _pending = null;
    }

    private async Task CheckLoopAsync(CancellationToken callerToken)
    {
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(_shutdown.Token, callerToken);
        var token = linked.Token;
        while (!token.IsCancellationRequested)
        {
            try
            {
                await CheckNowAsync(token).ConfigureAwait(false);
                await Task.Delay(_checkInterval, token).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (token.IsCancellationRequested)
            {
                break;
            }
        }
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

    public ReflectionVelopackUpdateClient(string feedUrl)
    {
        try
        {
            _managerType = Type.GetType("Velopack.UpdateManager, Velopack", throwOnError: false);
            _manager = _managerType is null
                ? null
                : Activator.CreateInstance(_managerType, new object?[] { feedUrl, null, null });
        }
        catch
        {
            _managerType = null;
            _manager = null;
        }
    }

    public async Task<AvailableUpdate?> CheckForUpdatesAsync(CancellationToken cancellationToken)
    {
        if (_manager is null) return null;
        var method = _managerType!.GetMethod("CheckForUpdatesAsync", BindingFlags.Public | BindingFlags.Instance);
        if (method?.Invoke(_manager, null) is not Task task) return null;
        await task.WaitAsync(cancellationToken).ConfigureAwait(false);
        var result = task.GetType().GetProperty("Result")?.GetValue(task);
        if (result is null) return null;
        var release = result.GetType().GetProperty("TargetFullRelease")?.GetValue(result) ?? result;
        var version = release.GetType().GetProperty("Version")?.GetValue(release)?.ToString();
        var availability = result.GetType().GetProperty("IsUpdateAvailable")?.GetValue(result);
        var isUpdate = availability is bool available
            ? available
            : !string.IsNullOrWhiteSpace(version);
        return isUpdate && !string.IsNullOrWhiteSpace(version) ? new AvailableUpdate(version!, result) : null;
    }

    public Task DownloadUpdatesAsync(AvailableUpdate update, CancellationToken cancellationToken)
    {
        return InvokeAsync("DownloadUpdatesAsync", update.NativeUpdate, cancellationToken);
    }

    public Task ApplyUpdatesAndRestartAsync(AvailableUpdate update, CancellationToken cancellationToken)
    {
        return InvokeAsync("ApplyUpdatesAndRestart", update.NativeUpdate, cancellationToken);
    }

    private async Task InvokeAsync(string methodName, object update, CancellationToken cancellationToken)
    {
        if (_manager is null) return;
        var method = _managerType!.GetMethod(methodName, BindingFlags.Public | BindingFlags.Instance);
        if (method is null) return;
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
            3 => new object?[] { target, null, cancellationToken },
            _ => new object?[] { target },
        };
        if (method.Invoke(_manager, arguments) is Task task)
        {
            await task.WaitAsync(cancellationToken).ConfigureAwait(false);
        }
    }
}
