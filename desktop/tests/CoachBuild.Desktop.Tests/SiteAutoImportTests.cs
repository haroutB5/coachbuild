using System.Net.Http;
using System.Text.Json;
using CoachBuild.Core;
using CoachBuild.Desktop.Web;
using Xunit;

namespace CoachBuild.Desktop.Tests;

/// <summary>
/// The automatic item import: the coordinator's debounce/trigger matrix
/// (pure), the service orchestration against fakes (single-flight, executor
/// routing, items-only batched writes), and automatic dual rune-page writes.
/// Browser behavior itself (loads, clicks, focus) is NOT assertable here --
/// the orchestrator live-verifies it -- but every DECISION the browser code
/// must honor is pinned: which site, which URL, in-place vs worker, and the
/// exact allowlist worker navigation must satisfy.
/// </summary>
public sealed class SiteAutoImportTests
{
    private sealed class FakeExecutor : ISiteAutoImportExecutor
    {
        public Func<CompanionTab, string?>? Visible { get; set; }

        public Func<CompanionTab, Uri, string?>? Worker { get; set; }

        public List<string> Calls { get; } = [];

        public Task<string?> ExtractVisibleAsync(CompanionTab site, CancellationToken cancellationToken = default)
        {
            Calls.Add($"visible:{site}");
            return Task.FromResult(Visible?.Invoke(site));
        }

        public Func<Uri, string?>? Runes { get; set; }

        public int ReleaseCount { get; private set; }

        public Task<string?> FetchViaWorkerAsync(
            CompanionTab site, Uri url, string? championKey, int? roleId,
            CancellationToken cancellationToken = default)
        {
            Calls.Add($"worker:{site}:{url}");
            return Task.FromResult(Worker?.Invoke(site, url));
        }

        public Task<string?> FetchCoachlessRunesAsync(
            Uri url, string? championKey, int? roleId,
            CancellationToken cancellationToken = default)
        {
            Calls.Add($"runes:{url}");
            return Task.FromResult(Runes?.Invoke(url));
        }

        // Counted, NOT appended to Calls: Calls is the fetch sequence every
        // other test asserts exactly, and a teardown is not a fetch.
        public void ReleaseImportWorkers() => ReleaseCount++;
    }

    private sealed class FakeSink : ISiteAutoImportSink
    {
        public List<string> Logs { get; } = [];

        public List<string> Statuses { get; } = [];

        public void LogInfo(string line) => Logs.Add(line);

        public void StatusNote(string message) => Statuses.Add(message);
    }

    private sealed class StubLcu : ILcuApi
    {
        public List<(HttpMethod Method, string Path, object? Body)> Calls { get; } = [];

        public bool ThrowOnPut { get; set; }

        /// <summary>
        /// The <c>/lol-perks/v1/pages</c> answer. Empty by default (the
        /// create path); a test pins the already-selected page here to drive
        /// the already-current wording. The current-page answer stays id
        /// 9001, so that test's page carries id 9001.
        /// </summary>
        public string PagesJson { get; set; } = "[]";

        public Task<LcuResponse> SendAsync(
            HttpMethod method, string path, object? body = null,
            CancellationToken cancellationToken = default)
        {
            Calls.Add((method, path, body));
            if (ThrowOnPut && method == HttpMethod.Put)
                throw new HttpRequestException("connection reset");
            if (method == HttpMethod.Get && path == "/lol-summoner/v1/current-summoner")
                return Task.FromResult(Ok("{\"summonerId\":77}"));
            if (method == HttpMethod.Get && path == "/lol-item-sets/v1/item-sets/77/sets")
                return Task.FromResult(Ok("{\"accountId\":77,\"timestamp\":1,\"itemSets\":[]}"));
            if (method == HttpMethod.Put && path == "/lol-item-sets/v1/item-sets/77/sets")
                return Task.FromResult(Ok("{}"));
            // Rune endpoints, for the 2.1.0 Coachless runes leg. An empty
            // page list plus room in the inventory is the create path.
            if (method == HttpMethod.Get && path == "/lol-perks/v1/pages")
                return Task.FromResult(Ok(PagesJson));
            if (method == HttpMethod.Get && path == "/lol-perks/v1/inventory")
                return Task.FromResult(Ok("{\"ownedPageCount\":5,\"canAddCustomPage\":true}"));
            if (method == HttpMethod.Post && path == "/lol-perks/v1/pages")
                return Task.FromResult(Ok("{\"id\":9001,\"isDeletable\":true}"));
            if (path.StartsWith("/lol-perks/v1/currentpage", StringComparison.Ordinal))
                return Task.FromResult(Ok("{\"id\":9001}"));
            return Task.FromResult(new LcuResponse(false, 404));
        }

        private static LcuResponse Ok(string raw)
        {
            using var document = JsonDocument.Parse(raw);
            return new LcuResponse(true, 200, document.RootElement.Clone(), raw);
        }
    }

    private const string AhriUggJson = """
        {"source":"u.gg","championSlug":"ahri","role":"mid","runes":null,
         "itemBlocks":[{"title":"Core","itemIds":[3157,3089]}]}
        """;

    private const string AhriUggRefreshedJson = """
        {"source":"u.gg","championSlug":"ahri","role":"mid","runes":null,
         "itemBlocks":[{"title":"Core","itemIds":[6653]}]}
        """;

    private const string AhriCoachlessJson = """
        {"source":"coachless","championSlug":"ahri","role":"mid","runes":null,
         "itemBlocks":[{"title":"Starter","itemIds":[1056]}]}
        """;

    private const string JhinUggJson = """
        {"source":"u.gg","championSlug":"jhin","role":"adc","runes":null,
         "itemBlocks":[{"title":"Core","itemIds":[3031]}]}
        """;

    private const string WukongCoachlessJson = """
        {"source":"coachless","championSlug":"wukong","role":"jungle","runes":null,
         "itemBlocks":[{"title":"Starter","itemIds":[1055]}]}
        """;

    private static SiteImportPayload Parse(string json)
    {
        Assert.True(SiteImportPayload.TryParse(json, out var payload, out var failure), failure);
        return payload!;
    }

    /// <summary>
    /// The scripted clock's zero. Every input stamps a time relative to this,
    /// so the hover settle is exercised with no real clock anywhere in the
    /// suite (the service never reads one either -- the window supplies it).
    /// </summary>
    private static readonly DateTimeOffset T0 = new(2026, 9, 9, 12, 18, 30, TimeSpan.Zero);

    private static AutoImportInput LockedAhri(
        CompanionTab visible = CompanionTab.Companion,
        string? url = null,
        bool lcu = true,
        double atSeconds = 0) =>
        new(103, "Ahri", "Ahri", 2, true, visible, url, lcu, T0.AddSeconds(atSeconds));

    /// <summary>Ahri HOVERED (pick intent, not locked) at <paramref name="atSeconds"/>.</summary>
    private static AutoImportInput HoveredAhri(
        double atSeconds = 0,
        CompanionTab visible = CompanionTab.Companion,
        string? url = null) =>
        LockedAhri(visible, url, atSeconds: atSeconds) with { Locked = false };

    private static readonly Uri AhriUggDeepLink = new("https://u.gg/lol/champions/ahri/build/mid");
    private static readonly Uri AhriCoachlessDeepLink = new("https://coachless.gg/builds/ahri?role=mid");

    private static SiteAutoImportService NewService(
        FakeExecutor executor, StubLcu api, FakeSink sink,
        IChampionDirectory? champions = null,
        bool withRunes = false) =>
        new(executor,
            new ItemSetApplyService(api),
            champions ?? new FakeChampionDirectory(),
            sink,
            withRunes ? new RuneApplyService(api) : null);

    /// <summary>The Coachless runes page for Ahri mid, as the extractor emits it.</summary>
    private const string AhriCoachlessRunesJson = """
        {"source":"coachless","championSlug":"ahri","role":"mid",
         "runes":{"primaryStyleId":8200,"subStyleId":8000,
                  "perkIds":[8214,8226,8210,8237,9111,9105],
                  "shardIds":[5008,5008,5011]},
         "itemBlocks":[]}
        """;

    private const string AhriUggRunesJson = """
        {"source":"u.gg","championSlug":"ahri","role":"mid",
         "runes":{"primaryStyleId":8200,"subStyleId":8100,
                  "perkIds":[8214,8226,8210,8237,8139,8137],
                  "shardIds":[5008,5008,5001]},
         "itemBlocks":[{"title":"Core","itemIds":[3157,3089]}]}
        """;

    private static readonly Uri AhriCoachlessRunesLink =
        new("https://coachless.gg/runes/tree/ahri/precision/domination?role=mid");

    private static JsonElement PutSets(StubLcu api)
    {
        var put = Assert.Single(api.Calls, call =>
            call.Method == HttpMethod.Put && call.Path.Contains("item-sets", StringComparison.Ordinal));
        using var document = JsonDocument.Parse(JsonSerializer.Serialize(put.Body, JsonOptions.Wire));
        return document.RootElement.GetProperty("itemSets").Clone();
    }

    /// <summary>The sets carried by the LAST item-set PUT, for runs that flush more than once.</summary>
    private static JsonElement LastPutSets(StubLcu api)
    {
        var put = api.Calls.Last(call =>
            call.Method == HttpMethod.Put && call.Path.Contains("item-sets", StringComparison.Ordinal));
        using var document = JsonDocument.Parse(JsonSerializer.Serialize(put.Body, JsonOptions.Wire));
        return document.RootElement.GetProperty("itemSets").Clone();
    }

    // -- Coordinator: the lock trigger -------------------------------------

    [Fact]
    public void Lock_fires_both_sites_at_the_deep_links_through_workers()
    {
        // Control: the deep links this decision must produce.
        Assert.Equal(AhriUggDeepLink, SiteDeepLink.Build(CompanionTab.UGg, "Ahri", 2));
        Assert.Equal(AhriCoachlessDeepLink, SiteDeepLink.Build(CompanionTab.Coachless, "Ahri", 2));

        var evaluation = AutoImportCoordinator.Evaluate(AutoImportState.Initial, LockedAhri(), hover: null);

        Assert.Null(evaluation.SkipReason);
        Assert.Equal(2, evaluation.Fetch.Count);
        var ugg = Assert.Single(evaluation.Fetch, plan => plan.Site == CompanionTab.UGg);
        Assert.Equal(AhriUggDeepLink, ugg.Url);
        Assert.False(ugg.ExtractInPlace);
        var coachless = Assert.Single(evaluation.Fetch, plan => plan.Site == CompanionTab.Coachless);
        Assert.Equal(AhriCoachlessDeepLink, coachless.Url);
        Assert.False(coachless.ExtractInPlace);
    }

    [Fact]
    public void Lock_with_the_visible_tab_already_there_extracts_it_in_place()
    {
        // The never-touches-visible-tab rule, both directions: the tab the
        // user is already reading is read, not navigated; the other site
        // still goes through a worker.
        var uggVisible = AutoImportCoordinator.Evaluate(
            AutoImportState.Initial,
            LockedAhri(CompanionTab.UGg, "https://u.gg/lol/champions/ahri/build/mid"), hover: null);
        var ugg = Assert.Single(uggVisible.Fetch, plan => plan.Site == CompanionTab.UGg);
        Assert.True(ugg.ExtractInPlace);
        Assert.Equal("https://u.gg/lol/champions/ahri/build/mid", ugg.Url.ToString());
        Assert.False(Assert.Single(uggVisible.Fetch, plan => plan.Site == CompanionTab.Coachless).ExtractInPlace);

        var coachlessVisible = AutoImportCoordinator.Evaluate(
            AutoImportState.Initial,
            LockedAhri(CompanionTab.Coachless, "https://coachless.gg/builds/ahri?role=mid"), hover: null);
        Assert.True(Assert.Single(coachlessVisible.Fetch, plan => plan.Site == CompanionTab.Coachless).ExtractInPlace);
        Assert.False(Assert.Single(coachlessVisible.Fetch, plan => plan.Site == CompanionTab.UGg).ExtractInPlace);
    }

    [Fact]
    public void Lock_with_the_visible_tab_on_another_page_uses_workers_for_both()
    {
        // Reading Ahri mid while locking... here the user views Ahri TOP
        // while locking mid: neither tab is already-there, so both fetch
        // through workers and the visible page never moves.
        var evaluation = AutoImportCoordinator.Evaluate(
            AutoImportState.Initial,
            LockedAhri(CompanionTab.UGg, "https://u.gg/lol/champions/ahri/build/top"), hover: null);

        Assert.Equal(2, evaluation.Fetch.Count);
        Assert.All(evaluation.Fetch, plan => Assert.False(plan.ExtractInPlace));
        Assert.Equal(
            AhriUggDeepLink,
            Assert.Single(evaluation.Fetch, plan => plan.Site == CompanionTab.UGg).Url);
    }

    [Fact]
    public void Completed_lock_stays_quiet_until_something_changes()
    {
        var state = AutoImportState.Initial;
        var first = AutoImportCoordinator.Evaluate(state, LockedAhri(), hover: null);
        Assert.Equal(2, first.Fetch.Count);

        state = AutoImportCoordinator.RecordCompleted(
            state, 103, 2, "Ahri",
            first.Fetch.Select(plan => new AutoImportOutcome(plan.Site, plan.Url.ToString(), null)).ToList());

        var second = AutoImportCoordinator.Evaluate(state, LockedAhri(), hover: null);
        Assert.Empty(second.Fetch);
        Assert.Null(second.SkipReason);
    }

    [Theory]
    [InlineData(64, 2)] // another champion (Lee Sin)
    [InlineData(103, 0)] // same champion, another role (Ahri top)
    [InlineData(103, null)] // same champion, role unknown
    public void New_champion_or_role_rearms_both_sites(int championId, int? roleId)
    {
        var key = championId == 103 ? "Ahri" : "LeeSin";
        var name = championId == 103 ? "Ahri" : "Lee Sin";
        var state = AutoImportCoordinator.RecordCompleted(
            AutoImportState.Initial, 103, 2, "Ahri",
            [new AutoImportOutcome(CompanionTab.UGg, AhriUggDeepLink.ToString(), null)]);

        var evaluation = AutoImportCoordinator.Evaluate(
            state,
            new AutoImportInput(championId, key, name, roleId, true, CompanionTab.Companion, null, true, T0),
            hover: null);

        Assert.Equal(2, evaluation.Fetch.Count);
    }

    // -- Coordinator: the hover (pick-intent) trigger ------------------------
    //
    // The field bug of 2026-09-09: a whole champ select with a hovered Viktor
    // and ZERO auto-import lines, because only a lock could arm the deep-link
    // fetch. The five rows below are the trigger truth table that replaces it.

    [Fact]
    public void Hover_with_no_observation_yet_fires_nothing()
    {
        // The first tick of a hover: TrackHover has only just stamped it, so
        // nothing has settled and nothing may fetch.
        var hovering = HoveredAhri();
        var hover = AutoImportCoordinator.TrackHover(null, hovering);

        var evaluation = AutoImportCoordinator.Evaluate(AutoImportState.Initial, hovering, hover);

        Assert.Empty(evaluation.Fetch);
        Assert.Equal(AutoImportTrigger.None, evaluation.Trigger);
    }

    [Fact]
    public void Hover_still_inside_the_settle_fires_nothing()
    {
        var hover = AutoImportCoordinator.TrackHover(null, HoveredAhri(0));
        var justShort = HoveredAhri(AutoImportCoordinator.HoverSettle.TotalSeconds - 0.1);

        var evaluation = AutoImportCoordinator.Evaluate(AutoImportState.Initial, justShort, hover);

        Assert.Empty(evaluation.Fetch);
    }

    [Fact]
    public void Hover_held_past_the_settle_fires_both_sites_before_any_lock()
    {
        var hover = AutoImportCoordinator.TrackHover(null, HoveredAhri(0));
        var settled = HoveredAhri(AutoImportCoordinator.HoverSettle.TotalSeconds);

        var evaluation = AutoImportCoordinator.Evaluate(AutoImportState.Initial, settled, hover);

        Assert.Equal(AutoImportTrigger.Hover, evaluation.Trigger);
        Assert.Equal(2, evaluation.Fetch.Count);
        Assert.Equal(
            AhriUggDeepLink,
            Assert.Single(evaluation.Fetch, plan => plan.Site == CompanionTab.UGg).Url);
        Assert.Equal(
            AhriCoachlessDeepLink,
            Assert.Single(evaluation.Fetch, plan => plan.Site == CompanionTab.Coachless).Url);
    }

    [Fact]
    public void Scrolling_the_picker_restamps_the_settle_instead_of_accruing_it()
    {
        // Ahri, then Lee Sin, then Ahri again, one tick apart. Nothing may
        // fire: each change restarts the settle, which is the whole reason
        // the hover trigger is safe to have at all.
        var hover = AutoImportCoordinator.TrackHover(null, HoveredAhri(0));
        var lee = new AutoImportInput(
            64, "LeeSin", "Lee Sin", 2, false, CompanionTab.Companion, null, true, T0.AddSeconds(0.8));
        hover = AutoImportCoordinator.TrackHover(hover, lee);
        Assert.Equal(64, hover!.ChampionId);
        Assert.Equal(T0.AddSeconds(0.8), hover.FirstSeenAt);

        var backToAhri = HoveredAhri(1.6);
        hover = AutoImportCoordinator.TrackHover(hover, backToAhri);
        Assert.Equal(T0.AddSeconds(1.6), hover!.FirstSeenAt);

        Assert.Empty(AutoImportCoordinator.Evaluate(AutoImportState.Initial, backToAhri, hover).Fetch);
        // Holding it from there does settle, on the LATEST stamp.
        Assert.Equal(
            AutoImportTrigger.Hover,
            AutoImportCoordinator.Evaluate(
                AutoImportState.Initial,
                backToAhri with { ObservedAt = hover.FirstSeenAt + AutoImportCoordinator.HoverSettle },
                hover).Trigger);
    }

    [Fact]
    public void A_hover_that_holds_still_keeps_its_first_stamp()
    {
        var first = AutoImportCoordinator.TrackHover(null, HoveredAhri(0));
        var later = AutoImportCoordinator.TrackHover(first, HoveredAhri(2));
        Assert.Same(first, later);
        Assert.Equal(T0, later!.FirstSeenAt);
    }

    [Fact]
    public void A_lock_or_a_lost_client_drops_the_hover_observation()
    {
        var hover = AutoImportCoordinator.TrackHover(null, HoveredAhri(0));
        Assert.NotNull(hover);
        Assert.Null(AutoImportCoordinator.TrackHover(hover, LockedAhri(atSeconds: 1)));
        Assert.Null(AutoImportCoordinator.TrackHover(hover, HoveredAhri(1) with { LcuConnected = false }));
        Assert.Null(AutoImportCoordinator.TrackHover(hover, HoveredAhri(1) with { ChampionId = null }));
    }

    [Fact]
    public void A_lock_on_a_different_champion_fires_immediately_with_no_settle()
    {
        // Requirement 3: a lock is a decision already made, and the game
        // starts seconds later -- there is nothing to settle.
        var state = AutoImportCoordinator.RecordCompleted(
            AutoImportState.Initial, 64, 2, "Lee Sin",
            [new AutoImportOutcome(CompanionTab.UGg, "https://u.gg/lol/champions/leesin/build/mid", null)]);

        var evaluation = AutoImportCoordinator.Evaluate(state, LockedAhri(), hover: null);

        Assert.Equal(AutoImportTrigger.Lock, evaluation.Trigger);
        Assert.Equal(2, evaluation.Fetch.Count);
    }

    [Fact]
    public void A_lock_on_the_champion_already_imported_from_its_hover_re_imports_nothing()
    {
        // Requirement 4: the (champion, role) debounce is what makes the new
        // trigger free -- the lock that follows a settled hover is the SAME
        // key, so it costs nothing.
        var hover = AutoImportCoordinator.TrackHover(null, HoveredAhri(0));
        var settled = HoveredAhri(AutoImportCoordinator.HoverSettle.TotalSeconds);
        var fromHover = AutoImportCoordinator.Evaluate(AutoImportState.Initial, settled, hover);
        Assert.Equal(2, fromHover.Fetch.Count);

        var state = AutoImportCoordinator.RecordCompleted(
            AutoImportState.Initial, 103, 2, "Ahri",
            fromHover.Fetch.Select(plan => new AutoImportOutcome(plan.Site, plan.Url.ToString(), null)).ToList());

        var afterLock = AutoImportCoordinator.Evaluate(state, LockedAhri(atSeconds: 6), hover: null);

        Assert.Empty(afterLock.Fetch);
        Assert.Equal(AutoImportTrigger.None, afterLock.Trigger);
    }

    [Fact]
    public void Re_hovering_a_different_champion_after_an_import_fires_again_once_settled()
    {
        // Row 5: the user changes their mind mid-select. The key changed, so
        // the new champion's pages are fetched -- after its own settle.
        var state = AutoImportCoordinator.RecordCompleted(
            AutoImportState.Initial, 103, 2, "Ahri",
            [new AutoImportOutcome(CompanionTab.UGg, AhriUggDeepLink.ToString(), null)]);
        var lee = new AutoImportInput(
            64, "LeeSin", "Lee Sin", 2, false, CompanionTab.Companion, null, true, T0.AddSeconds(10));
        var hover = AutoImportCoordinator.TrackHover(null, lee);

        Assert.Empty(AutoImportCoordinator.Evaluate(state, lee, hover).Fetch);

        var settled = lee with { ObservedAt = T0.AddSeconds(10) + AutoImportCoordinator.HoverSettle };
        var evaluation = AutoImportCoordinator.Evaluate(state, settled, hover);

        Assert.Equal(AutoImportTrigger.Hover, evaluation.Trigger);
        Assert.Equal(2, evaluation.Fetch.Count);
        Assert.Equal(
            SiteDeepLink.Build(CompanionTab.UGg, "LeeSin", 2),
            Assert.Single(evaluation.Fetch, plan => plan.Site == CompanionTab.UGg).Url);
    }

    [Fact]
    public void A_stale_hover_observation_cannot_settle_a_different_champion()
    {
        // Defensive: a caller that skipped a tick must not hand in Ahri's
        // long-held observation and have it license Lee Sin's pages.
        var ahriHover = AutoImportCoordinator.TrackHover(null, HoveredAhri(0));
        var lee = new AutoImportInput(
            64, "LeeSin", "Lee Sin", 2, false, CompanionTab.Companion, null, true, T0.AddSeconds(30));

        Assert.False(AutoImportCoordinator.IsHoverSettled(ahriHover, lee));
        Assert.Empty(AutoImportCoordinator.Evaluate(AutoImportState.Initial, lee, ahriHover).Fetch);
    }

    // -- Coordinator: the visible-page trigger ------------------------------

    [Fact]
    public void Visible_build_page_with_a_new_url_refires_only_that_site_in_place()
    {
        // The rank-filter case: same champion+role, the u.gg URL changed, so
        // u.gg re-imports THE VISIBLE PAGE (target is the visible URL, not
        // the deep link) while Coachless stays quiet.
        var state = AutoImportCoordinator.RecordCompleted(
            AutoImportState.Initial, 103, 2, "Ahri",
            [
                new AutoImportOutcome(CompanionTab.UGg, AhriUggDeepLink.ToString(), Parse(AhriUggJson)),
                new AutoImportOutcome(CompanionTab.Coachless, AhriCoachlessDeepLink.ToString(), Parse(AhriCoachlessJson)),
            ]);
        const string filtered = "https://u.gg/lol/champions/ahri/build/mid?rank=emerald_plus";

        var evaluation = AutoImportCoordinator.Evaluate(
            state, LockedAhri(CompanionTab.UGg, filtered), hover: null);

        var only = Assert.Single(evaluation.Fetch);
        Assert.Equal(CompanionTab.UGg, only.Site);
        Assert.Equal(filtered, only.Url.ToString());
        Assert.True(only.ExtractInPlace);
    }

    [Fact]
    public void Visible_page_for_another_champion_is_ignored()
    {
        var state = AutoImportCoordinator.RecordCompleted(
            AutoImportState.Initial, 103, 2, "Ahri",
            [new AutoImportOutcome(CompanionTab.UGg, AhriUggDeepLink.ToString(), null)]);

        var evaluation = AutoImportCoordinator.Evaluate(
            state, LockedAhri(CompanionTab.UGg, "https://u.gg/lol/champions/jhin/build/adc"), hover: null);

        Assert.Empty(evaluation.Fetch);
    }

    [Fact]
    public void Non_build_visible_page_is_ignored()
    {
        // Past the lock (which fires regardless of what the user views):
        // a homepage under the same key re-triggers nothing.
        var state = AutoImportCoordinator.RecordCompleted(
            AutoImportState.Initial, 103, 2, "Ahri",
            [new AutoImportOutcome(CompanionTab.UGg, AhriUggDeepLink.ToString(), null)]);

        var evaluation = AutoImportCoordinator.Evaluate(
            state, LockedAhri(CompanionTab.UGg, "https://u.gg/"), hover: null);
        Assert.Empty(evaluation.Fetch);
    }

    // -- Coordinator: quiet paths -------------------------------------------

    [Fact]
    public void No_client_skips_with_a_reason_and_no_targets()
    {
        var evaluation = AutoImportCoordinator.Evaluate(AutoImportState.Initial, LockedAhri(lcu: false), hover: null);
        Assert.Empty(evaluation.Fetch);
        Assert.NotNull(evaluation.SkipReason);
    }

    [Fact]
    public void No_context_means_nothing_due_and_no_reason()
    {
        var evaluation = AutoImportCoordinator.Evaluate(
            AutoImportState.Initial,
            new AutoImportInput(null, null, null, null, false, CompanionTab.Companion, null, true, T0),
            hover: null);
        Assert.Empty(evaluation.Fetch);
        Assert.Null(evaluation.SkipReason);
    }

    // -- Coordinator: the navigation allowlist --------------------------------

    [Fact]
    public void The_allowlist_pins_exact_deep_link_shapes()
    {
        // Controls: the builder outputs the allowlist is compared against.
        var ugg = SiteDeepLink.Build(CompanionTab.UGg, "Ahri", 2);
        var coachless = SiteDeepLink.Build(CompanionTab.Coachless, "Ahri", 2);
        Assert.NotNull(ugg);
        Assert.NotNull(coachless);

        Assert.True(AutoImportCoordinator.IsAllowedAutoImportTarget(CompanionTab.UGg, ugg, "Ahri", 2));
        Assert.True(AutoImportCoordinator.IsAllowedAutoImportTarget(CompanionTab.Coachless, coachless, "Ahri", 2));
        // The fold is case-insensitive on the key: MonkeyKing meets monkeyking.
        Assert.True(AutoImportCoordinator.IsAllowedAutoImportTarget(
            CompanionTab.UGg, new Uri("https://u.gg/lol/champions/monkeyking/build/jungle"), "MonkeyKing", 1));

        // Another champion, another role, another shape, another host,
        // a hand-built URL, nulls, and the Companion tab: all refused.
        Assert.False(AutoImportCoordinator.IsAllowedAutoImportTarget(
            CompanionTab.UGg, new Uri("https://u.gg/lol/champions/jhin/build/mid"), "Ahri", 2));
        Assert.False(AutoImportCoordinator.IsAllowedAutoImportTarget(
            CompanionTab.UGg, new Uri("https://u.gg/lol/champions/ahri/build/top"), "Ahri", 2));
        Assert.False(AutoImportCoordinator.IsAllowedAutoImportTarget(
            CompanionTab.UGg, new Uri("https://u.gg/lol/champions/ahri/build/mid?rank=x"), "Ahri", 2));
        Assert.False(AutoImportCoordinator.IsAllowedAutoImportTarget(
            CompanionTab.UGg, new Uri("https://example.com/lol/champions/ahri/build/mid"), "Ahri", 2));
        Assert.False(AutoImportCoordinator.IsAllowedAutoImportTarget(CompanionTab.UGg, null, "Ahri", 2));
        Assert.False(AutoImportCoordinator.IsAllowedAutoImportTarget(CompanionTab.UGg, ugg, null, 2));
        Assert.False(AutoImportCoordinator.IsAllowedAutoImportTarget(
            CompanionTab.Companion, new Uri("https://coachbuild.vercel.app/"), "Ahri", 2));
        // Cross-site: a coachless URL is never a u.gg target.
        Assert.False(AutoImportCoordinator.IsAllowedAutoImportTarget(CompanionTab.UGg, coachless, "Ahri", 2));
    }

    [Theory]
    [InlineData(CompanionTab.UGg, "https://u.gg/lol/champions/ahri/build/mid", "ahri")]
    [InlineData(CompanionTab.UGg, "https://u.gg/lol/champions/jhin/build", "jhin")]
    [InlineData(CompanionTab.Coachless, "https://coachless.gg/builds/wukong?role=jungle", "wukong")]
    public void Build_urls_yield_their_slug(CompanionTab site, string url, string slug)
    {
        Assert.Equal(slug, AutoImportCoordinator.SlugFromBuildUrl(site, url));
    }

    [Theory]
    [InlineData(CompanionTab.UGg, "https://u.gg/")]
    [InlineData(CompanionTab.UGg, "https://u.gg/lol/champions/ahri")]
    [InlineData(CompanionTab.Coachless, "https://coachless.gg/builds/creator")]
    [InlineData(CompanionTab.Coachless, "https://u.gg/lol/champions/ahri/build/mid")]
    [InlineData(CompanionTab.Companion, "https://coachless.gg/builds/ahri?role=mid")]
    public void Non_build_urls_yield_no_slug(CompanionTab site, string url)
    {
        Assert.Null(AutoImportCoordinator.SlugFromBuildUrl(site, url));
    }

    // -- Coordinator: the write batch -----------------------------------------

    [Fact]
    public void The_batch_keeps_both_sites_coexisting_with_fresh_winning()
    {
        var ugg = Parse(AhriUggJson);
        var coachless = Parse(AhriCoachlessJson);

        // Both fresh: both ride, no duplication.
        var both = AutoImportCoordinator.BuildWriteBatch(
            [ugg, coachless],
            new Dictionary<CompanionTab, CachedAutoImportSet>(),
            103, "Ahri");
        Assert.Equal(2, both.Count);

        // One fresh + one cached (the rank-filter refresh): the cached
        // other site rides along so the single-site write does not evict
        // it from the client.
        var state = AutoImportCoordinator.RecordCompleted(
            AutoImportState.Initial, 103, 2, "Ahri",
            [
                new AutoImportOutcome(CompanionTab.UGg, AhriUggDeepLink.ToString(), ugg),
                new AutoImportOutcome(CompanionTab.Coachless, AhriCoachlessDeepLink.ToString(), coachless),
            ]);
        var refreshed = AutoImportCoordinator.BuildWriteBatch(
            [Parse(AhriUggRefreshedJson)], state.CachedSets, 103, "Ahri");
        Assert.Equal(2, refreshed.Count);
        Assert.Contains(refreshed, contribution =>
            contribution.Payload.Source == SiteImportSource.UGg &&
            contribution.Payload.ItemBlocks[0].ItemIds[0] == 6653);
        Assert.Contains(refreshed, contribution =>
            contribution.Payload.Source == SiteImportSource.Coachless &&
            contribution.Payload.ItemBlocks[0].ItemIds[0] == 1056);

        // Cached sets for ANOTHER champion never ride along.
        var foreign = AutoImportCoordinator.BuildWriteBatch(
            [], state.CachedSets, 62, "Wukong");
        Assert.Empty(foreign);
    }

    // -- Service: the lock run --------------------------------------------------

    /// <summary>
    /// 2.1.2: each site's set is flushed as soon as ITS extraction
    /// completes -- two PUTs, not one. A practice-tool instalock ends champ
    /// select ~10s after the lock while the Coachless walk is still in
    /// flight; the old end-of-run write lost the u.gg set that had been
    /// sitting fetched for seconds. The second write still carries the first
    /// (the cached-set carry), so the two per-site titles coexist exactly as
    /// the old single write arranged.
    /// </summary>
    [Fact]
    public async Task Lock_run_flushes_each_site_as_its_extraction_completes_without_rune_calls()
    {
        var api = new StubLcu();
        var executor = new FakeExecutor
        {
            Worker = (site, _) => site == CompanionTab.UGg ? AhriUggRunesJson : AhriCoachlessJson,
        };
        var sink = new FakeSink();
        var service = NewService(executor, api, sink);

        await service.OnSnapshotAsync(LockedAhri());

        // Routed through workers (the visible tab is Companion), at the
        // deep links, once each.
        Assert.Equal(
            [$"worker:{CompanionTab.UGg}:{AhriUggDeepLink}",
              $"worker:{CompanionTab.Coachless}:{AhriCoachlessDeepLink}"],
            executor.Calls);
        // Two merged PUTs: the first carries only u.gg (Coachless had not
        // completed yet), the second carries both. The rune endpoints see
        // nothing even though the u.gg payload is rune-capable in shape.
        var puts = api.Calls.Where(call =>
            call.Method == HttpMethod.Put && call.Path.Contains("item-sets", StringComparison.Ordinal)).ToList();
        Assert.Equal(2, puts.Count);
        using var first = JsonDocument.Parse(JsonSerializer.Serialize(puts[0].Body, JsonOptions.Wire));
        var firstSets = first.RootElement.GetProperty("itemSets");
        Assert.Equal("CoachBuild import: Ahri Mid (u.gg)", Assert.Single(firstSets.EnumerateArray()).GetProperty("title").GetString());
        using var second = JsonDocument.Parse(JsonSerializer.Serialize(puts[1].Body, JsonOptions.Wire));
        var sets = second.RootElement.GetProperty("itemSets");
        Assert.Equal(2, sets.GetArrayLength());
        // Fresh first, cached carried after: the ORDER differs from the old
        // single write, so both titles are asserted as a set.
        Assert.Equal(
            ["CoachBuild import: Ahri Mid (Coachless)", "CoachBuild import: Ahri Mid (u.gg)"],
            sets.EnumerateArray().Select(set => set.GetProperty("title").GetString()).OrderBy(title => title));
        Assert.DoesNotContain(api.Calls, call => call.Path.Contains("perks", StringComparison.Ordinal));
        // Three verdicts for two writes: the second PUT re-batches the
        // carried u.gg set, and each contribution reports its own write.
        // Every line answers a real LCU PUT, so none is suppressed.
        Assert.Equal(3, sink.Statuses.Count);
        Assert.All(sink.Statuses, status => Assert.Contains("Auto-imported", status, StringComparison.Ordinal));

        // Debounced: the same tick again moves nothing.
        var calls = executor.Calls.Count;
        var lcu = api.Calls.Count;
        await service.OnSnapshotAsync(LockedAhri());
        Assert.Equal(calls, executor.Calls.Count);
        Assert.Equal(lcu, api.Calls.Count);
    }

    /// <summary>
    /// The instalock shape (live pass 3, 23:34:45): the Coachless leg never
    /// finishes, and the first site's ALREADY-EXTRACTED set must still land.
    /// </summary>
    [Fact]
    public async Task A_site_that_stalls_does_not_cost_the_site_that_finished()
    {
        var api = new StubLcu();
        var gate = new TaskCompletionSource<string?>(TaskCreationOptions.RunContinuationsAsynchronously);
        var executor = new FakeExecutor
        {
            Worker = (site, _) => site == CompanionTab.UGg
                ? AhriUggJson
                : gate.Task.GetAwaiter().GetResult(),
        };
        var sink = new FakeSink();
        var service = NewService(executor, api, sink);

        var run = Task.Run(() => service.OnSnapshotAsync(LockedAhri()));
        // Wait until the u.gg flush has landed while Coachless is still
        // parked in its fetch.
        var deadline = DateTime.UtcNow.AddSeconds(10);
        while (!api.Calls.Any(call =>
                call.Method == HttpMethod.Put && call.Path.Contains("item-sets", StringComparison.Ordinal)) &&
            DateTime.UtcNow < deadline)
            await Task.Delay(10);
        var puts = api.Calls.Where(call =>
            call.Method == HttpMethod.Put && call.Path.Contains("item-sets", StringComparison.Ordinal)).ToList();
        var only = Assert.Single(puts);
        using var document = JsonDocument.Parse(JsonSerializer.Serialize(only.Body, JsonOptions.Wire));
        var sets = document.RootElement.GetProperty("itemSets");
        Assert.Equal("CoachBuild import: Ahri Mid (u.gg)", Assert.Single(sets.EnumerateArray()).GetProperty("title").GetString());
        Assert.Contains(sink.Statuses, status =>
            status.Contains("Auto-imported", StringComparison.Ordinal) &&
            status.Contains("u.gg", StringComparison.Ordinal));

        // Let the run finish normally: the second write carries both.
        gate.SetResult(AhriCoachlessJson);
        await run;
        var all = api.Calls.Where(call =>
            call.Method == HttpMethod.Put && call.Path.Contains("item-sets", StringComparison.Ordinal)).ToList();
        Assert.Equal(2, all.Count);
    }

    /// <summary>
    /// Champ-select-end cancellation (a dodge: the phase leaves ChampSelect
    /// for None/Lobby) rolls the run's debounce state back. The write that
    /// already landed stands -- a client write cannot be unwound -- but the
    /// half-run counts as never attempted, so the next lock re-evaluates
    /// from scratch instead of trusting it.
    /// </summary>
    [Fact]
    public async Task Cancelling_mid_run_keeps_the_write_but_rolls_back_the_debounce()
    {
        var api = new StubLcu();
        var gate = new TaskCompletionSource<string?>(TaskCreationOptions.RunContinuationsAsynchronously);
        var executor = new FakeExecutor
        {
            Worker = (site, _) => site == CompanionTab.UGg
                ? AhriUggJson
                : gate.Task.GetAwaiter().GetResult(),
        };
        var sink = new FakeSink();
        var service = NewService(executor, api, sink);
        using var cts = new CancellationTokenSource();

        var run = Task.Run(() => service.OnSnapshotAsync(LockedAhri(), cts.Token));
        var deadline = DateTime.UtcNow.AddSeconds(10);
        while (!api.Calls.Any(call =>
                call.Method == HttpMethod.Put && call.Path.Contains("item-sets", StringComparison.Ordinal)) &&
            DateTime.UtcNow < deadline)
            await Task.Delay(10);
        Assert.Single(api.Calls, call =>
            call.Method == HttpMethod.Put && call.Path.Contains("item-sets", StringComparison.Ordinal));

        // Champ select ends mid-walk: cancel, then release the parked fetch
        // so the run can observe the cancel.
        cts.Cancel();
        gate.SetResult(AhriCoachlessJson);
        await run;

        // The u.gg write stood, Coachless never flushed, and the cancel was
        // said out loud rather than reported as an unexpected failure.
        Assert.Single(api.Calls, call =>
            call.Method == HttpMethod.Put && call.Path.Contains("item-sets", StringComparison.Ordinal));
        Assert.Contains(sink.Logs, line => line.Contains("cancelled", StringComparison.Ordinal));
        Assert.DoesNotContain(sink.Logs, line => line.Contains("unexpected failure", StringComparison.Ordinal));
        // Rolled back: the key advancement the first flush committed is
        // gone, so the next identical tick re-fetches BOTH sites.
        Assert.Null(service.State.ChampionId);
        await service.OnSnapshotAsync(LockedAhri());
        Assert.Equal(4, executor.Calls.Count);
    }

    /// <summary>
    /// A run that never starts (already-cancelled token, nothing fetched)
    /// writes nothing, advances nothing, and says exactly one quiet line.
    /// </summary>
    [Fact]
    public async Task A_cancelled_run_that_never_started_touches_nothing()
    {
        var api = new StubLcu();
        var executor = new FakeExecutor { Worker = (_, _) => AhriUggJson };
        var sink = new FakeSink();
        var service = NewService(executor, api, sink);
        using var cts = new CancellationTokenSource();
        cts.Cancel();

        await service.OnSnapshotAsync(LockedAhri(), cts.Token);

        Assert.Empty(executor.Calls);
        Assert.Empty(api.Calls);
        Assert.Empty(sink.Statuses);
        Assert.Single(sink.Logs, line => line.Contains("cancelled", StringComparison.Ordinal));
        Assert.Null(service.State.ChampionId);
    }

    /// <summary>
    /// 2.1.0: the extractor's own <c>meta.notes</c> reach the log, and reach it
    /// BEFORE the verdict line.
    ///
    /// <para>The field log 2026-09-08 read "u.gg yielded no item build --
    /// ignored" and that was the entire record: nothing said which stage the
    /// read stopped at, so diagnosing it needed a second live pass with a
    /// hand-captured fixture. A payload that yields nothing must now arrive
    /// with its own account.</para>
    /// </summary>
    [Fact]
    public async Task An_empty_item_yield_logs_the_extractors_stage_notes_before_the_verdict()
    {
        const string uggEmptyWithNotes = """
            {"source":"u.gg","championSlug":"ahri","role":"mid",
             "runes":{"primaryStyleId":8200,"subStyleId":8100,
                      "perkIds":[8214,8226,8210,8237,8135,8106],"shardIds":[5008,5008,5001]},
             "itemBlocks":[],
             "meta":{"stage":"json-found","notes":[
               "u.gg items: the rendered rank \"platinum_plus\" has no embedded build",
               "u.gg items: stage json-found (rank \"platinum_plus\", role \"mid\", 0 blocks)"]}}
            """;
        var api = new StubLcu();
        var executor = new FakeExecutor
        {
            Worker = (site, _) => site == CompanionTab.UGg ? uggEmptyWithNotes : AhriCoachlessJson,
        };
        var sink = new FakeSink();
        var service = NewService(executor, api, sink);

        await service.OnSnapshotAsync(LockedAhri());

        var verdict = sink.Logs.FindIndex(
            line => line.Contains("yielded no item build", StringComparison.Ordinal));
        var stage = sink.Logs.FindIndex(
            line => line.Contains("stage json-found", StringComparison.Ordinal));
        var refusal = sink.Logs.FindIndex(
            line => line.Contains("platinum_plus\" has no embedded build", StringComparison.Ordinal));
        Assert.True(verdict >= 0, string.Join(" | ", sink.Logs));
        Assert.True(refusal >= 0, string.Join(" | ", sink.Logs));
        Assert.True(stage >= 0, string.Join(" | ", sink.Logs));
        Assert.True(refusal < verdict && stage < verdict, string.Join(" | ", sink.Logs));
        // Log only: a slot the page could not fill is not worth interrupting
        // the user, and the Coachless half still wrote.
        Assert.DoesNotContain(sink.Statuses, status => status.Contains("stage", StringComparison.Ordinal));
        Assert.Contains(sink.Statuses, status => status.Contains("Auto-imported", StringComparison.Ordinal));
    }

    /// <summary>
    /// The 2026-09-09 field bug, end to end and in the service's own terms:
    /// a champion HOVERED in champ select and never locked must end up with
    /// two rune pages in the client, because that is the whole point of the
    /// feature ("create two rune pages in game, then I can just select the one
    /// I want before going into game"). Before this, the ~70s hover produced
    /// no <c>auto-import:</c> line at all.
    ///
    /// <para>Ticked the way the window ticks it -- one input per snapshot,
    /// each with its own stamp -- so the settle is exercised through the
    /// service's own hover tracking rather than by handing Evaluate a
    /// hand-made observation.</para>
    /// </summary>
    [Fact]
    public async Task A_held_hover_imports_items_and_both_rune_pages_without_a_lock()
    {
        var api = new StubLcu();
        var executor = new FakeExecutor
        {
            Worker = (site, _) => site == CompanionTab.UGg ? AhriUggRunesJson : AhriCoachlessJson,
            Runes = _ => AhriCoachlessRunesJson,
        };
        var sink = new FakeSink();
        var service = NewService(executor, api, sink, withRunes: true);

        // Two 750 ms ticks inside the settle: still nothing, and no lock has
        // happened in this test at all.
        await service.OnSnapshotAsync(HoveredAhri(0));
        await service.OnSnapshotAsync(HoveredAhri(0.75));
        Assert.Empty(executor.Calls);
        Assert.Equal(T0, service.Hover!.FirstSeenAt);

        // The tick past the settle imports.
        await service.OnSnapshotAsync(HoveredAhri(AutoImportCoordinator.HoverSettle.TotalSeconds + 0.75));

        Assert.Equal(
            [$"worker:{CompanionTab.UGg}:{AhriUggDeepLink}",
             $"runes:{AhriCoachlessRunesLink}",
             $"worker:{CompanionTab.Coachless}:{AhriCoachlessDeepLink}"],
            executor.Calls);
        var runeCreates = api.Calls.Where(call =>
            call.Method == HttpMethod.Post && call.Path == "/lol-perks/v1/pages").ToArray();
        Assert.Equal(2, runeCreates.Length);
        // Requirement 5: the log says WHICH trigger fired.
        Assert.Contains(sink.Logs, line =>
            line.Contains("Ahri Mid hovered and held", StringComparison.Ordinal) &&
            line.Contains("(trigger: hover)", StringComparison.Ordinal));
        Assert.DoesNotContain(sink.Logs, line =>
            line.Contains("(trigger: lock)", StringComparison.Ordinal));

        // The lock that follows costs nothing -- same key, already imported.
        var calls = executor.Calls.Count;
        var lcu = api.Calls.Count;
        await service.OnSnapshotAsync(LockedAhri(atSeconds: 20));
        Assert.Equal(calls, executor.Calls.Count);
        Assert.Equal(lcu, api.Calls.Count);
        Assert.Null(service.Hover);
    }

    /// <summary>
    /// The lock's own line, and the control that a lock does NOT wait for a
    /// settle: one tick, one import (see
    /// <see cref="Lock_run_flushes_each_site_as_its_extraction_completes_without_rune_calls"/>
    /// for the write detail).
    /// </summary>
    [Fact]
    public async Task A_lock_imports_on_its_first_tick_and_names_the_lock_trigger()
    {
        var api = new StubLcu();
        var executor = new FakeExecutor
        {
            Worker = (site, _) => site == CompanionTab.UGg ? AhriUggJson : AhriCoachlessJson,
        };
        var sink = new FakeSink();
        var service = NewService(executor, api, sink);

        await service.OnSnapshotAsync(LockedAhri());

        Assert.Equal(2, executor.Calls.Count);
        Assert.Contains(sink.Logs, line =>
            line.Contains("Ahri Mid locked in", StringComparison.Ordinal) &&
            line.Contains("(trigger: lock)", StringComparison.Ordinal));
    }

    // -- Service: the Coachless runes leg (2.1.0) -------------------------------

    [Fact]
    public async Task A_coachless_run_also_imports_the_runes_page()
    {
        var api = new StubLcu();
        var executor = new FakeExecutor
        {
            Worker = (site, _) => site == CompanionTab.UGg ? AhriUggRunesJson : AhriCoachlessJson,
            Runes = _ => AhriCoachlessRunesJson,
        };
        var sink = new FakeSink();
        var service = NewService(executor, api, sink, withRunes: true);

        await service.OnSnapshotAsync(LockedAhri());

        // The rune pair lands before the Coachless item fetch, exactly once.
        Assert.Equal(
            [$"worker:{CompanionTab.UGg}:{AhriUggDeepLink}",
             $"runes:{AhriCoachlessRunesLink}",
             $"worker:{CompanionTab.Coachless}:{AhriCoachlessDeepLink}"],
            executor.Calls);
        // ...and both source-named rune pages were actually written.
        var runeCreates = api.Calls.Where(call =>
            call.Method == HttpMethod.Post && call.Path == "/lol-perks/v1/pages").ToArray();
        Assert.Equal(2, runeCreates.Length);
        Assert.Contains(runeCreates, call => JsonSerializer.Serialize(call.Body).Contains("u.gg Ahri (Mid)"));
        Assert.Contains(runeCreates, call => JsonSerializer.Serialize(call.Body).Contains("Coachless Ahri (Mid)"));
        Assert.Contains(sink.Logs, line =>
            line.Contains("runes: wrote u.gg Ahri (Mid)", StringComparison.Ordinal));
        Assert.Contains(sink.Logs, line =>
            line.Contains("runes: wrote Coachless Ahri (Mid)", StringComparison.Ordinal));
    }

    /// <summary>
    /// Control for the test above: without a rune service the behaviour is
    /// exactly what it was before 2.1.0 — items only, no second navigation,
    /// no rune endpoint touched.
    /// </summary>
    [Fact]
    public async Task Both_rune_pages_are_written_before_coachless_items_start()
    {
        var api = new StubLcu();
        var runePagesAtItemFetch = -1;
        var executor = new FakeExecutor {
            Worker = (site, _) => {
                if (site == CompanionTab.UGg) return AhriUggRunesJson;
                runePagesAtItemFetch = api.Calls.Count(call =>
                    call.Method == HttpMethod.Post && call.Path == "/lol-perks/v1/pages");
                return AhriCoachlessJson;
            },
            Runes = _ => AhriCoachlessRunesJson,
        };
        var service = NewService(executor, api, new FakeSink(), withRunes: true);
        await service.OnSnapshotAsync(LockedAhri());
        Assert.Equal(2, runePagesAtItemFetch);
        Assert.Equal(2, api.Calls.Count(call =>
            call.Method == HttpMethod.Post && call.Path == "/lol-perks/v1/pages"));
    }

    [Fact]
    public async Task Without_a_rune_service_the_runes_leg_never_runs()
    {
        var api = new StubLcu();
        var executor = new FakeExecutor
        {
            Worker = (site, _) => site == CompanionTab.UGg ? AhriUggJson : AhriCoachlessJson,
            Runes = _ => AhriCoachlessRunesJson,
        };
        var service = NewService(executor, api, new FakeSink());

        await service.OnSnapshotAsync(LockedAhri());

        Assert.DoesNotContain(executor.Calls, call =>
            call.StartsWith("runes:", StringComparison.Ordinal));
        Assert.DoesNotContain(api.Calls, call =>
            call.Path.Contains("perks", StringComparison.Ordinal));
    }

    /// <summary>
    /// A u.gg-only visible trigger still imports both source pages; the u.gg
    /// payload is reused and only Coachless needs another navigation.
    /// </summary>
    [Fact]
    public async Task A_ugg_only_refresh_still_fetches_coachless_runes()
    {
        var api = new StubLcu();
        var executor = new FakeExecutor
        {
            Visible = _ => AhriUggRunesJson,
            Runes = _ => AhriCoachlessRunesJson,
        };
        var service = NewService(executor, api, new FakeSink(), withRunes: true);

        // Visible u.gg build page for the hovered champion: trigger 2 only.
        await service.OnSnapshotAsync(LockedAhri() with
        {
            Locked = false,
            VisibleTab = CompanionTab.UGg,
            VisibleUrl = AhriUggDeepLink.ToString(),
        });

        Assert.Equal(
            [$"visible:{CompanionTab.UGg}", $"runes:{AhriCoachlessRunesLink}"],
            executor.Calls);
    }

    [Fact]
    public async Task One_available_rune_slot_logs_the_exact_ugg_only_verdict()
    {
        var api = new StubLcu
        {
            PagesJson = """
                [{"id":1,"name":"Mine 1","isDeletable":true},
                 {"id":2,"name":"Mine 2","isDeletable":true},
                 {"id":3,"name":"Mine 3","isDeletable":true},
                 {"id":4,"name":"Mine 4","isDeletable":true}]
                """,
        };
        var executor = new FakeExecutor
        {
            Worker = (site, _) => site == CompanionTab.UGg ? AhriUggRunesJson : AhriCoachlessJson,
            Runes = _ => AhriCoachlessRunesJson,
        };
        var sink = new FakeSink();
        var service = NewService(executor, api, sink, withRunes: true);

        await service.OnSnapshotAsync(LockedAhri());

        Assert.Contains("runes: only one editable page slot -- wrote u.gg only", sink.Logs);
        var create = Assert.Single(api.Calls, call =>
            call.Method == HttpMethod.Post && call.Path == "/lol-perks/v1/pages");
        Assert.Contains("u.gg Ahri (Mid)", JsonSerializer.Serialize(create.Body), StringComparison.Ordinal);
        Assert.DoesNotContain(api.Calls, call => call.Method == HttpMethod.Delete);
    }

    [Fact]
    public async Task No_available_rune_slots_leave_every_foreign_page_untouched()
    {
        var api = new StubLcu
        {
            PagesJson = """
                [{"id":1,"name":"Mine 1","isDeletable":true},
                 {"id":2,"name":"Mine 2","isDeletable":true},
                 {"id":3,"name":"Mine 3","isDeletable":true},
                 {"id":4,"name":"Mine 4","isDeletable":true},
                 {"id":5,"name":"Mine 5","isDeletable":true}]
                """,
        };
        var executor = new FakeExecutor
        {
            Worker = (site, _) => site == CompanionTab.UGg ? AhriUggRunesJson : AhriCoachlessJson,
            Runes = _ => AhriCoachlessRunesJson,
        };
        var sink = new FakeSink();
        var service = NewService(executor, api, sink, withRunes: true);

        await service.OnSnapshotAsync(LockedAhri());

        Assert.Contains("runes: no editable page slots -- wrote no rune pages", sink.Logs);
        Assert.DoesNotContain(api.Calls, call =>
            call.Path.Contains("/lol-perks/v1/pages", StringComparison.Ordinal) &&
            call.Method != HttpMethod.Get);
    }

    /// <summary>
    /// A runes page that cannot be read completely writes NOTHING and says
    /// so. The item set, already written, is untouched — the two halves are
    /// independent on purpose.
    /// </summary>
    [Fact]
    public async Task An_unreadable_runes_page_is_a_typed_note_and_writes_no_perks()
    {
        var api = new StubLcu();
        var executor = new FakeExecutor
        {
            Worker = (site, _) => site == CompanionTab.UGg ? AhriUggJson : AhriCoachlessJson,
            Runes = _ => """{"error":"primary rune row 2 carried no WPA reading"}""",
        };
        var sink = new FakeSink();
        var service = NewService(executor, api, sink, withRunes: true);

        await service.OnSnapshotAsync(LockedAhri());

        Assert.DoesNotContain(api.Calls, call =>
            call.Path.Contains("perks", StringComparison.Ordinal));
        Assert.Contains(sink.Logs, line =>
            line.Contains("no rune build", StringComparison.Ordinal) &&
            line.Contains("primary rune row 2", StringComparison.Ordinal));
        // The items still landed (both per-site flushes; the last carries both).
        Assert.Equal(2, LastPutSets(api).GetArrayLength());
    }

    /// <summary>
    /// 2.1.2: a runes page that is identical AND already selected is an
    /// honest already-current, not a claimed import -- and, crucially, it
    /// still says something. The stub's current page is id 9001, so the
    /// pinned page carries it.
    /// </summary>
    [Fact]
    public async Task An_identical_selected_runes_page_is_reported_already_current()
    {
        var api = new StubLcu
        {
            PagesJson = """
                [{"id":9001,"name":"u.gg Ahri (Mid)","isDeletable":true,
                  "primaryStyleId":8200,"subStyleId":8100,
                  "selectedPerkIds":[8214,8226,8210,8237,8139,8137,5008,5008,5001],"current":true},
                 {"id":9002,"name":"Coachless Ahri (Mid)","isDeletable":true,
                  "primaryStyleId":8200,"subStyleId":8000,
                  "selectedPerkIds":[8214,8226,8210,8237,9111,9105,5008,5008,5011],"current":false}]
                """,
        };
        var executor = new FakeExecutor
        {
            Worker = (site, _) => site == CompanionTab.UGg ? AhriUggRunesJson : AhriCoachlessJson,
            Runes = _ => AhriCoachlessRunesJson,
        };
        var sink = new FakeSink();
        var service = NewService(executor, api, sink, withRunes: true);

        await service.OnSnapshotAsync(LockedAhri());

        // No page edit or create: both exact pages already match. Because
        // current was CoachBuild-owned, u.gg is explicitly kept current.
        Assert.DoesNotContain(api.Calls, call =>
            (call.Method == HttpMethod.Post || call.Path.StartsWith("/lol-perks/v1/pages/", StringComparison.Ordinal)));
        Assert.Contains(api.Calls, call =>
            call.Method == HttpMethod.Put && call.Path == "/lol-perks/v1/currentpage");
        Assert.Contains(sink.Logs, line =>
            line.Contains("u.gg Ahri (Mid) already matches", StringComparison.Ordinal));
        Assert.Contains(sink.Logs, line =>
            line.Contains("Coachless Ahri (Mid) already matches", StringComparison.Ordinal));
        // The items still landed through the per-site flushes.
        Assert.Equal(2, LastPutSets(api).GetArrayLength());
    }

    [Fact]
    public async Task A_runes_page_for_another_champion_is_ignored()
    {        var api = new StubLcu();
        var executor = new FakeExecutor
        {
            Worker = (site, _) => site == CompanionTab.UGg ? AhriUggJson : AhriCoachlessJson,
            Runes = _ => AhriCoachlessRunesJson.Replace(
                "\"championSlug\":\"ahri\"", "\"championSlug\":\"nasus\"", StringComparison.Ordinal),
        };
        var sink = new FakeSink();
        var service = NewService(executor, api, sink, withRunes: true);

        await service.OnSnapshotAsync(LockedAhri());

        Assert.DoesNotContain(api.Calls, call =>
            call.Path.Contains("perks", StringComparison.Ordinal));
        Assert.Contains(sink.Logs, line =>
            line.Contains("not the selected champion", StringComparison.Ordinal));
    }

    [Fact]
    public async Task Roleless_coachless_fetch_uses_the_role_discovered_by_ugg()
    {
        var api = new StubLcu();
        var executor = new FakeExecutor
        {
            Worker = (site, _) => site == CompanionTab.UGg ? AhriUggJson : AhriCoachlessJson,
        };
        var service = NewService(executor, api, new FakeSink());

        await service.OnSnapshotAsync(LockedAhri() with { RoleId = null });

        Assert.Equal(
            [$"worker:{CompanionTab.UGg}:https://u.gg/lol/champions/ahri/build",
             $"worker:{CompanionTab.Coachless}:{AhriCoachlessDeepLink}"],
            executor.Calls);
    }

    // -- Service: worker teardown (2.1.0 memory fix) ----------------------------

    [Fact]
    public async Task Every_run_that_fetched_releases_its_workers()
    {
        var api = new StubLcu();
        var executor = new FakeExecutor
        {
            Worker = (site, _) => site == CompanionTab.UGg ? AhriUggJson : AhriCoachlessJson,
        };
        var service = NewService(executor, api, new FakeSink());

        await service.OnSnapshotAsync(LockedAhri());
        Assert.Equal(1, executor.ReleaseCount);

        // The debounced re-tick fetches nothing, so it must not churn a
        // teardown call per 750ms tick.
        await service.OnSnapshotAsync(LockedAhri());
        Assert.Equal(1, executor.ReleaseCount);
    }

    [Fact]
    public async Task A_failed_run_still_releases_its_workers()
    {
        // The leak that matters is the one on the unhappy path.
        var api = new StubLcu();
        var executor = new FakeExecutor { Worker = (_, _) => "not json at all" };
        var service = NewService(executor, api, new FakeSink());

        await service.OnSnapshotAsync(LockedAhri());

        Assert.Equal(1, executor.ReleaseCount);
    }

    [Fact]
    public async Task A_tick_with_nothing_to_do_releases_nothing()
    {
        var executor = new FakeExecutor();
        var service = NewService(executor, new StubLcu(), new FakeSink());

        // No client: the coordinator stands down before any fetch.
        await service.OnSnapshotAsync(LockedAhri() with { LcuConnected = false });

        Assert.Empty(executor.Calls);
        Assert.Equal(0, executor.ReleaseCount);
    }

    [Fact]
    public async Task Visible_refresh_reads_in_place_and_rebatches_the_cached_other_site()
    {
        var api = new StubLcu();
        var executor = new FakeExecutor
        {
            Worker = (site, _) => site == CompanionTab.UGg ? AhriUggJson : AhriCoachlessJson,
            Visible = _ => AhriUggRefreshedJson,
        };
        var sink = new FakeSink();
        var service = NewService(executor, api, sink);

        await service.OnSnapshotAsync(LockedAhri());
        Assert.Equal(2, executor.Calls.Count);

        const string filtered = "https://u.gg/lol/champions/ahri/build/mid?rank=emerald_plus";
        await service.OnSnapshotAsync(LockedAhri(CompanionTab.UGg, filtered));

        // The visible u.gg page is READ, not navigated: no worker call for
        // it, one visible extract; Coachless is not re-fetched at all.
        Assert.Equal(
            [$"worker:{CompanionTab.UGg}:{AhriUggDeepLink}",
             $"worker:{CompanionTab.Coachless}:{AhriCoachlessDeepLink}",
             $"visible:{CompanionTab.UGg}"],
            executor.Calls);
        // ...yet the merged write still carries BOTH sets: the fresh u.gg
        // refresh plus the cached Coachless set.
        var puts = api.Calls.Where(call =>
            call.Method == HttpMethod.Put && call.Path.Contains("item-sets", StringComparison.Ordinal)).ToList();
        // 2.1.2: the lock run itself flushes twice (one site at a time),
        // so the refresh is the third PUT.
        Assert.Equal(3, puts.Count);
        using var document = JsonDocument.Parse(JsonSerializer.Serialize(puts[2].Body, JsonOptions.Wire));
        var sets = document.RootElement.GetProperty("itemSets");
        Assert.Equal(2, sets.GetArrayLength());
        Assert.Equal("6653", sets[0].GetProperty("blocks")[0].GetProperty("items")[0].GetProperty("id").GetString());
        Assert.Equal("CoachBuild import: Ahri Mid (Coachless)", sets[1].GetProperty("title").GetString());
    }

    [Fact]
    public async Task Extraction_failure_is_a_quiet_note_and_stays_debounced()
    {
        var api = new StubLcu();
        var executor = new FakeExecutor { Worker = (_, _) => "not json{{" };
        var sink = new FakeSink();
        var service = NewService(executor, api, sink);

        await service.OnSnapshotAsync(LockedAhri());

        Assert.Equal(2, executor.Calls.Count);
        Assert.Empty(api.Calls);
        // One quiet log plus one status-line note per site -- never a dialog
        // (there is no dialog surface on the sink at all).
        Assert.Equal(2, sink.Statuses.Count);
        Assert.All(sink.Statuses, status => Assert.Contains("failed", status, StringComparison.OrdinalIgnoreCase));

        var statuses = sink.Statuses.Count;
        var logs = sink.Logs.Count;
        await service.OnSnapshotAsync(LockedAhri());
        Assert.Equal(2, executor.Calls.Count);
        Assert.Equal(statuses, sink.Statuses.Count);
        Assert.Equal(logs, sink.Logs.Count);
    }

    [Fact]
    public async Task Payload_for_the_wrong_champion_is_ignored_without_lcu_traffic()
    {
        var api = new StubLcu();
        var executor = new FakeExecutor { Worker = (_, _) => JhinUggJson };
        var sink = new FakeSink();
        var service = NewService(executor, api, sink);

        await service.OnSnapshotAsync(LockedAhri());

        Assert.Empty(api.Calls);
        Assert.Empty(sink.Statuses);
        Assert.Contains(sink.Logs, line => line.Contains("not the selected champion", StringComparison.Ordinal));
    }

    [Fact]
    public async Task Wukong_alias_resolves_by_id_through_the_visible_page()
    {
        // Coachless 302s /builds/monkeyking to /builds/wukong, so the
        // visible slug never folds to the MonkeyKing context key. The
        // roster resolves both to champion 62 and the visible page imports
        // in place -- no worker, no navigation.
        var api = new StubLcu();
        var executor = new FakeExecutor { Visible = _ => WukongCoachlessJson };
        var sink = new FakeSink();
        var service = NewService(executor, api, sink);
        var hovering = new AutoImportInput(
            62, "MonkeyKing", "Wukong", 1, false,
            CompanionTab.Coachless, "https://coachless.gg/builds/wukong?role=jungle", true, T0);

        await service.OnSnapshotAsync(hovering);

        Assert.Equal([$"visible:{CompanionTab.Coachless}"], executor.Calls);
        var sets = PutSets(api);
        Assert.Equal(1, sets.GetArrayLength());
        Assert.Equal("CoachBuild import: Wukong Jungle (Coachless)", sets[0].GetProperty("title").GetString());
    }

    [Fact]
    public async Task Throwing_write_is_noted_and_still_advances_the_debounce()
    {
        // A write that throws (rather than returning a typed failure) must
        // not hot-loop: the outcomes commit, so the next identical tick
        // fetches nothing.
        var api = new StubLcu { ThrowOnPut = true };
        var executor = new FakeExecutor
        {
            Worker = (site, _) => site == CompanionTab.UGg ? AhriUggJson : AhriCoachlessJson,
        };
        var sink = new FakeSink();
        var service = NewService(executor, api, sink);

        await service.OnSnapshotAsync(LockedAhri());

        Assert.Contains(sink.Statuses, status => status.Contains("write failed", StringComparison.Ordinal));
        var calls = executor.Calls.Count;
        await service.OnSnapshotAsync(LockedAhri());
        Assert.Equal(calls, executor.Calls.Count);
    }

    /// <summary>
    /// A client that is genuinely absent is still reported, exactly once — but
    /// not on the FIRST tick. Field log 2026-09-08, first seconds after launch:
    /// <c>auto-import: League client not connected</c>, immediately followed by
    /// a successful poll. Nothing was wrong — LCU credential discovery had not
    /// finished its first cycle when the first 750 ms snapshot arrived. The
    /// line now waits
    /// <see cref="SiteAutoImportService.DisconnectedNoteAfterEvaluations"/>
    /// ticks. The "touches nothing" half is unchanged throughout, which is the
    /// control: the new silence must not have cost a fetch or a write.
    /// </summary>
    [Fact]
    public async Task No_client_ticks_stay_silent_through_discovery_then_log_once()
    {
        var api = new StubLcu();
        var executor = new FakeExecutor { Worker = (_, _) => AhriUggJson };
        var sink = new FakeSink();
        var service = NewService(executor, api, sink);

        // The threshold must outlast LCU discovery, so it is pinned as a
        // NUMBER and not merely read back from the constant: a test written
        // only in terms of the constant would pass just as happily at 1, which
        // is the pre-fix behaviour it exists to rule out. The tick is the
        // existing 750 ms snapshot, so 8 is ~6s.
        Assert.True(
            SiteAutoImportService.DisconnectedNoteAfterEvaluations >= 5,
            "the settle must outlast credential discovery, not merely exist");

        // The very first tick after launch -- the one the field log complained
        // about -- says nothing at all.
        await service.OnSnapshotAsync(LockedAhri(lcu: false));
        Assert.Empty(sink.Logs);

        // ...and so does every tick up to the threshold.
        for (var tick = 1; tick < SiteAutoImportService.DisconnectedNoteAfterEvaluations - 1; tick++)
        {
            await service.OnSnapshotAsync(LockedAhri(lcu: false));
            Assert.Empty(sink.Logs);
        }

        // ...and then the client really is absent, so it is said. Once.
        await service.OnSnapshotAsync(LockedAhri(lcu: false));
        await service.OnSnapshotAsync(LockedAhri(lcu: false));
        await service.OnSnapshotAsync(LockedAhri(lcu: false));

        Assert.Empty(executor.Calls);
        Assert.Empty(api.Calls);
        Assert.Empty(sink.Statuses);
        var line = Assert.Single(sink.Logs);
        Assert.Contains("League client not connected", line, StringComparison.Ordinal);
    }

    /// <summary>
    /// The counter measures CONSECUTIVE misses, not misses ever: a client that
    /// drops mid-session gets the same settle, and a connected tick in between
    /// re-arms it. Without the reset, one connected tick early on would license
    /// the note for the rest of the session.
    /// </summary>
    [Fact]
    public async Task A_connected_tick_re_arms_the_disconnected_settle()
    {
        var api = new StubLcu();
        var executor = new FakeExecutor { Worker = (_, _) => AhriUggJson };
        var sink = new FakeSink();
        var service = NewService(executor, api, sink);

        for (var tick = 0; tick < SiteAutoImportService.DisconnectedNoteAfterEvaluations - 1; tick++)
            await service.OnSnapshotAsync(LockedAhri(lcu: false));
        Assert.Empty(sink.Logs);

        // One CONNECTED tick with no champion: fetches nothing, but re-arms.
        await service.OnSnapshotAsync(new AutoImportInput(
            null, null, null, null, false, CompanionTab.Companion, null, LcuConnected: true, T0));
        Assert.Empty(sink.Logs);

        for (var tick = 0; tick < SiteAutoImportService.DisconnectedNoteAfterEvaluations - 1; tick++)
            await service.OnSnapshotAsync(LockedAhri(lcu: false));
        Assert.Empty(sink.Logs);

        await service.OnSnapshotAsync(LockedAhri(lcu: false));
        Assert.Single(sink.Logs);
        Assert.Empty(executor.Calls);
    }

    [Fact]
    public async Task Overlapping_ticks_single_flight_instead_of_double_firing()
    {
        var api = new StubLcu();
        var gate = new TaskCompletionSource<string?>(TaskCreationOptions.RunContinuationsAsynchronously);
        var executor = new FakeExecutor
        {
            // Blocks the RUN's thread (not the test's): the first flight
            // parks here while the overlapping tick must bounce off the
            // single-flight guard.
            Worker = (_, _) => gate.Task.GetAwaiter().GetResult(),
        };
        var sink = new FakeSink();
        var service = NewService(executor, api, sink);

        var first = Task.Run(() => service.OnSnapshotAsync(LockedAhri()));
        // Wait until the first run is inside the fetch before overlapping it.
        var deadline = DateTime.UtcNow.AddSeconds(5);
        while (executor.Calls.Count == 0 && DateTime.UtcNow < deadline)
            await Task.Delay(10);
        Assert.Single(executor.Calls);

        await service.OnSnapshotAsync(LockedAhri());

        gate.SetResult(AhriUggJson);
        // The worker func answers both sites with the u.gg JSON; the point
        // here is the flight count, not the payloads.
        await first;
        Assert.Equal(2, executor.Calls.Count);
    }

    [Theory]
    [InlineData("top", 0)]
    [InlineData("jungle", 1)]
    [InlineData("mid", 2)]
    [InlineData("adc", 3)]
    [InlineData("support", 4)]
    public void Role_tokens_round_trip(string token, int roleId)
    {
        Assert.Equal(roleId, SiteDeepLink.RoleIdFromToken(token));
        Assert.Equal(token, SiteDeepLink.RoleToken(roleId));
    }

    [Theory]
    [InlineData("bottom")]
    [InlineData("utility")]
    [InlineData("")]
    [InlineData(null)]
    public void An_unknown_role_token_is_dropped_not_guessed(string? token)
    {
        Assert.Null(SiteDeepLink.RoleIdFromToken(token));
    }

    // -- The u.gg SPA fallback (2.1.1) ------------------------------------------

    private static SiteImportPayload UggPayload(string stage, int blocks) =>
        new(SiteImportSource.UGg, "jhin", "adc", null!,
            blocks == 0
                ? []
                : [new SiteImportItemBlock("Core Items", [3006])])
        { Stage = stage };

    private static AutoImportSiteTarget UggTarget(bool inPlace) =>
        new(CompanionTab.UGg, new Uri("https://u.gg/lol/champions/jhin/build/adc"),
            inPlace, "jhin", 3);

    /// <summary>
    /// The live 2026-09-08 22:37:36 shape: an in-place read of the visible tab
    /// that found no embedded build blob. That is the SPA signature, and a
    /// direct load recovers it.
    /// </summary>
    [Fact]
    public void An_in_place_read_that_found_no_build_blob_retries_via_the_worker()
    {
        Assert.True(AutoImportCoordinator.ShouldRetryViaWorker(
            UggTarget(inPlace: true), UggPayload(SiteImportPayload.StageUrlRecognized, blocks: 0)));
    }

    /// <summary>
    /// The retry is a WORKER target, so a worker read that also yields nothing
    /// is the final answer — one retry per target, by construction, with no
    /// counter to get wrong.
    /// </summary>
    [Fact]
    public void The_retry_target_is_a_direct_load_and_never_retries_again()
    {
        var retry = AutoImportCoordinator.AsWorkerTarget(UggTarget(inPlace: true));
        Assert.False(retry.ExtractInPlace);
        Assert.Equal(UggTarget(inPlace: true).Url, retry.Url);
        Assert.Equal("jhin", retry.ChampionKey);
        Assert.Equal(3, retry.RoleId);
        Assert.False(AutoImportCoordinator.ShouldRetryViaWorker(
            retry, UggPayload(SiteImportPayload.StageUrlRecognized, blocks: 0)));
    }

    /// <summary>
    /// The signal is the STAGE, not the emptiness. A page that DID find a blob
    /// and still has no build for this rank/role is u.gg answering honestly —
    /// retrying that would re-load the page every tick, forever.
    /// </summary>
    [Theory]
    [InlineData("json-found")]
    [InlineData("keys-found")]
    [InlineData("blocks-built")]
    [InlineData("")]
    public void An_empty_yield_at_a_later_stage_is_the_final_answer(string stage)
    {
        Assert.False(AutoImportCoordinator.ShouldRetryViaWorker(
            UggTarget(inPlace: true), UggPayload(stage, blocks: 0)));
    }

    /// <summary>A read that produced a build is never re-fetched.</summary>
    [Fact]
    public void A_successful_in_place_read_is_never_retried()
    {
        Assert.False(AutoImportCoordinator.ShouldRetryViaWorker(
            UggTarget(inPlace: true), UggPayload(SiteImportPayload.StageUrlRecognized, blocks: 1)));
    }

}
