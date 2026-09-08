namespace CoachBuild.Core;

/// <summary>
/// Sends the tail of companion.log to My Stats, when the user asks for it from
/// the tray, and never on any other trigger.
///
/// <para><b>USER-TRIGGERED ONLY.</b> There is no timer, no phase hook and no
/// startup call anywhere in this file, and that is a product decision rather
/// than an unfinished one. Shipping a log the user pressed a button to send is
/// a diagnostics feature; shipping the same log on a schedule is telemetry, and
/// telemetry is a different product with a different consent conversation. If a
/// future change wants an automatic upload it needs that conversation first, not
/// a call site here.</para>
///
/// <para><b>The one rule this class inherits.</b> Same as
/// <see cref="RankCaptureService"/>: an upload fails silently with respect to
/// gameplay and NEVER blocks, delays or degrades an item-set or rune apply.
/// Three things enforce it and all three are tested:</para>
/// <list type="number">
/// <item>Nothing awaits an upload. <see cref="Fire"/> detaches onto the thread
/// pool and returns void; <see cref="PendingUpload"/> exists so a TEST can
/// settle deterministically, and production never reads it.</item>
/// <item>The whole body is inside a catch. <see cref="UploadAsync"/> has no
/// throw path at all — not for a dead LCU, not for an unreadable log, not for a
/// secret source that throws, not for a sink that throws, not for the caller's
/// own result callback throwing.</item>
/// <item>It takes no lock an apply path takes, and issues its one LCU read
/// through the same <see cref="ILcuApi"/> without serialising against them.
/// An upload wedged on a hung read leaves an apply completely untouched.</item>
/// </list>
///
/// <para><b>Why this exists at all.</b> The user runs CoachBuild on a separate
/// gaming PC and cannot copy a file off it. Diagnosing an in-game bug has meant
/// asking them to PHOTOGRAPH two hundred lines of log. The companion already
/// authenticates to the web app to post LP samples, so the channel and the
/// credential both already exist; this gives them a second use.</para>
/// </summary>
public sealed class DiagnosticsUploadService
{
    private readonly ILcuApi _lcu;
    private readonly IDiagnosticsSink _sink;
    private readonly Func<string?> _secret;
    private readonly Func<string?> _logPath;
    private readonly RedactedLog _log;
    private readonly Func<string?, int, string?> _readTail;

    private readonly object _gate = new();
    private Task? _pending;

    public DiagnosticsUploadService(
        ILcuApi lcu,
        IDiagnosticsSink sink,
        Func<string?> secret,
        Func<string?> logPath,
        RedactedLog? log = null,
        Func<string?, int, string?>? readTail = null)
    {
        _lcu = lcu ?? throw new ArgumentNullException(nameof(lcu));
        _sink = sink ?? throw new ArgumentNullException(nameof(sink));
        _secret = secret ?? throw new ArgumentNullException(nameof(secret));
        _logPath = logPath ?? throw new ArgumentNullException(nameof(logPath));
        // NOT `new RedactedLog()`: that resolves to the user's real
        // companion.log. See RedactedLog.Discarding and BridgeLogIsolationTests.
        _log = log ?? RedactedLog.Discarding;
        _readTail = readTail ?? LogTail.Read;
    }

    /// <summary>
    /// The most recent upload, for tests to await. Production NEVER reads this —
    /// the moment anything on the apply side does, rule 1 above is gone.
    /// </summary>
    public Task? PendingUpload { get { lock (_gate) return _pending; } }

    /// <summary>
    /// Start an upload and return immediately. Cannot throw, and cannot be
    /// awaited by accident — the return type is void.
    /// </summary>
    /// <param name="report">
    /// Called once with the outcome, on a thread-pool thread. The caller
    /// marshals it wherever its UI lives; a callback that throws is swallowed
    /// here rather than becoming an unobserved task exception.
    /// </param>
    public void Fire(Action<DiagnosticsUploadOutcome>? report = null, CancellationToken cancellationToken = default)
    {
        try
        {
            var task = Task.Run(
                async () =>
                {
                    var outcome = await UploadAsync(cancellationToken).ConfigureAwait(false);
                    try { report?.Invoke(outcome); }
                    catch { /* someone else's UI is not this class's failure mode */ }
                },
                CancellationToken.None);
            lock (_gate) _pending = task;
        }
        catch
        {
            // Task.Run only throws if the scheduler is gone, i.e. shutdown.
        }
    }

    /// <summary>
    /// One upload, start to finish. <b>Never throws</b>, for any input, from any
    /// dependency. Callers on a game path must still prefer <see cref="Fire"/> —
    /// not throwing is not the same as not taking time.
    /// </summary>
    public async Task<DiagnosticsUploadOutcome> UploadAsync(CancellationToken cancellationToken = default)
    {
        DiagnosticsUploadOutcome outcome;
        try
        {
            outcome = await UploadCoreAsync(cancellationToken).ConfigureAwait(false);
        }
        catch (Exception error)
        {
            outcome = DiagnosticsUploadOutcome.Failed;
            SafeLog(() => _log.Error(
                "diagnostics-upload",
                $"diagnostics: upload failed ({error.GetType().Name})"));
        }
        return outcome;
    }

    /// <summary>
    /// The order of the four gates is deliberate: cheapest and most likely
    /// misconfiguration first, network last.
    /// </summary>
    private async Task<DiagnosticsUploadOutcome> UploadCoreAsync(CancellationToken cancellationToken)
    {
        var secret = ReadSecret();
        if (secret is null) return Report(DiagnosticsUploadOutcome.NotPaired);

        var tail = ReadTail();
        if (string.IsNullOrWhiteSpace(tail)) return Report(DiagnosticsUploadOutcome.NoLog);

        var identity = await ReadIdentityAsync(cancellationToken).ConfigureAwait(false);
        if (identity is null) return Report(DiagnosticsUploadOutcome.NoIdentity);

        // THE SHARED POLICY, WITH THE SECRETS LIST. Not a private redactor:
        // ComplianceRules' own header says callers do not get to invent a second
        // policy, and a divergent one is how a credential leaks. The secret is
        // passed in because it is the one value that is definitely sensitive and
        // definitely not matched by any shape rule.
        var redacted = ComplianceRules.Redact(tail, secrets: [secret]);

        // Redaction can lengthen the text, so the WIRE cap is applied after it
        // and against the server's own number. See DiagnosticsBody.MaxWireBytes.
        var body = DiagnosticsBody.Create(identity, LogTail.LimitBytes(redacted, DiagnosticsBody.MaxWireBytes));
        if (body.Body.Length == 0) return Report(DiagnosticsUploadOutcome.NoLog);

        var result = await _sink.PostAsync(body, secret, cancellationToken).ConfigureAwait(false);
        return Report(result switch
        {
            RankSamplePostResult.Posted => DiagnosticsUploadOutcome.Sent,
            RankSamplePostResult.Rejected => DiagnosticsUploadOutcome.Rejected,
            _ => DiagnosticsUploadOutcome.Failed,
        });
    }

    /// <summary>
    /// One greppable line per outcome, unthrottled.
    ///
    /// <para>Unthrottled because this only ever runs on a click: there is no
    /// loop to spam the file, and throttling the ONE line that explains what the
    /// user just saw would recreate the silent no-op the feature exists to
    /// remove. Nothing here can carry the log's contents or the secret — the
    /// vocabulary is <see cref="DiagnosticsMessages.LogWord"/> and nothing
    /// else.</para>
    /// </summary>
    private DiagnosticsUploadOutcome Report(DiagnosticsUploadOutcome outcome)
    {
        SafeLog(() => _log.Info($"diagnostics: upload {DiagnosticsMessages.LogWord(outcome)}"));
        return outcome;
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

    private string? ReadTail()
    {
        try
        {
            return _readTail(_logPath(), LogTail.MaxTailBytes);
        }
        catch
        {
            return null;
        }
    }

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

    private static void SafeLog(Action write)
    {
        try { write(); } catch { /* diagnostics are fail-soft by design */ }
    }
}
