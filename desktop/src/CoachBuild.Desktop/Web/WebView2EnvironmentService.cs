using System.Diagnostics;
using Microsoft.Web.WebView2.Core;

namespace CoachBuild.Desktop.Web;

/// <summary>
/// Detects and creates the Evergreen per-user WebView2 runtime. No fixed
/// runtime binaries are shipped with CoachBuild; the installer/bootstrapper
/// owns the Evergreen prerequisite and this service only checks/repairs it.
/// </summary>
public sealed class WebView2EnvironmentService
{
    private static readonly TimeSpan DefaultRepairPollInterval = TimeSpan.FromSeconds(2);
    private static readonly TimeSpan DefaultRepairTimeout = TimeSpan.FromSeconds(120);

    private readonly string _userDataFolder;
    private readonly string _bootstrapperPath;
    private readonly Func<string?> _versionProbe;
    private readonly TimeSpan _repairPollInterval;
    private readonly TimeSpan _repairTimeout;
    private string? _lastProbeFailure;
    private int _lastProbeFailureWasRuntimeNotFound;

    public WebView2EnvironmentService(
        string userDataFolder,
        string? bootstrapperPath = null,
        Func<string?>? versionProbe = null,
        TimeSpan? repairPollInterval = null,
        TimeSpan? repairTimeout = null)
    {
        _userDataFolder = userDataFolder ?? throw new ArgumentNullException(nameof(userDataFolder));
        _bootstrapperPath = bootstrapperPath
            ?? Path.Combine(AppContext.BaseDirectory, "WebView2", "MicrosoftEdgeWebview2Setup.exe");
        _versionProbe = versionProbe ?? ProbeAvailableBrowserVersion;
        _repairPollInterval = repairPollInterval ?? DefaultRepairPollInterval;
        _repairTimeout = repairTimeout ?? DefaultRepairTimeout;
        if (_repairPollInterval <= TimeSpan.Zero)
            throw new ArgumentOutOfRangeException(nameof(repairPollInterval), "The repair poll interval must be positive.");
        if (_repairTimeout < TimeSpan.Zero)
            throw new ArgumentOutOfRangeException(nameof(repairTimeout), "The repair timeout cannot be negative.");
    }

    public string UserDataFolder => _userDataFolder;

    public string BootstrapperPath => _bootstrapperPath;

    public string? LastProbeFailure => Volatile.Read(ref _lastProbeFailure);

    public bool LastProbeFailureWasRuntimeNotFound => Volatile.Read(ref _lastProbeFailureWasRuntimeNotFound) != 0;

    public string? AvailableVersion => ProbeVersion();

    public Task<bool> IsRuntimeAvailableAsync(CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var version = ProbeVersion();
        return Task.FromResult(!string.IsNullOrWhiteSpace(version));
    }

    public async Task<CoreWebView2Environment> CreateAsync(CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (!await IsRuntimeAvailableAsync(cancellationToken).ConfigureAwait(false))
        {
            throw new WebView2RuntimeMissingException();
        }

        Directory.CreateDirectory(_userDataFolder);
        return await CoreWebView2Environment.CreateAsync(
            browserExecutableFolder: null,
            userDataFolder: _userDataFolder,
            options: null).ConfigureAwait(false);
    }

    /// <summary>
    /// Starts the packaged Evergreen bootstrapper in per-user mode. The
    /// caller can retry environment creation after it exits. If the installer
    /// was not included by the current package, no browser or shell fallback
    /// is launched and a failed result is returned.
    /// </summary>
    public async Task<RepairResult> RepairAsync(CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var elapsed = Stopwatch.StartNew();
        var bootstrapperFound = File.Exists(_bootstrapperPath);
        if (!bootstrapperFound)
            return new RepairResult(false, null, false, elapsed.Elapsed);

        Process? process;
        try
        {
            process = Process.Start(new ProcessStartInfo
            {
                FileName = _bootstrapperPath,
                Arguments = "/silent /install",
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden,
            });
        }
        catch
        {
            return new RepairResult(false, null, true, elapsed.Elapsed);
        }

        if (process is null)
            return new RepairResult(false, null, true, elapsed.Elapsed);

        using (process)
        {
            await process.WaitForExitAsync(cancellationToken).ConfigureAwait(false);
            var exitCode = process.ExitCode;
            var pollElapsed = Stopwatch.StartNew();
            var maxProbes = RepairResult.IsNetworkExitCode(exitCode) ? 2 : int.MaxValue;
            var probeCount = 0;

            while (probeCount < maxProbes)
            {
                cancellationToken.ThrowIfCancellationRequested();
                probeCount++;
                if (!string.IsNullOrWhiteSpace(ProbeVersion()))
                    return new RepairResult(true, exitCode, true, elapsed.Elapsed);

                if (probeCount >= maxProbes) break;

                var remaining = _repairTimeout - pollElapsed.Elapsed;
                if (remaining <= TimeSpan.Zero) break;

                var delay = remaining < _repairPollInterval ? remaining : _repairPollInterval;
                await Task.Delay(delay, cancellationToken).ConfigureAwait(false);
            }

            return new RepairResult(false, exitCode, true, elapsed.Elapsed);
        }
    }

    private string? ProbeVersion()
    {
        try
        {
            var version = _versionProbe();
            if (!string.IsNullOrWhiteSpace(version)) ClearProbeFailure();
            return version;
        }
        catch (WebView2RuntimeNotFoundException error)
        {
            RecordProbeFailure(error, runtimeNotFound: true);
            return null;
        }
        catch (Exception error)
        {
            RecordProbeFailure(error, runtimeNotFound: false);
            return null;
        }
    }

    private void RecordProbeFailure(Exception error, bool runtimeNotFound)
    {
        Volatile.Write(ref _lastProbeFailure, $"{error.GetType().Name}: {error.Message}");
        Volatile.Write(ref _lastProbeFailureWasRuntimeNotFound, runtimeNotFound ? 1 : 0);
    }

    private void ClearProbeFailure()
    {
        Volatile.Write(ref _lastProbeFailure, null);
        Volatile.Write(ref _lastProbeFailureWasRuntimeNotFound, 0);
    }

    private static string? ProbeAvailableBrowserVersion()
    {
        return CoreWebView2Environment.GetAvailableBrowserVersionString(null!);
    }
}

public sealed record RepairResult(
    bool Success,
    int? ExitCode,
    bool BootstrapperFound,
    TimeSpan Elapsed)
{
    public bool IsSuccess => Success;

    public static bool IsNetworkExitCode(int? exitCode)
    {
        return exitCode is NetworkDnsFailure
            or NetworkConnectionFailure
            or NetworkTlsFailure;
    }

    public static string FormatExitCode(int? exitCode)
    {
        return exitCode is int code
            ? $"0x{unchecked((uint)code):X8}"
            : "unknown";
    }

    // Keep the command-line repair entry point source-compatible while callers
    // that need diagnostics consume the structured result directly.
    public static implicit operator bool(RepairResult result) => result?.IsSuccess == true;

    private const int NetworkDnsFailure = unchecked((int)0x80072EE7);
    private const int NetworkConnectionFailure = unchecked((int)0x80072EFE);
    private const int NetworkTlsFailure = unchecked((int)0x80072F8F);
}

public sealed class WebView2RuntimeMissingException : InvalidOperationException
{
    public WebView2RuntimeMissingException()
        : base("The Evergreen WebView2 runtime is not installed for this user.")
    {
    }
}
