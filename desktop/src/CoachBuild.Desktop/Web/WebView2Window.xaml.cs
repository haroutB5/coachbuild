using System.Globalization;
using System.Windows;
using System.Windows.Controls;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;
using CoachBuild.Desktop.Tray;

namespace CoachBuild.Desktop.Web;

/// <summary>
/// The single native companion window. It owns one lazy WebView2 control per
/// destination so each tab keeps its own history and sign-in while the
/// application still has one window and one lifetime gate.
///
/// <para>The hosted CoachBuild page is the only surface with the persistent
/// session token and the only surface whose document is inspected: the version
/// meta tag is read solely to support the existing web-freshness check. Site
/// tabs are deliberately rendering-only; their pages are never scraped or
/// scripted.</para>
/// </summary>
public partial class WebView2Window : Window
{
    private sealed class BrowserTabState
    {
        public BrowserTabState(CompanionTab tab)
        {
            Tab = tab;
        }

        public CompanionTab Tab { get; }

        public WebView2? Browser { get; set; }

        public CoreWebView2? Core { get; set; }

        public bool Initialized { get; set; }

        public bool HasNavigated { get; set; }

        public bool IsLoading { get; set; }

        public string? Error { get; set; }

        public Task<bool>? Initialization { get; set; }
    }

    private readonly WebView2EnvironmentService _environmentService;
    private readonly HostedPagePolicy _policy;
    private readonly string _sessionToken;
    private readonly string _userDataFolder;
    private readonly Action<RepairResult>? _repairCompleted;
    private readonly Action<CompanionTabsPreferences>? _preferencesChanged;
    private readonly Dictionary<CompanionTab, BrowserTabState> _tabs = new();
    private CompanionTabsPreferences _preferences;
    private ChampSelectContext? _champSelectContext;
    private ReopenTarget _lastTarget = new(ReopenDestination.Home);
    private CompanionTab _activeTab = CompanionTab.Companion;
    private bool _hasActiveTab;
    private bool _showingFallback;
    private string? _fallbackMessage;
    private bool _disposed;
    private bool _browserDisposed;

    public WebView2Window(
        WebView2EnvironmentService environmentService,
        string appOrigin,
        string sessionToken,
        string userDataFolder,
        Action<RepairResult>? repairCompleted = null,
        CompanionTabsPreferences? preferences = null,
        Action<CompanionTabsPreferences>? preferencesChanged = null)
    {
        _environmentService = environmentService ?? throw new ArgumentNullException(nameof(environmentService));
        _policy = new HostedPagePolicy(appOrigin);
        if (!SessionTokenStore.IsValid(sessionToken)) throw new ArgumentException("Invalid session token.", nameof(sessionToken));
        _sessionToken = sessionToken;
        _userDataFolder = userDataFolder ?? throw new ArgumentNullException(nameof(userDataFolder));
        _repairCompleted = repairCompleted;
        _preferencesChanged = preferencesChanged;
        _preferences = preferences ?? CompanionTabsPreferences.Default;

        InitializeComponent();
        Fallback.RepairRequested += OnRepairRequested;
        Closed += OnClosed;
        UpdateChrome();
    }

    public HostedPagePolicy Policy => _policy;

    /// <summary>The tab currently shown in the content area.</summary>
    public CompanionTab ActiveTab => _hasActiveTab ? _activeTab : _preferences.LastTab;

    /// <summary>Read-only URL of the selected tab's top-level document.</summary>
    public string? CurrentUrl =>
        GetState(ActiveTab)?.Core?.Source
        ?? GetState(ActiveTab)?.Browser?.Source?.ToString();

    /// <summary>The browser control for the selected tab, if that tab has been created.</summary>
    public WebView2? ActiveBrowser => GetState(ActiveTab)?.Browser;

    /// <summary>True once the hosted CoachBuild WebView has completed initialization.</summary>
    public bool IsWebViewInitialized =>
        GetState(CompanionTab.Companion)?.Initialized == true;

    /// <summary>Whether a tab has been created and initialized. Site tabs are lazy.</summary>
    public bool IsTabInitialized(CompanionTab tab) =>
        CompanionTabsPreferences.IsKnownTab(tab) && GetState(tab)?.Initialized == true;

    public bool CanGoBack => GetState(ActiveTab)?.Browser?.CanGoBack == true;

    public bool CanGoForward => GetState(ActiveTab)?.Browser?.CanGoForward == true;

    public CompanionTabsPreferences Preferences => _preferences;

    /// <summary>
    /// The web app version the hosted document reported, or null when it has no
    /// coachbuild-version meta tag. This is never populated from a third-party
    /// tab.
    /// </summary>
    public string? LoadedWebVersion { get; private set; }

    /// <summary>Raised after every successful hosted-page navigation.</summary>
    public event Action<string?>? WebVersionObserved;

    /// <summary>Raised after a tab or zoom preference changes.</summary>
    public event Action<CompanionTabsPreferences>? PreferencesChanged;

    /// <summary>Raised when the user selects a different tab.</summary>
    public event Action<CompanionTab>? TabChanged;

    /// <summary>Raised when a tab's navigation/history state changes.</summary>
    public event Action? NavigationStateChanged;

    public void ShowRuntimeFallback(ReopenTarget target)
    {
        ArgumentNullException.ThrowIfNull(target);
        _lastTarget = target;
        _activeTab = CompanionTab.Companion;
        _hasActiveTab = true;
        UpdateChrome();
        Show();
        Activate();
        ShowFallback("The Evergreen WebView2 runtime is missing. Repair it, then retry this page.");
    }

    /// <summary>
    /// Opens the current remembered surface. The existing hosted route is
    /// navigated when Companion is selected. A third-party tab only opens its
    /// own home page when it has never been visited; a champ-select target is
    /// never translated into an automatic site deep link.
    /// </summary>
    public async Task OpenAsync(
        ReopenTarget target,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(target);
        _lastTarget = target;
        cancellationToken.ThrowIfCancellationRequested();
        if (_disposed) return;

        Show();
        Activate();

        if (!_hasActiveTab)
        {
            if (!await SelectTabCoreAsync(
                    _preferences.LastTab,
                    remember: false,
                    navigateWhenEmpty: false,
                    cancellationToken).ConfigureAwait(true))
                return;
        }

        var state = await EnsureActiveTabAsync(cancellationToken).ConfigureAwait(true);
        if (state is null) return;

        if (state.Tab == CompanionTab.Companion)
        {
            NavigateHosted(state, target);
        }
        else if (!state.HasNavigated && state.Core is not null)
        {
            NavigateSiteHome(state);
        }
        else
        {
            UpdateChrome();
        }
    }

    /// <summary>
    /// Brings the hosted surface forward and navigates it to the requested
    /// native route. Used by the existing web-freshness check even when the
    /// user was reading a stats tab.
    /// </summary>
    public async Task OpenCompanionAsync(
        ReopenTarget target,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(target);
        _lastTarget = target;
        cancellationToken.ThrowIfCancellationRequested();
        if (_disposed) return;

        // Freshness checks may run while the user is reading u.gg or Coachless.
        // Initialize and refresh Companion in the background, preserving the
        // selected tab and the user's window activation state.
        if (!_hasActiveTab)
        {
            _activeTab = CompanionTab.Companion;
            _hasActiveTab = true;
            UpdateChrome();
        }

        var state = await EnsureTabAsync(CompanionTab.Companion, cancellationToken).ConfigureAwait(true);
        if (_disposed || state is null) return;
        NavigateHosted(state, target);
        if (!IsActiveTab(state))
            state.Browser!.Visibility = Visibility.Collapsed;
    }

    /// <summary>Switches to a tab, creating its WebView only on first use.</summary>
    public Task SwitchToTabAsync(
        CompanionTab tab,
        CancellationToken cancellationToken = default)
    {
        if (!CompanionTabsPreferences.IsKnownTab(tab))
            throw new ArgumentOutOfRangeException(nameof(tab));
        return SelectTabCoreAsync(
            tab,
            remember: true,
            navigateWhenEmpty: true,
            cancellationToken);
    }

    /// <summary>
    /// Receives the current LCU champ-select projection. Updating this value
    /// only updates the offer row; it never navigates a site.
    /// </summary>
    public void UpdateChampSelectContext(ChampSelectContext? context)
    {
        if (_disposed) return;
        if (!Dispatcher.CheckAccess())
        {
            Dispatcher.BeginInvoke(
                new Action(() => UpdateChampSelectContext(context)),
                System.Windows.Threading.DispatcherPriority.Background);
            return;
        }

        _champSelectContext = context;
        UpdateOfferBar();
    }

    public void GoBack()
    {
        if (_disposed) return;
        if (GetState(ActiveTab)?.Browser is { CanGoBack: true } browser)
            browser.GoBack();
    }

    public void GoForward()
    {
        if (_disposed) return;
        if (GetState(ActiveTab)?.Browser is { CanGoForward: true } browser)
            browser.GoForward();
    }

    public void Refresh()
    {
        if (_disposed) return;
        var state = GetState(ActiveTab);
        if (state?.Core is null) return;
        state.Core.Reload();
        SetLoading(state, $"Refreshing {CompanionTabs.LabelFor(state.Tab)}…");
    }

    public void ZoomOut() => SetActiveZoom(_preferences.ZoomFor(ActiveTab) - CompanionTabsPreferences.ZoomStep);

    public void ZoomIn() => SetActiveZoom(_preferences.ZoomFor(ActiveTab) + CompanionTabsPreferences.ZoomStep);

    public void ResetZoom() => SetActiveZoom(CompanionTabsPreferences.DefaultZoomFactor);

    private async Task<bool> SelectTabCoreAsync(
        CompanionTab tab,
        bool remember,
        bool navigateWhenEmpty,
        CancellationToken cancellationToken)
    {
        if (_disposed) return false;
        cancellationToken.ThrowIfCancellationRequested();

        var changed = !_hasActiveTab || _activeTab != tab;
        _activeTab = tab;
        _hasActiveTab = true;
        HideBrowsersExcept(tab);
        if (remember) RememberLastTab(tab);
        UpdateChrome();

        var state = await EnsureTabAsync(tab, cancellationToken).ConfigureAwait(true);
        if (_disposed || state is null) return false;

        if (navigateWhenEmpty && !state.HasNavigated && state.Core is not null)
        {
            if (tab == CompanionTab.Companion)
                NavigateHosted(state, new ReopenTarget(ReopenDestination.Home));
            else
                NavigateSiteHome(state);
        }

        if (changed)
        {
            TabChanged?.Invoke(tab);
            NavigationStateChanged?.Invoke();
        }
        return true;
    }

    private async Task<BrowserTabState?> EnsureActiveTabAsync(CancellationToken cancellationToken)
    {
        return await EnsureTabAsync(ActiveTab, cancellationToken).ConfigureAwait(true);
    }

    private async Task<BrowserTabState?> EnsureTabAsync(
        CompanionTab tab,
        CancellationToken cancellationToken)
    {
        var state = GetOrCreateState(tab);
        if (state.Initialized) return state;
        if (state.Initialization is not null)
        {
            var alreadyInitializing = await state.Initialization.ConfigureAwait(true);
            return _disposed || !alreadyInitializing ? null : state;
        }

        state.Initialization = InitializeTabAsync(state, cancellationToken);
        try
        {
            var initialized = await state.Initialization.ConfigureAwait(true);
            return _disposed || !initialized ? null : state;
        }
        finally
        {
            state.Initialization = null;
        }
    }

    private async Task<bool> InitializeTabAsync(
        BrowserTabState state,
        CancellationToken cancellationToken)
    {
        try
        {
            state.IsLoading = true;
            if (IsActiveTab(state))
                SetLoading(state, $"Starting {CompanionTabs.LabelFor(state.Tab)}…");

            if (!await _environmentService.IsRuntimeAvailableAsync(cancellationToken).ConfigureAwait(true))
            {
                if (_disposed) return false;
                state.IsLoading = false;
                if (IsActiveTab(state)) ShowFallback(
                    "The Evergreen WebView2 runtime is missing. Repair it, then retry this page.");
                return false;
            }

            if (_disposed) return false;

            var browser = new WebView2
            {
                // Qualified: the property names shadow the enum type names here,
                // and WebView2 is an HwndHost so it has no IsTabStop at all.
                HorizontalAlignment = System.Windows.HorizontalAlignment.Stretch,
                VerticalAlignment = System.Windows.VerticalAlignment.Stretch,
                // WebView2 is an HwndHost. Keep its native child hidden until
                // CoreWebView2 is ready and UpdateChrome has selected the ready
                // active tab; otherwise the blank HWND sits above WPF's loading,
                // error, and landing layers because of airspace rules.
                Visibility = Visibility.Collapsed,
                Focusable = true,
                AllowExternalDrop = false,
            };
            if (_disposed)
            {
                browser.Dispose();
                return false;
            }
            BrowserHost.Children.Add(browser);
            state.Browser = browser;

            var environment = await _environmentService
                .CreateAsync(CompanionTabs.ProfileFolder(_userDataFolder, state.Tab), cancellationToken)
                .ConfigureAwait(true);
            if (_disposed)
            {
                RemoveFailedBrowser(state);
                return false;
            }

            await browser.EnsureCoreWebView2Async(environment).ConfigureAwait(true);
            if (_disposed)
            {
                RemoveFailedBrowser(state);
                return false;
            }

            state.Core = browser.CoreWebView2
                ?? throw new InvalidOperationException("WebView2 initialized without a CoreWebView2 instance.");

            ConfigureBrowser(state);
            browser.ZoomFactor = _preferences.ZoomFor(state.Tab);
            state.Initialized = true;
            state.IsLoading = false;
            state.Error = null;
            if (_disposed)
            {
                RemoveFailedBrowser(state);
                return false;
            }

            if (IsActiveTab(state)) HideFallbackAndError();
            UpdateChrome();
            return true;
        }
        catch (WebView2RuntimeMissingException)
        {
            RemoveFailedBrowser(state);
            if (IsActiveTab(state))
                ShowFallback("The Evergreen WebView2 runtime is missing. Repair it, then retry this page.");
            return false;
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            RemoveFailedBrowser(state);
            throw;
        }
        catch (Exception error)
        {
            RemoveFailedBrowser(state);
            if (_disposed) return false;
            state.IsLoading = false;
            state.Error = $"CoachBuild could not start this surface: {error.Message}";
            if (IsActiveTab(state)) ShowPageError(state, state.Error);
            return false;
        }
    }

    private void ConfigureBrowser(BrowserTabState state)
    {
        var browser = state.Browser!;
        var webView = state.Core!;

        webView.Settings.AreDefaultContextMenusEnabled = true;
        webView.Settings.AreDevToolsEnabled = false;
        webView.Settings.IsStatusBarEnabled = false;
        webView.Settings.IsZoomControlEnabled = true;

        webView.NavigationStarting += (_, args) => OnNavigationStarting(state, args);
        webView.NavigationCompleted += (_, args) => OnNavigationCompleted(state, args);
        webView.NewWindowRequested += (_, args) => OnNewWindowRequested(state, args);
        webView.PermissionRequested += (_, args) => OnPermissionRequested(state, args);
        webView.FrameNavigationStarting += (_, args) => OnFrameNavigationStarting(state, args);
        webView.LaunchingExternalUriScheme += (_, args) => OnLaunchingExternalUriScheme(state, args);
        webView.SourceChanged += (_, _) => OnNavigationStateChanged(state);
        webView.HistoryChanged += (_, _) => OnNavigationStateChanged(state);
        browser.ZoomFactorChanged += (_, _) => OnZoomFactorChanged(state);
    }

    private void OnNavigationStarting(
        BrowserTabState state,
        CoreWebView2NavigationStartingEventArgs args)
    {
        if (_disposed || state.Browser is null) return;
        state.IsLoading = true;
        state.Error = null;
        if (!IsAllowed(state.Tab, args.Uri))
        {
            args.Cancel = true;
            state.IsLoading = false;
            if (IsActiveTab(state))
                ShowPageError(
                    state,
                    state.Tab == CompanionTab.Companion
                        ? "That link leaves the hosted CoachBuild app and was blocked."
                        : "That page is outside the secure public web, so CoachBuild blocked it.");
            return;
        }

        if (IsActiveTab(state))
            SetLoading(state, state.Tab == CompanionTab.Companion
                ? "Opening your companion…"
                : $"Loading {CompanionTabs.LabelFor(state.Tab)}…");
    }

    private void OnFrameNavigationStarting(
        BrowserTabState state,
        CoreWebView2NavigationStartingEventArgs args)
    {
        if (_disposed) return;
        if (state.Tab != CompanionTab.Companion && !SiteNavigationPolicy.IsAllowed(args.Uri))
            args.Cancel = true;
    }

    private void OnNavigationCompleted(
        BrowserTabState state,
        CoreWebView2NavigationCompletedEventArgs args)
    {
        // Core events can arrive after Window.Close has disposed the HWND. Do
        // not touch state or WPF controls after that point; the initialization
        // task has its own disposed checks and will finish quietly.
        if (_disposed || state.Browser is null) return;
        state.IsLoading = false;
        if (args.IsSuccess)
        {
            state.HasNavigated = true;
            state.Error = null;
            state.Browser!.Visibility = Visibility.Collapsed;
            if (IsActiveTab(state))
            {
                HideFallbackAndError();
                StatusText.Text = $"{CompanionTabs.LabelFor(state.Tab)} ready";
                if (state.Core is not null)
                    state.Browser.ZoomFactor = _preferences.ZoomFor(state.Tab);
                UpdateChrome();
            }

            if (state.Tab == CompanionTab.Companion)
                _ = ReadLoadedWebVersionAsync(state);
            return;
        }

        ShowPageError(state, PageErrorMessage(state.Tab, args.WebErrorStatus));
    }

    /// <summary>
    /// The message shown when a page fails to load, for any tab.
    ///
    /// <para>Pulled out as a pure function for the same reason
    /// <see cref="RepairFailureMessage"/> is one: it is the whole of what the
    /// user is told when something goes wrong, and it is otherwise reachable
    /// only by taking a real network failure at a real navigation — which on a
    /// warm WebView2 profile is genuinely hard to stage, because the cache
    /// serves the page and the navigation SUCCEEDS.</para>
    ///
    /// <para><b>It never mentions the WebView2 runtime.</b> That wording
    /// belongs to <see cref="WebView2FallbackView"/> and its Repair button; a
    /// dropped connection is not a missing runtime, and offering to reinstall
    /// software the user already has is how a two-second retry becomes a
    /// support conversation.</para>
    /// </summary>
    internal static string PageErrorMessage(CompanionTab tab, CoreWebView2WebErrorStatus status)
    {
        // The site is named, so a failed u.gg tab does not read as CoachBuild
        // itself being broken.
        var who = tab == CompanionTab.Companion ? "CoachBuild" : CompanionTabs.LabelFor(tab);
        return $"{who} could not load this page ({status}). Check your connection and try again.";
    }

    private async Task ReadLoadedWebVersionAsync(BrowserTabState state)
    {
        // This is the only ExecuteScriptAsync call in the window and the state
        // guard makes it impossible for a third-party tab to reach it.
        if (state.Tab != CompanionTab.Companion) return;
        var version = await QueryLoadedWebVersionAsync(state).ConfigureAwait(true);
        if (_disposed || state.Tab != CompanionTab.Companion) return;
        LoadedWebVersion = version;
        WebVersionObserved?.Invoke(version);
    }

    private async Task<string?> QueryLoadedWebVersionAsync(BrowserTabState state)
    {
        for (var attempt = 0; attempt < 2; attempt++)
        {
            if (_disposed || state.Core is not { } webView) return null;
            try
            {
                var raw = await webView
                    .ExecuteScriptAsync(
                        "(function(){var m=document.querySelector('meta[name=\"coachbuild-version\"]');" +
                        "return m&&m.content?m.content:null;})()")
                    .ConfigureAwait(true);
                if (!string.IsNullOrWhiteSpace(raw) && raw != "null")
                    return System.Text.Json.JsonSerializer.Deserialize<string>(raw);
            }
            catch
            {
                return null;
            }

            if (attempt == 0)
                await Task.Delay(400).ConfigureAwait(true);
        }

        return null;
    }

    private void OnNewWindowRequested(
        BrowserTabState state,
        CoreWebView2NewWindowRequestedEventArgs args)
    {
        // Keep one native window. A user-clicked target=_blank link is treated
        // as an ordinary same-tab navigation after the same destination policy
        // check; unsolicited popups are simply swallowed.
        args.Handled = true;
        if (_disposed) return;
        if (args.IsUserInitiated
            && Uri.TryCreate(args.Uri, UriKind.Absolute, out var target)
            && IsAllowed(state.Tab, target))
        {
            Navigate(state, target);
            return;
        }

        if (IsActiveTab(state))
            SetStatus($"{CompanionTabs.LabelFor(state.Tab)} blocked a popup; this window stays focused.");
    }

    private void OnLaunchingExternalUriScheme(
        BrowserTabState state,
        CoreWebView2LaunchingExternalUriSchemeEventArgs args)
    {
        args.Cancel = true;
        if (!_disposed && IsActiveTab(state))
            SetStatus("External app links are blocked in the companion window.");
    }

    private static void OnPermissionRequested(
        BrowserTabState state,
        CoreWebView2PermissionRequestedEventArgs args)
    {
        // The hosted page reaches the unchanged loopback bridge. Third-party
        // pages never receive that permission, even if they request it.
        args.State = state.Tab == CompanionTab.Companion
            && IsLocalNetworkPermission(args.PermissionKind)
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

    private bool IsAllowed(CompanionTab tab, string? target)
    {
        return Uri.TryCreate(target, UriKind.Absolute, out var uri) && IsAllowed(tab, uri);
    }

    private bool IsAllowed(CompanionTab tab, Uri target)
    {
        if (tab == CompanionTab.Companion)
            return _policy.IsAllowed(target);
        var site = CompanionTabs.SiteFor(tab);
        return SiteNavigationPolicy.IsAllowed(site, target);
    }

    private void OnNavigationStateChanged(BrowserTabState state)
    {
        if (_disposed || state.Browser is null) return;
        if (IsActiveTab(state))
        {
            AddressText.Text = DisplayUrl(state.Core?.Source);
            UpdateChrome();
            UpdateOfferBar();
        }

        NavigationStateChanged?.Invoke();
    }

    private void OnZoomFactorChanged(BrowserTabState state)
    {
        if (_disposed) return;
        if (state.Browser is not { } browser) return;
        var normalized = CompanionTabsPreferences.NormalizeZoom(browser.ZoomFactor);
        if (Math.Abs(normalized - browser.ZoomFactor) > 0.001)
            browser.ZoomFactor = normalized;
        RememberZoom(state.Tab, normalized);
        if (IsActiveTab(state)) UpdateChrome();
    }

    private void NavigateHosted(BrowserTabState state, ReopenTarget target)
    {
        var url = _policy.BuildUrl(target, _sessionToken);
        if (!_policy.IsAllowed(url))
        {
            ShowFallback("CoachBuild refused a navigation outside its hosted origin.");
            return;
        }
        Navigate(state, url);
    }

    private void NavigateSiteHome(BrowserTabState state)
    {
        var site = CompanionTabs.SiteFor(state.Tab);
        if (site is null) return;
        Navigate(state, site.Home);
    }

    private void Navigate(BrowserTabState state, Uri url)
    {
        if (_disposed || state.Core is null || !IsAllowed(state.Tab, url))
        {
            if (!_disposed && IsActiveTab(state))
                ShowPageError(state, "CoachBuild blocked an unsafe navigation.");
            return;
        }

        state.Error = null;
        state.IsLoading = true;
        state.HasNavigated = true;
        if (IsActiveTab(state))
            SetLoading(state, $"Loading {CompanionTabs.LabelFor(state.Tab)}…");
        state.Core.Navigate(url.ToString());
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

            Fallback.Message = "WebView2 repaired. Opening your surface…";
            await OpenAsync(_lastTarget).ConfigureAwait(true);
        }
        catch (Exception error)
        {
            ShowFallback($"WebView2 repair failed: {error.Message}");
        }
        finally
        {
            if (!_disposed) Fallback.IsRepairEnabled = true;
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

    private async void OnCompanionTabClick(object sender, RoutedEventArgs e) =>
        await SwitchToTabAsync(CompanionTab.Companion).ConfigureAwait(true);

    private async void OnUggTabClick(object sender, RoutedEventArgs e) =>
        await SwitchToTabAsync(CompanionTab.UGg).ConfigureAwait(true);

    private async void OnCoachlessTabClick(object sender, RoutedEventArgs e) =>
        await SwitchToTabAsync(CompanionTab.Coachless).ConfigureAwait(true);

    private void OnBackClick(object sender, RoutedEventArgs e) => GoBack();

    private void OnForwardClick(object sender, RoutedEventArgs e) => GoForward();

    private void OnRefreshClick(object sender, RoutedEventArgs e) => Refresh();

    private async void OnRetryClick(object sender, RoutedEventArgs e)
    {
        var state = GetState(ActiveTab);
        if (state is null) return;
        ErrorState.Visibility = Visibility.Collapsed;
        if (state.Core is null)
        {
            await SwitchToTabAsync(ActiveTab).ConfigureAwait(true);
            return;
        }

        if (state.Tab == CompanionTab.Companion)
            NavigateHosted(state, _lastTarget);
        else
            NavigateSiteHome(state);
    }

    private void OnHomeClick(object sender, RoutedEventArgs e)
    {
        var state = GetState(ActiveTab);
        if (state is null) return;
        if (state.Tab == CompanionTab.Companion)
            NavigateHosted(state, new ReopenTarget(ReopenDestination.Home));
        else
            NavigateSiteHome(state);
    }

    private async void OnUggOfferClick(object sender, RoutedEventArgs e) =>
        await OpenSiteOfferAsync(CompanionTab.UGg).ConfigureAwait(true);

    private async void OnCoachlessOfferClick(object sender, RoutedEventArgs e) =>
        await OpenSiteOfferAsync(CompanionTab.Coachless).ConfigureAwait(true);

    private void OnZoomOutClick(object sender, RoutedEventArgs e) => ZoomOut();

    private void OnZoomInClick(object sender, RoutedEventArgs e) => ZoomIn();

    private async Task OpenSiteOfferAsync(CompanionTab tab)
    {
        if (_champSelectContext is not { } context) return;
        var site = CompanionTabs.SiteFor(tab);
        if (site is null || context.UrlFor(site) is not { } url) return;

        if (!await SelectTabCoreAsync(
                tab,
                remember: true,
                navigateWhenEmpty: false,
                _shutdownToken).ConfigureAwait(true))
            return;

        var state = GetState(tab);
        if (state?.Core is null) return;
        if (!SiteNavigationPolicy.IsAlreadyThere(state.Core.Source, url))
            Navigate(state, url);
        else
            SetStatus($"{site.Label} is already showing this champion and role.");
    }

    private CancellationToken _shutdownToken => CancellationToken.None;

    private void RememberLastTab(CompanionTab tab)
    {
        var next = _preferences.WithLastTab(tab);
        if (next.LastTab == _preferences.LastTab) return;
        _preferences = next;
        NotifyPreferencesChanged();
    }

    private void RememberZoom(CompanionTab tab, double zoom)
    {
        var normalized = CompanionTabsPreferences.NormalizeZoom(zoom);
        if (Math.Abs(normalized - _preferences.ZoomFor(tab)) <= 0.001) return;
        _preferences = _preferences.WithZoom(tab, normalized);
        NotifyPreferencesChanged();
    }

    private void NotifyPreferencesChanged()
    {
        try
        {
            _preferencesChanged?.Invoke(_preferences);
        }
        catch
        {
            // Settings persistence is best effort and must never take down a
            // browser tab. The public event remains a diagnostic seam.
        }

        try
        {
            PreferencesChanged?.Invoke(_preferences);
        }
        catch
        {
        }
    }

    private void SetActiveZoom(double zoom)
    {
        var normalized = CompanionTabsPreferences.NormalizeZoom(zoom);
        var state = GetState(ActiveTab);
        if (state?.Browser is not { } browser || !state.Initialized)
        {
            RememberZoom(ActiveTab, normalized);
            UpdateChrome();
            return;
        }

        browser.ZoomFactor = normalized;
        RememberZoom(ActiveTab, normalized);
        UpdateChrome();
    }

    private void UpdateChrome()
    {
        if (_disposed || !Dispatcher.CheckAccess()) return;

        var activeState = GetState(ActiveTab);
        var isFallback = _showingFallback;
        var isLoading = !isFallback && activeState?.IsLoading == true;
        var hasError = !isFallback && !isLoading && activeState?.Error is not null;
        var hasReadyBrowser = !isFallback
            && activeState?.Initialized == true
            && !isLoading
            && !hasError;
        var showLanding = !isFallback
            && !isLoading
            && !hasError
            && activeState?.Initialized != true;

        // WebView2 is an HWND host. A WPF sibling cannot reliably paint over it,
        // so the browser is visible only for a ready active tab; all app-owned
        // loading, error, fallback and landing states collapse it first.
        foreach (var state in _tabs.Values)
        {
            if (state.Browser is not null)
                state.Browser.Visibility = BrowserVisibilityFor(IsActiveTab(state), hasReadyBrowser);
        }

        Fallback.Visibility = isFallback ? Visibility.Visible : Visibility.Collapsed;
        if (isFallback && _fallbackMessage is not null)
            Fallback.Message = _fallbackMessage;
        LandingState.Visibility = showLanding ? Visibility.Visible : Visibility.Collapsed;
        LoadingOverlay.Visibility = isLoading ? Visibility.Visible : Visibility.Collapsed;
        ErrorState.Visibility = hasError ? Visibility.Visible : Visibility.Collapsed;
        if (hasError && activeState?.Error is { } activeError)
            ErrorText.Text = activeError;

        AddressText.Text = activeState?.Core?.Source is { } source
            ? DisplayUrl(source)
            : hasError ? "Unavailable" : "Ready";

        var label = CompanionTabs.LabelFor(ActiveTab);
        TabStateText.Text = isLoading
            ? $"{label}  •  loading"
            : hasError
                ? $"{label}  •  unavailable"
                : activeState?.Initialized == true
                    ? label
                    : $"{label}  •  ready";

        BackButton.IsEnabled = activeState?.Browser?.CanGoBack == true;
        ForwardButton.IsEnabled = activeState?.Browser?.CanGoForward == true;
        RefreshButton.IsEnabled = activeState?.Initialized == true;
        ZoomOutButton.IsEnabled = activeState?.Initialized == true;
        ZoomInButton.IsEnabled = activeState?.Initialized == true;
        ZoomText.Text = $"{(_preferences.ZoomFor(ActiveTab) * 100):0}%";

        SetTabVisual(CompanionTabButton, CompanionTab.Companion);
        SetTabVisual(UggTabButton, CompanionTab.UGg);
        SetTabVisual(CoachlessTabButton, CompanionTab.Coachless);
        UpdateOfferBar();
    }

    private void SetTabVisual(System.Windows.Controls.Button button, CompanionTab tab)
    {
        var active = ActiveTab == tab;
        // Fully qualified: WinForms is enabled on this project, so the implicit
        // System.Drawing using makes a bare `Brushes` the GDI+ one.
        var transparent = System.Windows.Media.Brushes.Transparent;
        button.Background = active ? (System.Windows.Media.Brush)FindResource("ChromeRaisedBrush") : transparent;
        button.BorderBrush = active ? (System.Windows.Media.Brush)FindResource("GoldBrush") : transparent;
        button.Foreground = active ? (System.Windows.Media.Brush)FindResource("TextBrush") : (System.Windows.Media.Brush)FindResource("MutedTextBrush");
    }

    private void UpdateOfferBar()
    {
        if (!Dispatcher.CheckAccess()) return;
        var context = _champSelectContext;
        var hasContext = ShouldShowOfferBar(ActiveTab, context);
        OfferBar.Visibility = hasContext ? Visibility.Visible : Visibility.Collapsed;
        if (!hasContext || context is null) return;

        var role = SiteDeepLink.RoleLabel(context.RoleId);
        OfferHintText.Text = context.Locked
            ? $"{context.ChampionName}{(role is null ? string.Empty : $" · {role}")} locked"
            : $"{context.ChampionName}{(role is null ? string.Empty : $" · {role}")} hovered";
        UggOfferButton.Content = "Open u.gg";
        CoachlessOfferButton.Content = "Open Coachless";

        var uggOffer = context.UrlFor(CompanionTabs.UGg);
        var coachlessOffer = context.UrlFor(CompanionTabs.Coachless);
        UggOfferButton.IsEnabled = uggOffer is not null
            && !SiteNavigationPolicy.IsAlreadyThere(
                GetState(CompanionTab.UGg)?.Core?.Source,
                uggOffer);
        CoachlessOfferButton.IsEnabled = coachlessOffer is not null
            && !SiteNavigationPolicy.IsAlreadyThere(
                GetState(CompanionTab.Coachless)?.Core?.Source,
                coachlessOffer);
    }

    /// <summary>
    /// The champ-select row belongs to the research tabs. Keeping it collapsed
    /// on Companion prevents an automatic draft open from adding a second call
    /// to action above the hosted app, while still preserving the context for
    /// the site tab the user chooses.
    /// </summary>
    internal static bool ShouldShowOfferBar(
        CompanionTab activeTab,
        ChampSelectContext? context)
    {
        return activeTab != CompanionTab.Companion
            && context is not null
            && context.UrlFor(CompanionTabs.UGg) is not null
            && context.UrlFor(CompanionTabs.Coachless) is not null;
    }

    /// <summary>
    /// WPF cannot paint over a visible WebView2 HWND. This single decision is
    /// used by UpdateChrome and is also the contract for a newly allocated tab.
    /// </summary>
    internal static Visibility BrowserVisibilityFor(bool isActiveTab, bool hasReadyBrowser) =>
        isActiveTab && hasReadyBrowser ? Visibility.Visible : Visibility.Collapsed;

    private void HideBrowsersExcept(CompanionTab tab)
    {
        foreach (var state in _tabs.Values)
        {
            if (state.Tab != tab && state.Browser is not null)
                state.Browser.Visibility = Visibility.Collapsed;
        }
    }

    private void SetLoading(BrowserTabState state, string message)
    {
        state.IsLoading = true;
        if (!IsActiveTab(state)) return;
        LoadingText.Text = message;
        StatusText.Text = message;
        UpdateChrome();
    }

    private void ShowPageError(BrowserTabState state, string message)
    {
        state.IsLoading = false;
        state.Error = message;
        if (!IsActiveTab(state)) return;
        ErrorText.Text = message;
        StatusText.Text = message;
        UpdateChrome();
    }

    private void ShowFallback(string message)
    {
        if (_disposed) return;
        _showingFallback = true;
        _fallbackMessage = message;
        Fallback.IsRepairEnabled = true;
        StatusText.Text = message;
        UpdateChrome();
    }

    private void HideFallbackAndError()
    {
        _showingFallback = false;
        _fallbackMessage = null;
        UpdateChrome();
    }

    private void SetStatus(string message)
    {
        StatusText.Text = message;
    }

    private static string DisplayUrl(string? source)
    {
        if (string.IsNullOrWhiteSpace(source)) return "Ready";
        if (!Uri.TryCreate(source, UriKind.Absolute, out var uri)) return source;
        var path = uri.AbsolutePath.TrimEnd('/');
        return string.IsNullOrEmpty(path) ? uri.Host : $"{uri.Host}{path}";
    }

    private bool IsActiveTab(BrowserTabState state) => _hasActiveTab && _activeTab == state.Tab;

    private BrowserTabState? GetState(CompanionTab tab) =>
        _tabs.TryGetValue(tab, out var state) ? state : null;

    private BrowserTabState GetOrCreateState(CompanionTab tab)
    {
        if (!_tabs.TryGetValue(tab, out var state))
        {
            state = new BrowserTabState(tab);
            _tabs[tab] = state;
        }
        return state;
    }

    private void RemoveFailedBrowser(BrowserTabState state)
    {
        if (state.Browser is not { } browser) return;
        try
        {
            browser.Dispose();
        }
        catch
        {
        }
        BrowserHost.Children.Remove(browser);
        state.Browser = null;
        state.Core = null;
        state.Initialized = false;
        state.HasNavigated = false;
    }

    private void OnClosed(object? sender, EventArgs e)
    {
        _disposed = true;
        Fallback.RepairRequested -= OnRepairRequested;
        DisposeBrowser();
    }

    /// <summary>
    /// Ends every Chromium process tree this window owns. Closing the WPF
    /// window alone leaves WebView2's out-of-process renderer alive; disposing
    /// each lazy tab is what releases its controller and profile environment.
    /// </summary>
    internal void DisposeBrowser()
    {
        if (_browserDisposed) return;
        _browserDisposed = true;

        foreach (var state in _tabs.Values)
        {
            if (state.Browser is not { } browser) continue;
            try
            {
                browser.Dispose();
            }
            catch
            {
            }
            state.Browser = null;
            state.Core = null;
            state.Initialized = false;
            state.HasNavigated = false;
            state.IsLoading = false;
        }

        _tabs.Clear();
        BrowserHost.Children.Clear();
    }
}
