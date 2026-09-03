namespace CoachBuild.Core;

/// <summary>
/// POST /client-log intake: the hosted page forwards its [autoExport]
/// decision lines here because its own console dies with the WebView2 window
/// at game start. Accepted lines are appended to companion.log prefixed with
/// "web: " (redacted by <see cref="RedactedLog"/> like every other line).
///
/// Bounds are the whole design: at most <see cref="MaxLinesPerRequest"/>
/// lines, each at most <see cref="MaxLineChars"/> chars, at most
/// <see cref="MaxTotalChars"/> chars total, and at most one accepted batch
/// per <see cref="MinInterval"/>. Anything outside is a 200
/// {ok:false, reason} — logging must never HTTP-error, because a logging
/// call that surfaces as a failure in the page would read as an export
/// failure. Throttle state is per service instance (one bridge, one log).
/// </summary>
public sealed class ClientLogService
{
    public const int MaxLinesPerRequest = 20;
    public const int MaxLineChars = 512;
    public const int MaxTotalChars = 4096;
    public static readonly TimeSpan MinInterval = TimeSpan.FromSeconds(1);

    private readonly RedactedLog _log;
    private readonly Func<DateTimeOffset> _clock;
    private readonly object _gate = new();
    private DateTimeOffset? _lastAcceptedAt;

    public ClientLogService(RedactedLog log, Func<DateTimeOffset>? clock = null)
    {
        _log = log;
        _clock = clock ?? (() => DateTimeOffset.UtcNow);
    }

    public ClientLogResult Accept(IReadOnlyList<string?>? lines)
    {
        if (lines is null || lines.Count == 0 || lines.Count > MaxLinesPerRequest)
            return new ClientLogResult(false, 0, "bad-body");
        var total = 0;
        foreach (var line in lines)
        {
            if (string.IsNullOrEmpty(line) || line.Length > MaxLineChars)
                return new ClientLogResult(false, 0, "bad-body");
            total += line.Length;
        }
        if (total > MaxTotalChars)
            return new ClientLogResult(false, 0, "bad-body");

        lock (_gate)
        {
            var now = _clock();
            if (_lastAcceptedAt.HasValue && now - _lastAcceptedAt.Value < MinInterval)
                return new ClientLogResult(false, 0, "throttled");
            _lastAcceptedAt = now;
        }

        foreach (var line in lines)
            _log.Info("web: " + line);
        return new ClientLogResult(true, lines.Count, null);
    }
}
