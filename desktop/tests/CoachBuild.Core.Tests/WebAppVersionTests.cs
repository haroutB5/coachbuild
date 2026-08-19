using System.Net;
using CoachBuild.Core;
using Xunit;

namespace CoachBuild.Core.Tests;

/// <summary>
/// 1.0.15 — the hosted window was running web code the site had already
/// replaced, and nothing could see it.
///
/// <para>The mechanism is in <see cref="WindowDecisionService"/> and is
/// pinned first, because a fix aimed at the wrong cause would still pass every
/// test below it: an OPEN, FOLLOWING window makes champ-select entry decide
/// <see cref="WindowDecisionKind.None"/>, so nothing navigates, so the page
/// keeps executing whatever bundle it loaded. That is correct behaviour for
/// WINDOWS and wrong for CODE, and 1.0.15 separates the two.</para>
/// </summary>
public sealed class WebAppVersionTests
{
    private static ChampSelectResolution Resolution(int championId, int roleId) =>
        new(10, championId, null, championId, championId, roleId, [], "BAN_PICK");

    // ── The mechanism, stated as a test ───────────────────────────────────────

    [Fact]
    public void An_attached_window_makes_champ_select_entry_navigate_nothing()
    {
        // This is the whole defect. It is not a bug in this service — the
        // one-window rule is deliberate — but it means "the page reloads at
        // champ select" is FALSE for the common case, which is what the
        // freshness check exists to compensate for.
        var now = DateTimeOffset.UtcNow;
        var attachments = new FollowAttachmentTracker();
        var service = new WindowDecisionService("session", attachments: attachments);

        // Nobody attached yet: champ select opens the draft page, and that
        // navigation is what would have picked up a new deploy.
        Assert.Equal(WindowDecisionKind.OpenDraft, service.OnChampSelectEntry(Resolution(103, 2), now).Kind);

        // A page that is following (the state any open window reaches within a
        // second of loading) — and the next champ select navigates nothing.
        service.OnPhaseChanged("None");
        attachments.RecordFollow(FollowKind.Draft, now.AddMinutes(30));
        var entry = service.OnChampSelectEntry(Resolution(103, 2), now.AddMinutes(30));
        Assert.Equal(WindowDecisionKind.None, entry.Kind);
        Assert.Null(entry.Url);
    }

    [Fact]
    public void A_following_page_stays_attached_far_longer_than_a_champ_select()
    {
        // Why the window is essentially never re-navigated in practice: the
        // attach window is 150s and the page polls every second, so the
        // attachment is refreshed ~150 times before it could ever lapse.
        var now = DateTimeOffset.UtcNow;
        var attachments = new FollowAttachmentTracker();
        attachments.RecordFollow(FollowKind.Draft, now);
        Assert.True(attachments.IsAnyAttached(now.AddSeconds(CompanionWire.AttachWindowSeconds - 1)));
        Assert.False(attachments.IsAnyAttached(now.AddSeconds(CompanionWire.AttachWindowSeconds + 1)));
        Assert.True(CompanionWire.AttachWindowSeconds >= 60);
    }

    // ── The comparison ────────────────────────────────────────────────────────

    [Fact]
    public void Compare_reloads_on_a_different_version_and_not_on_the_same_one()
    {
        Assert.Equal(WebFreshness.Current, WebAppVersionClient.Compare("0.113.0", "0.113.0"));
        Assert.Equal(WebFreshness.Stale, WebAppVersionClient.Compare("0.111.0", "0.112.0"));
        Assert.Equal(WebFreshness.Stale, WebAppVersionClient.Compare("0.113.0", "0.113.1"));
        // Whitespace from a meta tag must not read as a different build.
        Assert.Equal(WebFreshness.Current, WebAppVersionClient.Compare(" 0.113.0 ", "0.113.0"));
    }

    [Fact]
    public void A_page_with_no_version_tag_is_STALE_not_unknown()
    {
        // The meta tag arrived in web 0.113.0. Its absence dates the page: it
        // is the oldest thing that can be in that window, and it is exactly
        // what the reported user had. Treating it as "unknown, leave alone"
        // would make the fix a no-op for the very case it was built for.
        Assert.Equal(WebFreshness.StaleUntagged, WebAppVersionClient.Compare(null, "0.113.0"));
        Assert.Equal(WebFreshness.StaleUntagged, WebAppVersionClient.Compare("", "0.113.0"));
        Assert.Equal(WebFreshness.StaleUntagged, WebAppVersionClient.Compare("   ", "0.113.0"));
    }

    [Fact]
    public void An_unreachable_site_never_triggers_a_reload()
    {
        // The other direction, and it must not be symmetric with the one
        // above. An offline user mid-draft must keep the page they have.
        Assert.Equal(WebFreshness.Unknown, WebAppVersionClient.Compare("0.113.0", null));
        Assert.Equal(WebFreshness.Unknown, WebAppVersionClient.Compare(null, null));
        Assert.Equal(WebFreshness.Unknown, WebAppVersionClient.Compare("0.113.0", "  "));
    }

    // ── The wire ──────────────────────────────────────────────────────────────

    [Fact]
    public void ReadVersion_takes_the_field_and_refuses_everything_else()
    {
        Assert.Equal("0.113.0", WebAppVersionClient.ReadVersion("{\"version\":\"0.113.0\"}"));
        Assert.Null(WebAppVersionClient.ReadVersion("{\"version\":null}"));
        Assert.Null(WebAppVersionClient.ReadVersion("{\"version\":113}"));
        Assert.Null(WebAppVersionClient.ReadVersion("{}"));
        Assert.Null(WebAppVersionClient.ReadVersion("[]"));
        Assert.Null(WebAppVersionClient.ReadVersion("<!doctype html>"));
        Assert.Null(WebAppVersionClient.ReadVersion(""));
        Assert.Null(WebAppVersionClient.ReadVersion(null));
    }

    [Fact]
    public void The_client_asks_the_deployed_origin_for_the_route_the_web_app_added()
    {
        var client = new WebAppVersionClient("https://coachbuild.vercel.app");
        Assert.Equal("https://coachbuild.vercel.app/api/app-version", client.Endpoint.ToString());
        Assert.Equal("/api/app-version", WebAppVersionClient.VersionPath);
    }

    [Fact]
    public async Task A_non_200_returns_null_rather_than_a_version()
    {
        // A deployment older than web 0.113.0 has no such route, and a 404
        // body is not a version. Same class as offline: change nothing.
        var handler = new StubHandler(HttpStatusCode.NotFound, "Not Found");
        var client = new WebAppVersionClient("https://coachbuild.vercel.app", handler);
        Assert.Null(await client.GetVersionAsync());
    }

    [Fact]
    public async Task A_200_with_the_field_returns_it_and_asks_for_no_cache()
    {
        var handler = new StubHandler(HttpStatusCode.OK, "{\"version\":\"0.113.1\"}");
        var client = new WebAppVersionClient("https://coachbuild.vercel.app", handler);
        Assert.Equal("0.113.1", await client.GetVersionAsync());
        // A cached answer would report the version of whichever deployment
        // filled the cache — the exact failure this endpoint detects.
        Assert.True(handler.LastRequest?.Headers.CacheControl?.NoStore);
        Assert.True(handler.LastRequest?.Headers.CacheControl?.NoCache);
    }

    [Fact]
    public async Task A_thrown_transport_returns_null_instead_of_taking_champ_select_with_it()
    {
        var client = new WebAppVersionClient("https://coachbuild.vercel.app", new ThrowingHandler());
        Assert.Null(await client.GetVersionAsync());
    }

    private sealed class StubHandler : HttpMessageHandler
    {
        private readonly HttpStatusCode _status;
        private readonly string _body;

        public StubHandler(HttpStatusCode status, string body)
        {
            _status = status;
            _body = body;
        }

        public HttpRequestMessage? LastRequest { get; private set; }

        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            LastRequest = request;
            return Task.FromResult(new HttpResponseMessage(_status)
            {
                Content = new StringContent(_body),
            });
        }
    }

    private sealed class ThrowingHandler : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken) =>
            throw new HttpRequestException("no route to host");
    }
}
