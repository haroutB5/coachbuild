using System.Text.Json;
using CoachBuild.Core;
using Xunit;

namespace CoachBuild.Core.Tests;

public sealed class ChampSelectDecisionTests
{
    [Fact]
    public void Resolver_uses_cell_then_intent_then_own_flattened_action_and_exposes_ids_only()
    {
        using var document = JsonDocument.Parse("""
        {
          "localPlayerCellId": 10,
          "myTeam": [{"cellId":10,"championId":0,"championPickIntent":0,"assignedPosition":"bottom","summonerId":"must-not-read"}],
          "theirTeam": [{"championId":0,"championPickIntent":103,"summonerId":"hidden"},{"championId":22,"championPickIntent":0}],
          "actions": [[{"actorCellId":10,"type":"pick","championId":84,"completed":true}], [{"actorCellId":10,"type":"pick","championId":103,"completed":false}]],
          "timer": {"phase":"BAN_PICK"}
        }
        """);
        var resolved = ChampSelectResolver.Resolve(document.RootElement)!;

        Assert.Equal(103, resolved.ChampionId);
        Assert.Equal(103, resolved.ActionChampionId);
        Assert.Equal(3, resolved.RoleId);
        Assert.Equal([103, 22], resolved.TheirTeam);
        Assert.Equal("BAN_PICK", resolved.TimerPhase);
    }

    [Fact]
    public void One_window_table_opens_draft_once_then_live_follows_changes()
    {
        var now = DateTimeOffset.UtcNow;
        var service = new WindowDecisionService("session");
        var entry = service.OnChampSelectEntry(now);
        Assert.Equal(WindowDecisionKind.OpenDraft, entry.Kind);
        Assert.Contains("/draft?session=session", entry.Url, StringComparison.Ordinal);

        var first = service.OnChampSelectPoll(Resolution(103, 2), now.AddSeconds(1));
        Assert.Equal(WindowDecisionKind.None, first.Kind);
        var changed = service.OnChampSelectPoll(Resolution(22, 3), now.AddSeconds(2));
        Assert.Equal(WindowDecisionKind.None, changed.Kind);

        var reopen = service.Reopen("ChampSelect");
        Assert.Equal(WindowDecisionKind.ReopenDraft, reopen.Kind);
        Assert.Contains("/draft", reopen.Url, StringComparison.Ordinal);
        service.OnPhaseChanged("InProgress");
        var builds = service.Reopen("InProgress");
        Assert.Equal(WindowDecisionKind.ReopenBuilds, builds.Kind);
        Assert.Contains("championId=22", builds.Url, StringComparison.Ordinal);
    }

    [Fact]
    public void Fresh_follow_suppresses_open_but_detach_and_liveness_reopen_after_windows_expire()
    {
        var now = DateTimeOffset.UtcNow;
        var tracker = new FollowAttachmentTracker();
        tracker.RecordFollow(FollowKind.Builds, now);
        var service = new WindowDecisionService("session", attachments: tracker);
        var attached = service.OnChampSelectEntry(now.AddSeconds(1), browserAlive: true);
        Assert.Equal(WindowDecisionKind.None, attached.Kind);

        tracker.RecordDetach(FollowKind.Builds, now.AddSeconds(2));
        var afterDetach = new WindowDecisionService("session", attachments: tracker).OnChampSelectEntry(now.AddSeconds(3));
        Assert.Equal(WindowDecisionKind.OpenDraft, afterDetach.Kind);

        var deadTracker = new FollowAttachmentTracker();
        deadTracker.RecordFollow(FollowKind.Builds, now);
        var deadBrowser = new WindowDecisionService("session", attachments: deadTracker).OnChampSelectEntry(
            now.AddSeconds(3), browserAlive: false);
        Assert.Equal(WindowDecisionKind.OpenDraft, deadBrowser.Kind);
        Assert.False(tracker.IsAttached(FollowKind.Builds, now.AddSeconds(151), browserAlive: true));
    }

    private static ChampSelectResolution Resolution(int champion, int role) => new(
        1, champion, champion, champion, champion, role, [], "PLANNING");
}
