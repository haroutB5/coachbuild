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
    private readonly int _pollMilliseconds;
    private int? _lastChampSelectChampionId;

    public GameflowPoller(
        LcuCredentialResolver credentials,
        ILcuApi lcu,
        CompanionState state,
        WindowDecisionService? windows = null,
        RedactedLog? log = null,
        Action? champSelectEntered = null,
        GameflowPollerOptions? options = null)
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
        _pollMilliseconds = Math.Max(100, options?.PollMilliseconds ?? 1500);
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
