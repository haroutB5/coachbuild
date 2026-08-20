using System.Text;

namespace CoachBuild.Core;

public sealed class RedactedLog
{
    private readonly object _gate = new();
    private readonly string _path;
    private readonly int _maxBytes;
    private readonly bool _discarding;
    private readonly Dictionary<string, DateTimeOffset> _lastErrorAt = new(StringComparer.Ordinal);
    private string? _lastError;

    public RedactedLog(string? baseDirectory = null, int maxBytes = CompanionWire.MaxLogBytes)
    {
        var directory = baseDirectory ?? Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "CoachBuild");
        _path = Path.Combine(directory, "companion.log");
        _maxBytes = Math.Max(1024, maxBytes);
    }

    private RedactedLog(bool discarding)
    {
        _discarding = discarding;
        _path = string.Empty;
        _maxBytes = 1024;
    }

    /// <summary>
    /// A log that writes nowhere, and the default for any component whose
    /// caller did not supply one.
    ///
    /// <para>WHY THIS EXISTS. The parameterless <see cref="RedactedLog"/>
    /// resolves to the USER'S real
    /// <c>%LOCALAPPDATA%\CoachBuild\companion.log</c>. The shipped app never
    /// relies on that default (App.xaml.cs builds its log from
    /// <c>Paths.Root</c> and passes it in), so the only callers that ever hit
    /// it are tests and harnesses -- which meant every <c>dotnet test</c> run
    /// appended bridge lines to the one artifact used to diagnose real
    /// in-game sessions. 327 of the 349 <c>apply-runes</c> lines in that file
    /// on 2026-08-20 were written by WireContractReplayTests, not by the
    /// product, and two investigations were spent on them. Diagnostics that
    /// invent their own evidence are worse than no diagnostics.</para>
    /// </summary>
    public static RedactedLog Discarding { get; } = new(discarding: true);

    /// <summary>True for <see cref="Discarding"/> only.</summary>
    public bool IsDiscarding => _discarding;

    /// <summary>The log file, or an empty string for <see cref="Discarding"/>.</summary>
    public string FilePath => _path;
    public string? LastError { get { lock (_gate) return _lastError; } }

    public void Info(string message, IEnumerable<string>? secrets = null) =>
        Append(message, false, secrets);

    public void Error(string key, string message, IEnumerable<string>? secrets = null, TimeSpan? throttle = null)
    {
        var safe = ComplianceRules.Redact(message, secrets);
        lock (_gate)
        {
            _lastError = safe;
            var now = DateTimeOffset.UtcNow;
            var interval = throttle ?? TimeSpan.FromSeconds(60);
            if (_lastErrorAt.TryGetValue(key, out var previous) && now - previous < interval)
                return;
            _lastErrorAt[key] = now;
            AppendLocked(safe);
        }
    }

    public void Append(string message, bool error = false, IEnumerable<string>? secrets = null)
    {
        var safe = ComplianceRules.Redact(message, secrets)
            .Replace('\r', ' ')
            .Replace('\n', ' ');
        lock (_gate) AppendLocked(safe);
    }

    private void AppendLocked(string safeMessage)
    {
        if (_discarding) return;
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(_path)!);
            TrimIfNeededLocked();
            var line = $"{DateTimeOffset.UtcNow:O} {safeMessage}{Environment.NewLine}";
            File.AppendAllText(_path, line, new UTF8Encoding(false));
        }
        catch
        {
            // Diagnostics are fail-soft by design.
        }
    }

    private void TrimIfNeededLocked()
    {
        try
        {
            if (!File.Exists(_path)) return;
            var bytes = new FileInfo(_path).Length;
            if (bytes <= _maxBytes) return;
            var data = File.ReadAllBytes(_path);
            var keepFrom = data.Length / 2;
            while (keepFrom < data.Length && data[keepFrom] is not ((byte)'\n') and not ((byte)'\r'))
                keepFrom++;
            if (keepFrom < data.Length) keepFrom++;
            File.WriteAllBytes(_path, data[keepFrom..]);
        }
        catch
        {
            // A locked log should not block the next event.
        }
    }
}

