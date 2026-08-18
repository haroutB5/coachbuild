using System.Text.Json;

namespace CoachBuild.Core;

public sealed class LivePollingCoordinator
{
    public const int GameflowPollMs = 1500;

    /// <summary>
    /// The gameflow cadence WHILE PICKING. Champ select is the one phase where
    /// the user is changing something several times a second and watching the
    /// app for the answer, and 1500 ms was the measured remaining floor on the
    /// champion-switch path (see HANDOFF-core-builds-sync §8.3). Every other
    /// phase keeps <see cref="GameflowPollMs"/>: nothing there moves faster
    /// than the user can notice, and the LCU is a shared resource.
    /// </summary>
    public const int ChampSelectGameflowPollMs = 350;

    public const int PlayerListPollMs = 4000;

    /// <summary>
    /// How often <c>activeplayer</c> is read for level + QWER ranks.
    ///
    /// <para>250 ms, down from 1000 ms in 1.0.11, because the highlight now
    /// exists only while a skill point is unspent and that window is often
    /// under a second of real play. v1.0.6 shipped the same gate on a
    /// 750 ms–1.5 s sampler and users effectively never saw the box — this
    /// number is the reason that is not the outcome again.</para>
    ///
    /// <para>It replaces, rather than adds to, the second skills read that
    /// <c>RunActivePlayerCadenceAsync</c> used to make at 1500 ms: two workers
    /// polling the same endpoint for the same field was pure duplication.</para>
    /// </summary>
    public const int SkillsPollMs = 250;

    /// <summary>
    /// Consecutive unanswered skill polls before the retained snapshot is
    /// dropped. 20 × 250 ms = 5 s of silence.
    ///
    /// <para>Counted in POLLS, not wall clock, so it cannot be skewed by a
    /// test clock or by a machine that suspends. It exists because "the
    /// endpoint stopped answering" and "nothing changed" were the same thing
    /// to 1.0.11: when a game ended, the last snapshot simply stayed, and the
    /// overlay was still asserting it minutes later.</para>
    /// </summary>
    public const int SkillMissesBeforeDrop = 20;

    public const int AllGameDataPollMs = 3000;
    public const int IdentityFallbackPollMs = 2000;

    private readonly LiveClientDataClient _live;
    private readonly CompanionState _state;
    private readonly Action<JsonElement>? _allGameData;
    private readonly Action<JsonElement>? _playerList;
    private readonly Action<LiveSkillState?>? _skills;
    private readonly Action<JsonElement>? _activePlayerName;
    private readonly Func<bool>? _identityMissing;

    public LivePollingCoordinator(
        LiveClientDataClient live,
        CompanionState state,
        Action<JsonElement>? allGameData = null,
        Action<JsonElement>? playerList = null,
        Action<LiveSkillState?>? skills = null,
        Action<JsonElement>? activePlayerName = null,
        Func<bool>? identityMissing = null)
    {
        _live = live;
        _state = state;
        _allGameData = allGameData;
        _playerList = playerList;
        _skills = skills;
        _activePlayerName = activePlayerName;
        _identityMissing = identityMissing;
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

    /// <summary>
    /// One read of <c>activeplayer</c>. The result is handed to the caller
    /// EVEN WHEN IT IS NULL.
    ///
    /// <para>That is the change 1.0.12 needed most. Dropping a null here made
    /// "2999 stopped answering" and "the player did not level up"
    /// indistinguishable downstream, so the host kept serving its last
    /// snapshot forever - which is how a highlight survived the end of a game
    /// by two minutes in the field.</para>
    /// </summary>
    public async Task TickSkillsAsync(CancellationToken cancellationToken = default)
    {
        if (!IsInProgress()) return;
        var data = await _live.GetSkillsAsync(cancellationToken).ConfigureAwait(false);
        _skills?.Invoke(data);
    }

    /// <summary>
    /// Polls the bare-string identity endpoint, but only while the caller
    /// says it still has no usable identity. A healthy client answers on
    /// allgamedata, so this normally makes zero requests for a whole game;
    /// without the predicate it would be a standing extra request aimed at a
    /// question that was already answered.
    /// </summary>
    public async Task TickActivePlayerNameAsync(CancellationToken cancellationToken = default)
    {
        if (!IsInProgress()) return;
        if (_activePlayerName is null || _identityMissing is null || !_identityMissing()) return;
        var data = await _live.GetActivePlayerNameAsync(cancellationToken).ConfigureAwait(false);
        if (data is { } value) _activePlayerName(value);
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
            RunPeriodicAsync(TickActivePlayerNameAsync, IdentityFallbackPollMs, cancellationToken)
        };
        await Task.WhenAll(workers).ConfigureAwait(false);
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

