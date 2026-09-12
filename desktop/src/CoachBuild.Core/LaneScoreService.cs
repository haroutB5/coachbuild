using System.Text.Json;

namespace CoachBuild.Core;

/// <summary>
/// The feature's one entry point: it captures a finished ranked game off the
/// League client, keeps it in <see cref="LaneScoreStore"/> until the user
/// judges it, and answers the three bridge endpoints.
///
/// <para><b>Capture never blocks anything.</b> Same rule, and the same
/// mechanism, as <see cref="RankCaptureService"/>: <see cref="FireGameEnd"/>
/// detaches onto the thread pool and returns, the whole body is inside a catch,
/// and it shares no lock with the item-set or rune apply paths. A player is not
/// losing their item set because a scoring prompt wanted to read match history.
/// </para>
/// </summary>
public sealed class LaneScoreService
{
    /// <summary>
    /// The end-of-game block, tried first: it is the payload that exists at
    /// exactly the moment the phase leaves the game, with no dependency on the
    /// platform having finished writing match history.
    /// </summary>
    public const string EogStatsPath = "/lol-end-of-game/v1/eog-stats-block";

    /// <summary>
    /// The fallback. Match history is authoritative but lags — the platform is
    /// still scoring the game when the client says it is over — so it is read
    /// only when the end-of-game block is gone (the user clicked past it) and it
    /// is read with the same settle retries for the same reason.
    /// </summary>
    public const string MatchHistoryPath =
        "/lol-match-history/v1/products/lol/current-summoner/matches?begIndex=0&endIndex=0";

    /// <summary>
    /// Match ids the real store refuses outright. The demo mode below never
    /// calls the store at all, so this is the SECOND lock on that door: even a
    /// wiring mistake cannot land fabricated data in the user's history.
    /// </summary>
    public const string DemoMatchIdPrefix = "demo-";

    private readonly ILcuApi _lcu;
    private readonly LaneScoreStore _store;
    private readonly RedactedLog _log;
    private readonly TimeProvider _time;
    private readonly bool _demo;
    private readonly Action? _prompt;
    private readonly Func<TimeSpan, CancellationToken, Task> _delay;
    private readonly int _settleAttempts;
    private readonly TimeSpan _settleDelay;

    private readonly object _gate = new();
    private Task? _pending;

    public LaneScoreService(
        ILcuApi lcu,
        LaneScoreStore store,
        RedactedLog? log = null,
        TimeProvider? timeProvider = null,
        bool demo = false,
        // Raised once, after a capture actually records a new game, so the host
        // can bring the companion window up on the NON-YANKING path. Deliberately
        // an Action the host supplies rather than a window reference: nothing in
        // Core knows what a window is.
        Action? prompt = null,
        // ~60 s at the 5 s default. Match history can lag the end of a game by
        // well over the old 15 s window (field log 2026-09-11 23:58), and the
        // end-of-game identity guard keeps a stale history row from being taken.
        int settleAttempts = 12,
        TimeSpan? settleDelay = null,
        Func<TimeSpan, CancellationToken, Task>? delay = null)
    {
        _lcu = lcu ?? throw new ArgumentNullException(nameof(lcu));
        _store = store ?? throw new ArgumentNullException(nameof(store));
        // NOT `new RedactedLog()` -- see RedactedLog.Discarding; that default
        // resolves to the user's real companion.log.
        _log = log ?? RedactedLog.Discarding;
        _time = timeProvider ?? TimeProvider.System;
        _demo = demo;
        _prompt = prompt;
        _settleAttempts = Math.Max(0, settleAttempts);
        _settleDelay = settleDelay ?? TimeSpan.FromSeconds(5);
        _delay = delay ?? ((wait, token) => Task.Delay(wait, token));
    }

    /// <summary>True when this instance is serving fabricated data and writing nothing.</summary>
    public bool IsDemo => _demo;

    /// <summary>The most recent capture, for tests to await. Production never reads it.</summary>
    public Task? PendingCapture { get { lock (_gate) return _pending; } }

    /// <summary>
    /// Start a capture and return immediately. Cannot throw and cannot be
    /// awaited by accident.
    /// </summary>
    public void FireGameEnd(CancellationToken cancellationToken = default)
    {
        if (_demo) return;
        try
        {
            var task = Task.Run(() => CaptureAsync(cancellationToken), CancellationToken.None);
            lock (_gate) _pending = task;
        }
        catch
        {
            // Task.Run only throws when the scheduler is gone, i.e. shutdown.
        }
    }

    /// <summary>One capture, start to finish. Never throws, for any input, from any dependency.</summary>
    public async Task CaptureAsync(CancellationToken cancellationToken = default)
    {
        if (_demo) return;
        try
        {
            await CaptureCoreAsync(cancellationToken).ConfigureAwait(false);
        }
        catch (Exception error)
        {
            SafeLog(() => _log.Error("lane-score-capture",
                $"lane-score: capture failed: {error.GetType().Name}"));
        }
    }

    private async Task CaptureCoreAsync(CancellationToken cancellationToken)
    {
        var ownPuuid = await ReadOwnPuuidAsync(cancellationToken).ConfigureAwait(false);
        string? expectedMatchId = null;

        for (var attempt = 0; attempt <= _settleAttempts; attempt++)
        {
            if (cancellationToken.IsCancellationRequested) return;

            foreach (var path in new[] { EogStatsPath, MatchHistoryPath })
            {
                var response = await _lcu.SendAsync(HttpMethod.Get, path, cancellationToken: cancellationToken)
                    .ConfigureAwait(false);
                if (!response.Ok || response.Content is not { } content) continue;

                if (path == EogStatsPath)
                {
                    var identity = LaneScoreCapture.GameIdentity(content);
                    if (identity.QueueId is { } queue && !RankedQueues.IsRanked(queue)) return;
                    expectedMatchId ??= identity.MatchId;
                }

                var game = LaneScoreCapture.TryBuild(content, ownPuuid, _time.GetUtcNow());
                if (game is null && path == MatchHistoryPath &&
                    LaneScoreCapture.RankedMatchId(content) is { } matchId)
                {
                    var detail = await _lcu.SendAsync(HttpMethod.Get,
                        "/lol-match-history/v1/games/" + Uri.EscapeDataString(matchId),
                        cancellationToken: cancellationToken).ConfigureAwait(false);
                    if (detail.Ok && detail.Content is { } full)
                    {
                        var candidate = LaneScoreCapture.TryBuild(full, ownPuuid, _time.GetUtcNow());
                        if (candidate?.MatchId == matchId) game = candidate;
                    }
                }
                if (game is null)
                {
                    // Not ranked, or a shape we could not read. The inventory
                    // line is names-and-kinds only -- no values, so no puuids or
                    // summoner names reach the log. It is what makes the real
                    // payload shape verifiable from the user's next game.
                    SafeLog(() => _log.Info(
                        $"lane-score: {Source(path)} not recordable; shape={LaneScoreCapture.Describe(content)}"));
                    continue;
                }

                // History may still show a previous game that this installation
                // has never scored. Dedupe alone cannot recognise that stale row.
                if (expectedMatchId is not null && game.MatchId != expectedMatchId) continue;

                if (!_store.Capture(game))
                {
                    // History can still point at the previous game while the
                    // platform settles. A duplicate must not end the retry loop.
                    SafeLog(() => _log.Info($"lane-score: {Source(path)} game not added; continuing settle checks"));
                    continue;
                }

                SafeLog(() => _log.Info(
                    $"lane-score: captured {RankedQueues.Describe(game.QueueId)} from {Source(path)}; " +
                    $"champ={game.MyChampionId} role={LaneRoles.Describe(game.RoleId)} " +
                    $"opponent={(game.HasKnownOpponent ? game.OpponentChampionId!.Value.ToString() : "UNKNOWN")} " +
                    $"position-source={game.PositionSource}"));

                RaisePrompt();
                return;
            }

            if (attempt == _settleAttempts) break;
            await _delay(_settleDelay, cancellationToken).ConfigureAwait(false);
        }

        SafeLog(() => _log.Info("lane-score: no recordable ranked game found after game end"));
    }

    /// <summary>The prompt is a UI courtesy; it never gets to fail a capture that already succeeded.</summary>
    private void RaisePrompt()
    {
        try { _prompt?.Invoke(); }
        catch { /* the game is already on disk; the card will be there next time */ }
    }

    private async Task<string?> ReadOwnPuuidAsync(CancellationToken cancellationToken)
    {
        var response = await _lcu.SendAsync(
            HttpMethod.Get,
            "/lol-summoner/v1/current-summoner",
            cancellationToken: cancellationToken).ConfigureAwait(false);
        if (!response.Ok || response.Content is not { } content) return null;
        return ComplianceRules.NonBlankString(content, "puuid");
    }

    private static string Source(string path) =>
        path == EogStatsPath ? "eog-stats-block" : "match-history";

    // ---- bridge surface -------------------------------------------------

    /// <summary>
    /// The game awaiting a score, or null. In demo mode this is fabricated and
    /// the real store is never touched — not even read — so there is no path by
    /// which demo output can be mistaken for the user's history.
    /// </summary>
    public LaneScoreGame? Pending() => _demo ? DemoGame(_time.GetUtcNow()) : _store.Pending();

    /// <summary>
    /// Records a score or a skip. <b>In demo mode this writes nothing</b> and
    /// says so in the log; the caller still gets an accepted result so the card
    /// can be exercised end to end.
    /// </summary>
    public LaneScoreSubmission Submit(LaneScoreSubmitRequest? request)
    {
        if (_demo)
        {
            SafeLog(() => _log.Info("lane-score: DEMO submit discarded -- nothing was written"));
            return LaneScoreSubmission.Accepted;
        }

        if (request?.MatchId is { } matchId &&
            matchId.StartsWith(DemoMatchIdPrefix, StringComparison.Ordinal))
            return LaneScoreSubmission.Rejected("bad-request");

        var result = _store.Submit(request, _time.GetUtcNow());
        SafeLog(() => _log.Info(
            $"lane-score: submit ok={result.Ok}{(result.Reason is null ? "" : $" reason={result.Reason}")}"));
        return result;
    }

    /// <summary>
    /// The champ-select recommendation. Demo mode answers from the same
    /// fabricated game, so the panel can be eyeballed without a ranked history.
    /// </summary>
    public LaneScoreRecommendations Recommend(int enemyChampionId, int roleId)
    {
        if (_demo) return DemoRecommendations(enemyChampionId, roleId);
        return LaneScoreAggregator.Recommend(_store.Read().Scores, enemyChampionId, roleId);
    }

    // ---- demo mode ------------------------------------------------------

    /// <summary>
    /// The fabricated card. Reachable ONLY via the <c>--lane-score-demo</c>
    /// command-line flag: there is no tray item, no settings toggle and no
    /// bridge parameter that turns this on, so it cannot be tripped by a
    /// mis-click. Its match id carries <see cref="DemoMatchIdPrefix"/>, which
    /// <see cref="Submit"/> rejects outright on a non-demo instance.
    ///
    /// <para>It deliberately ships the UNKNOWN-opponent case: that is the branch
    /// a developer cannot otherwise reach on purpose, and it is the one the
    /// brief cares most about getting right.</para>
    /// </summary>
    public static LaneScoreGame DemoGame(DateTimeOffset now) => new()
    {
        MatchId = DemoMatchIdPrefix + "0000000001",
        PlayedAt = now.ToString("O"),
        QueueId = RankedQueues.SoloDuo,
        MyChampionId = 106,
        MyChampionName = "Volibear",
        RoleId = LaneRoles.Top,
        OpponentChampionId = null,
        OpponentChampionName = null,
        EnemyChampionIds = [887, 24, 86, 122, 875],
        PositionSource = "demo",
        CapturedAt = now.ToString("O"),
    };

    private static LaneScoreRecommendations DemoRecommendations(int enemyChampionId, int roleId) =>
        new(enemyChampionId, roleId, 6,
            Best:
            [
                new LaneScoreSummary(106, "Volibear", 3, 8.3, "2026-09-09T09:51:12.0000000+00:00"),
                new LaneScoreSummary(75, "Nasus", 2, 6.5, "2026-08-22T21:04:00.0000000+00:00"),
            ],
            Worst:
            [
                new LaneScoreSummary(24, "Jax", 1, 3.0, "2026-08-02T20:10:00.0000000+00:00"),
            ]);

    private static void SafeLog(Action write)
    {
        try { write(); } catch { /* diagnostics are fail-soft by design */ }
    }
}
