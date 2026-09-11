using System.Diagnostics;
using CoachBuild.Core;

namespace CoachBuild.Desktop.Web;

/// <summary>
/// What the automatic item import knows on one evaluation: the champ-select
/// context (if any), which tab the user is viewing and its URL, whether the
/// client is connected, and WHEN this tick was observed. Built on the UI
/// thread from the same 750 ms existing snapshot tick -- no new poll. (1.3.0;
/// <see cref="ObservedAt"/> 2.2.1.)
///
/// <para><see cref="Locked"/> is the pick/hover discriminator and stays
/// distinct: <c>cellChampionId</c> (locked) and <c>championPickIntent</c>
/// (hovered) both reach here as <see cref="ChampionId"/>, and this flag is
/// the only thing that says which one it is. Both now trigger an import; the
/// hover one waits out <see cref="AutoImportCoordinator.HoverSettle"/> first.</para>
///
/// <para><see cref="ObservedAt"/> is supplied by the caller rather than read
/// from a clock inside the decision, exactly as
/// <c>OpportunisticCheckPolicy.ShouldCheck</c> takes its <c>now</c>: the
/// hover settle is then unit-testable with scripted timestamps and no clock.
/// Deliberately REQUIRED, with no default: a defaulted timestamp would make
/// every tick look simultaneous and silently disable the settle in
/// production while the fixtures still passed.</para>
/// </summary>
public sealed record AutoImportInput(
    int? ChampionId,
    string? ChampionKey,
    string? ChampionName,
    int? RoleId,
    bool Locked,
    CompanionTab VisibleTab,
    string? VisibleUrl,
    bool LcuConnected,
    DateTimeOffset ObservedAt)
{
    public static AutoImportInput FromContext(
        ChampSelectContext? context,
        CompanionTab visibleTab,
        string? visibleUrl,
        bool lcuConnected,
        DateTimeOffset observedAt) =>
        context is null
            ? new AutoImportInput(
                null, null, null, null, false, visibleTab, visibleUrl, lcuConnected, observedAt)
            : new AutoImportInput(
                context.ChampionId, context.ChampionKey, context.ChampionName,
                context.RoleId, context.Locked, visibleTab, visibleUrl, lcuConnected, observedAt);
}

/// <summary>
/// A HOVERED (not yet locked) champion and the tick at which that hover was
/// first observed. The coordinator's clock-free settle: the service carries
/// one of these across ticks and <see cref="AutoImportCoordinator.TrackHover"/>
/// restamps it only when the hovered champion+role actually changes, so the
/// user scrolling the picker never accumulates settle time on a champion they
/// have already scrolled past.
/// </summary>
public sealed record AutoImportHover(int ChampionId, int? RoleId, DateTimeOffset FirstSeenAt);

/// <summary>Which trigger licensed a run's deep-link fetch, for the log line.</summary>
public enum AutoImportTrigger
{
    /// <summary>Nothing fired, or only the visible-page re-read did.</summary>
    None,

    /// <summary>The champion was locked in.</summary>
    Lock,

    /// <summary>The champion was hovered and the hover held still long enough.</summary>
    Hover,
}

/// <summary>
/// One site the coordinator wants fetched: WHERE (the deep link, or the
/// visible page itself) and HOW. <see cref="ExtractInPlace"/> is true only
/// when the user's visible tab is already on that exact page — the fetch
/// then reads the visible tab and navigates nothing. Otherwise the window
/// must use a background or hidden worker webview: the auto-import NEVER
/// navigates a tab the user is viewing (or changes the selected tab, or
/// steals focus) — that is the never-touches-visible-tab rule, and the
/// service calls the executor method the flag names.
/// </summary>
public sealed record AutoImportSiteTarget(
    CompanionTab Site,
    Uri Url,
    bool ExtractInPlace,
    string? ChampionKey,
    int? RoleId);

/// <summary>One site's last written item set, cached so a later single-site refresh can re-batch it.</summary>
public sealed record CachedAutoImportSet(
    SiteImportSource Source,
    string ChampionSlug,
    string Role,
    IReadOnlyList<SiteImportItemBlock> ItemBlocks,
    int ChampionId,
    string ChampionName);

/// <summary>
/// The coordinator's committed memory: the champion+role last acted on, the
/// per-site URL last attempted for it, and the per-site item set last
/// written. Advanced only by <see cref="AutoImportCoordinator.RecordCompleted"/>
/// after a run finishes — evaluation itself is side-effect-free, so a tick
/// dropped to single-flight loses no trigger.
/// </summary>
public sealed record AutoImportState(
    int? ChampionId,
    int? RoleId,
    IReadOnlyDictionary<CompanionTab, string> DoneUrls,
    IReadOnlyDictionary<CompanionTab, CachedAutoImportSet> CachedSets)
{
    public static AutoImportState Initial { get; } = new(
        null, null,
        new Dictionary<CompanionTab, string>(),
        new Dictionary<CompanionTab, CachedAutoImportSet>());
}

/// <summary>One site's fetch outcome, for debounce bookkeeping.</summary>
public sealed record AutoImportOutcome(
    CompanionTab Site,
    string Url,
    SiteImportPayload? Payload);

/// <summary>What evaluation decided: fetch these targets, or why nothing is due.</summary>
public sealed record AutoImportFetch(
    IReadOnlyList<AutoImportSiteTarget> Fetch,
    string? SkipReason,
    AutoImportTrigger Trigger = AutoImportTrigger.None);

/// <summary>
/// The pure decision half of the automatic item import: no clock, no
/// browser, no LCU, no I/O. The window feeds it one <see cref="AutoImportInput"/>
/// per snapshot tick and executes the returned targets (see
/// <see cref="SiteAutoImportService"/>); every transition is unit-tested
/// with scripted inputs.
///
/// <para>TRIGGERS, each debounced. (1) Champ-select PICK INTENT: both sites,
/// once per champion+role until it changes. A LOCK fires it immediately; a
/// HOVER fires it once the hover has held still for
/// <see cref="HoverSettle"/>. (2) The visible site page: that site, when its
/// URL is a recognized build page for the context champion and differs from
/// the URL last attempted (e.g. the user changed the rank filter — the re-run
/// imports the page as shown, not the deep link).
/// </para>
///
/// <para>WHY THE HOVER FIRES AT ALL (field log 2026-09-09 12:18:30-12:19:43).
/// The user picked Viktor, waited ~70s, saw no rune pages, and left without
/// locking: not one <c>auto-import:</c> line in the whole champ select,
/// because the only deep-link trigger was <c>Locked &amp;&amp; keyChanged</c>.
/// Lock-only is too late BY DESIGN — the point of the feature is to have two
/// rune pages sitting in the client so the user can pick one BEFORE the game,
/// and in the practice tool a lock launches the game more or less at once. So
/// the intent, not the commitment, is what arms the import.</para>
///
/// <para>WHY THE HOVER WAITS AND THE LOCK DOES NOT. A hover is what the
/// champion picker reports while the user is still scrolling it, so importing
/// on the first sight of one would fetch four pages for champions the user
/// merely passed over. A lock is a decision that has already been made and is
/// followed within seconds by the game starting: there is nothing left to
/// settle and no time to spend settling it. The settle is measured from the
/// hover's own first-seen tick (<see cref="AutoImportHover"/>), which the
/// caller stamps — no clock in here.</para>
///
/// <para>Attempts are debounced, not just successes: a quiet failure is
/// recorded like a success, so a broken page logs once per champion+URL
/// instead of once per 750 ms tick. A failure therefore never retries until
/// the champion, role, or page URL changes — the status line carries the
/// note in the meantime.</para>
/// </summary>
public static class AutoImportCoordinator
{
    private static readonly CompanionTab[] BothSites = [CompanionTab.UGg, CompanionTab.Coachless];

    /// <summary>
    /// The skip reason for "no League client". Named rather than inlined
    /// because the service treats it differently from every other reason: at
    /// startup it is not yet a fact, it is a race (see
    /// <see cref="SiteAutoImportService.DisconnectedNoteAfterEvaluations"/>).
    /// </summary>
    public const string DisconnectedSkipReason =
        "League client not connected -- auto-import standing by";

    /// <summary>
    /// How long a HOVERED champion must stay the hovered champion before its
    /// pages are worth fetching. Long enough that scrolling the picker past a
    /// champion never spends four page loads on it, short enough that the
    /// pages are in the client while the user is still deciding. Only the
    /// hover path consults it — a lock is already a decision (see the class
    /// remarks).
    /// </summary>
    public static readonly TimeSpan HoverSettle = TimeSpan.FromMilliseconds(2500);

    /// <summary>
    /// Carries the hover observation across ticks: same hovered champion+role
    /// keeps its original <see cref="AutoImportHover.FirstSeenAt"/> (settle
    /// time accrues), anything else restamps it at this tick, and a lock, a
    /// missing champion or a missing client drops it entirely. Pure: the
    /// caller owns both the previous observation and the clock.
    /// </summary>
    public static AutoImportHover? TrackHover(AutoImportHover? previous, AutoImportInput input)
    {
        ArgumentNullException.ThrowIfNull(input);
        if (!input.LcuConnected || input.Locked ||
            input.ChampionId is not > 0 || string.IsNullOrWhiteSpace(input.ChampionKey))
            return null;
        if (previous is not null &&
            previous.ChampionId == input.ChampionId && previous.RoleId == input.RoleId)
            return previous;
        return new AutoImportHover(input.ChampionId.Value, input.RoleId, input.ObservedAt);
    }

    /// <summary>
    /// True when <paramref name="hover"/> is an observation OF THIS INPUT's
    /// champion+role that has held for at least <see cref="HoverSettle"/>.
    /// The champion+role re-check is not redundant with
    /// <see cref="TrackHover"/>: a stale observation handed in by a caller
    /// that skipped a tick must not settle a champion it never described.
    /// </summary>
    public static bool IsHoverSettled(AutoImportHover? hover, AutoImportInput input)
    {
        ArgumentNullException.ThrowIfNull(input);
        return hover is not null &&
            hover.ChampionId == input.ChampionId &&
            hover.RoleId == input.RoleId &&
            input.ObservedAt - hover.FirstSeenAt >= HoverSettle;
    }

    /// <param name="hover">
    /// The running hover observation from <see cref="TrackHover"/>. Required
    /// (null means "no hover settled yet"), never defaulted: a call site that
    /// forgot it would silently be back to the lock-only behaviour this
    /// method exists to fix.
    /// </param>
    public static AutoImportFetch Evaluate(
        AutoImportState state, AutoImportInput input, AutoImportHover? hover)
    {
        ArgumentNullException.ThrowIfNull(state);
        ArgumentNullException.ThrowIfNull(input);
        if (!input.LcuConnected)
            return new AutoImportFetch([], DisconnectedSkipReason);
        if (input.ChampionId is not > 0 || string.IsNullOrWhiteSpace(input.ChampionKey))
            return new AutoImportFetch([], null);

        var keyChanged = state.ChampionId != input.ChampionId || state.RoleId != input.RoleId;
        var fetch = new List<AutoImportSiteTarget>();

        // Trigger 1 — the pick intent: both sites at the deep links, once per
        // key. A lock fires now; a hover fires once it has settled. Requirement
        // 4 falls out of keyChanged: a lock on the champion already imported
        // from its hover is the SAME key, so it re-imports nothing.
        var trigger = AutoImportTrigger.None;
        if (keyChanged)
        {
            if (input.Locked) trigger = AutoImportTrigger.Lock;
            else if (IsHoverSettled(hover, input)) trigger = AutoImportTrigger.Hover;
        }
        if (trigger is not AutoImportTrigger.None)
        {
            foreach (var site in BothSites)
            {
                if (SiteDeepLink.Build(site, input.ChampionKey, input.RoleId) is not { } target)
                    continue;
                fetch.Add(new AutoImportSiteTarget(
                    site,
                    target,
                    ExtractInPlace: input.VisibleTab == site &&
                        SiteNavigationPolicy.IsAlreadyThere(input.VisibleUrl, target),
                    input.ChampionKey,
                    input.RoleId));
            }
        }

        // Trigger 2 — the visible page: the site the user is reading, when
        // it shows this champion under a URL not yet attempted. The target
        // is the visible URL itself (the rank filter may have changed what
        // the page shows), so this path never navigates anywhere.
        if (input.VisibleTab is CompanionTab.UGg or CompanionTab.Coachless &&
            !fetch.Exists(plan => plan.Site == input.VisibleTab) &&
            !string.IsNullOrWhiteSpace(input.VisibleUrl) &&
            SiteImportExtractors.CanImportFromUrl(input.VisibleTab, input.VisibleUrl) &&
            SlugMatchesContext(input.VisibleTab, input.VisibleUrl, input.ChampionKey) &&
            (keyChanged || !IsDoneUrl(state, input.VisibleTab, input.VisibleUrl)))
        {
            fetch.Add(new AutoImportSiteTarget(
                input.VisibleTab,
                new Uri(input.VisibleUrl),
                ExtractInPlace: true,
                input.ChampionKey,
                input.RoleId));
        }

        return new AutoImportFetch(fetch, null, trigger);
    }

    /// <summary>
    /// Commits a finished run: advances the key, records each attempted URL
    /// (success or quiet failure — both re-arm only on change), and caches
    /// each written item set for later single-site batches.
    /// </summary>
    public static AutoImportState RecordCompleted(
        AutoImportState state,
        int championId,
        int? roleId,
        string championName,
        IReadOnlyList<AutoImportOutcome> outcomes)
    {
        ArgumentNullException.ThrowIfNull(state);
        ArgumentNullException.ThrowIfNull(outcomes);
        var keyChanged = state.ChampionId != championId || state.RoleId != roleId;
        var done = keyChanged
            ? new Dictionary<CompanionTab, string>()
            : new Dictionary<CompanionTab, string>(state.DoneUrls);
        var cached = keyChanged
            ? new Dictionary<CompanionTab, CachedAutoImportSet>()
            : new Dictionary<CompanionTab, CachedAutoImportSet>(state.CachedSets);
        foreach (var outcome in outcomes)
        {
            if (outcome is null) continue;
            done[outcome.Site] = outcome.Url;
            var payload = outcome.Payload;
            if (payload is not null && payload.ItemBlocks.Count > 0)
                cached[outcome.Site] = new CachedAutoImportSet(
                    payload.Source, payload.ChampionSlug, payload.Role,
                    payload.ItemBlocks, championId, championName);
        }
        return new AutoImportState(championId, roleId, done, cached);
    }

    /// <summary>
    /// The write list for one automatic import: every fresh payload plus the
    /// cached sets of the same champion for sites with no fresh payload, so
    /// a single-site refresh (rank filter) does not evict the other site's
    /// set from the client. Fresh wins per site; entries for other champions
    /// never ride along.
    /// </summary>
    public static IReadOnlyList<SiteImportItemsContribution> BuildWriteBatch(
        IReadOnlyList<SiteImportPayload> fresh,
        IReadOnlyDictionary<CompanionTab, CachedAutoImportSet> cached,
        int championId,
        string championName)
    {
        var contributions = new List<SiteImportItemsContribution>();
        var freshSites = new HashSet<CompanionTab>();
        if (fresh is not null)
        {
            foreach (var payload in fresh)
            {
                if (payload is null || payload.ItemBlocks.Count == 0) continue;
                contributions.Add(new SiteImportItemsContribution(payload, championName, championId));
                freshSites.Add(TabForSource(payload.Source));
            }
        }
        if (cached is not null)
        {
            foreach (var (site, entry) in cached)
            {
                if (entry is null || entry.ChampionId != championId ||
                    entry.ItemBlocks.Count == 0 || freshSites.Contains(site))
                    continue;
                var payload = new SiteImportPayload(
                    entry.Source, entry.ChampionSlug, entry.Role, null!, entry.ItemBlocks);
                contributions.Add(new SiteImportItemsContribution(payload, entry.ChampionName, entry.ChampionId));
            }
        }
        return contributions;
    }

    /// <summary>
    /// The sanctioned-automation allowlist. Automated navigation exists for
    /// exactly one purpose — fetching a locked champion's build pages — and
    /// its targets must be EXACTLY the URLs the app's own deep-link builders
    /// produce for that champion+role (<c>u.gg/lol/champions/{slug}/build/{role}</c>,
    /// <c>coachless.gg/builds/{slug}?role={role}</c>). Anything else —
    /// another champion, another shape, a hand-built URL — is refused. The
    /// window asserts this before navigating a worker; a test pins both the
    /// allowlist and the call site.
    /// </summary>
    public static bool IsAllowedAutoImportTarget(
        CompanionTab site,
        Uri? target,
        string? championKey,
        int? roleId)
    {
        if (target is null || site is not (CompanionTab.UGg or CompanionTab.Coachless))
            return false;
        if (SiteDeepLink.Build(site, championKey, roleId) is not { } expected)
            return false;
        return string.Equals(expected.AbsoluteUri, target.AbsoluteUri, StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>
    /// The runes-page half of the allowlist (2.1.0). Same rule as
    /// <see cref="IsAllowedAutoImportTarget"/> and for the same reason: the
    /// only automated navigation that may happen is to a URL this app's own
    /// builder produced for the champion+role champ select reported.
    /// Coachless only — u.gg's runes live on the build page.
    /// </summary>
    public static bool IsAllowedRunesTarget(Uri? target, string? championKey, int? roleId)
    {
        if (target is null) return false;
        if (SiteDeepLink.CoachlessRunesUrl(championKey, roleId) is not { } expected)
            return false;
        return string.Equals(expected.AbsoluteUri, target.AbsoluteUri, StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>
    /// The champion slug addressed by a build-page URL, folded the way the
    /// deep links fold it — or null when the URL is not that site's
    /// build-page shape. Pure string work; redirects (coachless 302s
    /// <c>monkeyking</c> to <c>wukong</c>) are the service's problem, which
    /// has the roster to resolve aliases by id.
    /// </summary>
    public static string? SlugFromBuildUrl(CompanionTab site, string? url)
    {
        if (string.IsNullOrWhiteSpace(url) || !Uri.TryCreate(url, UriKind.Absolute, out var uri))
            return null;
        var segments = uri.AbsolutePath.Split('/', StringSplitOptions.RemoveEmptyEntries);
        return site switch
        {
            CompanionTab.UGg when segments.Length >= 4
                && string.Equals(segments[0], "lol", StringComparison.OrdinalIgnoreCase)
                && string.Equals(segments[1], "champions", StringComparison.OrdinalIgnoreCase)
                && string.Equals(segments[3], "build", StringComparison.OrdinalIgnoreCase)
                => ChampionNameKey.Normalize(segments[2]),
            CompanionTab.Coachless when segments.Length == 2
                && string.Equals(segments[0], "builds", StringComparison.OrdinalIgnoreCase)
                && !string.Equals(segments[1], "creator", StringComparison.OrdinalIgnoreCase)
                => ChampionNameKey.Normalize(segments[1]),
            _ => null,
        };
    }

    /// <summary>
    /// Fast-path context check for the visible trigger: the page's slug folds
    /// to the context champion's key. Aliases the fold cannot see (Wukong's
    /// <c>wukong</c> redirect) are resolved by id in the service, which owns
    /// the roster.
    /// </summary>
    public static bool SlugMatchesContext(CompanionTab site, string? url, string? championKey)
    {
        var slug = SlugFromBuildUrl(site, url);
        if (string.IsNullOrEmpty(slug)) return false;
        var want = ChampionNameKey.Normalize(championKey);
        return !string.IsNullOrEmpty(want) &&
            string.Equals(slug, want, StringComparison.Ordinal);
    }

    public static bool SlugsMatch(string? first, string? second)
    {
        var left = ChampionNameKey.Normalize(first);
        var right = ChampionNameKey.Normalize(second);
        return !string.IsNullOrEmpty(left) && string.Equals(left, right, StringComparison.Ordinal);
    }

    public static CompanionTab TabForSource(SiteImportSource source) => source switch
    {
        SiteImportSource.Coachless => CompanionTab.Coachless,
        _ => CompanionTab.UGg,
    };

    /// <summary>
    /// Whether an EXTRACT-IN-PLACE read that yielded no item build should be
    /// retried as a hidden-worker DIRECT LOAD of the same URL, before the run
    /// gives up on that site.
    ///
    /// <para>WHY (field log 2026-09-08 22:37:36, a real champ select, Jhin):
    /// <c>u.gg items: no script on the page embeds a build blob</c> /
    /// <c>stage url-recognized (rank "emerald_plus", role "adc" via
    /// active-role-tab, embedded ranks [], 0 blocks)</c>. The read was correct
    /// about the DOM in front of it: u.gg is a single-page app, and it embeds
    /// the per-champion build blob only in the document it SERVES. Navigate
    /// within the site (a client-side route change — the user clicking through
    /// to a champion, which is exactly what the visible tab is for) and the
    /// rendered build comes from a client fetch while the document's scripts
    /// still belong to whatever page was loaded first. So the page shows a
    /// build the extractor genuinely cannot see. Every fixture we hold was
    /// captured by a direct load, which is why no fixture reproduces it and
    /// why this decision is pinned by tests rather than by a capture.</para>
    ///
    /// <para>THE SIGNAL IS THE STAGE, NOT THE EMPTINESS. Retrying on "no
    /// blocks" alone would re-load the page for a champion u.gg simply has no
    /// build for, on every 750 ms tick, forever. <c>url-recognized</c> is the
    /// extractor's own word for "I never found a build blob at all", which is
    /// the SPA signature and not the no-data signature (a page with data for a
    /// different rank/role reaches <c>json-found</c> or <c>keys-found</c> and
    /// says so). A worker load is only worth spending on the first.</para>
    ///
    /// <para>Retried AT MOST ONCE per target, by construction: the retry is a
    /// worker target (<c>ExtractInPlace: false</c>), and this returns false for
    /// those — so a worker load that also yields nothing is the final answer.</para>
    /// </summary>
    public static bool ShouldRetryViaWorker(AutoImportSiteTarget target, SiteImportPayload payload)
    {
        ArgumentNullException.ThrowIfNull(target);
        ArgumentNullException.ThrowIfNull(payload);
        if (!target.ExtractInPlace) return false;
        if (payload.ItemBlocks.Count > 0) return false;
        return string.Equals(
            payload.Stage, SiteImportPayload.StageUrlRecognized, StringComparison.Ordinal);
    }

    /// <summary>The same target as a hidden-worker direct load of its URL.</summary>
    public static AutoImportSiteTarget AsWorkerTarget(AutoImportSiteTarget target)
    {
        ArgumentNullException.ThrowIfNull(target);
        return target with { ExtractInPlace = false };
    }

    private static bool IsDoneUrl(AutoImportState state, CompanionTab site, string? url) =>
        !string.IsNullOrWhiteSpace(url) &&
        state.DoneUrls.TryGetValue(site, out var seen) &&
        string.Equals(seen, url, StringComparison.Ordinal);
}

/// <summary>
/// The browser half of the automatic import, implemented by the window (the
/// only place that may touch a WebView). Extract methods read WITHOUT
/// navigating; the worker method navigates a BACKGROUND or HIDDEN webview to
/// an allowlisted deep link — never the visible tab, never a change of the
/// selected tab, never a focus steal. Tests fake this seam.
/// </summary>
public interface ISiteAutoImportExecutor
{
    /// <summary>Read the visible tab (it is already on the target page). Navigates nothing.</summary>
    Task<string?> ExtractVisibleAsync(CompanionTab site, CancellationToken cancellationToken = default);

    /// <summary>
    /// Navigate a background/hidden webview to <paramref name="url"/>, wait
    /// for load, and extract. The implementation must refuse any
    /// <paramref name="url"/> that fails
    /// <see cref="AutoImportCoordinator.IsAllowedAutoImportTarget"/>.
    /// </summary>
    Task<string?> FetchViaWorkerAsync(
        CompanionTab site,
        Uri url,
        string? championKey,
        int? roleId,
        CancellationToken cancellationToken = default);

    /// <summary>
    /// Navigate a background/hidden webview to the Coachless per-slot RUNES
    /// page and extract the full rune page. Deliberately NOT defaulted to a
    /// null-returning stub: a fake that silently skipped this would let the
    /// tests pass while production imported no runes at all.
    /// </summary>
    Task<string?> FetchCoachlessRunesAsync(
        Uri url,
        string? championKey,
        int? roleId,
        CancellationToken cancellationToken = default);

    /// <summary>
    /// Dispose every hidden worker webview this run created, now that the run
    /// is over (2.1.0).
    ///
    /// <para>Before 2.1.0 the workers lived until the window closed. Measured
    /// on the user's machine 2026-09-08: ~2.1GB of WebView2 utility processes
    /// at 81% of system RAM against a ~55MB CoachBuild.Desktop, because four
    /// site profiles plus the import workers all stayed resident. A worker's
    /// page holds nothing worth keeping — the site tabs own the profiles, so
    /// cookies and consent survive in the profile directory — which makes
    /// per-run teardown free.</para>
    ///
    /// <para>Called after EVERY run, success or failure, so a failed import
    /// cannot be the one that leaks.</para>
    /// </summary>
    void ReleaseImportWorkers();
}

/// <summary>
/// Where the automatic import reports: a quiet log line and the status-line
/// note. Never a dialog — extraction failure is a note, not a popup.
/// </summary>
public interface ISiteAutoImportSink
{
    void LogInfo(string line);

    void StatusNote(string message);
}

/// <summary>
/// The stateful orchestrator for the automatic item import: single-flights
/// the snapshot ticks, executes the coordinator's targets through the
/// executor seam, and writes every fetched item set in ONE batched
/// item-set call so the two sites coexist in the client.
///
/// <para>2.1.2: the write is per SITE, not per run. Each site's set is
/// flushed as soon as ITS extraction completes (the batch still carries the
/// other site's cached set, so a later-completing site's write re-batches
/// whatever is ready). A practice-tool instalock ends champ select ~10s
/// after the lock while the Coachless read is still in flight; the old
/// end-of-run write lost the u.gg set that had been sitting fetched for
/// seconds. Fetch order is still u.gg then Coachless; only the write timing
/// changed.</para>
///
/// <para>THREADING: evaluated and advanced only inside the single flight.
/// The window calls <see cref="OnSnapshotAsync"/> from the dispatcher on
/// every 750 ms tick and never awaits it; overlapping ticks return
/// immediately and the next tick after completion re-evaluates, so a dropped
/// tick delays a trigger past the run but never loses it. LCU writes
/// serialize through the services' own write lease. Rune writes run only
/// after the item fetch/flush loop, so the two paths do not overlap.</para>
///
/// <para>CANCELLATION: the window owns the token. Champ-select END (the
/// phase leaving ChampSelect for None/Lobby, e.g. a dodge) cancels the
/// in-flight run: whatever it already flushed stands (a client write cannot
/// be unwound), but the debounce state rolls back to the run's start so the
/// next lock re-evaluates from scratch instead of trusting a half-run. The
/// game-start teardown deliberately does NOT cancel — hidden workers finish
/// their current run and write before disposing (see the window's linger).
/// Contract: never throws (a background import must not break the
/// snapshot tick); LCU absent means skip quietly with a log-once line;
/// extraction failure means a quiet log plus a status-line note.</para>
/// </summary>
public sealed class SiteAutoImportService
{
    private readonly ISiteAutoImportExecutor _executor;
    private readonly ItemSetApplyService _items;
    private readonly RuneApplyService? _runes;
    private readonly IChampionDirectory _champions;
    private readonly ISiteAutoImportSink _sink;
    private AutoImportState _state = AutoImportState.Initial;
    /// <summary>
    /// The running hover observation (2.2.1). Only ever touched inside the
    /// single flight, like <see cref="_state"/>. NOT rolled back by a
    /// cancelled run: it records what champ select showed, not what this
    /// service did about it, and champ-select end clears it anyway (a null
    /// context tracks to null).
    /// </summary>
    private AutoImportHover? _hover;
    private int _active;
    private string? _lastSkipNote;
    /// <summary>
    /// True once this flight has actually driven a webview, so the worker
    /// teardown runs after real work and not after every idle tick. Reset at
    /// the start of each flight; only ever touched inside the single flight.
    /// </summary>
    private bool _fetchedThisRun;
    /// <summary>
    /// The hover prefetch (2.3.5 part 2): worker fetches started on the FIRST
    /// hover tick, held in memory keyed by champion+role+site+url, consumed by
    /// the settled/locked run instead of fetching again. Guarded by
    /// <see cref="_prefetchLock"/> (the champ-select-end cancel races the
    /// snapshot tick); only ever STARTED, CONSUMED or ABANDONED inside the
    /// single flight, while the fetch tasks themselves never hold
    /// <see cref="_active"/> so the 750 ms tick is never blocked. A prefetch
    /// never writes to the LCU. Abandoned prefetches release workers, and the
    /// whole group is discarded at champ-select end, never reused across selects.
    /// </summary>
    private readonly object _prefetchLock = new();
    private PrefetchGroup? _prefetch;
    /// <summary>
    /// The drain of the last abandoned prefetch (fetch tasks + worker
    /// release). New prefetches and fresh runs await it before navigating the
    /// same worker core: u.gg and Coachless each have ONE core, so concurrent
    /// navigations on one core are not allowed. Completed in the common case.
    /// </summary>
    private Task _prefetchDrain = Task.CompletedTask;

    /// <summary>
    /// How many consecutive disconnected evaluations must pass before the
    /// "League client not connected" line is worth writing.
    ///
    /// <para>WHY THE DELAY. Field log 2026-09-08, first seconds after launch:
    /// <c>auto-import: League client not connected</c>, immediately followed by
    /// a successful poll. Nothing was wrong — LCU credential discovery had
    /// simply not finished its first cycle when the first 750 ms snapshot
    /// arrived, and reporting a race as a state is how a log teaches its reader
    /// to ignore it. Eight evaluations is ~6s of the existing tick: long past
    /// discovery on a client that is running, and still prompt on one that is
    /// not. Counted in TICKS, not seconds, so the rule stays testable with
    /// scripted inputs and no clock.</para>
    /// </summary>
    public const int DisconnectedNoteAfterEvaluations = 8;

    /// <summary>
    /// Consecutive evaluations that saw no client. Reset by any connected
    /// evaluation, so a genuine mid-session disconnect is reported after the
    /// same settle rather than being silenced by an earlier connection.
    /// </summary>
    private int _disconnectedEvaluations;

    /// <summary>The disconnected-tick count, for tests.</summary>
    internal int DisconnectedEvaluations => _disconnectedEvaluations;

    /// <param name="runes">
    /// The rune write service, for the Coachless runes page (2.1.0). Null
    /// keeps the pre-2.1.0 items-only behaviour: the runes leg is skipped
    /// entirely rather than half-run.
    /// </param>
    public SiteAutoImportService(
        ISiteAutoImportExecutor executor,
        ItemSetApplyService items,
        IChampionDirectory champions,
        ISiteAutoImportSink sink,
        RuneApplyService? runes = null)
    {
        _executor = executor ?? throw new ArgumentNullException(nameof(executor));
        _items = items ?? throw new ArgumentNullException(nameof(items));
        _champions = champions ?? throw new ArgumentNullException(nameof(champions));
        _sink = sink ?? throw new ArgumentNullException(nameof(sink));
        _runes = runes;
    }

    /// <summary>The committed debounce state, for tests.</summary>
    internal AutoImportState State => _state;

    /// <summary>The running hover observation, for tests.</summary>
    internal AutoImportHover? Hover => _hover;

    /// <summary>Whether a hover prefetch is currently held, for tests.</summary>
    internal bool HasPrefetch
    {
        get { lock (_prefetchLock) return _prefetch is not null; }
    }

    /// <summary>True while a run holds the single flight, for tests and for the window's linger.</summary>
    internal bool IsRunning => Volatile.Read(ref _active) != 0;

    public async Task OnSnapshotAsync(AutoImportInput input, CancellationToken cancellationToken = default)
    {
        if (input is null) return;
        if (Interlocked.CompareExchange(ref _active, 1, 0) == 1) return;
        _fetchedThisRun = false;
        try
        {
            await RunAsync(input, cancellationToken).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            // Champ-select-end cancellation (see CancelAutoImportFor... on
            // the window): the run's debounce state was already rolled back
            // inside RunAsync, so this is only the line saying so. Whatever
            // the run flushed before the cancel stands -- a client write
            // cannot be unwound, and the next lock re-imports from scratch.
            _sink.LogInfo("auto-import: run cancelled -- nothing further will be written");
        }
        catch (Exception error)
        {
            _sink.LogInfo($"auto-import: unexpected failure ({error.Message})");
        }
        finally
        {
            // Hand the Chromium trees back the moment the run is over --
            // success, typed failure or exception alike. Guarded by the flag
            // so the 750ms ticks that fetch NOTHING (the overwhelming
            // majority) do not churn a teardown call per tick.
            if (_fetchedThisRun)
            {
                try
                {
                    _executor.ReleaseImportWorkers();
                }
                catch (Exception error)
                {
                    _sink.LogInfo($"auto-import: worker release failed ({error.Message})");
                }
            }
            Interlocked.Exchange(ref _active, 0);
        }
    }

    /// <summary>
    /// Discards the held hover prefetch because champ select ended WITHOUT a
    /// game (a dodge back to None/Lobby). Called alongside the window's
    /// <c>CancelAutoImportForChampSelectEnd</c>: the in-flight run (if any) is
    /// cancelled through its own token, and whatever the prefetch already
    /// fetched is dropped — never written, never reused across champ selects.
    /// Abandoned prefetches release workers once their fetches land, the same
    /// way a finished run does. Thread-safe; a no-prefetch call is a no-op.
    /// </summary>
    public void CancelPrefetchForChampSelectEnd()
    {
        PrefetchGroup? old = null;
        lock (_prefetchLock)
        {
            old = _prefetch;
            _prefetch = null;
            if (old is not null)
            {
                try
                {
                    old.Cts.Cancel();
                }
                catch
                {
                }
                _prefetchDrain = CleanupAbandonedPrefetchAsync(old);
            }
        }
        if (old is not null)
            _sink.LogInfo($"auto-import: prefetch for {old.DisplayName} discarded (hover moved)");
    }

    private async Task RunAsync(AutoImportInput input, CancellationToken cancellationToken)
    {
        if (input.LcuConnected) _disconnectedEvaluations = 0;
        else if (_disconnectedEvaluations < int.MaxValue) _disconnectedEvaluations++;
        var previousHover = _hover;
        _hover = AutoImportCoordinator.TrackHover(_hover, input);
        var isNewHover = _hover is not null && !ReferenceEquals(previousHover, _hover);
        var evaluation = AutoImportCoordinator.Evaluate(_state, input, _hover);
        var fetch = evaluation.Fetch.ToList();
        if (fetch.Count == 0)
        {
            NoteSkipOnce(evaluation.SkipReason);
            // The fold pre-filter in Evaluate cannot see roster aliases
            // (coachless redirects monkeyking to wukong), so a same-champion
            // visible page with a differing slug gets one roster-checked
            // second chance here.
            if (await AliasVisibleCandidateAsync(input, cancellationToken).ConfigureAwait(false) is { } alias)
                fetch.Add(alias);
            else
            {
                HandlePrefetchForIdleTick(input, _hover, isNewHover, cancellationToken);
                return;
            }
        }
        _lastSkipNote = null;

        if (input.ChampionId is not > 0 || string.IsNullOrWhiteSpace(input.ChampionName))
            return;

        // WHICH trigger armed this run, in the log, before any fetch line. The
        // field bug it exists for (2026-09-09) was diagnosed from the ABSENCE
        // of auto-import lines, so "an import ran, and the hover is why" has to
        // be readable without inferring it from the lock timing.
        if (evaluation.Trigger is not AutoImportTrigger.None)
        {
            var who = SiteDeepLink.RoleLabel(input.RoleId) is { } role
                ? $"{input.ChampionName} {role}"
                : input.ChampionName;
            _sink.LogInfo(evaluation.Trigger is AutoImportTrigger.Hover
                ? $"auto-import: {who} hovered and held -- importing now (trigger: hover)"
                : $"auto-import: {who} locked in -- importing now (trigger: lock)");
        }

        // The debounce state before this run: restored verbatim if the run
        // is cancelled, so a half-run never counts as attempted.
        var preRun = _state;
        // The hover prefetch, if any: same champion+role is CONSUMED (its
        // completed or in-flight tasks are awaited instead of fetching again);
        // a different champion+role is ABANDONED (cancelled, and this run
        // waits for its drain before navigating the same worker core).
        PrefetchGroup? consumed = null;
        Task? predecessor;
        string? discardedDisplay = null;
        lock (_prefetchLock)
        {
            if (_prefetch is not null && input.ChampionId is > 0)
            {
                if (_prefetch.ChampionId == input.ChampionId && _prefetch.RoleId == input.RoleId)
                {
                    consumed = _prefetch;
                    _prefetch = null;
                }
                else
                {
                    var old = _prefetch;
                    _prefetch = null;
                    discardedDisplay = old.DisplayName;
                    try
                    {
                        old.Cts.Cancel();
                    }
                    catch
                    {
                    }
                    _prefetchDrain = CleanupAbandonedPrefetchAsync(old);
                }
            }
            predecessor = _prefetchDrain;
        }
        if (discardedDisplay is not null)
            _sink.LogInfo($"auto-import: prefetch for {discardedDisplay} discarded (hover moved)");
        try
        {
            await RunFetchesAsync(fetch, input, cancellationToken, consumed, predecessor).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            _state = preRun;
            throw;
        }
    }

    /// <summary>
    /// The idle-tick half of the hover prefetch: called only when NO run is
    /// due (not settled, not locked, no visible refresh). Starts one prefetch
    /// per site for a newly hovered champion+role (deep-link worker targets
    /// only — never a visible-tab in-place read), holds an identical hover's
    /// prefetch, and cancels a stale one when the hover moves. Quick and
    /// non-blocking: the fetches run in the background and never hold
    /// <see cref="_active"/>. A prefetch never writes to the LCU.
    /// </summary>
    private void HandlePrefetchForIdleTick(
        AutoImportInput input,
        AutoImportHover? hover,
        bool isNewHover,
        CancellationToken windowCt)
    {
        if (!input.LcuConnected || input.ChampionId is not > 0 ||
            string.IsNullOrWhiteSpace(input.ChampionKey) ||
            string.IsNullOrWhiteSpace(input.ChampionName) ||
            input.Locked || hover is null)
        {
            AbandonPrefetchForIdle();
            return;
        }
        if (AutoImportCoordinator.IsHoverSettled(hover, input))
            return;
        if (_state.ChampionId == input.ChampionId && _state.RoleId == input.RoleId)
            return;
        if (!isNewHover)
            return;
        Uri? uggUrl = null;
        Uri? runesUrl = null;
        Uri? coachlessItemsUrl = null;
        if (SiteDeepLink.Build(CompanionTab.UGg, input.ChampionKey, input.RoleId) is { } uggCandidate &&
            !(input.VisibleTab == CompanionTab.UGg &&
                SiteNavigationPolicy.IsAlreadyThere(input.VisibleUrl, uggCandidate)))
            uggUrl = uggCandidate;
        if (_runes is not null)
        {
            runesUrl = SiteDeepLink.CoachlessRunesUrl(input.ChampionKey, input.RoleId);
        }
        else if (SiteDeepLink.Build(CompanionTab.Coachless, input.ChampionKey, input.RoleId) is { } coachlessCandidate &&
            !(input.VisibleTab == CompanionTab.Coachless &&
                SiteNavigationPolicy.IsAlreadyThere(input.VisibleUrl, coachlessCandidate)))
            coachlessItemsUrl = coachlessCandidate;
        if (uggUrl is null && runesUrl is null && coachlessItemsUrl is null)
        {
            AbandonPrefetchForIdle();
            return;
        }
        Task predecessor;
        string? discardedDisplay = null;
        lock (_prefetchLock)
        {
            if (_prefetch is not null)
            {
                if (_prefetch.ChampionId == input.ChampionId && _prefetch.RoleId == input.RoleId)
                    return;
                var old = _prefetch;
                _prefetch = null;
                discardedDisplay = old.DisplayName;
                try
                {
                    old.Cts.Cancel();
                }
                catch
                {
                }
                _prefetchDrain = CleanupAbandonedPrefetchAsync(old);
            }
            predecessor = _prefetchDrain;
        }
        if (discardedDisplay is not null)
            _sink.LogInfo($"auto-import: prefetch for {discardedDisplay} discarded (hover moved)");
        CancellationTokenSource cts;
        try
        {
            cts = CancellationTokenSource.CreateLinkedTokenSource(windowCt);
        }
        catch
        {
            cts = new CancellationTokenSource();
        }
        var group = new PrefetchGroup
        {
            ChampionId = input.ChampionId.Value,
            RoleId = input.RoleId,
            ChampionKey = input.ChampionKey!,
            ChampionName = input.ChampionName!,
            UggUrl = uggUrl,
            RunesUrl = runesUrl,
            CoachlessItemsUrl = coachlessItemsUrl,
            Cts = cts,
        };
        var prefetchCt = cts.Token;
        var snapshot = input;
        // Runes first, then u.gg: the same start order as the settled run, so
        // the fetch sequence reads identically with or without a prefetch.
        if (runesUrl is not null)
            group.RunesTask = FetchRunesPrefetchAsync(runesUrl, snapshot, input.RoleId, prefetchCt, predecessor);
        if (uggUrl is not null)
            group.UggTask = FetchUggPrefetchAsync(
                uggUrl, snapshot, input.RoleId, prefetchCt, predecessor);
        if (coachlessItemsUrl is not null)
            group.CoachlessItemsTask = FetchCoachlessItemsPrefetchAsync(
                coachlessItemsUrl, snapshot, input.RoleId, prefetchCt, predecessor);
        lock (_prefetchLock)
        {
            // Single-flight ticks cannot race each other here; the explicit
            // champ-select-end cancel can, but it only clears — a group
            // created after its clear is for a tick that already passed the
            // idle gate, and the next null tick discards it again.
            _prefetch = group;
        }
        _sink.LogInfo($"auto-import: prefetching {group.DisplayName} on hover");
    }

    /// <summary>Abandons the held prefetch, if any, for an idle tick that needs none.</summary>
    private void AbandonPrefetchForIdle()
    {
        PrefetchGroup? old = null;
        lock (_prefetchLock)
        {
            old = _prefetch;
            _prefetch = null;
            if (old is not null)
            {
                try
                {
                    old.Cts.Cancel();
                }
                catch
                {
                }
                _prefetchDrain = CleanupAbandonedPrefetchAsync(old);
            }
        }
        if (old is not null)
            _sink.LogInfo($"auto-import: prefetch for {old.DisplayName} discarded (hover moved)");
    }

    /// <summary>
    /// Waits out an abandoned prefetch's fetches, then hands its Chromium
    /// trees back — the same teardown a finished run gets, so an abandoned
    /// hover cannot be the one that leaks. Never throws. The returned task is
    /// the drain the next prefetch (or run) awaits before navigating the same
    /// worker core.
    /// </summary>
    private Task CleanupAbandonedPrefetchAsync(PrefetchGroup old)
    {
        return Task.Run(async () =>
        {
            var pending = new List<Task>(3);
            if (old.UggTask is not null) pending.Add(old.UggTask);
            if (old.RunesTask is not null) pending.Add(old.RunesTask);
            if (old.CoachlessItemsTask is not null) pending.Add(old.CoachlessItemsTask);
            if (pending.Count > 0)
            {
                try
                {
                    await Task.WhenAll(pending).ConfigureAwait(false);
                }
                catch
                {
                }
            }
            try
            {
                _executor.ReleaseImportWorkers();
            }
            catch (Exception error)
            {
                _sink.LogInfo($"auto-import: worker release failed ({error.Message})");
            }
        });
    }

    private static bool PrefetchUrlsEqual(Uri? first, Uri? second) =>
        first is not null && second is not null &&
        string.Equals(first.AbsoluteUri, second.AbsoluteUri, StringComparison.OrdinalIgnoreCase);

    private async Task<PrefetchFetchResult> FetchUggPrefetchAsync(
        Uri url,
        AutoImportInput snapshot,
        int? roleId,
        CancellationToken prefetchCt,
        Task predecessor)
    {
        try
        {
            await predecessor.WaitAsync(prefetchCt).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch
        {
        }
        prefetchCt.ThrowIfCancellationRequested();
        var clock = Stopwatch.StartNew();
        try
        {
            var raw = await _executor.FetchViaWorkerAsync(
                CompanionTab.UGg, url, snapshot.ChampionKey, roleId, prefetchCt).ConfigureAwait(false);
            return new PrefetchFetchResult(raw, null, clock.ElapsedMilliseconds);
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception error)
        {
            return new PrefetchFetchResult(null, error.Message, clock.ElapsedMilliseconds);
        }
    }

    private async Task<PrefetchFetchResult> FetchCoachlessItemsPrefetchAsync(
        Uri url,
        AutoImportInput snapshot,
        int? roleId,
        CancellationToken prefetchCt,
        Task predecessor)
    {
        try
        {
            await predecessor.WaitAsync(prefetchCt).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch
        {
        }
        prefetchCt.ThrowIfCancellationRequested();
        var clock = Stopwatch.StartNew();
        try
        {
            var raw = await _executor.FetchViaWorkerAsync(
                CompanionTab.Coachless, url, snapshot.ChampionKey, roleId, prefetchCt).ConfigureAwait(false);
            return new PrefetchFetchResult(raw, null, clock.ElapsedMilliseconds);
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception error)
        {
            return new PrefetchFetchResult(null, error.Message, clock.ElapsedMilliseconds);
        }
    }

    private async Task<CoachlessRunesRaw> FetchRunesPrefetchAsync(
        Uri url,
        AutoImportInput snapshot,
        int? roleId,
        CancellationToken prefetchCt,
        Task predecessor)
    {
        try
        {
            await predecessor.WaitAsync(prefetchCt).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch
        {
        }
        prefetchCt.ThrowIfCancellationRequested();
        return await FetchCoachlessRunesRawAsync(url, snapshot, roleId, prefetchCt).ConfigureAwait(false);
    }

    /// <summary>
    /// The held hover prefetch (2.3.5 part 2): the deep-link worker fetches
    /// for one hovered champion+role, started on its first tick and consumed
    /// by the settled/locked run. Keyed by champion+role+site+url: the settled
    /// run reuses a task only when its site AND url match. At most one group
    /// exists at a time (one prefetch per site in flight); a hover move
    /// cancels the stale group and the next group awaits its drain before
    /// navigating the same worker core.
    /// </summary>
    private sealed class PrefetchGroup
    {
        public required int ChampionId;
        public required int? RoleId;
        public required string ChampionKey;
        public required string ChampionName;
        public Uri? UggUrl;
        public Uri? RunesUrl;
        public Uri? CoachlessItemsUrl;
        public required CancellationTokenSource Cts;
        public Task<PrefetchFetchResult>? UggTask;
        public Task<CoachlessRunesRaw>? RunesTask;
        public Task<PrefetchFetchResult>? CoachlessItemsTask;

        public string DisplayName
        {
            get
            {
                var role = SiteDeepLink.RoleLabel(RoleId);
                return role is null ? ChampionName : $"{ChampionName} {role}";
            }
        }
    }

    /// <summary>A prefetched worker answer: the extractor JSON, or the fetch error.</summary>
    private sealed record PrefetchFetchResult(string? Raw, string? Error, long ElapsedMs);

    /// <summary>
    /// The fetch loop: each site extracts, then ITS set is flushed before
    /// the next site starts (2.1.2). The batch still merges whatever is
    /// ready — the fresh payload plus the other site's cached set — so the
    /// second write carries the first, and the two per-site titles still
    /// coexist in the client exactly as the old single write arranged.
    ///
    /// <para>2.3.5: the Coachless runes fetch starts at the top of the run,
    /// concurrently with the u.gg fetch (different cores), and the u.gg rune
    /// page is written as soon as it validates — before the u.gg item flush,
    /// long before Coachless items. The Coachless ITEMS fetch still awaits
    /// the in-flight runes fetch first: both touch the same Coachless core
    /// and must never navigate it concurrently.</para>
    ///
    /// <para>2.3.5 part 2: the hover prefetch. <paramref name="consumed"/> is
    /// the held prefetch for THIS champion+role, if any: its completed or
    /// in-flight tasks are awaited instead of fetching again (same
    /// validate/write path after — every rune-page guarantee unchanged).
    /// <paramref name="predecessor"/> is the drain of an abandoned prefetch
    /// for ANOTHER champion: awaited before any navigation so the run never
    /// navigates a worker core the stale prefetch is still on.</para>
    /// </summary>
    private async Task RunFetchesAsync(
        List<AutoImportSiteTarget> fetch,
        AutoImportInput input,
        CancellationToken cancellationToken,
        PrefetchGroup? consumed = null,
        Task? predecessor = null)
    {
        if (consumed is null)
        {
            await RunFetchesCoreAsync(fetch, input, cancellationToken, null, predecessor).ConfigureAwait(false);
            return;
        }
        // The consumed prefetch runs on its own token: cancel it with the run,
        // and never return (which releases the workers) while one of its
        // fetches is still navigating a worker core.
        using var link = cancellationToken.Register(static state =>
        {
            try
            {
                ((CancellationTokenSource)state!).Cancel();
            }
            catch
            {
            }
        }, consumed.Cts);
        try
        {
            await RunFetchesCoreAsync(fetch, input, cancellationToken, consumed, predecessor).ConfigureAwait(false);
        }
        finally
        {
            await QuietlyAsync(consumed.UggTask).ConfigureAwait(false);
            await QuietlyAsync(consumed.RunesTask).ConfigureAwait(false);
            await QuietlyAsync(consumed.CoachlessItemsTask).ConfigureAwait(false);
        }
    }

    private static async Task QuietlyAsync(Task? task)
    {
        if (task is null) return;
        try
        {
            await task.ConfigureAwait(false);
        }
        catch
        {
        }
    }

    private async Task RunFetchesCoreAsync(
        List<AutoImportSiteTarget> fetch,
        AutoImportInput input,
        CancellationToken cancellationToken,
        PrefetchGroup? consumed,
        Task? predecessor)
    {
        var runClock = Stopwatch.StartNew();
        // A run for another champion never navigates a core the abandoned
        // prefetch is still on. The drain never throws (cleanup swallows), so
        // this awaits only on cancellation of THIS run.
        if (predecessor is not null)
        {
            try
            {
                await predecessor.WaitAsync(cancellationToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                throw;
            }
            catch
            {
            }
            cancellationToken.ThrowIfCancellationRequested();
        }
        // A consumed prefetch already drove a webview, so the worker teardown
        // must run even if this run's own fetches turn out to be in-place
        // reads that touch nothing.
        if (consumed?.UggTask is not null || consumed?.RunesTask is not null ||
            consumed?.CoachlessItemsTask is not null)
            _fetchedThisRun = true;
        var prefetchHit = false;
        // The speculative Coachless runes flight (2.3.5). Started BEFORE the
        // first item fetch so it overlaps the u.gg fetch on its own core.
        // Role known: the URL already carries it. Role-less: the role-less
        // URL; the resolved payload is accepted only when its role matches
        // the role u.gg discovers, else refetched aligned (see
        // ResolveCoachlessRunesAsync). Null when there is no rune service —
        // the items-only behaviour is then exactly what it was.
        // Part 2: a held prefetch for this champion+role IS the flight — the
        // same task, awaited by the same resolver, never fetched twice.
        CoachlessRunesFlight? runesFlight = null;
        if (consumed?.RunesTask is not null && _runes is not null &&
            consumed.RunesUrl is not null)
        {
            runesFlight = new CoachlessRunesFlight(consumed.RunesUrl, consumed.RunesTask);
            prefetchHit = true;
        }
        else if (_runes is not null &&
            SiteDeepLink.CoachlessRunesUrl(input.ChampionKey, input.RoleId) is { } speculativeUrl)
            runesFlight = StartCoachlessRunesFlight(speculativeUrl, input, input.RoleId, cancellationToken);
        var hadWritable = false;
        SiteImportPayload? uggRunesPayload = null;
        ApplyRunesRequest? uggRuneRequest = null;
        var uggStaged = false;
        var bothStaged = false;
        // Names already reported this run, so the second rune batch never
        // logs a duplicate "u.gg X already matches" for the same page.
        var runeReported = new HashSet<string>(StringComparer.Ordinal);
        var runeCapacityLogged = false;
        long uggMs = -1, coachlessMs = -1, firstRuneMs = -1, bothRuneMs = -1;
        var runesRefetched = false;
        var effectiveRoleId = input.RoleId;
        var assignedRole = SiteDeepLink.RoleToken(input.RoleId);
        foreach (var planned in fetch)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var target = planned;
            // Roleless lobbies first ask u.gg which role its rendered active
            // tab selected. Coachless then loads that exact role instead of
            // independently falling back to a different site default.
            if (target.Site == CompanionTab.Coachless &&
                input.RoleId is null && effectiveRoleId is not null &&
                SiteDeepLink.Build(CompanionTab.Coachless, input.ChampionKey, effectiveRoleId) is { } aligned)
            {
                target = target with
                {
                    Url = aligned,
                    RoleId = effectiveRoleId,
                    ExtractInPlace = target.ExtractInPlace &&
                        SiteNavigationPolicy.IsAlreadyThere(target.Url.ToString(), aligned),
                };
            }
            // Same-core serialization (2.3.5): the Coachless ITEMS fetch must
            // not touch the Coachless core while the runes flight is still
            // navigating it. The flight captures its own errors, so this
            // await throws only on cancellation — which propagates.
            if (target.Site == CompanionTab.Coachless && runesFlight is not null)
                await runesFlight.Fetch.ConfigureAwait(false);
            string? raw;
            if (!target.ExtractInPlace && consumed is not null &&
                ((target.Site == CompanionTab.UGg && consumed.UggTask is not null &&
                    PrefetchUrlsEqual(target.Url, consumed.UggUrl)) ||
                (target.Site == CompanionTab.Coachless && _runes is null &&
                    consumed.CoachlessItemsTask is not null &&
                    PrefetchUrlsEqual(target.Url, consumed.CoachlessItemsUrl))))
            {
                // The hover prefetch, consumed: the same task the first hover
                // tick started, completed or still in flight — never fetched
                // twice. Validated and written exactly as a fresh fetch.
                PrefetchFetchResult pre;
                try
                {
                    pre = target.Site == CompanionTab.UGg
                        ? await consumed.UggTask!.ConfigureAwait(false)
                        : await consumed.CoachlessItemsTask!.ConfigureAwait(false);
                }
                catch (OperationCanceledException)
                {
                    throw;
                }
                prefetchHit = true;
                _fetchedThisRun = true;
                if (pre.Error is not null)
                {
                    _sink.LogInfo($"auto-import: {CompanionTabs.LabelFor(target.Site)} fetch failed ({pre.Error})");
                    raw = null;
                }
                else
                {
                    raw = pre.Raw;
                }
            }
            else
            {
                // A prefetch this run did not consume (an in-place read, a
                // different url) may still be on this site's worker core.
                if (target.Site == CompanionTab.UGg)
                    await QuietlyAsync(consumed?.UggTask).ConfigureAwait(false);
                else if (target.Site == CompanionTab.Coachless)
                    await QuietlyAsync(consumed?.CoachlessItemsTask).ConfigureAwait(false);
                raw = await FetchTargetAsync(target, cancellationToken).ConfigureAwait(false);
            }
            if (target.Site == CompanionTab.UGg && uggMs < 0)
                uggMs = runClock.ElapsedMilliseconds;
            // SPA FALLBACK (2.1.1). An in-place read of the user's own visible
            // tab can be correct about the DOM and still see no build, because
            // u.gg embeds its build blob only in a directly-served document.
            // Re-load the SAME url in a hidden worker before giving up. See
            // AutoImportCoordinator.ShouldRetryViaWorker for why the stage --
            // not the emptiness -- is what licenses the second fetch.
            if (SiteImportPayload.TryParse(raw, out var firstPass, out _) &&
                firstPass is not null &&
                AutoImportCoordinator.ShouldRetryViaWorker(target, firstPass))
            {
                var label = CompanionTabs.LabelFor(target.Site);
                _sink.LogInfo(
                    $"auto-import: {label} the visible tab embeds no build blob " +
                    "(client-side navigation) -- retrying as a direct load");
                target = AutoImportCoordinator.AsWorkerTarget(target);
                var retried = await FetchTargetAsync(target, cancellationToken).ConfigureAwait(false);
                // Keep the first read only if the retry produced nothing
                // parseable at all: a worker answer, even an empty one, is the
                // better-informed one, but a worker that fails outright must
                // not erase what the visible tab did manage to say.
                if (!string.IsNullOrWhiteSpace(retried)) raw = retried;
            }
            if (!SiteImportPayload.TryParse(raw, out var payload, out var failure) || payload is null)
            {
                var label = CompanionTabs.LabelFor(target.Site);
                _sink.LogInfo($"auto-import: {label} extraction failed ({failure})");
                _sink.StatusNote($"Auto-import from {label} failed ({failure})");
                CommitOutcome(input, new AutoImportOutcome(target.Site, target.Url.ToString(), null));
                continue;
            }
            if (!PayloadMatchesContext(payload, input))
            {
                _sink.LogInfo(
                    $"auto-import: {CompanionTabs.LabelFor(target.Site)} yielded \"{payload.ChampionSlug}\", " +
                    $"not the selected champion -- ignored");
                CommitOutcome(input, new AutoImportOutcome(target.Site, target.Url.ToString(), null));
                continue;
            }
            // The extractor's own stage/slot notes, BEFORE the verdict line, so
            // "yielded no item build" is never again a bare absence with no
            // account of where the read stopped (field log 2026-09-08).
            LogPayloadNotes(target.Site, payload);
            if (payload.Source == SiteImportSource.UGg && payload.Runes is not null)
                uggRunesPayload = payload;
            if (effectiveRoleId is null)
                effectiveRoleId = SiteDeepLink.RoleIdFromToken(payload.Role);
            // STAGE 1 (2.3.5): the u.gg rune page is written as soon as it
            // validates, before its own item flush — the old code waited out
            // the whole Coachless runes fetch first. The Coachless half
            // follows in stage 2 once the flight resolves.
            if (!uggStaged && _runes is not null &&
                target.Site == CompanionTab.UGg && uggRunesPayload?.Runes is not null)
            {
                uggStaged = true;
                if (TryBuildRuneRequest(uggRunesPayload, input.ChampionName!, assignedRole, out var uggRequest))
                {
                    uggRuneRequest = uggRequest;
                    runeCapacityLogged = await ApplyRuneBatchAsync(
                        [uggRequest], runeReported, runeCapacityLogged, cancellationToken)
                        .ConfigureAwait(false);
                    firstRuneMs = runClock.ElapsedMilliseconds;
                }
                else
                {
                    LogDroppedRuneHalf(CompanionTab.UGg, uggRunesPayload);
                }
            }
            if (payload.ItemBlocks.Count == 0)
            {
                _sink.LogInfo(
                    $"auto-import: {CompanionTabs.LabelFor(target.Site)} yielded no item build -- ignored");
                CommitOutcome(input, new AutoImportOutcome(target.Site, target.Url.ToString(), null));
            }
            else
            {
                // FLUSH NOW (2.1.2): this site's set lands before the next site
                // even starts, so a teardown that aborts the rest of the run
                // cannot take an already-extracted set with it. The batch still
                // carries the cached other site, so contiguity is preserved.
                cancellationToken.ThrowIfCancellationRequested();
                hadWritable = true;
                await FlushSiteAsync(payload, input, cancellationToken).ConfigureAwait(false);
                CommitOutcome(input, new AutoImportOutcome(target.Site, target.Url.ToString(), payload));
            }
            // STAGE 2 (2.3.5): once u.gg's page (stage 1) and its items are
            // flushed, resolve the flight and write the pair. The u.gg half
            // is Unchanged here — no PUT — and its already-reported line is
            // suppressed, so the run says it once.
            if (uggStaged && !bothStaged && _runes is not null &&
                target.Site == CompanionTab.UGg && runesFlight is not null)
            {
                bothStaged = true;
                var resolved = await ResolveCoachlessRunesAsync(
                    input, effectiveRoleId, runesFlight, cancellationToken).ConfigureAwait(false);
                coachlessMs = resolved.ElapsedMs;
                runesRefetched |= resolved.Refetched;
                ApplyRunesRequest? coachlessRequest = null;
                if (resolved.Payload is not null)
                {
                    if (TryBuildRuneRequest(
                        resolved.Payload, input.ChampionName!, assignedRole, out var built))
                        coachlessRequest = built;
                    else
                        LogDroppedRuneHalf(CompanionTab.Coachless, resolved.Payload);
                }
                // A Coachless half that yielded nothing leaves the staged
                // u.gg page standing: no second batch at all.
                if (coachlessRequest is not null)
                {
                    var second = new List<ApplyRunesRequest>(2);
                    if (uggRuneRequest is not null) second.Add(uggRuneRequest);
                    second.Add(coachlessRequest);
                    runeCapacityLogged = await ApplyRuneBatchAsync(
                        second, runeReported, runeCapacityLogged, cancellationToken)
                        .ConfigureAwait(false);
                    bothRuneMs = runClock.ElapsedMilliseconds;
                }
            }
        }

        if (!hadWritable)
        {
            _sink.LogInfo("auto-import: nothing writable from this run -- nothing was imported");
        }

        cancellationToken.ThrowIfCancellationRequested();
        if (_runes is not null && !bothStaged)
        {
            // The combined path: no u.gg runes were staged in the loop (a
            // Coachless-only refresh, a failed u.gg extraction, ...). Fetch
            // the u.gg half for the pair exactly as before, then resolve the
            // flight and write whatever validated as one batch.
            bothStaged = true;
            if (runesFlight is null &&
                SiteDeepLink.CoachlessRunesUrl(input.ChampionKey, effectiveRoleId) is { } lateUrl)
                runesFlight = StartCoachlessRunesFlight(lateUrl, input, effectiveRoleId, cancellationToken);
            if (runesFlight is not null)
            {
                await QuietlyAsync(consumed?.UggTask).ConfigureAwait(false);
                var leg = await FetchUggRunesLegAsync(
                    input, uggRunesPayload, effectiveRoleId, cancellationToken).ConfigureAwait(false);
                uggRunesPayload = leg.Payload;
                effectiveRoleId = leg.EffectiveRoleId;
                if (uggMs < 0) uggMs = leg.ElapsedMs;
                var resolved = await ResolveCoachlessRunesAsync(
                    input, effectiveRoleId, runesFlight, cancellationToken).ConfigureAwait(false);
                coachlessMs = resolved.ElapsedMs;
                runesRefetched |= resolved.Refetched;
                var requests = new List<ApplyRunesRequest>(2);
                AddRuneRequest(CompanionTab.UGg, uggRunesPayload, input, assignedRole, requests);
                if (resolved.Payload is not null)
                    AddRuneRequest(CompanionTab.Coachless, resolved.Payload, input, assignedRole, requests);
                if (requests.Count > 0)
                {
                    runeCapacityLogged = await ApplyRuneBatchAsync(
                        requests, runeReported, runeCapacityLogged, cancellationToken)
                        .ConfigureAwait(false);
                    bothRuneMs = runClock.ElapsedMilliseconds;
                }
            }
        }

        // One stage-timing line per rune run (2.3.5): names only, no values
        // of user data. The next field pass reads the critical path off it.
        // Part 2 gains prefetch-hit: whether this run consumed the hover
        // prefetch instead of fetching again.
        if (runesFlight is not null)
        {
            var marker = runesRefetched ? "(parallel+refetch)" : "(parallel)";
            _sink.LogInfo(
                $"auto-import: timing ugg={FormatMs(uggMs)} " +
                $"coachless-runes={FormatMs(coachlessMs)} {marker} " +
                $"first-rune-page={FormatSec(firstRuneMs)} both-rune-pages={FormatSec(bothRuneMs)} " +
                $"prefetch-hit={(prefetchHit ? "true" : "false")}");
        }
    }

    private static string FormatMs(long milliseconds) =>
        milliseconds >= 0 ? $"{milliseconds}ms" : "none";

    private static string FormatSec(long milliseconds) =>
        milliseconds >= 0 ? $"{milliseconds / 1000.0:F1}s" : "none";

    /// <summary>
    /// Commits one site's outcome to the debounce state: records the
    /// attempted URL (success or quiet failure — both re-arm only on
    /// change) and caches a written set for later single-site batches.
    /// </summary>
    private void CommitOutcome(AutoImportInput input, AutoImportOutcome outcome)
    {
        if (input.ChampionId is not > 0) return;
        _state = AutoImportCoordinator.RecordCompleted(
            _state, input.ChampionId.Value, input.RoleId, input.ChampionName ?? string.Empty, [outcome]);
    }

    /// <summary>
    /// Writes one site's fresh payload batched with whatever the other site
    /// has cached. A write that THROWS (rather than returning a typed
    /// failure) still commits its outcome at the call site: without that,
    /// the debounce never advances and every 750 ms tick re-fetches both
    /// pages in a hot loop behind one flapping LCU call. Cancellation passes
    /// through unwritten.
    /// </summary>
    private async Task FlushSiteAsync(
        SiteImportPayload payload,
        AutoImportInput input,
        CancellationToken cancellationToken)
    {
        if (input.ChampionId is not > 0 || string.IsNullOrWhiteSpace(input.ChampionName))
            return;
        var batch = AutoImportCoordinator.BuildWriteBatch(
            [payload], _state.CachedSets, input.ChampionId.Value, input.ChampionName);
        if (batch.Count == 0) return;
        IReadOnlyList<SiteImportResult> results = [];
        try
        {
            results = await SiteImportApplier.ApplyItemsBatchAsync(
                batch, _items, cancellationToken).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception error)
        {
            _sink.LogInfo($"auto-import: item-set write failed ({error.Message})");
            _sink.StatusNote($"Auto-import write failed ({error.Message})");
        }
        foreach (var result in results)
        {
            _sink.LogInfo($"auto-import: {result.Message}");
            _sink.StatusNote(result.Message);
        }
    }

    /// <summary>
    /// What a speculative Coachless runes answer classified as: usable, the
    /// wrong champion, or failed outright. Only <see cref="Failed"/> (and a
    /// role mismatch on <see cref="Ok"/>) may fall through to the aligned
    /// refetch — a wrong champion would only mismatch again.
    /// </summary>
    private enum CoachlessRunesVerdict
    {
        Ok,
        WrongChampion,
        Failed,
    }

    /// <summary>
    /// The in-flight speculative Coachless runes fetch (2.3.5): the URL it
    /// was started with and its raw answer. Started at the top of the run so
    /// it overlaps the u.gg fetch on its own core.
    /// </summary>
    private sealed record CoachlessRunesFlight(Uri Url, Task<CoachlessRunesRaw> Fetch);

    /// <summary>
    /// The flight's raw answer: the extractor JSON, or the fetch error when
    /// the fetch itself threw (fail-soft, logged by the resolver with the
    /// same wording as a direct fetch), plus how long the fetch took.
    /// Cancellation is never captured here — it propagates.
    /// </summary>
    private sealed record CoachlessRunesRaw(string? Response, string? Error, long ElapsedMs);

    /// <summary>
    /// Starts the speculative Coachless runes flight. Marks the run as having
    /// driven a webview (so the worker teardown runs) and observes the fault
    /// even on paths that never await, so a background failure on a
    /// cancelled run stays observed.
    /// </summary>
    private CoachlessRunesFlight StartCoachlessRunesFlight(
        Uri url,
        AutoImportInput input,
        int? roleId,
        CancellationToken cancellationToken)
    {
        _fetchedThisRun = true;
        var flight = new CoachlessRunesFlight(
            url, FetchCoachlessRunesRawAsync(url, input, roleId, cancellationToken));
        _ = flight.Fetch.ContinueWith(
            task => _ = task.Exception,
            TaskContinuationOptions.OnlyOnFaulted | TaskContinuationOptions.ExecuteSynchronously);
        return flight;
    }

    private async Task<CoachlessRunesRaw> FetchCoachlessRunesRawAsync(
        Uri url,
        AutoImportInput input,
        int? roleId,
        CancellationToken cancellationToken)
    {
        var clock = Stopwatch.StartNew();
        try
        {
            var raw = await _executor.FetchCoachlessRunesAsync(
                url, input.ChampionKey, roleId, cancellationToken).ConfigureAwait(false);
            return new CoachlessRunesRaw(raw, null, clock.ElapsedMilliseconds);
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception error)
        {
            return new CoachlessRunesRaw(null, error.Message, clock.ElapsedMilliseconds);
        }
    }

    /// <summary>
    /// Resolves the flight to a usable Coachless runes payload (2.3.5).
    /// Accepts the speculative answer only when its role IS the resolved
    /// role (both null in a role-less run accepts); otherwise loads the
    /// aligned role exactly as the old serial code did. Every failure logs
    /// with the same wording as a direct fetch.
    /// </summary>
    private async Task<(SiteImportPayload? Payload, long ElapsedMs, bool Refetched)> ResolveCoachlessRunesAsync(
        AutoImportInput input,
        int? effectiveRoleId,
        CoachlessRunesFlight flight,
        CancellationToken cancellationToken)
    {
        CoachlessRunesRaw raw;
        try
        {
            raw = await flight.Fetch.ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        var elapsed = raw.ElapsedMs;
        var speculativeOk = ClassifyCoachlessRaw(raw.Response, raw.Error, input, out var speculative);
        if (speculativeOk == CoachlessRunesVerdict.Ok &&
            SiteDeepLink.RoleIdFromToken(speculative!.Role) == effectiveRoleId)
        {
            LogPayloadNotes(CompanionTab.Coachless, speculative);
            return (speculative, elapsed, false);
        }
        var aligned = SiteDeepLink.CoachlessRunesUrl(input.ChampionKey, effectiveRoleId);
        if (speculativeOk == CoachlessRunesVerdict.WrongChampion ||
            aligned is null ||
            string.Equals(aligned.AbsoluteUri, flight.Url.AbsoluteUri, StringComparison.OrdinalIgnoreCase))
        {
            // Wrong champion: another role would not change the champion.
            // Same URL: the speculative fetch already IS this URL's answer —
            // retrying it would double every failure, and a role the site
            // rendered differently than asked is still the best answer there
            // is. Both already logged their line.
            if (speculative is not null)
                LogPayloadNotes(CompanionTab.Coachless, speculative);
            return (speculative, elapsed, false);
        }
        var (payload, alignedMs) = await FetchAlignedCoachlessRunesAsync(
            aligned, input, effectiveRoleId, cancellationToken).ConfigureAwait(false);
        return (payload, elapsed + alignedMs, true);
    }

    /// <summary>
    /// Classifies the flight's raw answer with the SAME lines a direct fetch
    /// logs. Notes are NOT logged here — only the accepted (or kept)
    /// payload's notes reach the log, at the accept site.
    /// </summary>
    private CoachlessRunesVerdict ClassifyCoachlessRaw(
        string? response,
        string? error,
        AutoImportInput input,
        out SiteImportPayload? payload)
    {
        payload = null;
        if (error is not null)
        {
            _sink.LogInfo($"runes: Coachless fetch failed ({error})");
            return CoachlessRunesVerdict.Failed;
        }
        if (!SiteImportPayload.TryParse(response, out var fetched, out var failure) || fetched is null)
        {
            _sink.LogInfo($"runes: Coachless yielded no rune build ({failure})");
            return CoachlessRunesVerdict.Failed;
        }
        if (!PayloadMatchesContext(fetched, input))
        {
            _sink.LogInfo(
                $"runes: Coachless yielded \"{fetched.ChampionSlug}\", not the selected champion -- ignored");
            return CoachlessRunesVerdict.WrongChampion;
        }
        payload = fetched;
        return CoachlessRunesVerdict.Ok;
    }

    /// <summary>
    /// The aligned-role Coachless runes fetch: the old serial fetch, kept
    /// verbatim for the role-less mismatch (and late-start) path.
    /// </summary>
    private async Task<(SiteImportPayload? Payload, long ElapsedMs)> FetchAlignedCoachlessRunesAsync(
        Uri url,
        AutoImportInput input,
        int? roleId,
        CancellationToken cancellationToken)
    {
        var clock = Stopwatch.StartNew();
        _fetchedThisRun = true;
        try
        {
            var raw = await _executor.FetchCoachlessRunesAsync(
                url,
                input.ChampionKey,
                roleId,
                cancellationToken).ConfigureAwait(false);
            if (SiteImportPayload.TryParse(raw, out var fetched, out var failure) &&
                fetched is not null && PayloadMatchesContext(fetched, input))
            {
                LogPayloadNotes(CompanionTab.Coachless, fetched);
                return (fetched, clock.ElapsedMilliseconds);
            }
            else if (fetched is not null)
            {
                _sink.LogInfo(
                    $"runes: Coachless yielded \"{fetched.ChampionSlug}\", not the selected champion -- ignored");
            }
            else
            {
                _sink.LogInfo($"runes: Coachless yielded no rune build ({failure})");
            }
            return (null, clock.ElapsedMilliseconds);
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception error)
        {
            _sink.LogInfo($"runes: Coachless fetch failed ({error.Message})");
            return (null, clock.ElapsedMilliseconds);
        }
    }

    /// <summary>
    /// A Coachless-only run still imports BOTH rune pages. Fetches the u.gg
    /// build in a worker when the loop did not already read it — the old
    /// leg, unchanged.
    /// </summary>
    private async Task<(SiteImportPayload? Payload, int? EffectiveRoleId, long ElapsedMs)> FetchUggRunesLegAsync(
        AutoImportInput input,
        SiteImportPayload? uggPayload,
        int? effectiveRoleId,
        CancellationToken cancellationToken)
    {
        var clock = Stopwatch.StartNew();
        if (uggPayload?.Runes is null &&
            SiteDeepLink.Build(CompanionTab.UGg, input.ChampionKey, effectiveRoleId) is { } uggUrl)
        {
            _fetchedThisRun = true;
            try
            {
                var raw = await _executor.FetchViaWorkerAsync(
                    CompanionTab.UGg,
                    uggUrl,
                    input.ChampionKey,
                    effectiveRoleId,
                    cancellationToken).ConfigureAwait(false);
                if (SiteImportPayload.TryParse(raw, out var fetched, out var failure) &&
                    fetched is not null && PayloadMatchesContext(fetched, input))
                {
                    uggPayload = fetched;
                    if (effectiveRoleId is null)
                        effectiveRoleId = SiteDeepLink.RoleIdFromToken(fetched.Role);
                    LogPayloadNotes(CompanionTab.UGg, fetched);
                }
                else if (fetched is not null)
                {
                    _sink.LogInfo(
                        $"runes: u.gg yielded \"{fetched.ChampionSlug}\", not the selected champion -- ignored");
                }
                else
                {
                    _sink.LogInfo($"runes: u.gg yielded no rune build ({failure})");
                }
            }
            catch (OperationCanceledException)
            {
                throw;
            }
            catch (Exception error)
            {
                _sink.LogInfo($"runes: u.gg fetch failed ({error.Message})");
            }
        }
        return (uggPayload, effectiveRoleId, clock.ElapsedMilliseconds);
    }

    /// <summary>
    /// Builds one half's rune request, or logs the dropped half. A DROPPED
    /// HALF IS A LOG LINE, NOT A SILENCE (2.2.2). Field log 2026-09-09
    /// 13:11, Viktor: the u.gg fetch succeeded and was never mentioned
    /// again — no "wrote u.gg Viktor", no "yielded no rune build", nothing.
    /// A payload that arrives and then fails to become a request left no
    /// trace at all, so a one-page champ select was indistinguishable from a
    /// two-page one that got pruned.
    /// </summary>
    private void AddRuneRequest(
        CompanionTab site,
        SiteImportPayload? payload,
        AutoImportInput input,
        string? assignedRole,
        List<ApplyRunesRequest> requests)
    {
        if (payload is null) return;
        if (TryBuildRuneRequest(payload, input.ChampionName!, assignedRole, out var request))
        {
            requests.Add(request);
            return;
        }
        LogDroppedRuneHalf(site, payload);
    }

    private void LogDroppedRuneHalf(CompanionTab site, SiteImportPayload payload) =>
        _sink.LogInfo(
            $"runes: {CompanionTabs.LabelFor(site)} yielded a page but no rune build to write " +
            $"({SiteImportValidator.ValidateRunes(payload.Runes) ?? "the request failed payload validation"})");

    /// <summary>
    /// Applies one rune batch and logs it. Returns whether the capacity line
    /// has now been logged for this run, so the staged second batch never
    /// repeats it. Every guarantee of the old paired write holds per batch:
    /// foreign pages untouched, the sibling pair never pruned, unchanged
    /// pages cost no PUT.
    /// </summary>
    private async Task<bool> ApplyRuneBatchAsync(
        IReadOnlyList<ApplyRunesRequest> requests,
        HashSet<string> reported,
        bool capacityLogged,
        CancellationToken cancellationToken)
    {
        if (_runes is null) return capacityLogged;
        try
        {
            var result = await _runes.ApplyOwnedPagesAsync(requests, cancellationToken).ConfigureAwait(false);
            LogRuneBatch(result, reported, ref capacityLogged);
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception error)
        {
            _sink.LogInfo($"runes: automatic page write failed ({error.Message})");
        }
        return capacityLogged;
    }

    private void LogRuneBatch(
        AutoRunePagesResult result,
        HashSet<string> reported,
        ref bool capacityLogged)
    {
        foreach (var page in result.Pages)
        {
            if (page.Result is ApplyRunesSuccess success)
            {
                // Each page is said once per run: the staged second batch
                // re-reports the u.gg half (Unchanged, no PUT) and stays
                // silent about it — no second "u.gg X already matches"
                // after stage 1 already said "wrote u.gg X".
                if (!reported.Add(page.Name))
                    continue;
                var line = success.Unchanged == true
                    ? $"runes: {page.Name} already matches"
                    : $"runes: wrote {page.Name}";
                _sink.LogInfo(line);
                _sink.StatusNote(line);
            }
            else if (page.Result is ApplyRunesFailure failure && failure.Reason != "slots-full")
            {
                _sink.LogInfo($"runes: {page.Name} was not written ({failure.Hint ?? failure.Reason})");
            }
        }
        if (capacityLogged) return;
        if (result.OnlyOneEditableSlot &&
            result.Pages.FirstOrDefault()?.Result.Ok == true)
        {
            const string limited = "runes: only one editable page slot -- wrote u.gg only";
            _sink.LogInfo(limited);
            _sink.StatusNote(limited);
            capacityLogged = true;
        }
        else if (result.Pages.Count > 0 && result.Pages.All(page =>
                     page.Result is ApplyRunesFailure { Reason: "slots-full" }))
        {
            const string full = "runes: no editable page slots -- wrote no rune pages";
            _sink.LogInfo(full);
            _sink.StatusNote(full);
            capacityLogged = true;
        }
    }

    private static bool TryBuildRuneRequest(
        SiteImportPayload? payload,
        string championName,
        string? assignedRole,
        out ApplyRunesRequest request)
    {
        request = null!;
        if (payload?.Runes is null || SiteImportValidator.ValidateRunes(payload.Runes) is not null)
            return false;
        var title = SiteImportValidator.RunePageTitle(championName, assignedRole, payload.Source);
        request = SiteImportValidator.BuildAutoRuneRequest(title, payload.Runes);
        return ApplyPayloadValidation.TryValidateRunes(request, out _);
    }

    /// <summary>
    /// Logs the payload's own <c>meta.notes</c>, one line each, tagged with the
    /// site. Log only — never the status line: these are diagnostics for the
    /// next field pass, and a slot the page could not fill is not something to
    /// interrupt the user about.
    /// </summary>
    private void LogPayloadNotes(CompanionTab site, SiteImportPayload payload)
    {
        if (payload.Notes.Count == 0) return;
        var label = CompanionTabs.LabelFor(site);
        foreach (var note in payload.Notes)
        {
            _sink.LogInfo($"auto-import: {label} {note}");
        }
    }

    private async Task<string?> FetchTargetAsync(AutoImportSiteTarget target, CancellationToken cancellationToken)
    {
        _fetchedThisRun = true;
        try
        {
            return target.ExtractInPlace
                ? await _executor.ExtractVisibleAsync(target.Site, cancellationToken).ConfigureAwait(false)
                : await _executor.FetchViaWorkerAsync(
                    target.Site, target.Url, target.ChampionKey, target.RoleId, cancellationToken)
                    .ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            // Champ-select-end cancellation, not a fetch failure: it must
            // reach OnSnapshotAsync (which rolls the debounce back), never
            // the quiet-miss path below.
            throw;
        }
        catch (Exception error)
        {
            _sink.LogInfo($"auto-import: {CompanionTabs.LabelFor(target.Site)} fetch failed ({error.Message})");
            return null;
        }
    }

    /// <summary>
    /// Same champion by id when the folds disagree: the roster resolves both
    /// the context key and the page/payload slug (key AND name columns), so
    /// coachless's <c>wukong</c> redirect still meets the <c>MonkeyKing</c>
    /// context. Roster cache only — an unloaded roster refuses rather than
    /// guesses (the context itself requires a roster, so this is defensive).
    /// </summary>
    private bool PayloadMatchesContext(SiteImportPayload payload, AutoImportInput input)
    {
        if (AutoImportCoordinator.SlugsMatch(payload.ChampionSlug, input.ChampionKey))
            return true;
        var roster = _champions.Cached;
        if (roster is null) return false;
        var (id, _) = ChampionIdLookup.Resolve(roster, payload.ChampionSlug, null);
        return id == input.ChampionId;
    }

    private Task<AutoImportSiteTarget?> AliasVisibleCandidateAsync(
        AutoImportInput input,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (!input.LcuConnected || input.ChampionId is not > 0 ||
            string.IsNullOrWhiteSpace(input.ChampionKey) ||
            input.VisibleTab is not (CompanionTab.UGg or CompanionTab.Coachless) ||
            string.IsNullOrWhiteSpace(input.VisibleUrl) ||
            !SiteImportExtractors.CanImportFromUrl(input.VisibleTab, input.VisibleUrl) ||
            AutoImportCoordinator.SlugMatchesContext(input.VisibleTab, input.VisibleUrl, input.ChampionKey))
            return Task.FromResult<AutoImportSiteTarget?>(null);

        var freshKey = _state.ChampionId != input.ChampionId || _state.RoleId != input.RoleId;
        if (!freshKey &&
            _state.DoneUrls.TryGetValue(input.VisibleTab, out var seen) &&
            string.Equals(seen, input.VisibleUrl, StringComparison.Ordinal))
            return Task.FromResult<AutoImportSiteTarget?>(null);

        var roster = _champions.Cached;
        if (roster is null) return Task.FromResult<AutoImportSiteTarget?>(null);
        var slug = AutoImportCoordinator.SlugFromBuildUrl(input.VisibleTab, input.VisibleUrl);
        if (string.IsNullOrEmpty(slug)) return Task.FromResult<AutoImportSiteTarget?>(null);
        var (id, _) = ChampionIdLookup.Resolve(roster, slug, null);
        if (id != input.ChampionId) return Task.FromResult<AutoImportSiteTarget?>(null);

        return Task.FromResult<AutoImportSiteTarget?>(new AutoImportSiteTarget(
            input.VisibleTab,
            new Uri(input.VisibleUrl),
            ExtractInPlace: true,
            input.ChampionKey,
            input.RoleId));
    }

    private void NoteSkipOnce(string? reason)
    {
        if (string.IsNullOrWhiteSpace(reason))
        {
            _lastSkipNote = null;
            return;
        }
        // The startup race, not a state: say nothing until LCU discovery has
        // had a full cycle to fail. Deliberately returns WITHOUT recording the
        // note, so the line still arrives exactly once if the client really is
        // absent.
        if (string.Equals(reason, AutoImportCoordinator.DisconnectedSkipReason, StringComparison.Ordinal)
            && _disconnectedEvaluations < DisconnectedNoteAfterEvaluations)
            return;
        if (string.Equals(_lastSkipNote, reason, StringComparison.Ordinal)) return;
        _lastSkipNote = reason;
        _sink.LogInfo($"auto-import: {reason}");
    }
}
