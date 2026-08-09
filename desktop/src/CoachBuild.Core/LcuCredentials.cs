using System.Management;
using System.Text.Json;
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
            // The UX process has appeared under both LeagueClientUx.exe and
            // LeagueClientUxRender.exe. Query the family instead of assuming
            // one exact executable name; the parser applies the final allowlist.
            using var searcher = new ManagementObjectSearcher(
                "SELECT Name, CommandLine FROM Win32_Process WHERE Name LIKE 'LeagueClient%'");
            using var processes = searcher.Get();
            foreach (ManagementObject process in processes)
            {
                using (process)
                {
                    var name = process["Name"] as string;
                    var commandLine = process["CommandLine"] as string;
                    if (!string.IsNullOrWhiteSpace(name) &&
                        LcuCredentialParser.IsLeagueClientProcessName(name))
                    {
                        // CommandLine is legitimately null for an elevated
                        // client when the WMI caller cannot read it. Preserve
                        // the row so the resolver can continue to later layers.
                        result.Add(new LeagueClientProcess(name, commandLine));
                    }
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

public sealed record LcuDiscoveryLayerFailure(string Layer, string Reason);

public static partial class LcuCredentialParser
{
    private static readonly string[] RiotInstallProperties =
    [
        "associated_client",
        "rc_default",
        "rc_live",
        // Older/current manifests can also retain this path. It is harmless
        // to accept it and helps when the client has only partially refreshed
        // the primary entries.
        "KeystoneLocationLiveWin"
    ];

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

    /// <summary>
    /// Extracts the path-bearing entries from Riot's install manifest. The
    /// manifest has used both arrays and scalar values, so extraction is
    /// intentionally structural and only visits the known entry names.
    /// </summary>
    public static IReadOnlyList<string> ParseRiotClientInstallsJson(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) return Array.Empty<string>();
        try
        {
            using var document = JsonDocument.Parse(raw);
            if (document.RootElement.ValueKind != JsonValueKind.Object)
                return Array.Empty<string>();

            var paths = new List<string>();
            foreach (var property in document.RootElement.EnumerateObject())
            {
                if (!IsRiotInstallProperty(property.Name)) continue;
                CollectPathStrings(property.Value, paths, depth: 0);
            }
            return paths
                .Where(static path => !string.IsNullOrWhiteSpace(path))
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToArray();
        }
        catch
        {
            // A partially-written or future-shaped manifest must never block
            // the hardcoded, process, or fixed-drive discovery layers.
            return Array.Empty<string>();
        }
    }

    public static IReadOnlyList<string> ParseRiotClientInstalls(string? raw) =>
        ParseRiotClientInstallsJson(raw);

    /// <summary>
    /// Reads the single path value needed from Riot's product settings YAML.
    /// A full YAML dependency is unnecessary here: this is a scalar key in a
    /// vendor-owned file, so parsing is kept bounded and fail-soft.
    /// </summary>
    public static string? ParseProductSettingsYaml(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) return null;

        foreach (var line in raw.Split(["\r\n", "\n", "\r"], StringSplitOptions.None))
        {
            var trimmed = line.Trim();
            if (trimmed.Length == 0 || trimmed.StartsWith('#')) continue;
            var separator = trimmed.IndexOf(':');
            if (separator <= 0 ||
                !string.Equals(trimmed[..separator].Trim(), "product_install_full_path", StringComparison.OrdinalIgnoreCase))
                continue;

            return ParseYamlScalar(trimmed[(separator + 1)..].Trim());
        }

        return null;
    }

    public static string? ParseProductSettings(string? raw) => ParseProductSettingsYaml(raw);

    public static bool IsLeagueClientProcessName(string? name)
    {
        if (string.IsNullOrWhiteSpace(name)) return false;
        var processName = Path.GetFileNameWithoutExtension(name.Trim());
        return string.Equals(processName, "LeagueClient", StringComparison.OrdinalIgnoreCase) ||
            processName.StartsWith("LeagueClientUx", StringComparison.OrdinalIgnoreCase);
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

    private static bool IsRiotInstallProperty(string name) =>
        RiotInstallProperties.Any(property => string.Equals(property, name, StringComparison.OrdinalIgnoreCase));

    private static void CollectPathStrings(JsonElement element, ICollection<string> paths, int depth)
    {
        if (depth > 4) return;
        switch (element.ValueKind)
        {
            case JsonValueKind.String:
                var value = element.GetString()?.Trim();
                if (IsPathLike(value)) paths.Add(value!);
                break;
            case JsonValueKind.Array:
                foreach (var item in element.EnumerateArray())
                    CollectPathStrings(item, paths, depth + 1);
                break;
            case JsonValueKind.Object:
                foreach (var property in element.EnumerateObject())
                    CollectPathStrings(property.Value, paths, depth + 1);
                break;
        }
    }

    private static bool IsPathLike(string? value) =>
        !string.IsNullOrWhiteSpace(value) &&
        (value.Contains('\\') || value.Contains('/') ||
         (value.Length >= 2 && value[1] == ':'));

    private static string? ParseYamlScalar(string value)
    {
        if (value.Length == 0) return null;
        if (value[0] == '"')
        {
            if (value.Length < 2 || value[^1] != '"') return null;
            return value[1..^1]
                .Replace("\\\"", "\"", StringComparison.Ordinal)
                .Replace("\\\\", "\\", StringComparison.Ordinal)
                .Trim();
        }

        if (value[0] == '\'')
        {
            if (value.Length < 2 || value[^1] != '\'') return null;
            return value[1..^1].Replace("''", "'", StringComparison.Ordinal).Trim();
        }

        var comment = value.IndexOf(" #", StringComparison.Ordinal);
        if (comment >= 0) value = value[..comment];
        return value.Trim();
    }
}

public sealed class LcuCredentialResolver
{
    private readonly object _gate = new();
    private readonly ILeagueClientProcessSource _processSource;
    private readonly Func<string?, string?> _lockfileReader;
    private readonly Func<string?, string?> _metadataReader;
    private readonly string[] _lockfilePaths;
    private readonly string _riotClientInstallsPath;
    private readonly string _productSettingsPath;
    private readonly TimeSpan _negativeCacheDuration;
    private readonly Func<IEnumerable<string>> _fixedDriveLockfilePathsProvider;
    private readonly Action<string>? _diagnosticSink;
    private LcuCredentials? _cached;
    private DateTimeOffset? _negativeCachedUntil;
    private IReadOnlyList<string>? _fixedDriveLockfilePaths;
    private string? _fixedDriveEnumerationReason;
    private bool _failureDiagnosticEmitted;

    public LcuCredentialResolver(
        ILeagueClientProcessSource? processSource = null,
        Func<string?, string?>? lockfileReader = null,
        string? lockfilePath = null,
        TimeSpan? negativeCacheDuration = null,
        string? programDataDirectory = null,
        Func<string?, string?>? metadataReader = null,
        Func<IEnumerable<string>>? fixedDriveLockfilePathsProvider = null,
        Action<string>? diagnosticSink = null)
    {
        _processSource = processSource ?? new WindowsLeagueClientProcessSource();
        _lockfileReader = lockfileReader ?? LcuCredentialParser.ReadLockfile;
        _metadataReader = metadataReader ?? _lockfileReader;
        _negativeCacheDuration = negativeCacheDuration ?? TimeSpan.FromSeconds(5);
        if (_negativeCacheDuration < TimeSpan.FromSeconds(5) || _negativeCacheDuration > TimeSpan.FromSeconds(10))
            throw new ArgumentOutOfRangeException(nameof(negativeCacheDuration), "Negative credential cache must be 5-10 seconds.");

        var environmentProgramData = Environment.GetEnvironmentVariable("PROGRAMDATA");
        var resolvedProgramData = string.IsNullOrWhiteSpace(programDataDirectory)
            ? (string.IsNullOrWhiteSpace(environmentProgramData)
                ? Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData)
                : environmentProgramData)
            : programDataDirectory;
        resolvedProgramData ??= string.Empty;
        _riotClientInstallsPath = Path.Combine(resolvedProgramData, "Riot Games", "RiotClientInstalls.json");
        _productSettingsPath = Path.Combine(
            resolvedProgramData,
            "Riot Games",
            "Metadata",
            "league_of_legends.live",
            "league_of_legends.live.product_settings.yaml");

        var defaultPath = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86),
            "Riot Games", "League of Legends", "lockfile");
        var defaultProgramFilesPath = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
            "Riot Games", "League of Legends", "lockfile");
        _lockfilePaths = string.IsNullOrWhiteSpace(lockfilePath)
            ? [
                // Riot's default installation path is the first candidate on
                // standard 64-bit Windows installations.
                @"C:\Riot Games\League of Legends\lockfile",
                defaultPath,
                defaultProgramFilesPath
            ]
            : [lockfilePath];

        _fixedDriveLockfilePathsProvider = fixedDriveLockfilePathsProvider ?? EnumerateFixedDriveLockfiles;
        _diagnosticSink = diagnosticSink;
    }

    public LcuCredentials? Resolve()
    {
        lock (_gate)
        {
            if (_cached is not null) return _cached;
            if (_negativeCachedUntil is { } negativeUntil && negativeUntil > DateTimeOffset.UtcNow)
                return null;

            var failures = new List<LcuDiscoveryLayerFailure>(capacity: 4);

            var credentials = TryRiotInstallMetadata(out var registryReason);
            if (credentials is not null) return CacheSuccess(credentials);
            failures.Add(new LcuDiscoveryLayerFailure("riot-install-registry", registryReason));

            credentials = TryLockfilePaths(_lockfilePaths, _lockfileReader, out var hardcodedReason);
            if (credentials is not null) return CacheSuccess(credentials);
            failures.Add(new LcuDiscoveryLayerFailure("hardcoded-lockfiles", hardcodedReason));

            credentials = TryProcessArguments(out var processReason);
            if (credentials is not null) return CacheSuccess(credentials);
            failures.Add(new LcuDiscoveryLayerFailure("wmi-process-commandline", processReason));

            credentials = TryFixedDriveLockfiles(out var fixedDriveReason);
            if (credentials is not null) return CacheSuccess(credentials);
            failures.Add(new LcuDiscoveryLayerFailure("fixed-drive-lockfiles", fixedDriveReason));

            _negativeCachedUntil = DateTimeOffset.UtcNow + _negativeCacheDuration;
            EmitFailureDiagnostic(failures);
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

    private LcuCredentials? TryRiotInstallMetadata(out string reason)
    {
        var details = new List<string>();
        var installPaths = new List<string>();

        var manifest = ReadMetadata(_riotClientInstallsPath, out var manifestReadReason);
        if (manifest is null)
        {
            details.Add($"RiotClientInstalls.json={manifestReadReason}");
        }
        else
        {
            var parsed = LcuCredentialParser.ParseRiotClientInstallsJson(manifest);
            if (parsed.Count == 0)
                details.Add("RiotClientInstalls.json=malformed-or-no-known-path");
            else
                installPaths.AddRange(parsed);
        }

        var productSettings = ReadMetadata(_productSettingsPath, out var productReadReason);
        if (productSettings is null)
        {
            details.Add($"product_settings.yaml={productReadReason}");
        }
        else
        {
            var parsed = LcuCredentialParser.ParseProductSettingsYaml(productSettings);
            if (string.IsNullOrWhiteSpace(parsed))
                details.Add("product_settings.yaml=malformed-or-missing-product-install-full-path");
            else
                installPaths.Add(parsed);
        }

        var lockfilePaths = installPaths
            .Select(BuildLockfilePath)
            .Where(static path => !string.IsNullOrWhiteSpace(path))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToArray();
        var credentials = TryLockfilePaths(lockfilePaths, _lockfileReader, out var lockfileReason);
        if (credentials is not null)
        {
            reason = "found";
            return credentials;
        }

        if (lockfilePaths.Length == 0)
            details.Add("league-lockfiles=no-candidates");
        else
            details.Add($"league-lockfiles={lockfileReason}");
        reason = string.Join(';', details);
        return null;
    }

    private LcuCredentials? TryLockfilePaths(
        IEnumerable<string?> paths,
        Func<string?, string?> reader,
        out string reason)
    {
        var details = new List<string>();
        var candidates = paths
            .Where(static path => !string.IsNullOrWhiteSpace(path))
            .Select(static path => path!)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToArray();
        if (candidates.Length == 0)
        {
            reason = "no-candidates";
            return null;
        }

        foreach (var path in candidates)
        {
            string? raw;
            try
            {
                raw = reader(path);
            }
            catch (Exception error)
            {
                details.Add($"{FormatPath(path)}=unreadable:{error.GetType().Name}");
                continue;
            }

            var credentials = LcuCredentialParser.ParseLockfile(raw);
            if (credentials is not null)
            {
                reason = $"{FormatPath(path)}=found";
                return credentials;
            }
            details.Add($"{FormatPath(path)}={(raw is null ? "missing-or-unreadable" : "invalid")}");
        }

        reason = string.Join(',', details);
        return null;
    }

    private LcuCredentials? TryProcessArguments(out string reason)
    {
        var details = new List<string>();
        var matchingProcesses = 0;
        try
        {
            foreach (var process in _processSource.GetProcesses() ?? Array.Empty<LeagueClientProcess>())
            {
                if (!LcuCredentialParser.IsLeagueClientProcessName(process.Name)) continue;
                matchingProcesses++;
                if (string.IsNullOrWhiteSpace(process.CommandLine))
                {
                    details.Add($"{process.Name}=command-line-empty");
                    // Elevated/access-denied WMI rows are expected. Do not
                    // conclude absence: continue to the fixed-drive layer.
                    continue;
                }

                var credentials = LcuCredentialParser.ParseProcessArguments(process.CommandLine);
                if (credentials is not null)
                {
                    reason = "found";
                    return credentials;
                }
                details.Add($"{process.Name}=command-line-invalid");
            }
        }
        catch (Exception error)
        {
            details.Add($"enumeration-failed:{error.GetType().Name}");
        }

        if (matchingProcesses == 0 && details.Count == 0)
            details.Add("no-matching-process");
        reason = string.Join(',', details);
        return null;
    }

    private LcuCredentials? TryFixedDriveLockfiles(out string reason)
    {
        var paths = GetFixedDriveLockfilePaths();
        var credentials = TryLockfilePaths(paths, _lockfileReader, out var lockfileReason);
        if (credentials is not null)
        {
            reason = "found";
            return credentials;
        }

        var prefix = _fixedDriveEnumerationReason is null
            ? $"drives={paths.Count}"
            : $"drives={paths.Count}; enumeration={_fixedDriveEnumerationReason}";
        reason = $"{prefix}; lockfiles={lockfileReason}";
        return null;
    }

    private IReadOnlyList<string> GetFixedDriveLockfilePaths()
    {
        if (_fixedDriveLockfilePaths is not null) return _fixedDriveLockfilePaths;

        try
        {
            _fixedDriveLockfilePaths = (_fixedDriveLockfilePathsProvider() ?? Array.Empty<string>())
                .Where(static path => !string.IsNullOrWhiteSpace(path))
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToArray();
        }
        catch (Exception error)
        {
            _fixedDriveEnumerationReason = error.GetType().Name;
            _fixedDriveLockfilePaths = Array.Empty<string>();
        }

        return _fixedDriveLockfilePaths;
    }

    private string? ReadMetadata(string path, out string reason)
    {
        try
        {
            var raw = _metadataReader(path);
            reason = raw is null ? "missing-or-unreadable" : "available";
            return raw;
        }
        catch (Exception error)
        {
            reason = $"unreadable:{error.GetType().Name}";
            return null;
        }
    }

    private LcuCredentials CacheSuccess(LcuCredentials credentials)
    {
        _negativeCachedUntil = null;
        _failureDiagnosticEmitted = false;
        return _cached = credentials;
    }

    private void EmitFailureDiagnostic(IReadOnlyList<LcuDiscoveryLayerFailure> failures)
    {
        if (_failureDiagnosticEmitted) return;
        _failureDiagnosticEmitted = true;
        var payload = new
        {
            @event = "lcu_discovery_failed",
            layers = failures.Select(static failure => new { layer = failure.Layer, reason = failure.Reason })
        };
        var line = JsonSerializer.Serialize(payload);
        try { _diagnosticSink?.Invoke(line); }
        catch { /* Diagnostics must never make discovery fail. */ }
    }

    private static string? BuildLockfilePath(string? installPath)
    {
        if (string.IsNullOrWhiteSpace(installPath)) return null;
        try
        {
            var normalized = installPath.Trim().Trim('"', '\'');
            normalized = normalized.Replace('/', Path.DirectorySeparatorChar);
            if (normalized.EndsWith(Path.DirectorySeparatorChar))
                normalized = normalized.TrimEnd(Path.DirectorySeparatorChar);
            if (string.Equals(Path.GetFileName(normalized), "lockfile", StringComparison.OrdinalIgnoreCase))
                return normalized;

            var fileName = Path.GetFileName(normalized);
            if (fileName.EndsWith(".exe", StringComparison.OrdinalIgnoreCase))
                normalized = Path.GetDirectoryName(normalized) ?? normalized;
            return Path.Combine(normalized, "lockfile");
        }
        catch
        {
            // A malformed vendor path is only one candidate failure; the next
            // discovery layer must still run.
            return null;
        }
    }

    private static string FormatPath(string path) => path.Replace('\\', '/');

    private static IEnumerable<string> EnumerateFixedDriveLockfiles()
    {
        var paths = new List<string>();
        if (!OperatingSystem.IsWindows()) return paths;

        try
        {
            foreach (var drive in DriveInfo.GetDrives())
            {
                try
                {
                    if (drive.DriveType != DriveType.Fixed) continue;
                    var root = drive.RootDirectory.FullName;
                    if (string.IsNullOrWhiteSpace(root)) continue;
                    // Bounded, non-recursive final fallback: inspect one known
                    // Riot path per fixed drive and nothing else.
                    paths.Add(Path.Combine(root, "Riot Games", "League of Legends", "lockfile"));
                }
                catch
                {
                    // A disconnected/unreadable drive is simply not a candidate.
                }
            }
        }
        catch
        {
            // Drive enumeration is best effort; the caller reports no paths.
        }

        return paths;
    }
}
