using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Threading;
using Microsoft.Web.WebView2.Core;
using CoachBuild.Desktop.Overlay;
using CoachBuild.Desktop.Tray;
using CoachBuild.Desktop.Web;

namespace CoachBuild.Desktop.CompanionTabsPreview;

/// <summary>
/// A disposable, non-production launcher for visual QA. It constructs the
/// shipped WPF window directly, with a profile under the caller-provided temp
/// root, so App.OnStartup (LCU, tray, updater, settings and registry startup)
/// never runs. Reflection is intentional here: the preview should keep
/// working while the companion window's tab coordinator is being reshaped.
/// </summary>
internal static class Program
{
    private const string AppOrigin = "https://coachbuild.local";
    private const string Token = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    [STAThread]
    private static int Main(string[] args)
    {
        var options = PreviewOptions.Parse(args);
        Directory.CreateDirectory(options.ProfileRoot);

        var app = new Application
        {
            ShutdownMode = ShutdownMode.OnExplicitShutdown,
        };

        WebView2Window? window = null;
        app.Startup += (_, _) =>
        {
            try
            {
                var environment = new WebView2EnvironmentService(
                    Path.Combine(options.ProfileRoot, "webview2"));
                var preferences = new OverlaySettingsStore(
                    Path.Combine(options.ProfileRoot, "desktop-settings.json"));
                var remembered = ((ICompanionTabsPreferencesStore)preferences).Read();
                var persist = new Action<CompanionTabsPreferences>(value =>
                    ((ICompanionTabsPreferencesStore)preferences).Save(value));
                window = CreateWindow(environment, preferences, remembered, persist, options.ProfileRoot);
                window.Closed += (_, _) => app.Shutdown();
                window.Show();
                WriteReady(options.ReadyFile, window);
                _ = OpenRequestedTabsAsync(
                    window,
                    options.Tabs,
                    options.IntervalMilliseconds,
                    options.ReadyFile,
                    options.CaptureDirectory,
                    options.ErrorTab,
                    options.NavigateUrls,
                    app.Dispatcher);
                if (options.DurationSeconds > 0)
                {
                    var closeTimer = new DispatcherTimer
                    {
                        Interval = TimeSpan.FromSeconds(options.DurationSeconds),
                    };
                    closeTimer.Tick += (_, _) =>
                    {
                        closeTimer.Stop();
                        window?.Close();
                    };
                    closeTimer.Start();
                }
            }
            catch (Exception error)
            {
                WriteReady(options.ReadyFile, error);
                app.Shutdown(2);
            }
        };

        return app.Run();
    }

    private static WebView2Window CreateWindow(
        WebView2EnvironmentService environment,
        OverlaySettingsStore preferences,
        CompanionTabsPreferences remembered,
        Action<CompanionTabsPreferences> persist,
        string profileRoot)
    {
        // The current constructor is deliberately represented through the
        // same argument mapper as future tab-window constructors. This keeps
        // the preview out of the production API and lets QA run against a
        // build where a tab coordinator has moved into its own service.
        var failures = new List<string>();
        foreach (var constructor in typeof(WebView2Window)
                     .GetConstructors(BindingFlags.Public | BindingFlags.Instance)
                     .OrderByDescending(static constructor => constructor.GetParameters().Length))
        {
            if (!TryBuildArguments(
                    constructor.GetParameters(),
                    environment,
                    preferences,
                    remembered,
                    persist,
                    profileRoot,
                    out var values))
            {
                failures.Add($"{constructor}: unsupported parameter shape");
                continue;
            }
            try
            {
                if (constructor.Invoke(values) is WebView2Window created)
                    return created;
            }
            catch (TargetInvocationException error)
            {
                // Try a less specific overload. The final error names every
                // constructor shape rather than hiding an API mismatch.
                failures.Add($"{constructor}: {error.InnerException?.GetType().Name}: {error.InnerException?.Message}");
            }
        }

        throw new InvalidOperationException(
            "CompanionTabsPreview could not construct CoachBuild.Desktop.Web.WebView2Window. "
            + string.Join(" | ", failures));
    }

    private static bool TryBuildArguments(
        ParameterInfo[] parameters,
        WebView2EnvironmentService environment,
        OverlaySettingsStore preferences,
        CompanionTabsPreferences remembered,
        Action<CompanionTabsPreferences> persist,
        string profileRoot,
        out object?[] values)
    {
        values = new object?[parameters.Length];
        for (var index = 0; index < parameters.Length; index++)
        {
            var parameter = parameters[index];
            var type = parameter.ParameterType;
            var name = parameter.Name?.ToLowerInvariant() ?? string.Empty;

            if (type == typeof(WebView2EnvironmentService))
            {
                values[index] = environment;
            }
            else if (typeof(ICompanionTabsPreferencesStore).IsAssignableFrom(type))
            {
                values[index] = preferences;
            }
            else if (type == typeof(CompanionTabsPreferences))
            {
                values[index] = remembered;
            }
            else if (type == typeof(string))
            {
                values[index] = name.Contains("origin") ? AppOrigin
                    : name.Contains("token") || name.Contains("session") ? Token
                    : profileRoot;
            }
            else if (type == typeof(ReopenTarget))
            {
                values[index] = new ReopenTarget(ReopenDestination.Home);
            }
            else if (type == typeof(CompanionTab))
            {
                values[index] = CompanionTab.Companion;
            }
            else if (type == typeof(Action<RepairResult>))
            {
                values[index] = null;
            }
            else if (type == typeof(Action<CompanionTabsPreferences>))
            {
                values[index] = persist;
            }
            else if (parameter.HasDefaultValue)
            {
                values[index] = parameter.DefaultValue;
            }
            else if (!type.IsValueType || Nullable.GetUnderlyingType(type) is not null)
            {
                // Optional services are allowed to be absent in this preview;
                // no production service is ever created by this process.
                values[index] = null;
            }
            else if (type == typeof(bool))
            {
                values[index] = false;
            }
            else if (type.IsEnum)
            {
                values[index] = Enum.GetValues(type).GetValue(0);
            }
            else
            {
                return false;
            }
        }

        return true;
    }

    private static async Task OpenRequestedTabsAsync(
        WebView2Window window,
        IReadOnlyList<CompanionTab> tabs,
        int intervalMilliseconds,
        string? readyFile,
        string? captureDirectory,
        CompanionTab? errorTab,
        IReadOnlyDictionary<CompanionTab, Uri> navigateUrls,
        Dispatcher dispatcher)
    {
        try
        {
            foreach (var tab in tabs)
            {
                await dispatcher.InvokeAsync(async () =>
                {
                    if (await TryInvokeTabApiAsync(window, tab).ConfigureAwait(true)) return;

                    // This fallback is the stable pre-tab API and gives a useful
                    // Companion screenshot even when this executable is built
                    // against an older desktop assembly.
                    if (tab == CompanionTab.Companion)
                        await window.OpenAsync(new ReopenTarget(ReopenDestination.Home)).ConfigureAwait(true);
                    else
                        throw new InvalidOperationException(
                            $"The desktop assembly exposes no tab navigation API for {tab}.");
                }).Task.Unwrap().ConfigureAwait(true);
                await dispatcher.InvokeAsync(
                    () => WaitForTabNavigationAsync(window, tab)).Task.Unwrap().ConfigureAwait(true);
                if (navigateUrls.TryGetValue(tab, out var qaUrl))
                {
                    // QA-only deep navigation (same isolated pattern as
                    // NavigateToQaErrorAsync): lets a capture land on a
                    // specific page, e.g. a champion build page, without
                    // touching production navigation paths.
                    await dispatcher.InvokeAsync(
                        () => NavigateToUrlAsync(window, tab, qaUrl)).Task.Unwrap().ConfigureAwait(true);
                }
                WriteTabMarker(readyFile, tab, window);
                if (captureDirectory is not null)
                {
                    if (intervalMilliseconds > 0)
                        await Task.Delay(intervalMilliseconds).ConfigureAwait(true);
                    await dispatcher.InvokeAsync(
                        () => CaptureWindowAsync(
                            window,
                            Path.Combine(
                                captureDirectory,
                                $"companion-tabs-{CompanionTabs.KeyFor(tab)}.png"),
                            "selected-tab",
                            tab)).Task.Unwrap().ConfigureAwait(true);
                }
                else if (intervalMilliseconds > 0)
                    await Task.Delay(intervalMilliseconds).ConfigureAwait(true);
            }

            if (captureDirectory is not null && errorTab is { } failedTab)
            {
                await dispatcher.InvokeAsync(
                    () => window.SwitchToTabAsync(failedTab)).Task.Unwrap().ConfigureAwait(true);
                if (intervalMilliseconds > 0)
                    await Task.Delay(intervalMilliseconds).ConfigureAwait(true);

                await dispatcher.InvokeAsync(
                    () => NavigateToQaErrorAsync(window, failedTab)).Task.Unwrap().ConfigureAwait(true);
                await dispatcher.InvokeAsync(
                    () => CaptureWindowAsync(
                        window,
                        Path.Combine(
                            captureDirectory,
                            $"companion-tabs-{CompanionTabs.KeyFor(failedTab)}-error.png"),
                        "navigation-error",
                        failedTab)).Task.Unwrap().ConfigureAwait(true);
                WriteErrorMarker(readyFile, failedTab, window);
            }
        }
        catch (Exception error)
        {
            WriteReady(readyFile, error);
        }
    }

    private static async Task WaitForTabNavigationAsync(WebView2Window window, CompanionTab tab)
    {
        var browser = window.ActiveBrowser
            ?? throw new InvalidOperationException($"The {tab} tab has no active WebView2 control.");
        var core = browser.CoreWebView2
            ?? throw new InvalidOperationException($"The {tab} tab has no initialized CoreWebView2 controller.");

        // A completed page makes the production control visible. This fast
        // path also handles a remembered profile whose navigation completed
        // before the preview got to subscribe to the event.
        if (browser.Visibility == Visibility.Visible && !string.IsNullOrWhiteSpace(core.Source))
            return;

        var completed = new TaskCompletionSource<bool>(
            TaskCreationOptions.RunContinuationsAsynchronously);
        void OnNavigationCompleted(object? sender, CoreWebView2NavigationCompletedEventArgs args) =>
            completed.TrySetResult(true);

        core.NavigationCompleted += OnNavigationCompleted;
        try
        {
            await completed.Task.WaitAsync(TimeSpan.FromSeconds(60)).ConfigureAwait(true);
            // Let the first paint settle before the native CapturePreview call.
            await Task.Delay(500).ConfigureAwait(true);
        }
        finally
        {
            core.NavigationCompleted -= OnNavigationCompleted;
        }
    }

    private static async Task NavigateToUrlAsync(WebView2Window window, CompanionTab tab, Uri url)
    {
        var browser = window.ActiveBrowser
            ?? throw new InvalidOperationException($"The {tab} tab has no active WebView2 control.");
        var core = browser.CoreWebView2
            ?? throw new InvalidOperationException($"The {tab} tab has no initialized CoreWebView2 controller.");
        var completed = new TaskCompletionSource<bool>(
            TaskCreationOptions.RunContinuationsAsynchronously);

        void OnNavigationCompleted(object? sender, CoreWebView2NavigationCompletedEventArgs args) =>
            completed.TrySetResult(args.IsSuccess);

        core.NavigationCompleted += OnNavigationCompleted;
        try
        {
            core.Navigate(url.AbsoluteUri);
            await completed.Task.WaitAsync(TimeSpan.FromSeconds(45)).ConfigureAwait(true);
            await Task.Delay(250).ConfigureAwait(true);
        }
        finally
        {
            core.NavigationCompleted -= OnNavigationCompleted;
        }
    }

    private static async Task NavigateToQaErrorAsync(WebView2Window window, CompanionTab tab)
    {
        var browser = window.ActiveBrowser
            ?? throw new InvalidOperationException($"The {tab} tab has no active WebView2 control.");
        var core = browser.CoreWebView2
            ?? throw new InvalidOperationException($"The {tab} tab has no initialized CoreWebView2 controller.");
        var completed = new TaskCompletionSource<bool>(
            TaskCreationOptions.RunContinuationsAsynchronously);

        void OnNavigationCompleted(object? sender, CoreWebView2NavigationCompletedEventArgs args) =>
            completed.TrySetResult(args.IsSuccess);

        core.NavigationCompleted += OnNavigationCompleted;
        try
        {
            // .invalid is reserved by RFC 2606, so this is an isolated,
            // allowed HTTPS navigation that cannot load a real site. It lets
            // QA exercise the shipped error card without changing production
            // configuration or reading page DOM.
            core.Navigate("https://coachbuild-companion-tabs.invalid/qa-error");
            await completed.Task.WaitAsync(TimeSpan.FromSeconds(25)).ConfigureAwait(true);
            await Task.Delay(250).ConfigureAwait(true);
        }
        finally
        {
            core.NavigationCompleted -= OnNavigationCompleted;
        }
    }

    /// <summary>
    /// Captures the actual client visual tree and, when the production window
    /// is showing a ready WebView2 tab, composites CoreWebView2's native page
    /// PNG into the measured BrowserHost rectangle. This works while the
    /// Windows session is locked; it does not pretend a screen grab succeeded.
    /// </summary>
    private static async Task CaptureWindowAsync(
        WebView2Window window,
        string path,
        string state,
        CompanionTab tab)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(path))!);
        window.UpdateLayout();

        var root = window.Content as Visual
            ?? throw new InvalidOperationException("The preview window has no WPF visual root.");
        var rootElement = root as UIElement
            ?? throw new InvalidOperationException("The preview window root is not a WPF UIElement.");
        var dpi = VisualTreeHelper.GetDpi(window);
        var rootWidthDip = root is FrameworkElement element
            ? element.ActualWidth
            : window.ActualWidth;
        var rootHeightDip = root is FrameworkElement element2
            ? element2.ActualHeight
            : window.ActualHeight;
        var width = Math.Max(1, (int)Math.Round(rootWidthDip * dpi.DpiScaleX));
        var height = Math.Max(1, (int)Math.Round(rootHeightDip * dpi.DpiScaleY));

        var browser = window.ActiveBrowser;
        var browserVisible = browser?.Visibility == Visibility.Visible;
        var browserRect = browser is null
            ? new Rect()
            : new Rect(
                browser.TranslatePoint(new Point(0, 0), rootElement),
                new Size(browser.ActualWidth, browser.ActualHeight));

        BitmapSource? page = null;
        var pageWidth = 0;
        var pageHeight = 0;
        if (browserVisible)
        {
            var core = browser!.CoreWebView2
                ?? throw new InvalidOperationException($"The visible {tab} tab has no WebView2 controller.");
            Exception? lastError = null;
            for (var attempt = 0; attempt < 6 && page is null; attempt++)
            {
                try
                {
                    await using var stream = new MemoryStream();
                    await core.CapturePreviewAsync(
                        CoreWebView2CapturePreviewImageFormat.Png,
                        stream).ConfigureAwait(true);
                    stream.Position = 0;
                    page = BitmapFrame.Create(
                        stream,
                        BitmapCreateOptions.PreservePixelFormat,
                        BitmapCacheOption.OnLoad);
                    pageWidth = page.PixelWidth;
                    pageHeight = page.PixelHeight;
                }
                catch (Exception error) when (attempt < 5)
                {
                    lastError = error;
                    await Task.Delay(500).ConfigureAwait(true);
                }
            }

            if (page is null)
                throw new InvalidOperationException(
                    $"CapturePreviewAsync failed for {tab}: {lastError?.Message}",
                    lastError);
        }

        BitmapSource native;
        var previousVisibility = browser?.Visibility;
        try
        {
            // HwndHost content is intentionally hidden only while WPF renders
            // its own controls. The browser PNG above is still from the real
            // WebView2 controller and is placed back into this exact layout.
            if (browser is not null)
                browser.Visibility = Visibility.Collapsed;
            window.UpdateLayout();
            var nativeTarget = new RenderTargetBitmap(
                width,
                height,
                96 * dpi.DpiScaleX,
                96 * dpi.DpiScaleY,
                PixelFormats.Pbgra32);
            nativeTarget.Render(root);
            native = nativeTarget;
        }
        finally
        {
            if (browser is not null && previousVisibility is { } visibility)
                browser.Visibility = visibility;
            window.UpdateLayout();
        }

        var composedVisual = new DrawingVisual();
        using (var drawing = composedVisual.RenderOpen())
        {
            // DrawingVisual coordinates are DIPs even though the target
            // bitmap dimensions are device pixels. Keeping both layers in
            // this same DIP space avoids the high-DPI double-scale/clipping
            // failure that makes the right side disappear at 150%/200%.
            drawing.DrawImage(native, new Rect(0, 0, rootWidthDip, rootHeightDip));
            if (page is not null && browserVisible)
            {
                drawing.DrawImage(page, browserRect);
            }
        }

        var finalTarget = new RenderTargetBitmap(
            width,
            height,
            96 * dpi.DpiScaleX,
            96 * dpi.DpiScaleY,
            PixelFormats.Pbgra32);
        finalTarget.Render(composedVisual);
        SavePng(finalTarget, path);

        var metadataPath = Path.ChangeExtension(path, ".json");
        var metadata = new
        {
            method = "WPF RenderTargetBitmap client visual tree + CoreWebView2.CapturePreviewAsync PNG composition",
            screenCapture = false,
            lockedSessionCompatible = true,
            state,
            tab = CompanionTabs.KeyFor(tab),
            windowClientPixels = new { width, height },
            browserRectDip = new
            {
                x = Math.Round(browserRect.X, 2),
                y = Math.Round(browserRect.Y, 2),
                width = Math.Round(browserRect.Width, 2),
                height = Math.Round(browserRect.Height, 2),
            },
            webViewCapturePixels = page is null ? null : new { width = pageWidth, height = pageHeight },
            webViewComposited = page is not null && browserVisible,
            windowFrameIncluded = false,
        };
        File.WriteAllText(
            metadataPath,
            JsonSerializer.Serialize(metadata, new JsonSerializerOptions { WriteIndented = true }));
    }

    private static void SavePng(BitmapSource bitmap, string path)
    {
        var encoder = new PngBitmapEncoder();
        encoder.Frames.Add(BitmapFrame.Create(bitmap));
        using var output = File.Create(path);
        encoder.Save(output);
    }

    private static async Task<bool> TryInvokeTabApiAsync(
        WebView2Window window,
        CompanionTab requestedTab)
    {
        var candidates = typeof(WebView2Window)
            .GetMethods(BindingFlags.Public | BindingFlags.Instance)
            .Where(static method => !method.IsSpecialName)
            // IsTabInitialized also accepts a CompanionTab, but calling it
            // would only observe state and would never exercise tab
            // selection. Keep the launcher coupled to the navigation seam,
            // not to diagnostic properties that happen to share its type.
            .Where(static method => method.Name.Equals("SwitchToTabAsync", StringComparison.Ordinal)
                || method.Name.Equals("OpenSiteAsync", StringComparison.Ordinal)
                || method.Name.Equals("OpenSiteOfferAsync", StringComparison.Ordinal))
            .OrderBy(static method => method.Name, StringComparer.Ordinal);

        foreach (var method in candidates)
        {
            var parameters = method.GetParameters();
            var tabParameter = parameters.FirstOrDefault(static parameter =>
                parameter.ParameterType == typeof(CompanionTab));
            if (tabParameter is null) continue;

            var values = new object?[parameters.Length];
            var supported = true;
            for (var index = 0; index < parameters.Length; index++)
            {
                var parameter = parameters[index];
                if (parameter.ParameterType == typeof(CompanionTab))
                    values[index] = requestedTab;
                else if (parameter.HasDefaultValue)
                    values[index] = parameter.DefaultValue;
                else if (!parameter.ParameterType.IsValueType)
                    values[index] = null;
                else if (parameter.ParameterType == typeof(CancellationToken))
                    values[index] = CancellationToken.None;
                else
                {
                    supported = false;
                    break;
                }
            }
            if (!supported) continue;

            var result = method.Invoke(window, values);
            if (result is Task task)
            {
                await task.ConfigureAwait(true);
            }
            return true;
        }

        return false;
    }

    private static void WriteReady(string? path, WebView2Window window)
    {
        if (string.IsNullOrWhiteSpace(path)) return;
        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(path))!);
        File.WriteAllText(path, $"ready\n{window.Title}\n{window.ActualWidth:0}x{window.ActualHeight:0}\n");
    }

    private static void WriteTabMarker(string? path, CompanionTab tab, WebView2Window window)
    {
        if (string.IsNullOrWhiteSpace(path)) return;
        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(path))!);
        File.AppendAllText(
            path,
            $"tab={CompanionTabs.KeyFor(tab)} active={window.ActiveTab} initialized={window.IsTabInitialized(tab)}\n");
    }

    private static void WriteErrorMarker(string? path, CompanionTab tab, WebView2Window window)
    {
        if (string.IsNullOrWhiteSpace(path)) return;
        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(path))!);
        File.AppendAllText(
            path,
            $"error-tab={CompanionTabs.KeyFor(tab)} active={window.ActiveTab} initialized={window.IsTabInitialized(tab)}\n");
    }

    private static void WriteReady(string? path, Exception error)
    {
        if (string.IsNullOrWhiteSpace(path)) return;
        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(path))!);
        File.WriteAllText(path, $"error\n{error.GetType().Name}: {error.Message}");
    }
}

internal sealed record PreviewOptions(
    string ProfileRoot,
    string? ReadyFile,
    IReadOnlyList<CompanionTab> Tabs,
    int IntervalMilliseconds,
    int DurationSeconds,
    string? CaptureDirectory,
    CompanionTab? ErrorTab,
    IReadOnlyDictionary<CompanionTab, Uri> NavigateUrls)
{
    public static PreviewOptions Parse(string[] args)
    {
        var profile = Path.Combine(
            Path.GetTempPath(),
            $"CoachBuild-companion-tabs-preview-{Guid.NewGuid():N}");
        string? ready = null;
        var tabs = new List<CompanionTab> { CompanionTab.Companion };
        var intervalMilliseconds = 1200;
        var duration = 0;
        string? captureDirectory = null;
        CompanionTab? errorTab = null;
        var navigateUrls = new Dictionary<CompanionTab, Uri>();

        for (var index = 0; index < args.Length; index++)
        {
            var argument = args[index];
            var value = index + 1 < args.Length ? args[index + 1] : null;
            if (argument.Equals("--profile", StringComparison.OrdinalIgnoreCase) && value is not null)
            {
                profile = Path.GetFullPath(value);
                index++;
            }
            else if (argument.Equals("--ready-file", StringComparison.OrdinalIgnoreCase) && value is not null)
            {
                ready = Path.GetFullPath(value);
                index++;
            }
            else if (argument.Equals("--tab", StringComparison.OrdinalIgnoreCase) && value is not null)
            {
                tabs = [CompanionTabs.ParseKey(value)];
                index++;
            }
            else if (argument.Equals("--tabs", StringComparison.OrdinalIgnoreCase) && value is not null)
            {
                tabs = value
                    .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                    .Select(CompanionTabs.ParseKey)
                    .Distinct()
                    .ToList();
                if (tabs.Count == 0) tabs.Add(CompanionTab.Companion);
                index++;
            }
            else if (argument.Equals("--interval-ms", StringComparison.OrdinalIgnoreCase) && value is not null
                && int.TryParse(value, out var parsedInterval))
            {
                intervalMilliseconds = Math.Max(0, parsedInterval);
                index++;
            }
            else if (argument.Equals("--duration", StringComparison.OrdinalIgnoreCase) && value is not null
                && int.TryParse(value, out var parsedDuration))
            {
                duration = Math.Max(0, parsedDuration);
                index++;
            }
            else if (argument.Equals("--capture-dir", StringComparison.OrdinalIgnoreCase) && value is not null)
            {
                captureDirectory = Path.GetFullPath(value);
                index++;
            }
            else if (argument.Equals("--error-tab", StringComparison.OrdinalIgnoreCase) && value is not null)
            {
                errorTab = CompanionTabs.ParseKey(value);
                index++;
            }
            else if (argument.Equals("--navigate", StringComparison.OrdinalIgnoreCase) && value is not null)
            {
                // --navigate ugg=https://u.gg/lol/champions/jhin/build/adc
                var separator = value.IndexOf('=');
                if (separator <= 0)
                    throw new ArgumentException($"--navigate expects <tab>=<https-url>, got: {value}");
                var target = new Uri(value[(separator + 1)..], UriKind.Absolute);
                if (target.Scheme != Uri.UriSchemeHttps)
                    throw new ArgumentException($"--navigate only accepts https urls, got: {target}");
                navigateUrls[CompanionTabs.ParseKey(value[..separator])] = target;
                index++;
            }
        }

        return new PreviewOptions(
            profile,
            ready,
            tabs,
            intervalMilliseconds,
            duration,
            captureDirectory,
            errorTab,
            navigateUrls);
    }
}
