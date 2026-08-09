using System.Management;
using System.Text.RegularExpressions;

namespace CoachBuild.Core;

public sealed record LeagueClientProcess(string Name, string? CommandLine);

public interface ILeagueClientProcessSource
{
    IEnumerable<LeagueClientProcess> GetProcesses();
}

/// <summary>
/// Process discovery is intentionally injectable. Win32_Process exposes the
/// command line through CIM/WMI without opening the Riot process or walking its
/// PEB. That keeps credential discovery out of the process-memory access path.
/// </summary>
public sealed class WindowsLeagueClientProcessSource : ILeagueClientProcessSource
{
    public IEnumerable<LeagueClientProcess> GetProcesses()
    {
        var result = new List<LeagueClientProcess>();
        if (!OperatingSystem.IsWindows()) return result;

        try
        {
            using var searcher = new ManagementObjectSearcher(
                "SELECT Name, CommandLine FROM Win32_Process WHERE Name='LeagueClientUx.exe'");
            using var processes = searcher.Get();
            foreach (ManagementObject process in processes)
            {
                using (process)
                {
                    var name = process["Name"] as string;
                    var commandLine = process["CommandLine"] as string;
                    if (!string.IsNullOrWhiteSpace(name))
                        result.Add(new LeagueClientProcess(name, commandLine));
                }
            }
        }
        catch
        {
            // WMI is best effort; no client is the normal idle state and the
            // resolver must still be null-safe if the provider is unavailable.
        }
        return result;
    }
}

public static partial class LcuCredentialParser
{
    public static LcuCredentials? ParseLockfile(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) return null;
        try
        {
            var fields = raw.Trim().Split(':');
            if (fields.Length < 5 || !int.TryParse(fields[2], out var port) || port <= 0 || port > 65535)
                return null;
            var token = fields[3].Trim();
            return string.IsNullOrWhiteSpace(token)
                ? null
                : new LcuCredentials(port, token, "lockfile");
        }
        catch
        {
            return null;
        }
    }

    public static LcuCredentials? ParseProcessArguments(string? commandLine)
    {
        if (string.IsNullOrWhiteSpace(commandLine)) return null;
        var portMatch = PortRegex().Match(commandLine);
        var tokenMatch = TokenRegex().Match(commandLine);
        if (!portMatch.Success || !tokenMatch.Success ||
            !int.TryParse(portMatch.Groups[1].Value, out var port) ||
            port <= 0 || port > 65535)
            return null;
        var token = (tokenMatch.Groups[1].Success
                ? tokenMatch.Groups[1].Value
                : tokenMatch.Groups[2].Value)
            .Trim()
            .Trim('"');
        return string.IsNullOrWhiteSpace(token)
            ? null
            : new LcuCredentials(port, token, "process-args");
    }

    [GeneratedRegex("(?:^|\\s)--app-port(?:=|\\s+)(\\d+)(?:\\s|$)", RegexOptions.IgnoreCase)]
    private static partial Regex PortRegex();

    [GeneratedRegex("(?:^|\\s)--remoting-auth-token(?:=|\\s+)(?:\"([^\"]+)\"|([^\\s]+))", RegexOptions.IgnoreCase)]
    private static partial Regex TokenRegex();

    public static string? ReadLockfile(string? path)
    {
        if (string.IsNullOrWhiteSpace(path) || !File.Exists(path)) return null;
        try { return File.ReadAllText(path); }
        catch { return null; }
    }
}

public sealed class LcuCredentialResolver
{
    private readonly object _gate = new();
    private readonly ILeagueClientProcessSource _processSource;
    private readonly Func<string?, string?> _lockfileReader;
    private readonly string[] _lockfilePaths;
    private readonly TimeSpan _negativeCacheDuration;
    private LcuCredentials? _cached;
    private DateTimeOffset? _negativeCachedUntil;

    public LcuCredentialResolver(
        ILeagueClientProcessSource? processSource = null,
        Func<string?, string?>? lockfileReader = null,
        string? lockfilePath = null,
        TimeSpan? negativeCacheDuration = null)
    {
        _processSource = processSource ?? new WindowsLeagueClientProcessSource();
        _lockfileReader = lockfileReader ?? LcuCredentialParser.ReadLockfile;
        _negativeCacheDuration = negativeCacheDuration ?? TimeSpan.FromSeconds(5);
        if (_negativeCacheDuration < TimeSpan.FromSeconds(5) || _negativeCacheDuration > TimeSpan.FromSeconds(10))
            throw new ArgumentOutOfRangeException(nameof(negativeCacheDuration), "Negative credential cache must be 5-10 seconds.");
        var defaultPath = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86),
            "Riot Games", "League of Legends", "lockfile");
        _lockfilePaths = string.IsNullOrWhiteSpace(lockfilePath)
            ? [
                // Riot's default installation path is the first candidate on
                // standard 64-bit Windows installations.
                @"C:\Riot Games\League of Legends\lockfile",
                defaultPath,
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
                    "Riot Games", "League of Legends", "lockfile")
            ]
            : [lockfilePath];
    }

    public LcuCredentials? Resolve()
    {
        lock (_gate)
        {
            if (_cached is not null) return _cached;
            if (_negativeCachedUntil is { } negativeUntil && negativeUntil > DateTimeOffset.UtcNow)
                return null;

            // Deliberately lockfile first. It is the stable source and avoids a
            // process command-line read on every cold start.
            foreach (var path in _lockfilePaths.Distinct(StringComparer.OrdinalIgnoreCase))
            {
                var credentials = LcuCredentialParser.ParseLockfile(_lockfileReader(path));
                if (credentials is not null)
                {
                    _negativeCachedUntil = null;
                    return _cached = credentials;
                }
            }

            try
            {
                foreach (var process in _processSource.GetProcesses())
                {
                    if (!string.Equals(process.Name, "LeagueClientUx", StringComparison.OrdinalIgnoreCase) &&
                        !string.Equals(process.Name, "LeagueClientUx.exe", StringComparison.OrdinalIgnoreCase))
                        continue;
                    var credentials = LcuCredentialParser.ParseProcessArguments(process.CommandLine);
                    if (credentials is not null)
                    {
                        _negativeCachedUntil = null;
                        return _cached = credentials;
                    }
                }
            }
            catch
            {
                // Discovery is best effort; no client is the normal idle state.
            }
            _negativeCachedUntil = DateTimeOffset.UtcNow + _negativeCacheDuration;
            return null;
        }
    }

    public LcuCredentials? GetCachedOrResolve() => Resolve();

    public void Invalidate()
    {
        lock (_gate)
        {
            _cached = null;
            _negativeCachedUntil = null;
        }
    }

    public LcuCredentials? Cached
    {
        get { lock (_gate) return _cached; }
    }
}
