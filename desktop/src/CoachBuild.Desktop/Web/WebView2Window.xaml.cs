using System.Windows;
using Microsoft.Web.WebView2.Core;
using CoachBuild.Desktop.Tray;

namespace CoachBuild.Desktop.Web;

/// <summary>
/// One WPF-owned WebView2 window for the remote /draft and Builds pages.
/// Navigation changes the same CoreWebView2 instance, so draft-to-build never
/// creates a second native window or falls back to Process.Start/browser tabs.
/// </summary>
public partial class WebView2Window : Window
{
    private readonly WebView2EnvironmentService _environmentService;
    private readonly HostedPagePolicy _policy;
    private readonly string _sessionToken;
    private readonly string _userDataFolder;
    private readonly Action<RepairResult>? _repairCompleted;
    private ReopenTarget _lastTarget = new(ReopenDestination.Home);
    private bool _initialized;
    private bool _disposed;

    public WebView2Window(
        WebView2EnvironmentService environmentService,
        string appOrigin,
        string sessionToken,
        string userDataFolder,
        Action<RepairResult>? repairCompleted = null)
    {
        _environmentService = environmentService ?? throw new ArgumentNullException(nameof(environmentService));
        _policy = new HostedPagePolicy(appOrigin);
        if (!SessionTokenStore.IsValid(sessionToken)) throw new ArgumentException("Invalid session token.", nameof(sessionToken));
        _sessionToken = sessionToken;
        _userDataFolder = userDataFolder ?? throw new ArgumentNullException(nameof(userDataFolder));
        _repairCompleted = repairCompleted;

        InitializeComponent();
        Fallback.RepairRequested += OnRepairRequested;
        Closed += OnClosed;
    }

    public HostedPagePolicy Policy => _policy;

    public bool IsWebViewInitialized => _initialized;

    public string? CurrentUrl => Browser.CoreWebView2?.Source;

    public void ShowRuntimeFallback(ReopenTarget target)
    {
        ArgumentNullException.ThrowIfNull(target);
        _lastTarget = target;
        Show();
        ShowFallback("The Evergreen WebView2 runtime is missing. Repair it, then retry this page.");
    }

    public async Task OpenAsync(ReopenTarget target, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(target);
        _lastTarget = target;
        cancellationToken.ThrowIfCancellationRequested();
        if (_disposed) return;

        Show();
        Activate();
        if (!await EnsureInitializedAsync(cancellationToken).ConfigureAwait(true)) return;

        var url = _policy.BuildUrl(target, _sessionToken);
        if (!_policy.IsAllowed(url))
        {
            ShowFallback("CoachBuild refused a navigation outside its hosted origin.");
            return;
        }

        Browser.CoreWebView2!.Navigate(url.ToString());
    }

    private async Task<bool> EnsureInitializedAsync(CancellationToken cancellationToken)
    {
        if (_initialized && Browser.CoreWebView2 is not null) return true;
        if (!await _environmentService.IsRuntimeAvailableAsync(cancellationToken).ConfigureAwait(true))
        {
            ShowFallback("The Evergreen WebView2 runtime is missing. Repair it, then retry this page.");
            return false;
        }

        try
        {
            Directory.CreateDirectory(_userDataFolder);
            var environment = await _environmentService.CreateAsync(cancellationToken).ConfigureAwait(true);
            await Browser.EnsureCoreWebView2Async(environment).ConfigureAwait(true);
            ConfigureBrowser(Browser.CoreWebView2!);
            _initialized = true;
            return true;
        }
        catch (WebView2RuntimeMissingException)
        {
            ShowFallback("The Evergreen WebView2 runtime is missing. Repair it, then retry this page.");
            return false;
        }
        catch (Exception error)
        {
            ShowFallback($"CoachBuild could not start WebView2: {error.Message}");
            return false;
        }
    }

    private void ConfigureBrowser(CoreWebView2 webView)
    {
        webView.Settings.AreDefaultContextMenusEnabled = true;
        webView.Settings.AreDevToolsEnabled = false;
        webView.Settings.IsStatusBarEnabled = false;
        webView.Settings.IsZoomControlEnabled = true;
        webView.NavigationStarting += OnNavigationStarting;
        webView.NavigationCompleted += OnNavigationCompleted;
        webView.NewWindowRequested += OnNewWindowRequested;
        webView.PermissionRequested += OnPermissionRequested;
    }

    private void OnNavigationStarting(object? sender, CoreWebView2NavigationStartingEventArgs e)
    {
        if (!_policy.IsAllowed(e.Uri))
        {
            e.Cancel = true;
            ShowFallback("This link leaves the hosted CoachBuild site and was blocked.");
        }
    }

    private void OnNavigationCompleted(object? sender, CoreWebView2NavigationCompletedEventArgs e)
    {
        if (_disposed) return;
        if (e.IsSuccess)
        {
            Browser.Visibility = Visibility.Visible;
            Fallback.Visibility = Visibility.Collapsed;
        }
        else
        {
            ShowFallback($"CoachBuild could not load this page ({e.WebErrorStatus}). Check your connection and retry from the tray.");
        }
    }

    private void OnNewWindowRequested(object? sender, CoreWebView2NewWindowRequestedEventArgs e)
    {
        e.Handled = true;
        if (_policy.IsAllowed(e.Uri))
        {
            Browser.CoreWebView2?.Navigate(e.Uri);
        }
        else
        {
            ShowFallback("A new window outside the hosted CoachBuild site was blocked.");
        }
    }

    private static void OnPermissionRequested(object? sender, CoreWebView2PermissionRequestedEventArgs e)
    {
        // The unchanged web page reaches the desktop bridge over loopback.
        // Older WebView2 SDKs do not expose LocalNetworkAccess as an enum
        // member, so keep the allow-list name-based for forward compatibility.
        e.State = IsLocalNetworkPermission(e.PermissionKind)
            ? CoreWebView2PermissionState.Allow
            : CoreWebView2PermissionState.Deny;
    }

    private static bool IsLocalNetworkPermission(CoreWebView2PermissionKind permissionKind)
    {
        var name = permissionKind.ToString();
        return string.Equals(name, "LocalNetworkAccess", StringComparison.OrdinalIgnoreCase)
            || string.Equals(name, "LocalNetwork", StringComparison.OrdinalIgnoreCase)
            || string.Equals(name, "Loopback", StringComparison.OrdinalIgnoreCase);
    }

    private async void OnRepairRequested(object? sender, EventArgs e)
    {
        if (_disposed) return;
        Fallback.IsRepairEnabled = false;
        Fallback.Message = "Repairing WebView2 for this Windows user…";
        try
        {
            var result = await _environmentService.RepairAsync().ConfigureAwait(true);
            _repairCompleted?.Invoke(result);
            if (!result.IsSuccess)
            {
                ShowFallback(RepairFailureMessage(
                    result,
                    _environmentService.LastProbeFailure,
                    _environmentService.LastProbeFailureWasRuntimeNotFound));
                return;
            }

            Fallback.Message = "WebView2 repaired. Opening CoachBuild…";
            await OpenAsync(_lastTarget).ConfigureAwait(true);
        }
        catch (Exception error)
        {
            ShowFallback($"WebView2 repair failed: {error.Message}");
        }
        finally
        {
            Fallback.IsRepairEnabled = true;
        }
    }

    internal static string RepairFailureMessage(
        RepairResult result,
        string? lastProbeFailure,
        bool lastProbeFailureWasRuntimeNotFound)
    {
        if (!result.BootstrapperFound)
            return "The repair helper is missing from this installation. Reinstall CoachBuild with the latest Setup.exe.";

        if (RepairResult.IsNetworkExitCode(result.ExitCode))
            return "The WebView2 download failed — check your internet connection or firewall, then retry.";

        if (lastProbeFailure is not null && !lastProbeFailureWasRuntimeNotFound)
            return "CoachBuild hit an app-side WebView2 loader problem. Installing the runtime will not help; see %LOCALAPPDATA%\\CoachBuild\\companion.log for details.";

        if (result.ExitCode is 0)
            return "The WebView2 installer finished, but Windows has not registered the runtime yet. Wait a minute and retry.";

        return $"WebView2 install did not finish (installer code {RepairResult.FormatExitCode(result.ExitCode)}). Retry, or install the runtime from Microsoft and relaunch CoachBuild.";
    }

    private void ShowFallback(string message)
    {
        if (_disposed) return;
        Browser.Visibility = Visibility.Collapsed;
        Fallback.Visibility = Visibility.Visible;
        Fallback.Message = message;
        Fallback.IsRepairEnabled = true;
    }

    private void OnClosed(object? sender, EventArgs e)
    {
        _disposed = true;
        if (Browser.CoreWebView2 is { } webView)
        {
            webView.NavigationStarting -= OnNavigationStarting;
            webView.NavigationCompleted -= OnNavigationCompleted;
            webView.NewWindowRequested -= OnNewWindowRequested;
            webView.PermissionRequested -= OnPermissionRequested;
        }
        Fallback.RepairRequested -= OnRepairRequested;
    }
}
