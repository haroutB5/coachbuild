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
    private readonly string _userDataFolder;
    private readonly string _bootstrapperPath;
    private readonly Func<string?> _versionProbe;

    public WebView2EnvironmentService(
        string userDataFolder,
        string? bootstrapperPath = null,
        Func<string?>? versionProbe = null)
    {
        _userDataFolder = userDataFolder ?? throw new ArgumentNullException(nameof(userDataFolder));
        _bootstrapperPath = bootstrapperPath
            ?? Path.Combine(AppContext.BaseDirectory, "WebView2", "MicrosoftEdgeWebview2Setup.exe");
        _versionProbe = versionProbe ?? ProbeVersion;
    }

    public string UserDataFolder => _userDataFolder;

    public string BootstrapperPath => _bootstrapperPath;

    public string? AvailableVersion => _versionProbe();

    public Task<bool> IsRuntimeAvailableAsync(CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var version = _versionProbe();
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
    /// is launched and false is returned.
    /// </summary>
    public async Task<bool> RepairAsync(CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (!File.Exists(_bootstrapperPath)) return false;

        using var process = Process.Start(new ProcessStartInfo
        {
            FileName = _bootstrapperPath,
            Arguments = "/silent /install",
            UseShellExecute = false,
            CreateNoWindow = true,
            WindowStyle = ProcessWindowStyle.Hidden,
        });
        if (process is null) return false;
        await process.WaitForExitAsync(cancellationToken).ConfigureAwait(false);
        return process.ExitCode == 0 && await IsRuntimeAvailableAsync(cancellationToken).ConfigureAwait(false);
    }

    private static string? ProbeVersion()
    {
        try
        {
            return CoreWebView2Environment.GetAvailableBrowserVersionString(null!);
        }
        catch
        {
            return null;
        }
    }
}

public sealed class WebView2RuntimeMissingException : InvalidOperationException
{
    public WebView2RuntimeMissingException()
        : base("The Evergreen WebView2 runtime is not installed for this user.")
    {
    }
}
