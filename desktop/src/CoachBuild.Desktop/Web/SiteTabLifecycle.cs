using System.Text.Json;

namespace CoachBuild.Desktop.Web;

/// <summary>Request-level ad serving policy for the three public site tabs.</summary>
public static class SiteAdBlockingPolicy
{
    /// <summary>
    /// Maintained ad-serving/adtech domain patterns. Keep consent providers
    /// and first-party site/CDN hosts out of this list: site functionality
    /// wins whenever a host is ambiguous.
    /// </summary>
    public static readonly IReadOnlyList<string> BlockedDomainPatterns =
    [
        "doubleclick.net",
        "googlesyndication.com",
        "adservice.google.*",
        "adnxs.com",
        "amazon-adsystem.com",
        "criteo.com",
        "criteo.net",
        "taboola.com",
        "outbrain.com",
        "pubmatic.com",
        "rubiconproject.com",
        "openx.net",
        "indexexchange.com",
        "magnite.com",
        "media.net",
    ];

    private static readonly string[] FirstPartyRoots = ["u.gg", "coachless.gg", "op.gg"];

    public static bool TryGetBlockedDomain(string? requestUri, out string domain)
    {
        domain = string.Empty;
        if (!Uri.TryCreate(requestUri, UriKind.Absolute, out var uri)) return false;
        var host = uri.IdnHost.TrimEnd('.').ToLowerInvariant();
        if (host.Length == 0 || IsFirstParty(host) || IsConsentHost(host)) return false;

        foreach (var pattern in BlockedDomainPatterns)
        {
            if (pattern.EndsWith(".*", StringComparison.Ordinal))
            {
                var prefix = pattern[..^1];
                if (!host.StartsWith(prefix, StringComparison.Ordinal)) continue;
            }
            else if (!string.Equals(host, pattern, StringComparison.Ordinal) &&
                     !host.EndsWith("." + pattern, StringComparison.Ordinal))
            {
                continue;
            }

            domain = host;
            return true;
        }
        return false;
    }

    private static bool IsFirstParty(string host) =>
        FirstPartyRoots.Any(root =>
            string.Equals(host, root, StringComparison.Ordinal) ||
            host.EndsWith("." + root, StringComparison.Ordinal));

    private static bool IsConsentHost(string host) =>
        host.Contains("qc-cmp", StringComparison.Ordinal) ||
        host.Contains("fundingchoices", StringComparison.Ordinal);
}

/// <summary>
/// The typed answer from <see cref="SiteImportExtractors.ConsentDismissScript"/>.
/// Never throws: an unparseable result is "nothing was dismissed", which is
/// the same path as a page that had no wall.
/// </summary>
public sealed record ConsentDismissal(bool Dismissed, string Reason)
{
    public static ConsentDismissal None { get; } = new(false, "none");

    /// <summary>The log line for a dismissal, or null when there was nothing to say.</summary>
    public string? LogLine(string siteLabel) =>
        Dismissed ? $"{siteLabel}: dismissed consent dialog" : null;

    public static ConsentDismissal Parse(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) return None;
        try
        {
            using var document = JsonDocument.Parse(raw);
            var root = document.RootElement;
            if (root.ValueKind == JsonValueKind.String)
            {
                // ExecuteScriptAsync JSON-encodes the returned JS string, so
                // the outer value wraps the object -- same envelope as every
                // other step result.
                var inner = root.GetString();
                if (string.IsNullOrWhiteSpace(inner)) return None;
                using var innerDocument = JsonDocument.Parse(inner);
                return FromObject(innerDocument.RootElement);
            }
            return FromObject(root);
        }
        catch (JsonException)
        {
            return None;
        }
    }

    private static ConsentDismissal FromObject(JsonElement root)
    {
        if (root.ValueKind != JsonValueKind.Object) return None;
        var dismissed = root.TryGetProperty("dismissed", out var flag)
            && flag.ValueKind == JsonValueKind.True;
        var reason = root.TryGetProperty("reason", out var value)
            && value.ValueKind == JsonValueKind.String
                ? value.GetString()?.Trim()
                : null;
        return new ConsentDismissal(dismissed, string.IsNullOrEmpty(reason) ? "none" : reason);
    }
}

/// <summary>
/// Whether a Coachless RUNES read is a verdict or just an early paint.
///
/// <para>WHY THIS EXISTS. Field log 2026-09-08: <c>Coachless yielded no rune
/// build (no keystone on the runes page carried a WPA reading)</c>, while the
/// captured fixture of the same page yields a complete rune page. The page is
/// Angular and renders its rune cards before the WPA deltas land, so the very
/// first read after NavigationCompleted legitimately sees cards with no
/// numbers. The extractor marks exactly those absences <c>retryable</c>
/// (<see cref="SiteImportExtractors.CoachlessRunesTemplate"/>); this is the
/// C# half that recognizes the mark, so the window settle-polls instead of
/// reporting a first-paint read as the answer.</para>
///
/// <para>Fails CLOSED: anything unparseable, or any failure without the mark,
/// is NOT retryable — an honest typed failure must still reach the log on its
/// first occurrence rather than being swallowed by an eight-second wait.</para>
/// </summary>
public static class RunesSettleProbe
{
    /// <summary>How long a runes read may keep settling before its last failure stands.</summary>
    public const int SettleTimeoutMs = 8000;

    /// <summary>The gap between settle attempts. 8000/400 = 20 reads at most.</summary>
    public const int SettleDelayMs = 400;

    /// <summary>True when this raw extractor result is a failure worth re-reading.</summary>
    public static bool IsRetryable(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) return false;
        try
        {
            using var document = JsonDocument.Parse(raw);
            var root = document.RootElement;
            if (root.ValueKind == JsonValueKind.String)
            {
                // ExecuteScriptAsync JSON-encodes the returned JS string, so
                // the outer value wraps the object -- same envelope as every
                // other step result.
                var inner = root.GetString();
                if (string.IsNullOrWhiteSpace(inner)) return false;
                using var innerDocument = JsonDocument.Parse(inner);
                return HasMark(innerDocument.RootElement);
            }
            return HasMark(root);
        }
        catch (JsonException)
        {
            return false;
        }
    }

    private static bool HasMark(JsonElement root) =>
        root.ValueKind == JsonValueKind.Object
        && root.TryGetProperty("error", out var error)
        && error.ValueKind == JsonValueKind.String
        && root.TryGetProperty("retryable", out var flag)
        && flag.ValueKind == JsonValueKind.True;
}

/// <summary>What the idle sweep decided for one tab.</summary>
public enum TabIdleDecision
{
    /// <summary>Leave it alone.</summary>
    Keep,

    /// <summary>Dispose its WebView2 controller; the tab button stays and revisiting recreates it.</summary>
    Dispose,
}

/// <summary>
/// One tab as the idle sweep sees it. Deliberately not the window's
/// <c>BrowserTabState</c>: this carries no WebView2 handle, so the policy can
/// be exercised without a browser.
/// </summary>
/// <param name="Tab">Which tab.</param>
/// <param name="IsVisible">True for the tab the user is currently looking at.</param>
/// <param name="HasBrowser">False when the tab is already torn down (or never created).</param>
/// <param name="LastVisible">When the tab was last the visible one.</param>
public sealed record TabIdleSnapshot(
    CompanionTab Tab,
    bool IsVisible,
    bool HasBrowser,
    DateTimeOffset LastVisible);

/// <summary>
/// The pure decision half of the memory fix: which site tabs have been out of
/// sight long enough to give their Chromium tree back.
///
/// <para>WHY. Field measurement 2026-09-08: CoachBuild.Desktop itself is
/// ~55MB, but the process tree reached ~2.1GB at 81% of system RAM, all of it
/// WebView2 utility processes — four site profiles plus the hidden import
/// workers, none of which were ever torn down before the window closed. A
/// WebView2 the user has not looked at in ten minutes is pure resident cost.
/// </para>
///
/// <para>WHAT IS NEVER TORN DOWN, and why each is a rule rather than a
/// heuristic:</para>
/// <list type="bullet">
///   <item>The VISIBLE tab. Disposing what the user is reading is a bug, not
///   a saving, however long it has been open.</item>
///   <item>The DRAFT tab (<see cref="CompanionTab.Companion"/>). It is the
///   app's own surface, it holds live champ-select state, and it is the one
///   page that must be instant when champ select starts.</item>
///   <item>A tab with no browser. Already free; deciding again would log a
///   teardown per sweep for a tab that has none.</item>
/// </list>
///
/// <para>Recreation is the EXISTING lazy-creation path, unchanged — which is
/// what makes this symmetric and cheap: the profile directories persist, so
/// cookies, consent and sign-ins all survive a teardown and a revisit pays
/// only the cold start it would have paid on first open.</para>
/// </summary>
public static class SiteTabIdlePolicy
{
    /// <summary>
    /// How long a site tab may sit invisible before its WebView2 is disposed.
    /// The one place this number lives.
    /// </summary>
    public static readonly TimeSpan IdleTimeout = TimeSpan.FromMinutes(10);

    /// <summary>
    /// The decision for one tab. Pure: same inputs, same answer, no clock of
    /// its own — <paramref name="now"/> is supplied so tests can drive it.
    /// </summary>
    public static TabIdleDecision Decide(TabIdleSnapshot tab, DateTimeOffset now)
    {
        ArgumentNullException.ThrowIfNull(tab);
        if (!tab.HasBrowser) return TabIdleDecision.Keep;
        if (tab.IsVisible) return TabIdleDecision.Keep;
        if (tab.Tab == CompanionTab.Companion) return TabIdleDecision.Keep;
        // Strictly greater: a tab that has been idle for exactly the timeout
        // survives one more sweep, so the boundary can never depend on clock
        // granularity.
        return now - tab.LastVisible > IdleTimeout
            ? TabIdleDecision.Dispose
            : TabIdleDecision.Keep;
    }

    /// <summary>Every tab the sweep should dispose, in the order given.</summary>
    public static IReadOnlyList<CompanionTab> Sweep(
        IEnumerable<TabIdleSnapshot> tabs,
        DateTimeOffset now)
    {
        ArgumentNullException.ThrowIfNull(tabs);
        var due = new List<CompanionTab>();
        foreach (var tab in tabs)
        {
            if (tab is not null && Decide(tab, now) == TabIdleDecision.Dispose) due.Add(tab.Tab);
        }
        return due;
    }

    /// <summary>The log line for one teardown.</summary>
    public static string TeardownLine(CompanionTab tab) =>
        $"tabs: released {CompanionTabs.LabelFor(tab)} after {IdleTimeout.TotalMinutes:0} idle minutes " +
        "(revisiting reloads it)";

    /// <summary>The log line for the lazy recreation that follows a revisit.</summary>
    public static string RecreateLine(CompanionTab tab) =>
        $"tabs: recreating {CompanionTabs.LabelFor(tab)} after an idle release";
}
