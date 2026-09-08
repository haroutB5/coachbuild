using System.Net.Http;
using System.Text.Json;
using CoachBuild.Core;
using CoachBuild.Desktop.Web;
using Xunit;

namespace CoachBuild.Desktop.Tests;

/// <summary>
/// The automatic item import: the coordinator's debounce/trigger matrix
/// (pure), the service orchestration against fakes (single-flight, executor
/// routing, items-only batched writes), and the runes button's pure state.
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
                return Task.FromResult(Ok("[]"));
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

    private static AutoImportInput LockedAhri(
        CompanionTab visible = CompanionTab.Companion,
        string? url = null,
        bool lcu = true) =>
        new(103, "Ahri", "Ahri", 2, true, visible, url, lcu);

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

    private static readonly Uri AhriCoachlessRunesLink =
        new("https://coachless.gg/runes/tree/ahri/precision/domination?role=mid");

    private static JsonElement PutSets(StubLcu api)
    {
        var put = Assert.Single(api.Calls, call =>
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

        var evaluation = AutoImportCoordinator.Evaluate(AutoImportState.Initial, LockedAhri());

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
            LockedAhri(CompanionTab.UGg, "https://u.gg/lol/champions/ahri/build/mid"));
        var ugg = Assert.Single(uggVisible.Fetch, plan => plan.Site == CompanionTab.UGg);
        Assert.True(ugg.ExtractInPlace);
        Assert.Equal("https://u.gg/lol/champions/ahri/build/mid", ugg.Url.ToString());
        Assert.False(Assert.Single(uggVisible.Fetch, plan => plan.Site == CompanionTab.Coachless).ExtractInPlace);

        var coachlessVisible = AutoImportCoordinator.Evaluate(
            AutoImportState.Initial,
            LockedAhri(CompanionTab.Coachless, "https://coachless.gg/builds/ahri?role=mid"));
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
            LockedAhri(CompanionTab.UGg, "https://u.gg/lol/champions/ahri/build/top"));

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
        var first = AutoImportCoordinator.Evaluate(state, LockedAhri());
        Assert.Equal(2, first.Fetch.Count);

        state = AutoImportCoordinator.RecordCompleted(
            state, 103, 2, "Ahri",
            first.Fetch.Select(plan => new AutoImportOutcome(plan.Site, plan.Url.ToString(), null)).ToList());

        var second = AutoImportCoordinator.Evaluate(state, LockedAhri());
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
            state, new AutoImportInput(championId, key, name, roleId, true, CompanionTab.Companion, null, true));

        Assert.Equal(2, evaluation.Fetch.Count);
    }

    [Fact]
    public void Hover_never_fires_the_lock_path()
    {
        var hovering = LockedAhri() with { Locked = false };
        var evaluation = AutoImportCoordinator.Evaluate(AutoImportState.Initial, hovering);
        Assert.Empty(evaluation.Fetch);
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
            state, LockedAhri(CompanionTab.UGg, filtered));

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
            state, LockedAhri(CompanionTab.UGg, "https://u.gg/lol/champions/jhin/build/adc"));

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
            state, LockedAhri(CompanionTab.UGg, "https://u.gg/"));
        Assert.Empty(evaluation.Fetch);
    }

    // -- Coordinator: quiet paths -------------------------------------------

    [Fact]
    public void No_client_skips_with_a_reason_and_no_targets()
    {
        var evaluation = AutoImportCoordinator.Evaluate(AutoImportState.Initial, LockedAhri(lcu: false));
        Assert.Empty(evaluation.Fetch);
        Assert.NotNull(evaluation.SkipReason);
    }

    [Fact]
    public void No_context_means_nothing_due_and_no_reason()
    {
        var evaluation = AutoImportCoordinator.Evaluate(
            AutoImportState.Initial,
            new AutoImportInput(null, null, null, null, false, CompanionTab.Companion, null, true));
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

    [Fact]
    public async Task Lock_run_writes_both_item_sets_in_one_put_without_rune_calls()
    {
        var api = new StubLcu();
        var executor = new FakeExecutor
        {
            Worker = (site, _) => site == CompanionTab.UGg ? AhriUggJson : AhriCoachlessJson,
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
        // One merged PUT carrying both per-site titles; the rune endpoints
        // see nothing even though the u.gg payload is rune-capable in shape.
        var sets = PutSets(api);
        Assert.Equal(2, sets.GetArrayLength());
        Assert.Equal("CoachBuild import: Ahri Mid (u.gg)", sets[0].GetProperty("title").GetString());
        Assert.Equal("CoachBuild import: Ahri Mid (Coachless)", sets[1].GetProperty("title").GetString());
        Assert.DoesNotContain(api.Calls, call => call.Path.Contains("perks", StringComparison.Ordinal));
        Assert.Equal(2, sink.Statuses.Count);
        Assert.All(sink.Statuses, status => Assert.Contains("Auto-imported", status, StringComparison.Ordinal));

        // Debounced: the same tick again moves nothing.
        var calls = executor.Calls.Count;
        var lcu = api.Calls.Count;
        await service.OnSnapshotAsync(LockedAhri());
        Assert.Equal(calls, executor.Calls.Count);
        Assert.Equal(lcu, api.Calls.Count);
    }

    // -- Service: the Coachless runes leg (2.1.0) -------------------------------

    [Fact]
    public async Task A_coachless_run_also_imports_the_runes_page()
    {
        var api = new StubLcu();
        var executor = new FakeExecutor
        {
            Worker = (site, _) => site == CompanionTab.UGg ? AhriUggJson : AhriCoachlessJson,
            Runes = _ => AhriCoachlessRunesJson,
        };
        var sink = new FakeSink();
        var service = NewService(executor, api, sink, withRunes: true);

        await service.OnSnapshotAsync(LockedAhri());

        // The runes page is fetched at the app's OWN deep link, after both
        // item fetches, exactly once.
        Assert.Equal(
            [$"worker:{CompanionTab.UGg}:{AhriUggDeepLink}",
             $"worker:{CompanionTab.Coachless}:{AhriCoachlessDeepLink}",
             $"runes:{AhriCoachlessRunesLink}"],
            executor.Calls);
        // ...and a rune page was actually written.
        Assert.Contains(api.Calls, call =>
            call.Method == HttpMethod.Post && call.Path == "/lol-perks/v1/pages");
        Assert.Contains(sink.Logs, line =>
            line.Contains("Imported runes for Ahri (Mid)", StringComparison.Ordinal));
    }

    /// <summary>
    /// Control for the test above: without a rune service the behaviour is
    /// exactly what it was before 2.1.0 — items only, no second navigation,
    /// no rune endpoint touched.
    /// </summary>
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
    /// A u.gg-only trigger must not navigate a Coachless runes page: the leg
    /// rides a run that already touched Coachless, never one that did not.
    /// </summary>
    [Fact]
    public async Task A_ugg_only_refresh_does_not_fetch_coachless_runes()
    {
        var api = new StubLcu();
        var executor = new FakeExecutor
        {
            Visible = _ => AhriUggJson,
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

        Assert.Equal([$"visible:{CompanionTab.UGg}"], executor.Calls);
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
        // The items still landed.
        Assert.Equal(2, PutSets(api).GetArrayLength());
    }

    [Fact]
    public async Task A_runes_page_for_another_champion_is_ignored()
    {
        var api = new StubLcu();
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
        Assert.Equal(2, puts.Count);
        using var document = JsonDocument.Parse(JsonSerializer.Serialize(puts[1].Body, JsonOptions.Wire));
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
            CompanionTab.Coachless, "https://coachless.gg/builds/wukong?role=jungle", true);

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

    [Fact]
    public async Task No_client_tick_logs_once_and_touches_nothing()
    {
        var api = new StubLcu();
        var executor = new FakeExecutor { Worker = (_, _) => AhriUggJson };
        var sink = new FakeSink();
        var service = NewService(executor, api, sink);

        await service.OnSnapshotAsync(LockedAhri(lcu: false));
        await service.OnSnapshotAsync(LockedAhri(lcu: false));

        Assert.Empty(executor.Calls);
        Assert.Empty(api.Calls);
        Assert.Empty(sink.Statuses);
        Assert.Single(sink.Logs);
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

    // -- The runes button's pure state ------------------------------------------

    [Theory]
    [InlineData(CompanionTab.UGg, "https://u.gg/lol/champions/jhin/build/adc", true, false, true, true)]
    [InlineData(CompanionTab.UGg, "https://u.gg/lol/champions/jhin/build", true, false, true, true)]
    public void Runes_button_enables_on_a_u_gg_build_page_with_client(
        CompanionTab tab, string? url, bool host, bool running, bool lcu, bool enabled)
    {
        var state = WebView2Window.RunesButtonFor(tab, url, host, running, lcu);
        Assert.True(state.Visible);
        Assert.Equal(enabled, state.Enabled);
        Assert.Contains("rune", state.Tooltip, StringComparison.OrdinalIgnoreCase);
    }

    [Theory]
    // Hidden on Coachless (no rune page -- never a dead button) and on
    // Companion (never scraped), whatever the URL.
    [InlineData(CompanionTab.Coachless, "https://coachless.gg/builds/jhin?role=adc")]
    [InlineData(CompanionTab.Coachless, "https://u.gg/lol/champions/jhin/build/adc")]
    [InlineData(CompanionTab.Companion, "https://u.gg/lol/champions/jhin/build/adc")]
    [InlineData(CompanionTab.UGg, "https://u.gg/")]
    [InlineData(CompanionTab.UGg, null)]
    public void Runes_button_hides_off_the_u_gg_build_shape(CompanionTab tab, string? url)
    {
        var state = WebView2Window.RunesButtonFor(tab, url, true, false, true);
        Assert.False(state.Visible);
        Assert.False(state.Enabled);
    }

    [Theory]
    [InlineData(false, false, true, "unavailable")]
    [InlineData(true, true, true, "already running")]
    [InlineData(true, false, false, "League client")]
    public void Runes_button_tooltip_names_the_reason(
        bool host, bool running, bool lcu, string fragment)
    {
        var state = WebView2Window.RunesButtonFor(
            CompanionTab.UGg, "https://u.gg/lol/champions/jhin/build/adc", host, running, lcu);
        Assert.True(state.Visible);
        Assert.False(state.Enabled);
        Assert.Contains(fragment, state.Tooltip, StringComparison.Ordinal);
    }
}
