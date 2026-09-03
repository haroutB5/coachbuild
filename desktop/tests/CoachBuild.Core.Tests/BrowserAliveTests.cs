using System.Net.Http;
using System.Text.Json;
using CoachBuild.Core;
using Xunit;

namespace CoachBuild.Core.Tests;

/// <summary>
/// The poller used to pass <c>browserAlive: true</c> literally at every call
/// site, neutering FollowAttachmentTracker.IsAttached's hard-kill safeguard:
/// a crashed browser kept its stale attach stamp for the full 150 s window
/// and suppressed the draft window the user was waiting for. These drive the
/// real GameflowPoller with an injected probe (and cover the session-token
/// validation the probe's trust decision sits beside).
/// </summary>
public sealed class BrowserAliveTests
{
    [Theory]
    [InlineData("0123456789abcdef0123456789ABCDEF", true)]
    [InlineData("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", true)]
    [InlineData("", false)]
    [InlineData(null, false)]
    [InlineData("   ", false)]
    [InlineData("0123456789abcdef", false)]
    [InlineData("0123456789abcdef0123456789abcdeg", false)]
    [InlineData("zz-top-is-not-a-token-at-all-!!!!", false)]
    public void Session_token_validation_accepts_both_minted_shapes_and_nothing_else(string? token, bool valid)
    {
        Assert.Equal(valid, SessionTokenStore.IsValidSessionToken(token));
    }

    [Fact]
    public void GetOrCreate_regenerates_a_corrupt_token_file_instead_of_persisting_it()
    {
        var root = Path.Combine(Path.GetTempPath(), $"coachbuild-token-{Guid.NewGuid():N}");
        var store = new SessionTokenStore(root);
        Directory.CreateDirectory(root);
        File.WriteAllText(store.FilePath, "tampered-token-!!!");
        var token = store.GetOrCreate();
        Assert.True(SessionTokenStore.IsValidSessionToken(token));
        Assert.Equal(token, File.ReadAllText(store.FilePath).Trim());
        Assert.True(store.TryRead(out var reread));
        Assert.Equal(token, reread);
    }

    [Fact]
    public void GetOrCreate_keeps_a_valid_token_stable_across_restarts()
    {
        var root = Path.Combine(Path.GetTempPath(), $"coachbuild-token-{Guid.NewGuid():N}");
        var first = new SessionTokenStore(root).GetOrCreate();
        var second = new SessionTokenStore(root).GetOrCreate();
        Assert.Equal(first, second);
    }

    [Fact]
    public void TryRead_reports_false_on_a_corrupt_token_file()
    {
        var root = Path.Combine(Path.GetTempPath(), $"coachbuild-token-{Guid.NewGuid():N}");
        var store = new SessionTokenStore(root);
        Directory.CreateDirectory(root);
        File.WriteAllText(store.FilePath, "short");
        Assert.False(store.TryRead(out var token));
        Assert.Null(token);
    }

    [Fact]
    public async Task Dead_browser_kills_a_stale_attach_at_champ_select_entry()
    {
        var state = new CompanionState();
        var api = new MockLcuApi();
        var windows = new WindowDecisionService("session", attachments: state.FollowAttachments);
        // A live tab's follow stamp, as the bridge records it on /status.
        state.FollowAttachments.RecordFollow(FollowKind.Builds, DateTimeOffset.UtcNow);
        var poller = new GameflowPoller(Resolver(), api, state, windows, browserAliveProbe: () => false);

        api.Enqueue(HttpMethod.Get, "/lol-gameflow/v1/gameflow-phase", Phase("ChampSelect"));
        api.Enqueue(HttpMethod.Get, "/lol-champ-select/v1/session", Session(103));
        var decision = await poller.TickAsync();

        Assert.Equal(WindowDecisionKind.OpenDraft, decision!.Kind);
    }

    [Fact]
    public async Task Live_browser_keeps_suppressing_while_a_tab_is_attached()
    {
        var state = new CompanionState();
        var api = new MockLcuApi();
        var windows = new WindowDecisionService("session", attachments: state.FollowAttachments);
        state.FollowAttachments.RecordFollow(FollowKind.Builds, DateTimeOffset.UtcNow);
        var poller = new GameflowPoller(Resolver(), api, state, windows, browserAliveProbe: () => true);

        api.Enqueue(HttpMethod.Get, "/lol-gameflow/v1/gameflow-phase", Phase("ChampSelect"));
        api.Enqueue(HttpMethod.Get, "/lol-champ-select/v1/session", Session(103));
        var decision = await poller.TickAsync();

        Assert.Equal(WindowDecisionKind.None, decision!.Kind);
    }

    [Fact]
    public async Task Throwing_probe_fails_open_to_alive_never_to_a_reopen_storm()
    {
        var state = new CompanionState();
        var api = new MockLcuApi();
        var windows = new WindowDecisionService("session", attachments: state.FollowAttachments);
        state.FollowAttachments.RecordFollow(FollowKind.Builds, DateTimeOffset.UtcNow);
        var poller = new GameflowPoller(
            Resolver(), api, state, windows,
            browserAliveProbe: () => throw new InvalidOperationException("probe blew up"));

        api.Enqueue(HttpMethod.Get, "/lol-gameflow/v1/gameflow-phase", Phase("ChampSelect"));
        api.Enqueue(HttpMethod.Get, "/lol-champ-select/v1/session", Session(103));
        var decision = await poller.TickAsync();

        Assert.Equal(WindowDecisionKind.None, decision!.Kind);
    }

    [Fact]
    public void Known_browser_names_cover_the_companion_script_list()
    {
        // The C# probe and Test-BrowserProcessRunning must name the same
        // processes, or one bridge reopens over a browser the other can see.
        Assert.Contains("chrome", BrowserProcessProbe.KnownBrowserProcessNames);
        Assert.Contains("msedge", BrowserProcessProbe.KnownBrowserProcessNames);
        Assert.Contains("firefox", BrowserProcessProbe.KnownBrowserProcessNames);
        Assert.DoesNotContain("LeagueClientUx", BrowserProcessProbe.KnownBrowserProcessNames);
    }

    private static LcuCredentialResolver Resolver() => new(
        new FixedProcessSource(),
        _ => null,
        Path.Combine(Path.GetTempPath(), $"coachbuild-missing-{Guid.NewGuid():N}"));

    private static LcuResponse Ok(string raw) => new(true, 200, MockLcuApi.Json(raw), raw);

    private static LcuResponse Phase(string phase) => Ok(JsonSerializer.Serialize(phase));

    private static LcuResponse Session(int championId) => Ok(
        $"{{\"localPlayerCellId\":10,\"myTeam\":[{{\"cellId\":10,\"championId\":{championId},"
        + "\"championPickIntent\":0,\"assignedPosition\":\"middle\"}],\"theirTeam\":[],"
        + "\"actions\":[],\"timer\":{\"phase\":\"PLANNING\"}}");

    private sealed class FixedProcessSource : ILeagueClientProcessSource
    {
        public IEnumerable<LeagueClientProcess> GetProcesses() =>
            [new LeagueClientProcess("LeagueClientUx.exe", "--app-port=51234 --remoting-auth-token=test")];
    }
}
