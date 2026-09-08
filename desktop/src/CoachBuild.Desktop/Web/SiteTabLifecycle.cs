using System.Text.Json;

namespace CoachBuild.Desktop.Web;

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
