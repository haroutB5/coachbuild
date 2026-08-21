namespace CoachBuild.Core;

/// <summary>Tuning for <see cref="RankCaptureService"/>. Defaults are production.</summary>
/// <param name="GameEndSettleAttempts">
/// Extra ranked-stats reads after a game ends, waiting for the LP to move.
/// Zero disables the settle loop.
/// </param>
/// <param name="GameEndSettleDelay">Pause between those reads.</param>
public sealed record RankCaptureOptions(
    int GameEndSettleAttempts = 6,
    TimeSpan? GameEndSettleDelay = null)
{
    public TimeSpan ResolvedSettleDelay => GameEndSettleDelay ?? TimeSpan.FromSeconds(5);

    /// <summary>
    /// The worst case a game-end capture can occupy, as a fact rather than an
    /// assumption. Nothing waits on this task, but a bound that cannot be
    /// stated is a bound nobody can reason about.
    /// </summary>
    public TimeSpan MaximumSettleWindow => ResolvedSettleDelay * Math.Max(0, GameEndSettleAttempts);
}

/// <summary>
/// Reads ranked LP off the LCU and posts one sample, at app start, at champ
/// select entry and at game end (spec §5).
///
/// <para><b>The one rule this class exists to keep.</b> Capture fails silently
/// and NEVER blocks, delays or degrades an item-set or rune apply. A player
/// losing their item set because an LP read timed out would be a far worse bug
/// than this whole feature is worth. Three things enforce it and all three are
/// tested:</para>
/// <list type="number">
/// <item>Nothing ever awaits a capture. <see cref="Fire"/> detaches onto the
/// thread pool and returns; <see cref="PendingCapture"/> exists so a TEST can
/// settle deterministically, and production never reads it.</item>
/// <item>The whole body is inside a catch. <see cref="CaptureAsync"/> has no
/// throw path at all — not for a dead LCU, not for a malformed body, not for a
/// secret source that throws, not for a sink that throws.</item>
/// <item>It takes no lock the apply paths take, and issues its LCU reads
/// through the same <see cref="ILcuApi"/> without serialising against them.
/// A capture wedged on a hung read leaves an apply completely untouched.</item>
/// </list>
///
/// <para>Screen capture, OCR and memory reads are permanently off the table for
/// this app (1.0.16 policy, CHANGELOG.md). This is an LCU HTTP read, which is
/// the mechanism the companion has always used.</para>
/// </summary>
public sealed class RankCaptureService
{
    private readonly ILcuApi _lcu;
    private readonly IRankSampleSink _sink;
    private readonly Func<string?> _secret;
    private readonly RedactedLog _log;
    private readonly TimeProvider _time;
    private readonly RankCaptureOptions _options;
    private readonly Func<TimeSpan, CancellationToken, Task> _delay;

    private readonly object _gate = new();
    private RankSample? _lastObserved;
    private Task? _pending;
    private bool _announcedMissingSecret;

    public RankCaptureService(
        ILcuApi lcu,
        IRankSampleSink sink,
        Func<string?> secret,
        RedactedLog? log = null,
        TimeProvider? timeProvider = null,
        RankCaptureOptions? options = null,
        Func<TimeSpan, CancellationToken, Task>? delay = null)
    {
        _lcu = lcu ?? throw new ArgumentNullException(nameof(lcu));
        _sink = sink ?? throw new ArgumentNullException(nameof(sink));
        _secret = secret ?? throw new ArgumentNullException(nameof(secret));
        // NOT `new RedactedLog()`: that resolves to the user's real
        // companion.log. See RedactedLog.Discarding.
        _log = log ?? RedactedLog.Discarding;
        _time = timeProvider ?? TimeProvider.System;
        _options = options ?? new RankCaptureOptions();
        _delay = delay ?? ((wait, token) => Task.Delay(wait, token));
    }

    /// <summary>
    /// The most recent capture, for tests to await. Production NEVER reads this
    /// — the moment anything on the apply side does, rule 1 above is gone.
    /// </summary>
    public Task? PendingCapture { get { lock (_gate) return _pending; } }

    /// <summary>The last reading taken, whether or not it posted. Diagnostics only.</summary>
    public RankSample? LastObserved { get { lock (_gate) return _lastObserved; } }

    /// <summary>
    /// Start a capture and return immediately. Cannot throw, and cannot be
    /// awaited by accident — the returned task is void.
    /// </summary>
    public void Fire(RankCaptureTrigger trigger, CancellationToken cancellationToken = default)
    {
        try
        {
            var task = Task.Run(() => CaptureAsync(trigger, cancellationToken), CancellationToken.None);
            lock (_gate) _pending = task;
        }
        catch
        {
            // Task.Run only throws if the scheduler is gone, i.e. shutdown.
        }
    }

    /// <summary>
    /// One capture, start to finish. <b>Never throws</b>, for any input, from
    /// any dependency. Callers on a game path must still prefer
    /// <see cref="Fire"/> — not throwing is not the same as not taking time.
    /// </summary>
    public async Task CaptureAsync(RankCaptureTrigger trigger, CancellationToken cancellationToken = default)
    {
        try
        {
            await CaptureCoreAsync(trigger, cancellationToken).ConfigureAwait(false);
        }
        catch (Exception error)
        {
            // Throttled, keyed per trigger: a client that is going to fail this
            // read is going to fail it again in 90 seconds, and the file this
            // lands in is the one the user is asked to send us.
            SafeLog(() => _log.Error(
                $"rank-sample-{trigger}",
                $"rank-sample: {Name(trigger)} capture failed: {error.GetType().Name}"));
        }
    }

    private async Task CaptureCoreAsync(RankCaptureTrigger trigger, CancellationToken cancellationToken)
    {
        var secret = ReadSecret();
        if (secret is null)
        {
            // Once per process. Without this line the feature's total observable
            // behaviour when unconfigured is "nothing happens", which is
            // indistinguishable from it being broken.
            lock (_gate)
            {
                if (_announcedMissingSecret) return;
                _announcedMissingSecret = true;
            }
            SafeLog(() => _log.Info("rank-sample: no account secret configured -- LP capture is inert"));
            return;
        }

        var identity = await ReadIdentityAsync(cancellationToken).ConfigureAwait(false);
        if (identity is null)
        {
            SafeLog(() => _log.Error($"rank-sample-identity-{trigger}",
                $"rank-sample: {Name(trigger)} skipped -- client identity unavailable"));
            return;
        }

        var sample = await ReadSampleAsync(trigger, cancellationToken).ConfigureAwait(false);
        if (sample is null)
        {
            SafeLog(() => _log.Error($"rank-sample-unranked-{trigger}",
                $"rank-sample: {Name(trigger)} skipped -- no ranked-solo standing to record"));
            return;
        }

        lock (_gate) _lastObserved = sample;

        var body = RankSampleBody.Create(identity, sample, _time.GetUtcNow());
        var result = await _sink.PostAsync(body, secret, cancellationToken).ConfigureAwait(false);

        // Tier/division/LP are the account's ladder position, not an identifier,
        // and they are the only thing that makes this line worth having. The
        // identity that travelled on the wire is deliberately absent.
        SafeLog(() => _log.Info(
            $"rank-sample: {Name(trigger)} {sample.Tier}" +
            $"{(sample.Division is null ? string.Empty : " " + sample.Division)} " +
            $"{sample.LeaguePoints}lp -> {result.ToString().ToLowerInvariant()}",
            secrets: [secret]));
    }

    /// <summary>
    /// The ranked reading, with the game-end settle loop.
    ///
    /// <para><b>Why game end retries.</b> Leaving <c>InProgress</c> is the
    /// client noticing the game is over; it is not the platform having finished
    /// scoring it. The LCU's ranked stats can still be reporting the PRE-game
    /// number at that instant, and a sample taken then is worse than useless:
    /// spec §6 calls a bracket <c>exact</c> when a sample exists at or after the
    /// session's last game, so a stale one would make the last game of every
    /// session vanish from the total while still being labelled exact.</para>
    ///
    /// <para>So it re-reads until the value moves, bounded by
    /// <see cref="RankCaptureOptions.MaximumSettleWindow"/>. If the budget runs
    /// out it posts whatever it has anyway — a dodge, a remake or an
    /// already-settled read all legitimately leave LP unchanged, and refusing to
    /// record those would silently delete the bracket edge for them.</para>
    /// </summary>
    private async Task<RankSample?> ReadSampleAsync(RankCaptureTrigger trigger, CancellationToken cancellationToken)
    {
        var extraAttempts = trigger == RankCaptureTrigger.GameEnd
            ? Math.Max(0, _options.GameEndSettleAttempts)
            : 0;
        RankSample? sample = null;
        RankSample? baseline;
        lock (_gate) baseline = _lastObserved;

        for (var attempt = 0; attempt <= extraAttempts; attempt++)
        {
            if (cancellationToken.IsCancellationRequested) break;
            var response = await _lcu.SendAsync(
                HttpMethod.Get,
                RankedStats.CurrentRankedStatsPath,
                cancellationToken: cancellationToken).ConfigureAwait(false);
            sample = response.Ok ? RankedStats.ReadSoloQueue(response.Content) : null;

            // An unranked/unreadable account will still be unranked in five
            // seconds; only a settled-vs-unsettled NUMBER is worth waiting on.
            if (sample is null) break;
            if (baseline is null || !SameStanding(sample, baseline)) break;
            if (attempt == extraAttempts) break;
            await _delay(_options.ResolvedSettleDelay, cancellationToken).ConfigureAwait(false);
        }

        return sample;
    }

    private static bool SameStanding(RankSample left, RankSample right) =>
        left.LeaguePoints == right.LeaguePoints &&
        string.Equals(left.Tier, right.Tier, StringComparison.Ordinal) &&
        string.Equals(left.Division, right.Division, StringComparison.Ordinal);

    private async Task<OwnIdentity?> ReadIdentityAsync(CancellationToken cancellationToken)
    {
        var response = await _lcu.SendAsync(
            HttpMethod.Get,
            "/lol-summoner/v1/current-summoner",
            cancellationToken: cancellationToken).ConfigureAwait(false);
        return response.Ok && response.Content is { } content
            ? OwnIdentityConverter.TryConvert(content)
            : null;
    }

    /// <summary>A settings read is someone else's file IO; it does not get to throw in here.</summary>
    private string? ReadSecret()
    {
        try
        {
            var value = _secret()?.Trim();
            return string.IsNullOrEmpty(value) ? null : value;
        }
        catch
        {
            return null;
        }
    }

    private static void SafeLog(Action write)
    {
        try { write(); } catch { /* diagnostics are fail-soft by design */ }
    }

    private static string Name(RankCaptureTrigger trigger) => trigger switch
    {
        RankCaptureTrigger.AppStart => "app-start",
        RankCaptureTrigger.ChampSelect => "champ-select",
        RankCaptureTrigger.GameEnd => "game-end",
        _ => "unknown"
    };

    /// <summary>
    /// The phases during which a game is being played. <c>Reconnect</c> is in the
    /// set on purpose: a player who drops and reconnects passes
    /// InProgress -> Reconnect -> InProgress, and treating that as a game ending
    /// would post a mid-game sample and then fail to post a real one.
    /// </summary>
    internal static bool IsInGamePhase(string? phase) =>
        string.Equals(phase, "InProgress", StringComparison.Ordinal) ||
        string.Equals(phase, "Reconnect", StringComparison.Ordinal);

    /// <summary>A transition OUT of the in-game phases, and only that.</summary>
    internal static bool LeftGame(string? before, string? after) =>
        IsInGamePhase(before) && !IsInGamePhase(after);
}
