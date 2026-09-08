using System.Net.Http;
using System.Text.Json;
using CoachBuild.Core;
using CoachBuild.Desktop.Web;
using Xunit;

namespace CoachBuild.Desktop.Tests;

/// <summary>
/// The Desktop side of the import AFTER the script returns: scrape parse,
/// roster resolution, connection gate, then the two apply services. Every
/// failure must precede the first LCU call (asserted via the stub's call
/// log), because a failed import that still wrote half a build is the
/// outcome this whole feature exists to prevent.
/// </summary>
public sealed class SiteImportHostTests
{
    private sealed class StubLcuApi : ILcuApi
    {
        private readonly Queue<LcuResponse> _responses = new();

        public List<(HttpMethod Method, string Path)> Calls { get; } = [];

        public void Enqueue(LcuResponse response) => _responses.Enqueue(response);

        public Task<LcuResponse> SendAsync(
            HttpMethod method, string path, object? body = null, CancellationToken cancellationToken = default)
        {
            Calls.Add((method, path));
            return Task.FromResult(
                _responses.Count > 0 ? _responses.Dequeue() : new LcuResponse(false, 404));
        }
    }

    private static IReadOnlyList<ChampionRef> JhinRoster { get; } =
        [new ChampionRef(202, "Jhin", "Jhin"), .. FakeChampionDirectory.DefaultRoster];

    private static CompanionState ConnectedState()
    {
        var state = new CompanionState();
        Assert.True(state.SetCredentials(new LcuCredentials(1234, "token", "test")));
        return state;
    }

    private static SiteImportHost ConnectedHost(StubLcuApi api, IChampionDirectory? champions = null) =>
        new(new RuneApplyService(api), new ItemSetApplyService(api),
            champions ?? new FakeChampionDirectory(JhinRoster), ConnectedState());

    private const string JhinUggJson = """
        {"source":"u.gg","championSlug":"jhin","role":"adc",
         "runes":{"primaryStyleId":8000,"subStyleId":8200,
          "perkIds":[8021,9111,9104,8014,8233,8237],"shardIds":[5005,5008,5011]},
         "itemBlocks":[{"title":"Core","itemIds":[3031,3033,3006]}]}
        """;

    private static void EnqueueRuneCreate(StubLcuApi api)
    {
        const string title = "CoachBuild import: Jhin ADC (u.gg)";
        api.Enqueue(Ok("[]"));
        api.Enqueue(Ok("{\"ownedPageCount\":5}"));
        api.Enqueue(Ok("{\"id\":7}"));
        api.Enqueue(Ok("7"));
        // The 2.1.0-round-2 prune re-reads the pages after selecting the new
        // one (RuneApplyService.PruneOwnedPagesAsync). Handing back a list
        // holding ONLY the page just written is also an assertion in itself:
        // with nothing over the cap no DELETE is issued, so the verification
        // read below is still the next call on the wire.
        api.Enqueue(Ok(
            "[{\"id\":7,\"name\":\"" + title + "\",\"isDeletable\":true,\"primaryStyleId\":8000," +
            "\"subStyleId\":8200,\"selectedPerkIds\":[],\"current\":true}]"));
        api.Enqueue(Ok(
            "{\"id\":7,\"name\":\"" + title + "\",\"isDeletable\":true,\"primaryStyleId\":8000,\"subStyleId\":8200," +
            "\"selectedPerkIds\":[8021,9111,9104,8014,8233,8237,5005,5008,5011],\"current\":true}"));
    }

    private static void EnqueueItemWrite(StubLcuApi api, long summonerId = 77)
    {
        api.Enqueue(Ok("{\"summonerId\":" + summonerId + "}"));
        api.Enqueue(Ok("{\"accountId\":" + summonerId + ",\"timestamp\":1,\"itemSets\":[]}"));
        api.Enqueue(Ok("{}"));
    }

    [Fact]
    public async Task Garbage_scrape_reports_bad_scrape_and_touches_no_lcu()
    {
        var api = new StubLcuApi();
        var result = await ConnectedHost(api).ImportBuildAsync("not json");

        var failure = Assert.IsType<SiteImportFailure>(result);
        Assert.Equal("bad-scrape", failure.Reason);
        Assert.Contains("nothing was imported", failure.Message, StringComparison.Ordinal);
        Assert.Empty(api.Calls);
    }

    [Fact]
    public async Task Unknown_slug_writes_nothing()
    {
        var api = new StubLcuApi();
        // Control: the default roster has no Jhin, so the slug genuinely
        // cannot resolve — the zero-call assertion below measures the miss.
        var host = ConnectedHost(api, new FakeChampionDirectory());
        var result = await host.ImportBuildAsync(JhinUggJson);

        var failure = Assert.IsType<SiteImportFailure>(result);
        Assert.Equal("unknown-champion", failure.Reason);
        Assert.Contains("jhin", failure.Message, StringComparison.Ordinal);
        Assert.Empty(api.Calls);
    }

    [Fact]
    public async Task Disconnected_client_reports_no_client_before_any_lcu_call()
    {
        var api = new StubLcuApi();
        var host = new SiteImportHost(
            new RuneApplyService(api), new ItemSetApplyService(api),
            new FakeChampionDirectory(JhinRoster), new CompanionState());

        var result = await host.ImportBuildAsync(JhinUggJson);

        var failure = Assert.IsType<SiteImportFailure>(result);
        Assert.Equal("no-client", failure.Reason);
        Assert.Empty(api.Calls);
    }

    [Fact]
    public async Task Connected_client_imports_runes_and_item_set()
    {
        var api = new StubLcuApi();
        EnqueueRuneCreate(api);
        EnqueueItemWrite(api);

        var result = await ConnectedHost(api).ImportBuildAsync(JhinUggJson);

        var success = Assert.IsType<SiteImportSuccess>(result);
        Assert.Equal("Imported runes + 3-item set for Jhin (ADC) from u.gg", success.Message);
        Assert.Contains(api.Calls, call => call.Path == "/lol-perks/v1/pages");
        Assert.Contains(api.Calls, call => call.Path.Contains("item-sets", StringComparison.Ordinal));
    }

    [Fact]
    public async Task Roster_loads_on_demand_when_the_cache_is_empty()
    {
        var api = new StubLcuApi();
        EnqueueRuneCreate(api);
        EnqueueItemWrite(api);
        var champions = new FakeChampionDirectory(JhinRoster, preloaded: false);

        var result = await ConnectedHost(api, champions).ImportBuildAsync(JhinUggJson);

        Assert.IsType<SiteImportSuccess>(result);
        Assert.Equal(1, champions.Loads);
    }

    [Fact]
    public async Task Items_without_runes_write_the_item_set_only()
    {
        // The Coachless overview shape: a real item build, no rune page.
        // Items-only is a success now: the item set is written, the rune
        // service is never touched, and the status names the missing half.
        const string itemsOnly = """
            {"source":"coachless","championSlug":"jhin","role":"adc","runes":null,
             "itemBlocks":[{"title":"Starter","itemIds":[1120]}]}
            """;
        var api = new StubLcuApi();
        EnqueueItemWrite(api);
        var result = await ConnectedHost(api).ImportBuildAsync(itemsOnly);

        var success = Assert.IsType<SiteImportSuccess>(result);
        Assert.Equal("Imported 1-item set (no rune page on this site) from Coachless", success.Message);
        Assert.Contains(api.Calls, call => call.Path.Contains("item-sets", StringComparison.Ordinal));
        Assert.DoesNotContain(api.Calls,
            call => call.Path.StartsWith("/lol-perks/", StringComparison.Ordinal));
    }

    [Fact]
    public async Task Runes_button_path_writes_the_rune_page_only()
    {
        // The offer-bar button: runes out of the u.gg payload, items never
        // flowing -- the item-set endpoints see zero calls even though the
        // payload carries an item build.
        var api = new StubLcuApi();
        EnqueueRuneCreate(api);
        var result = await ConnectedHost(api).ImportRunesAsync(JhinUggJson);

        var success = Assert.IsType<SiteImportSuccess>(result);
        Assert.Equal("Imported runes for Jhin (ADC) from u.gg", success.Message);
        Assert.Contains(api.Calls, call => call.Path == "/lol-perks/v1/pages");
        Assert.DoesNotContain(api.Calls,
            call => call.Path.Contains("item-sets", StringComparison.Ordinal));
    }

    [Fact]
    public async Task Runes_button_with_items_only_reports_no_runes_and_writes_nothing()
    {
        const string itemsOnly = """
            {"source":"coachless","championSlug":"jhin","role":"adc","runes":null,
             "itemBlocks":[{"title":"Starter","itemIds":[1120]}]}
            """;
        var api = new StubLcuApi();
        var result = await ConnectedHost(api).ImportRunesAsync(itemsOnly);

        var failure = Assert.IsType<SiteImportFailure>(result);
        Assert.Equal("bad-runes", failure.Reason);
        Assert.Contains("nothing was imported", failure.Message, StringComparison.Ordinal);
        Assert.Empty(api.Calls);
    }

    [Fact]
    public async Task Runes_button_disconnected_reports_no_client_before_any_lcu_call()
    {
        var api = new StubLcuApi();
        var host = new SiteImportHost(
            new RuneApplyService(api), new ItemSetApplyService(api),
            new FakeChampionDirectory(JhinRoster), new CompanionState());

        var result = await host.ImportRunesAsync(JhinUggJson);

        var failure = Assert.IsType<SiteImportFailure>(result);
        Assert.Equal("no-client", failure.Reason);
        Assert.Empty(api.Calls);
    }

    private static LcuResponse Ok(string raw)
    {
        using var document = JsonDocument.Parse(raw);
        return new LcuResponse(true, 200, document.RootElement.Clone(), raw);
    }
}
