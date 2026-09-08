using CoachBuild.Core;

namespace CoachBuild.Desktop.Web;

/// <summary>
/// What the automatic item import knows on one evaluation: the champ-select
/// context (if any), which tab the user is viewing and its URL, and whether
/// the client is connected. Built on the UI thread from the same 750 ms
/// snapshot tick that feeds the offer bar -- no new poll. (1.3.0.)
/// </summary>
public sealed record AutoImportInput(
    int? ChampionId,
    string? ChampionKey,
    string? ChampionName,
    int? RoleId,
    bool Locked,
    CompanionTab VisibleTab,
    string? VisibleUrl,
    bool LcuConnected)
{
    public static AutoImportInput FromContext(
        ChampSelectContext? context,
        CompanionTab visibleTab,
        string? visibleUrl,
        bool lcuConnected) =>
        context is null
            ? new AutoImportInput(null, null, null, null, false, visibleTab, visibleUrl, lcuConnected)
            : new AutoImportInput(
                context.ChampionId, context.ChampionKey, context.ChampionName,
                context.RoleId, context.Locked, visibleTab, visibleUrl, lcuConnected);
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
    string? SkipReason);

/// <summary>
/// The pure decision half of the automatic item import: no clock, no
/// browser, no LCU, no I/O. The window feeds it one <see cref="AutoImportInput"/>
/// per snapshot tick and executes the returned targets (see
/// <see cref="SiteAutoImportService"/>); every transition is unit-tested
/// with scripted inputs.
///
/// <para>TRIGGERS, each debounced. (1) Champ-select lock: both sites, once
/// per champion+role until it changes. (2) The visible site page: that site,
/// when its URL is a recognized build page for the context champion and
/// differs from the URL last attempted (e.g. the user changed the rank
/// filter — the re-run imports the page as shown, not the deep link).
/// </para>
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

    public static AutoImportFetch Evaluate(AutoImportState state, AutoImportInput input)
    {
        ArgumentNullException.ThrowIfNull(state);
        ArgumentNullException.ThrowIfNull(input);
        if (!input.LcuConnected)
            return new AutoImportFetch([], "League client not connected -- auto-import standing by");
        if (input.ChampionId is not > 0 || string.IsNullOrWhiteSpace(input.ChampionKey))
            return new AutoImportFetch([], null);

        var keyChanged = state.ChampionId != input.ChampionId || state.RoleId != input.RoleId;
        var fetch = new List<AutoImportSiteTarget>();

        // Trigger 1 — the lock: both sites at the deep links, once per key.
        if (input.Locked && keyChanged)
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

        return new AutoImportFetch(fetch, null);
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
/// <para>THREADING: evaluated and advanced only inside the single flight.
/// The window calls <see cref="OnSnapshotAsync"/> from the dispatcher on
/// every 750 ms tick and never awaits it; overlapping ticks return
/// immediately and the next tick after completion re-evaluates, so a dropped
/// tick delays a trigger past the run but never loses it. LCU writes
/// serialize through the item-set service's own write lease, and the offer
/// bar's runes button touches only the rune endpoints — the runes/items
/// split is also the concurrency split, so the two paths share no
/// read-modify-write.</para>
///
/// <para>Contract: never throws (a background import must not break the
/// snapshot tick); LCU absent means skip quietly with a log-once line;
/// extraction failure means a quiet log plus a status-line note; runes are
/// never written by this path (items-only batch).</para>
/// </summary>
public sealed class SiteAutoImportService
{
    private readonly ISiteAutoImportExecutor _executor;
    private readonly ItemSetApplyService _items;
    private readonly IChampionDirectory _champions;
    private readonly ISiteAutoImportSink _sink;
    private AutoImportState _state = AutoImportState.Initial;
    private int _active;
    private string? _lastSkipNote;

    public SiteAutoImportService(
        ISiteAutoImportExecutor executor,
        ItemSetApplyService items,
        IChampionDirectory champions,
        ISiteAutoImportSink sink)
    {
        _executor = executor ?? throw new ArgumentNullException(nameof(executor));
        _items = items ?? throw new ArgumentNullException(nameof(items));
        _champions = champions ?? throw new ArgumentNullException(nameof(champions));
        _sink = sink ?? throw new ArgumentNullException(nameof(sink));
    }

    /// <summary>The committed debounce state, for tests.</summary>
    internal AutoImportState State => _state;

    public async Task OnSnapshotAsync(AutoImportInput input, CancellationToken cancellationToken = default)
    {
        if (input is null) return;
        if (Interlocked.CompareExchange(ref _active, 1, 0) == 1) return;
        try
        {
            await RunAsync(input, cancellationToken).ConfigureAwait(false);
        }
        catch (Exception error)
        {
            _sink.LogInfo($"auto-import: unexpected failure ({error.Message})");
        }
        finally
        {
            Interlocked.Exchange(ref _active, 0);
        }
    }

    private async Task RunAsync(AutoImportInput input, CancellationToken cancellationToken)
    {
        var evaluation = AutoImportCoordinator.Evaluate(_state, input);
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
                return;
        }
        _lastSkipNote = null;

        if (input.ChampionId is not > 0 || string.IsNullOrWhiteSpace(input.ChampionName))
            return;

        var outcomes = new List<AutoImportOutcome>();
        var fresh = new List<SiteImportPayload>();
        foreach (var target in fetch)
        {
            var raw = await FetchTargetAsync(target, cancellationToken).ConfigureAwait(false);
            if (!SiteImportPayload.TryParse(raw, out var payload, out var failure) || payload is null)
            {
                var label = CompanionTabs.LabelFor(target.Site);
                _sink.LogInfo($"auto-import: {label} extraction failed ({failure})");
                _sink.StatusNote($"Auto-import from {label} failed ({failure})");
                outcomes.Add(new AutoImportOutcome(target.Site, target.Url.ToString(), null));
                continue;
            }
            if (!PayloadMatchesContext(payload, input))
            {
                _sink.LogInfo(
                    $"auto-import: {CompanionTabs.LabelFor(target.Site)} yielded \"{payload.ChampionSlug}\", " +
                    $"not the selected champion -- ignored");
                outcomes.Add(new AutoImportOutcome(target.Site, target.Url.ToString(), null));
                continue;
            }
            if (payload.ItemBlocks.Count == 0)
            {
                _sink.LogInfo(
                    $"auto-import: {CompanionTabs.LabelFor(target.Site)} yielded no item build -- ignored");
                outcomes.Add(new AutoImportOutcome(target.Site, target.Url.ToString(), null));
                continue;
            }
            fresh.Add(payload);
            outcomes.Add(new AutoImportOutcome(target.Site, target.Url.ToString(), payload));
        }

        var batch = AutoImportCoordinator.BuildWriteBatch(
            fresh, _state.CachedSets, input.ChampionId.Value, input.ChampionName);
        if (batch.Count > 0)
        {
            // A write that THROWS (rather than returning a typed failure)
            // still commits its outcomes below: without that, the debounce
            // never advances and every 750 ms tick re-fetches both pages in
            // a hot loop behind one flapping LCU call.
            IReadOnlyList<SiteImportResult> results = [];
            try
            {
                results = await SiteImportApplier.ApplyItemsBatchAsync(
                    batch, _items, cancellationToken).ConfigureAwait(false);
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
        else
        {
            _sink.LogInfo("auto-import: nothing writable from this run -- nothing was imported");
        }

        _state = AutoImportCoordinator.RecordCompleted(
            _state, input.ChampionId.Value, input.RoleId, input.ChampionName, outcomes);
    }

    private async Task<string?> FetchTargetAsync(AutoImportSiteTarget target, CancellationToken cancellationToken)
    {
        try
        {
            return target.ExtractInPlace
                ? await _executor.ExtractVisibleAsync(target.Site, cancellationToken).ConfigureAwait(false)
                : await _executor.FetchViaWorkerAsync(
                    target.Site, target.Url, target.ChampionKey, target.RoleId, cancellationToken)
                    .ConfigureAwait(false);
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
        if (string.Equals(_lastSkipNote, reason, StringComparison.Ordinal)) return;
        _lastSkipNote = reason;
        _sink.LogInfo($"auto-import: {reason}");
    }
}
