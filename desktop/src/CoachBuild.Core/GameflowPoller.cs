using System.Text.Json;

namespace CoachBuild.Core;

public sealed record GameflowPollerOptions(int PollMilliseconds = 1500);

public sealed class GameflowPoller
{
    private readonly LcuCredentialResolver _credentials;
    private readonly ILcuApi _lcu;
    private readonly CompanionState _state;
    private readonly WindowDecisionService? _windows;
    private readonly RedactedLog? _log;
    private readonly Action? _champSelectEntered;
    private readonly Action<RankCaptureTrigger>? _rankCapture;
    private readonly int _pollMilliseconds;
    private int? _lastChampSelectChampionId;

    public GameflowPoller(
        LcuCredentialResolver credentials,
        ILcuApi lcu,
        CompanionState state,
        WindowDecisionService? windows = null,
        RedactedLog? log = null,
        Action? champSelectEntered = null,
        GameflowPollerOptions? options = null,
        // Raised at champ-select ENTRY and at GAME END (spec §5's second and
        // third moments; app start is raised by the host, which is the only
        // thing that knows the process just came up).
        //
        // Deliberately a SEPARATE callback from champSelectEntered, which
        // already means "forget last game's rune ledger" and defaults to the
        // rune service. Folding a second meaning into it would make one of the
        // two impossible to suppress without suppressing the other.
        //
        // The implementation must not block -- see RankCaptureService.Fire.
        // This poller wraps the call in a catch anyway, because a diagnostic
        // feature does not get to stop the gameflow loop.
        Action<RankCaptureTrigger>? rankCapture = null)
    {
        _credentials = credentials;
        _lcu = lcu;
        _state = state;
        _windows = windows;
        _log = log;
        _champSelectEntered = champSelectEntered ??
            (state.RuneApplyService is { } registeredRunes
                ? new Action(registeredRunes.ClearForChampSelect)
                : null);
        _rankCapture = rankCapture;
        _pollMilliseconds = Math.Max(100, options?.PollMilliseconds ?? 1500);
    }

    /// <summary>
    /// Raises a rank-capture trigger without letting it reach the caller. The
    /// callback is already required not to throw; this is the second lock on
    /// the door, because the caller here is the loop that drives champ select.
    /// </summary>
    private void RaiseRankCapture(RankCaptureTrigger trigger)
    {
        try { _rankCapture?.Invoke(trigger); }
        catch { /* an LP sample never gets to break the gameflow tick */ }
    }

    public async Task<WindowDecision?> TickAsync(CancellationToken cancellationToken = default)
    {
        _state.RecordPoll();
        var credentials = _credentials.GetCachedOrResolve();
        _state.SetCredentials(credentials);
        var phase = "None";
        if (credentials is not null)
        {
            var response = await _lcu.SendAsync(
                HttpMethod.Get,
                "/lol-gameflow/v1/gameflow-phase",
                cancellationToken: cancellationToken).ConfigureAwait(false);
            if (response.Ok && response.Content is { } content)
                phase = ReadString(content) ?? "None";
            else if (response.IsConnectionOrAuthFailure)
            {
                _credentials.Invalidate();
                _state.SetCredentials(null);
            }
        }

        var previousPhase = _state.Phase;
        var phaseChanged = !string.Equals(previousPhase, phase, StringComparison.Ordinal);
        _state.SetPhase(phase);
        if (phaseChanged)
            _log?.Info($"phase: {previousPhase} -> {phase}");
        // BEFORE the non-champ-select early return below, and before anything
        // that depends on credentials: a game ending is a transition away from
        // InProgress, so by the time we notice it the phase is one this method
        // otherwise stops caring about.
        if (RankCaptureService.LeftGame(previousPhase, phase))
            RaiseRankCapture(RankCaptureTrigger.GameEnd);
        _windows?.OnPhaseChanged(phase);

        if (!string.Equals(phase, "ChampSelect", StringComparison.Ordinal) || credentials is null)
        {
            _lastChampSelectChampionId = null;
            return null;
        }

        var enteredChampSelect = !string.Equals(previousPhase, "ChampSelect", StringComparison.Ordinal);
        if (enteredChampSelect)
        {
            _champSelectEntered?.Invoke();
            RaiseRankCapture(RankCaptureTrigger.ChampSelect);
        }

        var sessionResponse = await _lcu.SendAsync(
            HttpMethod.Get,
            "/lol-champ-select/v1/session",
            cancellationToken: cancellationToken).ConfigureAwait(false);
        if (!sessionResponse.Ok || sessionResponse.Content is not { } session)
        {
            if (sessionResponse.IsConnectionOrAuthFailure)
            {
                _credentials.Invalidate();
                _state.SetCredentials(null);
            }
            return enteredChampSelect ? _windows?.OnChampSelectEntry(browserAlive: true) : null;
        }

        var resolution = ChampSelectResolver.Resolve(session);
        if (resolution is null)
            return enteredChampSelect ? _windows?.OnChampSelectEntry(browserAlive: true) : null;
        WindowDecision? entryDecision = enteredChampSelect
            ? _windows?.OnChampSelectEntry(resolution, browserAlive: true)
            : null;
        _state.SetChampSelect(new CompanionChampSelectSnapshot(
            resolution.LocalPlayerCellId,
            resolution.CellChampionId,
            resolution.PickIntent,
            resolution.ActionChampionId,
            resolution.RoleId,
            resolution.TheirTeam,
            resolution.TimerPhase));
        var decision = _windows?.OnChampSelectPoll(resolution, browserAlive: true);
        if (resolution.ChampionId is > 0)
        {
            if (_lastChampSelectChampionId != resolution.ChampionId)
                _state.SetLastOpen(resolution.ChampionId.Value, resolution.RoleId);
            _lastChampSelectChampionId = resolution.ChampionId;
            if (entryDecision is { Kind: WindowDecisionKind.OpenDraft } ||
                decision is { Kind: WindowDecisionKind.OpenDraft })
                _log?.Info($"champ-select champ={resolution.ChampionId.Value} role={(resolution.RoleId?.ToString() ?? "none")}");
        }
        else
        {
            _lastChampSelectChampionId = null;
        }
        return entryDecision is { Kind: WindowDecisionKind.OpenDraft } ? entryDecision : decision;
    }

    public async Task RunAsync(CancellationToken cancellationToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromMilliseconds(_pollMilliseconds));
        while (await timer.WaitForNextTickAsync(cancellationToken).ConfigureAwait(false))
        {
            try { await TickAsync(cancellationToken).ConfigureAwait(false); }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { return; }
            catch (Exception ex)
            {
                _log?.Error("gameflow", $"gameflow poll failed: {ex.GetType().Name}: {ex.Message}");
                _state.SetLastError($"gameflow poll failed: {ex.GetType().Name}");
            }
        }
    }

    private static string? ReadString(JsonElement content) => content.ValueKind switch
    {
        JsonValueKind.String => content.GetString(),
        JsonValueKind.Object => ComplianceRules.NonBlankString(content, "phase"),
        _ => null
    };
}
