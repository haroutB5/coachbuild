using System.Text.Json;

namespace CoachBuild.Core;

public sealed class LivePollingCoordinator
{
    public const int GameflowPollMs = 1500;
    public const int ActivePlayerIdlePollMs = 5000;
    public const int ActivePlayerActivePollMs = 1500;
    public const int PlayerListPollMs = 4000;
    public const int SkillsPollMs = 1000;
    public const int AllGameDataPollMs = 3000;

    private readonly LiveClientDataClient _live;
    private readonly CompanionState _state;
    private readonly Action<JsonElement>? _allGameData;
    private readonly Action<JsonElement>? _playerList;
    private readonly Action<LiveSkillState>? _skills;

    public LivePollingCoordinator(
        LiveClientDataClient live,
        CompanionState state,
        Action<JsonElement>? allGameData = null,
        Action<JsonElement>? playerList = null,
        Action<LiveSkillState>? skills = null)
    {
        _live = live;
        _state = state;
        _allGameData = allGameData;
        _playerList = playerList;
        _skills = skills;
    }

    public async Task TickAllGameDataAsync(CancellationToken cancellationToken = default)
    {
        if (!IsInProgress()) return;
        var data = await _live.GetAllGameDataAsync(cancellationToken).ConfigureAwait(false);
        if (data is { } value) _allGameData?.Invoke(value);
    }

    public async Task TickPlayerListAsync(CancellationToken cancellationToken = default)
    {
        if (!IsInProgress()) return;
        var data = await _live.GetPlayerListAsync(cancellationToken).ConfigureAwait(false);
        if (data is { } value) _playerList?.Invoke(value);
    }

    public async Task TickSkillsAsync(CancellationToken cancellationToken = default)
    {
        if (!IsInProgress()) return;
        var data = await _live.GetSkillsAsync(cancellationToken).ConfigureAwait(false);
        if (data is not null) _skills?.Invoke(data);
    }

    /// <summary>
    /// Starts independent, fail-soft workers. Raw live payloads are passed to
    /// the caller and are not retained by the coordinator.
    /// </summary>
    public async Task RunAsync(CancellationToken cancellationToken)
    {
        var workers = new[]
        {
            RunPeriodicAsync(TickAllGameDataAsync, AllGameDataPollMs, cancellationToken),
            RunPeriodicAsync(TickPlayerListAsync, PlayerListPollMs, cancellationToken),
            RunPeriodicAsync(TickSkillsAsync, SkillsPollMs, cancellationToken),
            RunActivePlayerCadenceAsync(cancellationToken)
        };
        await Task.WhenAll(workers).ConfigureAwait(false);
    }

    private async Task RunActivePlayerCadenceAsync(CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            var delay = IsInProgress() ? ActivePlayerActivePollMs : ActivePlayerIdlePollMs;
            await Task.Delay(delay, cancellationToken).ConfigureAwait(false);
            if (!IsInProgress()) continue;
            // Skills are the only active-player data exposed by the native
            // surface; this tick keeps the explicit active cadence available
            // without retaining another-player data.
            var data = await _live.GetSkillsAsync(cancellationToken).ConfigureAwait(false);
            if (data is not null) _skills?.Invoke(data);
        }
    }

    private async Task RunPeriodicAsync(
        Func<CancellationToken, Task> tick,
        int milliseconds,
        CancellationToken cancellationToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromMilliseconds(milliseconds));
        while (await timer.WaitForNextTickAsync(cancellationToken).ConfigureAwait(false))
        {
            try { await tick(cancellationToken).ConfigureAwait(false); }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { return; }
            catch { /* Live Client Data is unavailable between games. */ }
        }
    }

    private bool IsInProgress() => string.Equals(_state.Phase, "InProgress", StringComparison.Ordinal);
}

