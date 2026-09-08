using System.Globalization;
using System.Windows;
using System.Windows.Controls;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;
using CoachBuild.Core;
using CoachBuild.Desktop.Tray;
using CoachBuild.Desktop.Updates;

namespace CoachBuild.Desktop.Web;

/// <summary>
/// The single native companion window. It owns one lazy WebView2 control per
/// destination so each tab keeps its own history and sign-in while the
/// application still has one window and one lifetime gate.
///
/// <para>The hosted CoachBuild page is the only surface with the persistent
/// session token and the only surface whose document is inspected
/// unprompted: the version meta tag is read solely to support the existing
/// web-freshness check. The site tabs are read-mostly, with TWO sanctioned
/// exceptions. (1) The gold <c>Import runes</c> button reads the VISIBLE u.gg
/// build page once per click - runes only, never items - while the client is
/// connected (<see cref="SiteImportExtractors"/> for the scripts,
/// <c>RunRunesImportAsync</c> below for the single call site). It is hidden
/// on Coachless, which has no rune page. (2) The automatic item import
/// (<see cref="SiteAutoImportService"/>) fetches both sites' item sets in the
/// background on champ-select lock (and re-fetches the visible build page
/// when its URL changes): u.gg is one read-only script; Coachless is a
/// stepped select-and-recompute walk (inspect, click each ITEM slot's top row
/// from 1st Item in DOM order awaiting settle, final read of selected else
/// conditioned top rows) because its tables recompute conditioned on the
/// picks so far. Background fetches reuse a background site tab or a hidden
/// worker webview - never the visible tab, never a change of the selected
/// tab, never a focus steal - and a worker is navigated ONLY to the exact
/// deep-link URL the app's own builders produce for the locked
/// champion+role
/// (<see cref="AutoImportCoordinator.IsAllowedAutoImportTarget"/>).
/// <c>SiteTabComplianceTests</c> pins that scope: site-tab script execution
/// is extractor steps from the runes click, the visible-extract path, or the
/// worker-fetch path (plus this file's Companion version read); automated
/// navigation call sites are enumerated and the worker one asserts the
/// allowlist; and no timer of the window's own may scrape.</para>
/// </summary>
public partial class WebView2Window : Window, ISiteAutoImportExecutor
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

        /// <summary>
        /// True once the MyStats consent dismissal has been ATTEMPTED for the
        /// navigation currently in this tab (2.1.0 round 2). Cleared on
        /// NavigationStarting, so the attempt is once per navigation and never
        /// once per event: op.gg is a SPA and fires NavigationCompleted more
        /// than once for a single page.
        /// </summary>
        public bool ConsentAttempted { get; set; }

        /// <summary>
        /// True when the idle sweep disposed this tab's WebView2. The state
        /// row survives (the tab button stays), so this is what tells the
        /// lazy path it is RE-creating rather than creating.
        /// </summary>
        public bool Released { get; set; }

        /// <summary>
        /// The shared environment this tab was created from. The auto-import
        /// hidden workers reuse a site tab's environment so they share its
        /// profile (cookies, Cloudflare clearance) instead of minting a
        /// second one for the same folder, which WebView2 refuses.
        /// </summary>
        public CoreWebView2Environment? Environment { get; set; }
    }

    private readonly WebView2EnvironmentService _environmentService;
    private readonly HostedPagePolicy _policy;
    private readonly string _sessionToken;
    private readonly string _userDataFolder;
    private readonly Action<RepairResult>? _repairCompleted;
    private readonly Action<CompanionTabsPreferences>? _preferencesChanged;
    private readonly Func<CancellationToken, Task<Uri?>>? _opGgProfileResolver;
    private readonly Dictionary<CompanionTab, BrowserTabState> _tabs = new();
    private CompanionTabsPreferences _preferences;
    private ChampSelectContext? _champSelectContext;
    private readonly ISiteImportHost? _siteImport;
    private bool _lcuConnected;
    private bool _importRunning;
    /// <summary>
    /// The automatic item import: constructed by
    /// <see cref="AttachAutoImport"/> (the window is the executor — the only
    /// place that may touch a WebView) and driven by
    /// <see cref="NotifySnapshotForAutoImport"/> on the snapshot tick. Null
    /// until attached; the runes button works without it.
    /// </summary>
    private SiteAutoImportService? _autoImport;
    /// <summary>
    /// The tray log sink, kept so the window's own browser-lifecycle lines
    /// (consent dismissal, idle teardown) reach the same companion.log the
    /// auto-import writes to. Null until <see cref="AttachAutoImport"/>.
    /// </summary>
    private Action<string>? _autoImportLog;
    private readonly Dictionary<CompanionTab, DateTimeOffset> _lastVisible = new();
    /// <summary>Hidden worker webviews for the auto-import, one per site at most. Never shown, never selected.</summary>
    private readonly Dictionary<CompanionTab, BrowserTabState> _workers = new();
    private string? _activeUpdateHint;
    private string? _paintedUpdateHint;
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
        Action<CompanionTabsPreferences>? preferencesChanged = null,
        ISiteImportHost? siteImport = null,
        Func<CancellationToken, Task<Uri?>>? opGgProfileResolver = null)
    {
        _environmentService = environmentService ?? throw new ArgumentNullException(nameof(environmentService));
        _policy = new HostedPagePolicy(appOrigin);
        if (!SessionTokenStore.IsValid(sessionToken)) throw new ArgumentException("Invalid session token.", nameof(sessionToken));
        _sessionToken = sessionToken;
        _userDataFolder = userDataFolder ?? throw new ArgumentNullException(nameof(userDataFolder));
        _repairCompleted = repairCompleted;
        _preferencesChanged = preferencesChanged;
        _opGgProfileResolver = opGgProfileResolver;
        _preferences = preferences ?? CompanionTabsPreferences.Default;
        // Null (no host, e.g. the client never connected at startup) leaves
        // the import button present but disabled with a tooltip saying why.
        _siteImport = siteImport;

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
            await NavigateSiteHome(state, cancellationToken).ConfigureAwait(true);
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

        // Freshness checks may run while the user is reading any site tab.
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

    /// <summary>
    /// Receives the LCU connection projection on the existing snapshot tick.
    /// Redraws chrome (the import button's enabled state), and — on the
    /// RISING edge of the connection — gives the MyStats tab the one retry it
    /// was missing (see <see cref="RetryOpGgProfileAsync"/>).
    /// </summary>
    public void UpdateSiteImportAvailability(bool lcuConnected)
    {
        if (_disposed) return;
        if (!Dispatcher.CheckAccess())
        {
            Dispatcher.BeginInvoke(
                new Action(() => UpdateSiteImportAvailability(lcuConnected)),
                System.Windows.Threading.DispatcherPriority.Background);
            return;
        }

        var connected = lcuConnected && !_lcuConnected;
        _lcuConnected = lcuConnected;
        UpdateOfferBar();
        if (connected) _ = RetryOpGgProfileAsync(_shutdownToken);
    }

    /// <summary>
    /// Re-resolves the user's op.gg profile once the League client connects,
    /// and navigates the MyStats tab there IF it is still sitting on op.gg
    /// home.
    ///
    /// <para>THE BUG THIS FIXES. The 2026-09-08 field log contains ZERO
    /// <c>opgg:</c> lines across the whole session: the tab silently opened
    /// op.gg home and stayed there. Two causes, both real, both fixed here.
    /// (1) TIMING — <see cref="NavigateSiteHome"/> resolves the profile
    /// exactly once, on the tab's first navigation. Open MyStats before the
    /// client is up (the log shows ~60s of "League client not connected" at
    /// launch) and the resolve fails, home loads, and nothing ever tries
    /// again; this method is that retry. (2) SILENCE — the resolver's catch
    /// swallowed every failure, so a user seeing op.gg home had no way to
    /// learn why. Both paths now log one line either way.</para>
    ///
    /// <para>It refuses to move a page the user navigated themselves: only a
    /// tab still on op.gg's own home is redirected, so someone reading
    /// another player's profile when the client connects keeps their page.
    /// </para>
    /// </summary>
    private async Task RetryOpGgProfileAsync(CancellationToken cancellationToken)
    {
        if (_disposed || _opGgProfileResolver is null) return;
        var state = GetState(CompanionTab.OpGg);
        // Nothing to correct until the tab exists and has actually loaded.
        if (state?.Core is null || !state.HasNavigated) return;
        if (!IsOpGgHome(state.Core.Source)) return;

        var profile = await ResolveOpGgProfileAsync(cancellationToken).ConfigureAwait(true);
        if (_disposed || profile is null) return;
        if (GetState(CompanionTab.OpGg) is not { } current || current.Core is null) return;
        if (!IsOpGgHome(current.Core.Source)) return;
        Navigate(current, profile);
    }

    /// <summary>
    /// Resolves the op.gg profile and LOGS the outcome either way. The one
    /// place either branch is written, so the visible-tab path and the
    /// on-connect retry can never disagree about what happened.
    /// </summary>
    private async Task<Uri?> ResolveOpGgProfileAsync(CancellationToken cancellationToken)
    {
        if (_opGgProfileResolver is null)
        {
            LogLifecycle("opgg: identity unavailable (no resolver attached) -- opening home");
            return null;
        }
        try
        {
            var profile = await _opGgProfileResolver(cancellationToken).ConfigureAwait(true);
            if (profile is null)
            {
                LogLifecycle(
                    "opgg: identity unavailable (client returned no riot id or platform) -- opening home");
                return null;
            }
            // Path only: "/summoners/{region}/{name}-{tag}". The riot id is
            // the user's own and already goes to op.gg in the URL, but the
            // log is a file on disk, so it stays to the same shape the tab
            // will show and carries nothing else.
            LogLifecycle($"opgg: profile resolved {profile.AbsolutePath.TrimStart('/')}");
            return profile;
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception error)
        {
            LogLifecycle($"opgg: identity unavailable ({error.Message}) -- opening home");
            return null;
        }
    }

    /// <summary>
    /// True when the MyStats tab is on op.gg's own landing page rather than a
    /// profile the user chose. Path-only, so a tracking query cannot make the
    /// home page look like a destination.
    /// </summary>
    internal static bool IsOpGgHome(string? url)
    {
        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri)) return false;
        var host = uri.Host.TrimEnd('.');
        if (!host.Equals("op.gg", StringComparison.OrdinalIgnoreCase)
            && !host.Equals("www.op.gg", StringComparison.OrdinalIgnoreCase)) return false;
        return uri.AbsolutePath.Trim('/').Length == 0;
    }

    /// <summary>
    /// Receives the update service's staged-release projection for the status
    /// line. Like the champ-select context above this only redraws chrome: it
    /// paints the hint when the slot is idle, leaves a site message exactly
    /// as it is, and clears only its own paint.
    /// </summary>
    public void UpdateStagedUpdateHint(UpdateTrayModel? model)
    {
        if (_disposed) return;
        if (!Dispatcher.CheckAccess())
        {
            Dispatcher.BeginInvoke(
                new Action(() => UpdateStagedUpdateHint(model)),
                System.Windows.Threading.DispatcherPriority.Background);
            return;
        }

        _activeUpdateHint = UpdateWindowHint.For(model);
        RefreshUpdateHint();
    }

    /// <summary>
    /// The slot shapes the hint may land on without fighting the site tabs:
    /// the initial text, a navigation-idle line, an empty slot, or the hint's
    /// own paint (a version bump repaints over itself). Pure so the sharing
    /// rule is assertable without a window.
    /// </summary>
    internal static bool IsIdleStatusSlot(string? statusText, string? paintedHint)
    {
        if (!string.IsNullOrEmpty(paintedHint)
            && string.Equals(statusText, paintedHint, StringComparison.Ordinal))
            return true;
        if (string.IsNullOrEmpty(statusText)) return true;
        if (string.Equals(statusText, "Ready", StringComparison.Ordinal)) return true;
        foreach (var tab in CompanionTabs.Order)
        {
            if (string.Equals(statusText, $"{CompanionTabs.LabelFor(tab)} ready", StringComparison.Ordinal))
                return true;
        }

        return false;
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
        // Stamp BOTH: the tab being left starts its idle clock now, and the
        // tab being entered must not carry a stale stamp from a previous
        // visit (which would make it eligible for teardown while visible --
        // the policy refuses that anyway, but the stamp should be honest).
        var now = DateTimeOffset.UtcNow;
        if (_hasActiveTab) _lastVisible[_activeTab] = now;
        _lastVisible[tab] = now;
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
                await NavigateSiteHome(state, cancellationToken).ConfigureAwait(true);
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
        if (state.Released)
        {
            // Symmetric with the idle teardown: the same lazy path rebuilds
            // it, and the log says so, so a slow first paint after ten idle
            // minutes reads as a deliberate release rather than a bug.
            state.Released = false;
            LogLifecycle(SiteTabIdlePolicy.RecreateLine(tab));
        }
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
            // Kept so the auto-import hidden workers can share this tab's
            // environment (and therefore its profile) instead of opening the
            // same folder twice.
            state.Environment = environment;
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

        if (state.Tab == CompanionTab.Companion)
        {
            // The draft page is a static export shipped in the package, mapped
            // onto the app's own origin. DenyCors keeps the mapped folder from
            // being read cross-origin; the page's own calls to the loopback
            // bridge are governed by the bridge's Origin allowlist instead.
            webView.SetVirtualHostNameToFolderMapping(
                _policy.Origin.Host,
                System.IO.Path.Combine(AppContext.BaseDirectory, HostedPagePolicy.LocalAssetFolder),
                CoreWebView2HostResourceAccessKind.DenyCors);
        }

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
                        ? "That link leaves the local CoachBuild app and was blocked."
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
        // Re-arm the one-per-navigation MyStats consent attempt. Set here, not
        // in the completed handler, so a SPA route change that fires several
        // completions still gets exactly one attempt.
        else if (state.Tab == CompanionTab.OpGg) state.ConsentAttempted = false;
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
                if (_activeUpdateHint is not null)
                {
                    StatusText.Text = _activeUpdateHint;
                    _paintedUpdateHint = _activeUpdateHint;
                }
                else
                {
                    StatusText.Text = $"{CompanionTabs.LabelFor(state.Tab)} ready";
                    _paintedUpdateHint = null;
                }
                if (state.Core is not null)
                    state.Browser.ZoomFactor = _preferences.ZoomFor(state.Tab);
                UpdateChrome();
            }

            // MyStats' consent wall, dismissed once per navigation (2.1.0
            // round 2). The import paths already do this for the two build
            // sites; MyStats had no import path at all, so its wall sat over
            // the whole tab with no dismissal anywhere (screenshot
            // _evidence/live-2.1.0/02-mystats-tab.png). Fire-and-forget: a
            // navigation handler must not await, and a failed dismissal just
            // leaves the page as it was.
            if (state.Tab == CompanionTab.OpGg && !state.ConsentAttempted && state.Core is not null)
            {
                state.ConsentAttempted = true;
                _ = DismissMyStatsConsentAsync(state.Core, _shutdownToken);
            }

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

    private async Task NavigateSiteHome(
        BrowserTabState state,
        CancellationToken cancellationToken = default)
    {
        var site = CompanionTabs.SiteFor(state.Tab);
        if (site is null) return;
        var target = site.Home;
        if (state.Tab == CompanionTab.OpGg)
        {
            // Profile resolution is an enhancement over a usable site tab: any
            // LCU or payload failure still degrades to op.gg home. What it no
            // longer does is degrade SILENTLY -- ResolveOpGgProfileAsync logs
            // one line either way, and UpdateSiteImportAvailability retries
            // this on the connection's rising edge, because the whole reason
            // the field log had no opgg lines is that the tab can be opened
            // before the client is up.
            target = await ResolveOpGgProfileAsync(cancellationToken).ConfigureAwait(true)
                ?? site.Home;
        }
        Navigate(state, target);
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

    private async void OnOpGgTabClick(object sender, RoutedEventArgs e) =>
        await SwitchToTabAsync(CompanionTab.OpGg).ConfigureAwait(true);

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
            await NavigateSiteHome(state, _shutdownToken).ConfigureAwait(true);
    }

    private async void OnHomeClick(object sender, RoutedEventArgs e)
    {
        var state = GetState(ActiveTab);
        if (state is null) return;
        if (state.Tab == CompanionTab.Companion)
            NavigateHosted(state, new ReopenTarget(ReopenDestination.Home));
        else
            await NavigateSiteHome(state, _shutdownToken).ConfigureAwait(true);
    }

    private async void OnUggOfferClick(object sender, RoutedEventArgs e) =>
        await OpenSiteOfferAsync(CompanionTab.UGg).ConfigureAwait(true);

    private async void OnCoachlessOfferClick(object sender, RoutedEventArgs e) =>
        await OpenSiteOfferAsync(CompanionTab.Coachless).ConfigureAwait(true);

    private async void OnImportRunesClick(object sender, RoutedEventArgs e) =>
        await RunRunesImportAsync().ConfigureAwait(true);

    /// <summary>
    /// The runes-button import, reachable only from
    /// <see cref="ImportRunesButton"/>, which shows only on a u.gg
    /// build-page URL and enables only while the client is connected — and
    /// the connection is re-checked here, because the client may have closed
    /// between the last snapshot tick and the click. u.gg runs ONE
    /// read-only script, then the host validates and writes the rune page
    /// alone: items never flow through this button (they arrive via the
    /// automatic import). Never navigates, never reloads; every outcome
    /// (including an unexpected exception) lands on the status line and
    /// writes nothing partial.
    /// </summary>
    private async Task RunRunesImportAsync()
    {
        if (_disposed || _importRunning) return;
        // Belt and braces behind the hidden button: runes import reads the
        // visible u.gg page only. Anything else has no rune page to read.
        if (ActiveTab != CompanionTab.UGg) return;
        var state = GetState(CompanionTab.UGg);
        // Without a host or a live site browser there is nothing to read.
        if (state?.Core is null || _siteImport is null) return;

        _importRunning = true;
        UpdateOfferBar();
        SetStatus($"Importing runes from {CompanionTabs.LabelFor(CompanionTab.UGg)}…");
        try
        {
            var raw = await state.Core.ExecuteScriptAsync(SiteImportExtractors.UGgScript).ConfigureAwait(true);
            if (_disposed) return;
            var result = await _siteImport.ImportRunesAsync(raw, _shutdownToken).ConfigureAwait(true);
            if (_disposed) return;
            SetStatus(result.Message);
        }
        catch (Exception error)
        {
            // The script surface carries no secrets (no token, no
            // credentials), so naming the failure is safe and debuggable.
            if (!_disposed) SetStatus($"Import failed ({error.Message}) -- nothing was imported");
        }
        finally
        {
            _importRunning = false;
            if (!_disposed) UpdateOfferBar();
        }
    }

    /// <summary>
    /// The zoom keyboard shortcuts. 2.1.0 removed the Zoom -/100%/+ chrome
    /// cluster to merge the two chrome rows into one; zoom itself had to keep
    /// working, so the shortcuts are now explicit here rather than implied by
    /// three buttons.
    ///
    /// <para>Ctrl+Plus / Ctrl+Minus / Ctrl+0, including the numpad keys and
    /// the unshifted <c>=</c> that Ctrl+Plus really is on most layouts. The
    /// result still persists per site: <c>SetActiveZoom</c> writes through
    /// <see cref="CompanionTabsPreferences"/> exactly as the buttons did.</para>
    /// </summary>
    protected override void OnKeyDown(System.Windows.Input.KeyEventArgs e)
    {
        ArgumentNullException.ThrowIfNull(e);
        base.OnKeyDown(e);
        if (e.Handled || _disposed) return;
        if ((System.Windows.Input.Keyboard.Modifiers & System.Windows.Input.ModifierKeys.Control) == 0)
            return;

        switch (e.Key)
        {
            case System.Windows.Input.Key.OemPlus:
            case System.Windows.Input.Key.Add:
                ZoomIn();
                e.Handled = true;
                break;
            case System.Windows.Input.Key.OemMinus:
            case System.Windows.Input.Key.Subtract:
                ZoomOut();
                e.Handled = true;
                break;
            case System.Windows.Input.Key.D0:
            case System.Windows.Input.Key.NumPad0:
                ResetZoom();
                e.Handled = true;
                break;
            default:
                break;
        }
    }

    /// <summary>
    /// The Coachless select-and-recompute walk as extractor-shaped JSON: the
    /// page's slot tables recompute conditioned on the picks so far, so the
    /// fetch reproduces what a user gets by clicking the top-WPA row of each
    /// ITEM slot from 1st Item in DOM order, then reading each item slot
    /// (selected row else conditioned top row). The order AND the clickable
    /// set come from the page (the opening inspect step), never from a
    /// hardcoded list: only item slots whose top row carries the site's
    /// <c>selectable</c> class are clicked (Keystone, Starter and Spell
    /// never; read-only slots are skipped outright, never clicked, never
    /// waited on).
    ///
    /// <para>Runs on ANY site CoreWebView2 -- the visible Coachless tab or a
    /// hidden worker -- because the caller (never this method) decides which
    /// core is safe to touch. Returns the final payload JSON, or an
    /// <c>error</c> payload on failure so the service's normal typed-failure
    /// path reports it. Each loop turn runs one small step script; after a
    /// click the driver polls until the tables settle AND the clicked slot
    /// shows a selection (~250ms apart, ~5s wait per slot -- plain awaits,
    /// not a timer). A clicked slot that never selects does NOT fail the
    /// fetch -- the walk notes it into the payload meta and moves on.
    /// Compliance calls this a script SITE (not a call count): it is
    /// reachable only from the two auto-import fetch paths below.</para>
    /// </summary>
    private async Task<string> RunCoachlessWalkAsync(CoreWebView2 core, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(core);
        try
        {
            var sequence = SiteImportSequencer.Initial();
            while (true)
            {
                if (_disposed) return WalkFailure("the window closed during the import");
                cancellationToken.ThrowIfCancellationRequested();
                switch (SiteImportSequencer.CommandFor(sequence))
                {
                    case FailCommand fail:
                        return WalkFailure(fail.Reason);
                    case SucceedCommand done:
                        return done.PayloadJson;
                    case ClickSlotCommand click:
                    {
                        var raw = await core.ExecuteScriptAsync(
                            SiteImportExtractors.CoachlessStepScript(
                                SiteImportSteps.Click(click.Title))).ConfigureAwait(true);
                        if (_disposed) return WalkFailure("the window closed during the import");
                        sequence = SiteImportSequencer.Transition(
                            sequence, CoachlessStepResponse.Parse(raw));
                        break;
                    }
                    case ReadFinalCommand:
                    {
                        var raw = await core.ExecuteScriptAsync(
                            SiteImportExtractors.CoachlessStepScript(
                                SiteImportSteps.Read())).ConfigureAwait(true);
                        if (_disposed) return WalkFailure("the window closed during the import");
                        sequence = SiteImportSequencer.Transition(
                            sequence, CoachlessStepResponse.Parse(raw));
                        break;
                    }
                    default:
                    {
                        // InspectCommand: discovery, or one settle poll. The
                        // pause lives only here, before settle polls -- a
                        // plain await, not a timer.
                        if (sequence.Phase == SequencerPhase.Settle)
                            await Task.Delay(
                                SiteImportSequencer.SettlePollDelayMs,
                                cancellationToken).ConfigureAwait(true);
                        if (_disposed) return WalkFailure("the window closed during the import");
                        var raw = await core.ExecuteScriptAsync(
                            SiteImportExtractors.CoachlessInspectScript).ConfigureAwait(true);
                        if (_disposed) return WalkFailure("the window closed during the import");
                        sequence = SiteImportSequencer.Transition(
                            sequence, CoachlessStepResponse.Parse(raw));
                        break;
                    }
                }
            }
        }
        catch (Exception error)
        {
            return WalkFailure(error.Message);
        }
    }

    /// <summary>
    /// Shapes a walk failure as the extractor's own <c>error</c> envelope so
    /// the service reports it through the normal typed-failure path (quiet
    /// log plus status-line note, never a dialog).
    /// </summary>
    private static string WalkFailure(string reason) =>
        System.Text.Json.JsonSerializer.Serialize(
            new { error = string.IsNullOrWhiteSpace(reason) ? "the import failed" : reason.Trim() });

    /// <summary>
    /// Attaches the automatic item import to this window. The window is the
    /// executor (the only place that may touch a WebView);
    /// <paramref name="items"/> is the bridge's item-set service (items-only
    /// writes, so the runes button's rune pages are never in reach) and
    /// <paramref name="logInfo"/> is the tray log sink. Null until attached;
    /// the runes button works without it. Call on the dispatcher.
    /// </summary>
    public void AttachAutoImport(
        ItemSetApplyService items,
        IChampionDirectory champions,
        Action<string> logInfo,
        RuneApplyService? runes = null)
    {
        ArgumentNullException.ThrowIfNull(items);
        ArgumentNullException.ThrowIfNull(champions);
        ArgumentNullException.ThrowIfNull(logInfo);
        if (_disposed) return;
        _autoImportLog = logInfo;
        _autoImport = new SiteAutoImportService(
            this, items, champions, new WindowAutoImportSink(this, logInfo), runes);
    }

    /// <summary>Quiet log hop for the window's own lifecycle lines. Never throws.</summary>
    private void LogLifecycle(string line)
    {
        if (string.IsNullOrWhiteSpace(line)) return;
        try
        {
            _autoImportLog?.Invoke(line);
        }
        catch
        {
        }
    }

    /// <summary>
    /// Receives the champ-select projection plus the LCU connection on the
    /// existing snapshot tick and offers them to the auto-import. Like the
    /// champ-select context above this only STARTS background work -- it
    /// never navigates a visible tab itself (worker navigation happens
    /// inside the service flight, through the allowlisted worker path
    /// below), never changes the selected tab, and never blocks the tick:
    /// the service single-flights and never throws.
    /// </summary>
    public void NotifySnapshotForAutoImport(ChampSelectContext? context, bool lcuConnected)
    {
        if (_disposed) return;
        if (!Dispatcher.CheckAccess())
        {
            Dispatcher.BeginInvoke(
                new Action(() => NotifySnapshotForAutoImport(context, lcuConnected)),
                System.Windows.Threading.DispatcherPriority.Background);
            return;
        }

        // The idle sweep rides the tick the window already gets rather than
        // owning a timer: it is a pure decision plus a dispose, and it must
        // not run on a thread of its own next to WebView2. Deliberately
        // BEFORE the auto-import guard -- the memory a stale tab holds is not
        // conditional on the import being attached.
        SweepIdleTabs(DateTimeOffset.UtcNow);

        var auto = _autoImport;
        if (auto is null) return;

        var input = AutoImportInput.FromContext(context, ActiveTab, CurrentUrl, lcuConnected);
        // Fire-and-forget by construction (see the service contract).
        _ = auto.OnSnapshotAsync(input, CancellationToken.None);
    }

    /// <summary>
    /// The auto-import's sink: log lines go to the tray log, notes to the
    /// status line. Every hop is exception-proof -- background reporting
    /// must not take down a browser tab. Never a dialog.
    /// </summary>
    private sealed class WindowAutoImportSink(WebView2Window window, Action<string> logInfo) : ISiteAutoImportSink
    {
        public void LogInfo(string line)
        {
            try
            {
                logInfo(line);
            }
            catch
            {
            }
        }

        public void StatusNote(string message)
        {
            try
            {
                var dispatcher = window.Dispatcher;
                if (dispatcher.CheckAccess())
                {
                    if (!window._disposed) window.SetStatus(message);
                    return;
                }
                dispatcher.BeginInvoke(new Action(() =>
                {
                    if (!window._disposed) window.SetStatus(message);
                }));
            }
            catch
            {
            }
        }
    }

    /// <summary>
    /// The executor's visible read (<see cref="ISiteAutoImportExecutor"/>):
    /// extracts off the visible tab WITHOUT navigating it. Null when the
    /// tab was never initialized -- the service records the miss as a quiet
    /// failure and the debounce moves on. Marshals to the dispatcher: the
    /// service calls from a background flight, and WebView2 is
    /// thread-affine.
    /// </summary>
    public Task<string?> ExtractVisibleAsync(CompanionTab site, CancellationToken cancellationToken = default)
    {
        if (site is not (CompanionTab.UGg or CompanionTab.Coachless))
            return Task.FromResult<string?>(null);
        var completion = new TaskCompletionSource<string?>(TaskCreationOptions.RunContinuationsAsynchronously);
        Dispatcher.BeginInvoke(new Func<Task>(async () =>
        {
            try
            {
                completion.TrySetResult(await ExtractVisibleOnUiAsync(site, cancellationToken).ConfigureAwait(true));
            }
            catch (Exception error)
            {
                completion.TrySetException(error);
            }
        }));
        return completion.Task;
    }

    private async Task<string?> ExtractVisibleOnUiAsync(CompanionTab site, CancellationToken cancellationToken)
    {
        if (_disposed) return null;
        var core = GetState(site)?.Core;
        if (core is null) return null;
        await DismissConsentAsync(core, site, cancellationToken).ConfigureAwait(true);
        if (_disposed) return null;
        if (site == CompanionTab.Coachless)
            return await RunCoachlessWalkAsync(core, cancellationToken).ConfigureAwait(true);
        return await core.ExecuteScriptAsync(SiteImportExtractors.UGgScript).ConfigureAwait(true);
    }

    /// <summary>
    /// How long the import waits after accepting a consent dialog before it
    /// reads the page. The wall's teardown re-renders the content behind it,
    /// and reading during that is what produced a no-build.
    /// </summary>
    private const int ConsentSettleDelayMs = 600;

    /// <summary>
    /// Dismisses a recognized TCF consent wall once, at the start of an
    /// import, and logs the fact.
    ///
    /// <para>This is the ONE click the import makes outside the Coachless
    /// slot walk, and it is inside the same user-sanctioned interaction: the
    /// user asked for the build, and the wall is what stands between the
    /// worker and the page they asked about (field log 2026-09-08 17:48:15,
    /// "Coachless extraction failed (no build on page)"). It clicks only the
    /// two accept controls named in
    /// <see cref="SiteImportExtractors.ConsentDismissTemplate"/> and nothing
    /// else; an unrecognized wall stays up and the import fails honestly.
    /// Never throws — a failed dismissal just leaves the page as it was.</para>
    /// </summary>
    private async Task DismissConsentAsync(
        CoreWebView2 core,
        CompanionTab site,
        CancellationToken cancellationToken)
    {
        if (_disposed) return;
        try
        {
            var raw = await core.ExecuteScriptAsync(
                SiteImportExtractors.ConsentDismissScript).ConfigureAwait(true);
            if (_disposed) return;
            var outcome = ConsentDismissal.Parse(raw);
            if (!outcome.Dismissed) return;
            LogLifecycle(outcome.LogLine(CompanionTabs.LabelFor(site)) ?? string.Empty);
            await Task.Delay(ConsentSettleDelayMs, cancellationToken).ConfigureAwait(true);
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch
        {
            // A wall we could not dismiss is the pre-2.1.0 behaviour: the
            // extraction below reports its own typed failure.
        }
    }

    /// <summary>
    /// The MyStats (op.gg) consent dismissal: ONE attempt per navigation,
    /// after the same settle the import paths use.
    ///
    /// <para>WHY MYSTATS TOO. Screenshot <c>_evidence/live-2.1.0/02-mystats-tab.png</c>,
    /// 2026-09-08: op.gg's consent modal covers the profile on first visit and
    /// the tab offers no way past it — the import paths' dismissal
    /// (<see cref="DismissConsentAsync"/>) never ran here, because MyStats has
    /// no import path. It is LITERALLY the same dialog: op.gg runs Quantcast
    /// Choice, the same CMP Coachless runs, and the modal in that screenshot is
    /// the <c>coachless-jhin-adc.html</c> fixture's wall word for word — "We
    /// value your privacy", the IABGPP_HDR_GppString sentence, MORE OPTIONS /
    /// DISAGREE / AGREE. So the <c>#qc-cmp2-container</c> + <c>#accept-btn</c>
    /// anchors already shipped in
    /// <see cref="SiteImportExtractors.ConsentDismissTemplate"/> recognize it
    /// with no new selector and no new guess. That is the whole of the change:
    /// this tab is still never scraped, never navigated by us, and never
    /// read — the one script it may run is the recognized-accept-control
    /// click, once per navigation, and <c>SiteTabComplianceTests</c> pins
    /// exactly that.</para>
    ///
    /// <para>Never throws, never awaits the caller: it runs off a navigation
    /// handler.</para>
    /// </summary>
    private async Task DismissMyStatsConsentAsync(CoreWebView2 core, CancellationToken cancellationToken)
    {
        try
        {
            // The wall mounts after the document does, so read the page the
            // same beat later the import paths already wait.
            await Task.Delay(ConsentSettleDelayMs, cancellationToken).ConfigureAwait(true);
            if (_disposed) return;
            var raw = await core.ExecuteScriptAsync(
                SiteImportExtractors.ConsentDismissScript).ConfigureAwait(true);
            if (_disposed) return;
            var outcome = ConsentDismissal.Parse(raw);
            if (outcome.LogLine(CompanionTabs.LabelFor(CompanionTab.OpGg)) is { } line)
            {
                LogLifecycle(line);
                return;
            }
            // A wall we recognized but could not click is worth a line: it is
            // the difference between "no wall today" and "the wall changed".
            if (!string.Equals(outcome.Reason, "none", StringComparison.Ordinal))
            {
                LogLifecycle(
                    $"{CompanionTabs.LabelFor(CompanionTab.OpGg)}: consent dialog left alone ({outcome.Reason})");
            }
        }
        catch (OperationCanceledException)
        {
            // Window closing.
        }
        catch
        {
            // A wall we could not dismiss leaves the page exactly as it was,
            // which is the pre-2.1.0 behaviour for this tab.
        }
    }

    /// <summary>
    /// The executor's Coachless RUNES fetch: navigate a worker to the
    /// per-slot WPA runes page and read the full page off it.
    ///
    /// <para>Separate from the item walk because it is a separate PAGE. The
    /// builds overview ranks keystones only, so before 2.1.0 a Coachless
    /// import was honestly items-only ("no rune page on this site"). Same
    /// worker rules as every other automated navigation: allowlisted URL,
    /// hidden core, never the visible tab.</para>
    /// </summary>
    public Task<string?> FetchCoachlessRunesAsync(
        Uri url,
        string? championKey,
        int? roleId,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(url);
        var completion = new TaskCompletionSource<string?>(TaskCreationOptions.RunContinuationsAsynchronously);
        Dispatcher.BeginInvoke(new Func<Task>(async () =>
        {
            try
            {
                completion.TrySetResult(
                    await FetchCoachlessRunesOnUiAsync(url, championKey, roleId, cancellationToken)
                        .ConfigureAwait(true));
            }
            catch (Exception error)
            {
                completion.TrySetException(error);
            }
        }));
        return completion.Task;
    }

    private async Task<string?> FetchCoachlessRunesOnUiAsync(
        Uri url,
        string? championKey,
        int? roleId,
        CancellationToken cancellationToken)
    {
        if (_disposed) return null;
        if (!AutoImportCoordinator.IsAllowedRunesTarget(url, championKey, roleId)) return null;

        var core = await GetFetchCoreAsync(CompanionTab.Coachless, cancellationToken).ConfigureAwait(true);
        if (core is null || _disposed) return null;
        if (!await NavigateRunesWorkerAndWaitAsync(core, url, championKey, roleId, cancellationToken)
            .ConfigureAwait(true))
            return null;
        if (_disposed) return null;
        await DismissConsentAsync(core, CompanionTab.Coachless, cancellationToken).ConfigureAwait(true);
        if (_disposed) return null;

        // SETTLE-POLL, do not read once (2.1.0 round 2). NavigationCompleted
        // means the document arrived, not that the WPA numbers did: the page
        // is Angular and paints its rune cards first, which is how a page that
        // reads perfectly as a fixture produced "no keystone on the runes page
        // carried a WPA reading" live. Re-read while the extractor says the
        // absence is still growable; the LAST result is what is reported, so a
        // timed-out settle returns the extractor's own typed failure with its
        // per-row census rather than a bare "timed out".
        var deadline = RunesSettleProbe.SettleTimeoutMs;
        var waited = 0;
        var raw = await core.ExecuteScriptAsync(SiteImportExtractors.CoachlessRunesScript).ConfigureAwait(true);
        var reads = 1;
        while (!_disposed && RunesSettleProbe.IsRetryable(raw) && waited < deadline)
        {
            await Task.Delay(RunesSettleProbe.SettleDelayMs, cancellationToken).ConfigureAwait(true);
            if (_disposed) return raw;
            waited += RunesSettleProbe.SettleDelayMs;
            raw = await core.ExecuteScriptAsync(SiteImportExtractors.CoachlessRunesScript).ConfigureAwait(true);
            reads++;
        }
        if (reads > 1)
        {
            LogLifecycle(
                $"runes: settled the Coachless runes page over {reads} reads in {waited}ms " +
                (RunesSettleProbe.IsRetryable(raw) ? "-- still no WPA readings" : "-- readings arrived"));
        }
        return raw;
    }

    /// <summary>
    /// The executor's worker fetch (<see cref="ISiteAutoImportExecutor"/>):
    /// navigates a BACKGROUND site tab or a HIDDEN worker webview to the
    /// deep link and extracts -- never the visible tab, never a change of
    /// the selected tab, never a focus steal. Refuses any URL outside
    /// <see cref="AutoImportCoordinator.IsAllowedAutoImportTarget"/> before
    /// navigating anything. Marshals to the dispatcher like the visible
    /// read above.
    /// </summary>
    public Task<string?> FetchViaWorkerAsync(
        CompanionTab site,
        Uri url,
        string? championKey,
        int? roleId,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(url);
        if (site is not (CompanionTab.UGg or CompanionTab.Coachless))
            return Task.FromResult<string?>(null);
        var completion = new TaskCompletionSource<string?>(TaskCreationOptions.RunContinuationsAsynchronously);
        Dispatcher.BeginInvoke(new Func<Task>(async () =>
        {
            try
            {
                completion.TrySetResult(
                    await FetchViaWorkerOnUiAsync(site, url, championKey, roleId, cancellationToken)
                        .ConfigureAwait(true));
            }
            catch (Exception error)
            {
                completion.TrySetException(error);
            }
        }));
        return completion.Task;
    }

    private async Task<string?> FetchViaWorkerOnUiAsync(
        CompanionTab site,
        Uri url,
        string? championKey,
        int? roleId,
        CancellationToken cancellationToken)
    {
        if (_disposed) return null;
        if (!AutoImportCoordinator.IsAllowedAutoImportTarget(site, url, championKey, roleId))
        {
            SetStatus($"Auto-import refused an unexpected page for {CompanionTabs.LabelFor(site)} -- nothing was imported");
            return null;
        }

        var core = await GetFetchCoreAsync(site, cancellationToken).ConfigureAwait(true);
        if (core is null || _disposed) return null;
        if (!await NavigateWorkerAndWaitAsync(core, site, url, championKey, roleId, cancellationToken)
            .ConfigureAwait(true))
            return null;
        if (_disposed) return null;
        await DismissConsentAsync(core, site, cancellationToken).ConfigureAwait(true);
        if (_disposed) return null;
        if (site == CompanionTab.Coachless)
            return await RunCoachlessWalkAsync(core, cancellationToken).ConfigureAwait(true);
        return await core.ExecuteScriptAsync(SiteImportExtractors.UGgScript).ConfigureAwait(true);
    }

    /// <summary>
    /// The core a worker fetch may navigate: the site's own tab when it is
    /// initialized and NOT the one the user is viewing (reusing its profile
    /// without moving the user's page), else a hidden worker webview (which
    /// shares the site tab's environment when one exists). Null when there
    /// is no safe core -- the fetch becomes a quiet miss. Caller is on the
    /// dispatcher.
    /// </summary>
    private async Task<CoreWebView2?> GetFetchCoreAsync(CompanionTab site, CancellationToken cancellationToken)
    {
        var state = GetState(site);
        if (state?.Initialized == true && state.Core is not null)
        {
            if (!IsActiveTab(state)) return state.Core;
        }
        else if (ActiveTab != site)
        {
            // Lazily created in the background for the fetch; it stays
            // hidden because it is not the active tab, and it carries the
            // real site profile from the first byte.
            var created = await EnsureTabAsync(site, cancellationToken).ConfigureAwait(true);
            if (created is not null && created.Core is not null && !IsActiveTab(created))
                return created.Core;
        }
        return await EnsureWorkerCoreAsync(site, cancellationToken).ConfigureAwait(true);
    }

    /// <summary>
    /// The hidden worker core for a site, in the zero-area
    /// <c>AutoImportHost</c> grid: never visible, never selected, never
    /// focused. Shares the site tab's environment (hence its profile --
    /// cookies and Cloudflare clearance) when the tab has initialized, else
    /// a dedicated auto-import profile folder. Null when the runtime is gone
    /// -- the fetch becomes a quiet miss. Caller is on the dispatcher.
    /// </summary>
    private async Task<CoreWebView2?> EnsureWorkerCoreAsync(CompanionTab site, CancellationToken cancellationToken)
    {
        if (_disposed) return null;
        if (_workers.TryGetValue(site, out var existing) && existing.Core is not null)
            return existing.Core;

        var environment = GetState(site)?.Environment;
        if (environment is null)
        {
            // The SITE's own profile folder, not a private "auto-" one.
            //
            // Until 2.1.0 this fell back to Path.Combine(_userDataFolder,
            // "auto-" + key), which is a SEPARATE Chromium profile: on a
            // launch where the user never opened the site tab, the worker got
            // a profile that had never seen the consent wall, and accepting
            // consent in the visible tab did nothing for it -- so the wall
            // came back on every single run. That is the profile divergence
            // the 1.3.0 brief said must not exist, and it is the standing
            // half of the 2026-09-08 "no build on page" failure; the consent
            // click is the other half. Same folder, same cookies, one
            // acceptance. WebView2 supports several environments over one
            // user-data folder, so this needs no tab to exist first.
            try
            {
                environment = await _environmentService.CreateAsync(
                    CompanionTabs.ProfileFolder(_userDataFolder, site),
                    cancellationToken).ConfigureAwait(true);
            }
            catch
            {
                return null;
            }
        }
        if (_disposed || environment is null) return null;

        var browser = new WebView2
        {
            HorizontalAlignment = System.Windows.HorizontalAlignment.Left,
            VerticalAlignment = System.Windows.VerticalAlignment.Top,
            Width = 0,
            Height = 0,
            Visibility = Visibility.Collapsed,
            Focusable = false,
            AllowExternalDrop = false,
            IsHitTestVisible = false,
        };
        AutoImportHost.Children.Add(browser);
        var worker = new BrowserTabState(site) { Browser = browser, Environment = environment };
        try
        {
            await browser.EnsureCoreWebView2Async(environment).ConfigureAwait(true);
        }
        catch
        {
            AutoImportHost.Children.Remove(browser);
            try
            {
                browser.Dispose();
            }
            catch
            {
            }
            return null;
        }
        if (_disposed || browser.CoreWebView2 is null)
        {
            AutoImportHost.Children.Remove(browser);
            try
            {
                browser.Dispose();
            }
            catch
            {
            }
            return null;
        }
        worker.Core = browser.CoreWebView2;
        worker.Initialized = true;
        // Hygiene, not policy: a background fetch opens no popups, launches
        // no external schemes, takes no permissions, and follows https only
        // (the deep-link allowlist already pins the first navigation).
        worker.Core.NewWindowRequested += (_, args) => args.Handled = true;
        worker.Core.LaunchingExternalUriScheme += (_, args) => args.Cancel = true;
        worker.Core.PermissionRequested += (_, args) => args.State = CoreWebView2PermissionState.Deny;
        worker.Core.NavigationStarting += (_, args) =>
        {
            if (!SiteNavigationPolicy.IsAllowed(args.Uri)) args.Cancel = true;
        };
        _workers[site] = worker;
        return worker.Core;
    }

    /// <summary>
    /// Disposes every hidden import worker (<see cref="ISiteAutoImportExecutor"/>).
    /// Marshals to the dispatcher: the service calls this from its background
    /// flight, and a WebView2 must be disposed on the thread that made it.
    /// </summary>
    public void ReleaseImportWorkers()
    {
        if (_disposed) return;
        if (!Dispatcher.CheckAccess())
        {
            Dispatcher.BeginInvoke(new Action(ReleaseImportWorkers));
            return;
        }
        ReleaseImportWorkersOnUi();
    }

    private void ReleaseImportWorkersOnUi()
    {
        if (_disposed || _workers.Count == 0) return;
        var released = new List<CompanionTab>(_workers.Count);
        foreach (var (site, worker) in _workers)
        {
            if (worker.Browser is not { } browser) continue;
            AutoImportHost.Children.Remove(browser);
            try
            {
                browser.Dispose();
            }
            catch
            {
            }
            worker.Browser = null;
            worker.Core = null;
            worker.Initialized = false;
            worker.HasNavigated = false;
            worker.IsLoading = false;
            released.Add(site);
        }
        _workers.Clear();
        foreach (var site in released)
            LogLifecycle($"tabs: released the {CompanionTabs.LabelFor(site)} import worker after its run");
    }

    /// <summary>
    /// The idle sweep: disposes the WebView2 of any site tab the user has not
    /// looked at for <see cref="SiteTabIdlePolicy.IdleTimeout"/>. The tab
    /// BUTTON stays; revisiting recreates the browser through the existing
    /// lazy path, and the profile directory keeps its cookies, consent and
    /// sign-in, so a recreated tab is not a signed-out one.
    ///
    /// <para>The decision is not made here — <see cref="SiteTabIdlePolicy"/>
    /// owns it and is unit-tested without a browser. This method is only the
    /// hands.</para>
    /// </summary>
    internal void SweepIdleTabs(DateTimeOffset now)
    {
        if (_disposed) return;
        if (!Dispatcher.CheckAccess())
        {
            Dispatcher.BeginInvoke(new Action(() => SweepIdleTabs(now)));
            return;
        }

        var snapshots = new List<TabIdleSnapshot>(_tabs.Count);
        foreach (var (tab, state) in _tabs)
        {
            snapshots.Add(new TabIdleSnapshot(
                tab,
                IsVisible: _hasActiveTab && _activeTab == tab,
                HasBrowser: state.Browser is not null,
                LastVisible: _lastVisible.TryGetValue(tab, out var seen) ? seen : now));
        }

        foreach (var tab in SiteTabIdlePolicy.Sweep(snapshots, now))
        {
            if (!_tabs.TryGetValue(tab, out var state) || state.Browser is not { } browser) continue;
            BrowserHost.Children.Remove(browser);
            try
            {
                browser.Dispose();
            }
            catch
            {
            }
            // The STATE row survives with Browser/Core null, so the tab button
            // stays and EnsureTabAsync rebuilds it on the next visit. The
            // environment is deliberately kept: recreating on the same
            // environment is what makes the revisit cheap.
            state.Browser = null;
            state.Core = null;
            state.Initialized = false;
            state.HasNavigated = false;
            state.IsLoading = false;
            state.Error = null;
            state.Released = true;
            LogLifecycle(SiteTabIdlePolicy.TeardownLine(tab));
        }
    }

    /// <summary>
    /// How long a worker fetch waits for its deep link to load before the
    /// run becomes a quiet miss. Background work must not pile up across
    /// snapshot ticks; the service single-flight already bounds overlap.
    /// </summary>
    private static readonly TimeSpan AutoImportNavigationTimeout = TimeSpan.FromSeconds(30);

    /// <summary>
    /// Navigates a WORKER core (hidden worker, or a background site tab the
    /// user is not viewing) to a deep link and waits for the load. THE
    /// automated-navigation call site: the allowlist assert below is the
    /// compliance pin -- automated navigation reaches no other Navigate in
    /// this file. Returns false on refusal, timeout, cancellation, or load
    /// failure; the fetch then becomes a quiet miss.
    /// </summary>
    private async Task<bool> NavigateWorkerAndWaitAsync(
        CoreWebView2 core,
        CompanionTab site,
        Uri url,
        string? championKey,
        int? roleId,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(core);
        ArgumentNullException.ThrowIfNull(url);
        if (!AutoImportCoordinator.IsAllowedAutoImportTarget(site, url, championKey, roleId))
            return false;
        return await NavigateAndWaitCoreAsync(core, url, cancellationToken).ConfigureAwait(true);
    }

    /// <summary>
    /// The SECOND automated-navigation call site (2.1.0): the Coachless
    /// per-slot runes page. Its own allowlist
    /// (<see cref="AutoImportCoordinator.IsAllowedRunesTarget"/>) is the same
    /// shape as the build-page one — the URL must be EXACTLY what
    /// <see cref="SiteDeepLink.CoachlessRunesUrl"/> produces for this
    /// champion+role, so a hand-built or drifted URL is refused before
    /// anything navigates.
    /// </summary>
    private async Task<bool> NavigateRunesWorkerAndWaitAsync(
        CoreWebView2 core,
        Uri url,
        string? championKey,
        int? roleId,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(core);
        ArgumentNullException.ThrowIfNull(url);
        if (!AutoImportCoordinator.IsAllowedRunesTarget(url, championKey, roleId))
            return false;
        return await NavigateAndWaitCoreAsync(core, url, cancellationToken).ConfigureAwait(true);
    }

    /// <summary>
    /// Navigate-and-wait, shared by the two allowlisted worker paths above
    /// and reachable ONLY from them. It deliberately performs no check of its
    /// own: each caller asserts its own allowlist first, which keeps the two
    /// policies visible at the two call sites instead of hidden in a shared
    /// branch.
    /// </summary>
    private async Task<bool> NavigateAndWaitCoreAsync(
        CoreWebView2 core,
        Uri url,
        CancellationToken cancellationToken)
    {
        var loaded = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        void Handler(object? sender, CoreWebView2NavigationCompletedEventArgs args)
        {
            core.NavigationCompleted -= Handler;
            loaded.TrySetResult(args.IsSuccess);
        }
        core.NavigationCompleted += Handler;
        try
        {
            core.Navigate(url.ToString());
            var completed = await Task.WhenAny(
                loaded.Task,
                Task.Delay(AutoImportNavigationTimeout, cancellationToken)).ConfigureAwait(true);
            if (!ReferenceEquals(completed, loaded.Task)) return false;
            return await loaded.Task.ConfigureAwait(true);
        }
        catch
        {
            return false;
        }
        finally
        {
            core.NavigationCompleted -= Handler;
        }
    }

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

        SetTabVisual(CompanionTabButton, CompanionTab.Companion);
        SetTabVisual(UggTabButton, CompanionTab.UGg);
        SetTabVisual(CoachlessTabButton, CompanionTab.Coachless);
        SetTabVisual(OpGgTabButton, CompanionTab.OpGg);
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
        var showOffer = ShouldShowOfferBar(ActiveTab, context);
        // The runes button works outside champ select too (a rune page
        // persists), so the bar also shows for a bare u.gg build page --
        // with the chips hidden and only the runes button working. Item
        // sets arrive via the automatic import, never this button.
        var runesUrl = ShouldShowRunesImport(ActiveTab, GetState(ActiveTab)?.Core?.Source);
        OfferBar.Visibility = showOffer || runesUrl ? Visibility.Visible : Visibility.Collapsed;
        if (OfferBar.Visibility != Visibility.Visible) return;

        ChampChipsPanel.Visibility = showOffer && context is not null
            ? Visibility.Visible
            : Visibility.Collapsed;
        if (showOffer && context is not null)
        {
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
        else
        {
            OfferHintText.Text = "Import reads this page's runes";
        }

        var button = RunesButtonFor(
            ActiveTab,
            GetState(ActiveTab)?.Core?.Source,
            _siteImport is not null,
            _importRunning,
            _lcuConnected);
        ImportRunesButton.Visibility = button.Visible ? Visibility.Visible : Visibility.Collapsed;
        ImportRunesButton.IsEnabled = button.Enabled;
        ImportRunesButton.ToolTip = button.Tooltip;
        OfferCaptionText.Text = showOffer ? "Click a site to open" : "Import writes to the client";
    }

    /// <summary>The runes button's chrome state: visibility, enablement, and the reason in the tooltip.</summary>
    internal sealed record RunesButtonState(bool Visible, bool Enabled, string Tooltip);

    /// <summary>
    /// Pure runes-button state. Visible only on a u.gg build page (hidden on
    /// Coachless -- no rune page there -- and on Companion, which is never
    /// scraped); enabled only while the client is connected. The tooltip
    /// always says WHY the button will not run, not merely refuse.
    /// </summary>
    internal static RunesButtonState RunesButtonFor(
        CompanionTab activeTab,
        string? currentUrl,
        bool hasHost,
        bool importRunning,
        bool lcuConnected)
    {
        if (!ShouldShowRunesImport(activeTab, currentUrl))
            return new(false, false, "Open a u.gg champion build page to import its runes.");
        if (!hasHost)
            return new(true, false, "Import is unavailable in this window.");
        if (importRunning)
            return new(true, false, "Import already running…");
        if (!lcuConnected)
            return new(true, false, "Open the League client to import these runes.");
        return new(true, true, "Read this page's rune build into the League client.");
    }

    /// <summary>
    /// The runes button's visibility: the u.gg tab on a build-page URL. Pure,
    /// so the button state and the extractor share one definition of "a
    /// build page" through
    /// <see cref="SiteImportExtractors.CanImportFromUrl"/>. Hidden on
    /// Coachless (that site renders no rune page -- a button there would be
    /// a dead click) and on Companion (never scraped).
    /// </summary>
    internal static bool ShouldShowRunesImport(CompanionTab activeTab, string? currentUrl) =>
        activeTab == CompanionTab.UGg
        && SiteImportExtractors.CanImportFromUrl(activeTab, currentUrl);

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

    /// <summary>
    /// Paints or clears the staged-update hint without fighting the site
    /// tabs: the hint only ever lands on an idle slot, and clearing only ever
    /// removes the hint's own paint. A site message in the slot is left
    /// exactly as it is — it wins by staying.
    /// </summary>
    private void RefreshUpdateHint()
    {
        if (_disposed || !Dispatcher.CheckAccess()) return;
        if (_activeUpdateHint is not null)
        {
            if (IsIdleStatusSlot(StatusText.Text, _paintedUpdateHint))
            {
                StatusText.Text = _activeUpdateHint;
                _paintedUpdateHint = _activeUpdateHint;
            }

            return;
        }

        if (_paintedUpdateHint is not null
            && string.Equals(StatusText.Text, _paintedUpdateHint, StringComparison.Ordinal))
        {
            StatusText.Text = IdleStatusText();
            _paintedUpdateHint = null;
        }
    }

    private string IdleStatusText() => $"{CompanionTabs.LabelFor(ActiveTab)} ready";

    // DisplayUrl lived here to format the chrome's URL label. 2.1.0 removed
    // that label with the second chrome row, and its only caller with it.

    private bool IsActiveTab(BrowserTabState state) => _hasActiveTab && _activeTab == state.Tab;

    private BrowserTabState? GetState(CompanionTab tab) =>
        _tabs.TryGetValue(tab, out var state) ? state : null;

    private BrowserTabState GetOrCreateState(CompanionTab tab)
    {
        if (!_tabs.TryGetValue(tab, out var state))
        {
            state = new BrowserTabState(tab);
            _tabs[tab] = state;
            // Start the idle clock at CREATION, not at first visit. A tab the
            // auto-import created in the background to fetch through (see
            // GetFetchCoreAsync) may never be selected at all, and without a
            // stamp the sweep would default its LastVisible to "now" on every
            // pass and it would never age out -- the exact leak the idle
            // teardown exists to close.
            _lastVisible.TryAdd(tab, DateTimeOffset.UtcNow);
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

        // The auto-import's hidden workers die with the window: their pages
        // hold no user state worth keeping (the site tabs own the profiles).
        foreach (var worker in _workers.Values)
        {
            if (worker.Browser is not { } browser) continue;
            try
            {
                browser.Dispose();
            }
            catch
            {
            }
            worker.Browser = null;
            worker.Core = null;
            worker.Initialized = false;
            worker.HasNavigated = false;
            worker.IsLoading = false;
        }

        _workers.Clear();
        AutoImportHost.Children.Clear();
    }
}
