using System.Net.Http;
using System.Text.Json;
using CoachBuild.Core;
using CoachBuild.Desktop.Web;
using Xunit;

namespace CoachBuild.Desktop.Tests;

/// <summary>
/// Contract checks for the companion tab model. These deliberately exercise
/// the pure tab/link/navigation policies so they can run without WebView2,
/// League, an LCU process, or a writable production profile.
/// </summary>
public sealed class CompanionTabsIntegrationTests
{
    [Fact]
    public void Tab_order_and_labels_are_stable()
    {
        Assert.Equal(
            [CompanionTab.Companion, CompanionTab.UGg, CompanionTab.Coachless, CompanionTab.OpGg],
            CompanionTabs.Order);
        Assert.Equal("Draft", CompanionTabs.LabelFor(CompanionTab.Companion));
        Assert.Equal("u.gg", CompanionTabs.LabelFor(CompanionTab.UGg));
        Assert.Equal("Coachless", CompanionTabs.LabelFor(CompanionTab.Coachless));
        Assert.Equal("MyStats", CompanionTabs.LabelFor(CompanionTab.OpGg));
        Assert.Equal(3, CompanionTabs.Sites.Count);
        Assert.Equal([CompanionTabs.UGg, CompanionTabs.Coachless], CompanionTabs.BuildSites);
    }

    [Theory]
    [InlineData("companion", CompanionTab.Companion)]
    [InlineData(" UGG ", CompanionTab.UGg)]
    [InlineData("coachless", CompanionTab.Coachless)]
    [InlineData("OPGG", CompanionTab.OpGg)]
    [InlineData("future-tab", CompanionTab.Companion)]
    [InlineData(null, CompanionTab.Companion)]
    public void Persisted_tab_keys_fail_closed_to_companion(string? key, CompanionTab expected)
    {
        Assert.Equal(expected, CompanionTabs.ParseKey(key));
        Assert.Equal(expected switch
        {
            CompanionTab.UGg => "ugg",
            CompanionTab.Coachless => "coachless",
            CompanionTab.OpGg => "opgg",
            _ => "companion",
        }, CompanionTabs.KeyFor(expected));
    }

    [Fact]
    public void Third_party_sites_are_https_and_never_carry_the_session_token()
    {
        var token = new string('a', 64);

        foreach (var site in CompanionTabs.Sites)
        {
            Assert.Equal(Uri.UriSchemeHttps, site.Home.Scheme);
            Assert.True(SiteNavigationPolicy.IsAllowed(site.Home));
            Assert.DoesNotContain("session", site.Home.Query, StringComparison.OrdinalIgnoreCase);

            var link = site.BuildUrl("MonkeyKing", roleId: 1);
            if (site.Tab == CompanionTab.OpGg)
            {
                Assert.Null(link);
            }
            else
            {
                Assert.NotNull(link);
                Assert.Equal(Uri.UriSchemeHttps, link!.Scheme);
                Assert.DoesNotContain(token, link.ToString(), StringComparison.Ordinal);
                Assert.DoesNotContain("session=", link.ToString(), StringComparison.OrdinalIgnoreCase);
            }
        }
    }

    [Fact]
    public void Site_profiles_are_separate_and_the_companion_profile_keeps_the_legacy_root()
    {
        var root = Path.Combine(Path.GetTempPath(), "coachbuild-tabs-test", "profiles");

        var companion = CompanionTabs.ProfileFolder(root, CompanionTab.Companion);
        var ugg = CompanionTabs.ProfileFolder(root, CompanionTab.UGg);
        var coachless = CompanionTabs.ProfileFolder(root, CompanionTab.Coachless);
        var opgg = CompanionTabs.ProfileFolder(root, CompanionTab.OpGg);

        Assert.Equal(Path.GetFullPath(root), companion);
        Assert.Equal(Path.Combine(Path.GetFullPath(root), "ugg"), ugg);
        Assert.Equal(Path.Combine(Path.GetFullPath(root), "coachless"), coachless);
        Assert.Equal(Path.Combine(Path.GetFullPath(root), "opgg"), opgg);
        Assert.NotEqual(companion, ugg);
        Assert.NotEqual(ugg, coachless);
        Assert.NotEqual(coachless, opgg);
        Assert.DoesNotContain("session", ugg, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("session", coachless, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("session", opgg, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void Last_tab_and_zoom_preferences_are_independent_and_bounded()
    {
        var preferences = new CompanionTabsPreferences(
            CompanionTab.Coachless,
            new Dictionary<CompanionTab, double>
            {
                [CompanionTab.UGg] = 1.35,
            });

        Assert.Equal(CompanionTab.Coachless, preferences.LastTab);
        Assert.Equal(1.35, preferences.ZoomFor(CompanionTab.UGg), precision: 3);
        Assert.Equal(CompanionTabsPreferences.DefaultZoomFactor, preferences.ZoomFor(CompanionTab.Coachless));

        var changed = preferences
            .WithZoom(CompanionTab.Coachless, 9)
            .WithZoom(CompanionTab.UGg, 0.01)
            .WithZoom((CompanionTab)99, 1.7);

        Assert.Equal(CompanionTabsPreferences.MaxZoomFactor, changed.ZoomFor(CompanionTab.Coachless));
        Assert.Equal(CompanionTabsPreferences.MinZoomFactor, changed.ZoomFor(CompanionTab.UGg));
        Assert.Equal(CompanionTab.Coachless, changed.LastTab);
        Assert.Equal(
            CompanionTab.Companion,
            changed.WithLastTab((CompanionTab)99).LastTab);
        Assert.Equal(
            CompanionTabsPreferences.DefaultZoomFactor,
            CompanionTabsPreferences.NormalizeZoom(double.NaN));
    }

    [Fact]
    public void Champion_links_are_role_aware_and_use_the_shared_normalized_key()
    {
        var ugg = SiteDeepLink.Build(CompanionTab.UGg, "Monkey King", roleId: 1);
        var coachless = SiteDeepLink.Build(CompanionTab.Coachless, "Kai'Sa", roleId: 4);

        Assert.Equal("https://u.gg/lol/champions/monkeyking/build/jungle", ugg?.ToString());
        Assert.Equal("https://coachless.gg/builds/kaisa?role=support", coachless?.ToString());

        Assert.Null(SiteDeepLink.Build(CompanionTab.Companion, "Urgot", roleId: 0));
        Assert.Equal("https://u.gg/lol/champions/urgot/build", SiteDeepLink.Build(CompanionTab.UGg, "Urgot", roleId: 99)?.ToString());
        Assert.Null(SiteDeepLink.Build(CompanionTab.UGg, "", roleId: 0));
        Assert.Null(SiteDeepLink.Build(CompanionTab.OpGg, "Urgot", roleId: 0));
    }

    [Theory]
    [InlineData("EUW1", "euw")]
    [InlineData("eun1", "eune")]
    [InlineData("NA1", "na")]
    [InlineData("OC1", "oce")]
    [InlineData("ME1", "me")]
    [InlineData("unknown", null)]
    [InlineData(null, null)]
    public void Opgg_region_comes_from_an_explicit_platform_mapping(string? platformId, string? expected)
    {
        Assert.Equal(expected, OpGgProfileLink.RegionForPlatform(platformId));
    }

    [Fact]
    public void Opgg_profile_link_encodes_the_riot_id_components()
    {
        var profile = OpGgProfileLink.Build(" K1ayer Name ", "swift/tag", "EUW1");

        Assert.Equal(
            "https://op.gg/summoners/euw/K1ayer%20Name-swift%2Ftag",
            profile?.AbsoluteUri);
        Assert.Null(OpGgProfileLink.Build("K1ayer", "swift", "unknown"));
        Assert.Null(OpGgProfileLink.Build("", "swift", "EUW1"));
    }

    [Fact]
    public async Task Opgg_resolver_reads_current_summoner_then_platform_id()
    {
        var lcu = new RecordingLcuApi(new Dictionary<string, LcuResponse>
        {
            [OpGgProfileResolver.CurrentSummonerPath] = Ok("""
                { "gameName": "K1ayer Name", "tagLine": "swift", "puuid": "local-id" }
                """),
            [OpGgProfileResolver.PlatformIdPath] = Ok("\"EUW1\""),
        });

        var profile = await new OpGgProfileResolver(lcu).ResolveAsync();

        Assert.Equal("https://op.gg/summoners/euw/K1ayer%20Name-swift", profile?.AbsoluteUri);
        Assert.Equal(
            [OpGgProfileResolver.CurrentSummonerPath, OpGgProfileResolver.PlatformIdPath],
            lcu.Paths);
    }

    [Fact]
    public async Task Opgg_resolver_returns_home_signal_without_a_live_client()
    {
        var lcu = new RecordingLcuApi(new Dictionary<string, LcuResponse>());

        var profile = await new OpGgProfileResolver(lcu).ResolveAsync();

        Assert.Null(profile);
        Assert.Equal([OpGgProfileResolver.CurrentSummonerPath], lcu.Paths);
    }

    [Fact]
    public void Champ_select_chip_explains_hover_and_lock_state()
    {
        var site = CompanionTabs.UGg;
        var hovered = new ChampSelectContext(11, "MonkeyKing", "Wukong", 1, Locked: false);
        var locked = hovered with { Locked = true };

        Assert.Equal("Open Wukong Jungle on u.gg (hovered)", hovered.ChipLabel(site));
        Assert.Equal("Open Wukong Jungle on u.gg", locked.ChipLabel(site));
        Assert.Equal(hovered.UrlFor(site), locked.UrlFor(site));
    }

    [Theory]
    [InlineData("https://u.gg/lol/champions/urgot/build/top", true)]
    [InlineData("https://coachless.gg/builds/urgot?role=top", true)]
    [InlineData("http://u.gg/lol/champions/urgot/build/top", false)]
    [InlineData("javascript:alert(1)", false)]
    [InlineData("file:///C:/Windows/System32", false)]
    [InlineData("riotclient://launch", false)]
    [InlineData("not a uri", false)]
    public void Site_navigation_policy_allows_https_only(string value, bool expected)
    {
        Assert.Equal(expected, SiteNavigationPolicy.IsAllowed(value));
    }

    [Fact]
    public void Already_there_compares_origin_and_path_but_ignores_site_query_rewrites()
    {
        var offer = new Uri("https://u.gg/lol/champions/urgot/build/top");

        Assert.True(SiteNavigationPolicy.IsAlreadyThere(
            "https://u.gg/lol/champions/urgot/build/top?utm_source=coachbuild", offer));
        Assert.False(SiteNavigationPolicy.IsAlreadyThere(
            "https://u.gg/lol/champions/urgot/build/jungle", offer));
        Assert.False(SiteNavigationPolicy.IsAlreadyThere(
            "https://evil.example/lol/champions/urgot/build/top", offer));
        Assert.False(SiteNavigationPolicy.IsAlreadyThere(null, offer));
    }

    [Fact]
    public void Already_there_keeps_coachless_role_changes_distinct()
    {
        var offer = new Uri("https://coachless.gg/builds/urgot?role=top");

        Assert.True(SiteNavigationPolicy.IsAlreadyThere(
            "https://coachless.gg/builds/urgot?role=top&utm_campaign=companion", offer));
        Assert.False(SiteNavigationPolicy.IsAlreadyThere(
            "https://coachless.gg/builds/urgot?role=jungle", offer));
        Assert.False(SiteNavigationPolicy.IsAlreadyThere(
            "https://coachless.gg/builds/urgot", offer));
    }

    private static LcuResponse Ok(string json)
    {
        using var document = JsonDocument.Parse(json);
        return new LcuResponse(true, 200, document.RootElement.Clone(), json);
    }

    private sealed class RecordingLcuApi(IReadOnlyDictionary<string, LcuResponse> responses) : ILcuApi
    {
        public List<string> Paths { get; } = [];

        public Task<LcuResponse> SendAsync(
            HttpMethod method,
            string path,
            object? body = null,
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            Assert.Equal(HttpMethod.Get, method);
            Paths.Add(path);
            return Task.FromResult(
                responses.TryGetValue(path, out var response)
                    ? response
                    : new LcuResponse(false, 0));
        }
    }
}
