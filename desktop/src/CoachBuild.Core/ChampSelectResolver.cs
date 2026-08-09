using System.Text.Json;

namespace CoachBuild.Core;

public sealed record ChampSelectMember(
    int CellId,
    int? ChampionId,
    int? ChampionPickIntent,
    string? AssignedPosition);

public sealed record ChampSelectAction(
    int ActorCellId,
    string Type,
    int? ChampionId,
    bool Completed);

public sealed record ChampSelectSession(
    int LocalPlayerCellId,
    IReadOnlyList<ChampSelectMember> MyTeam,
    IReadOnlyList<ChampSelectMember> TheirTeam,
    IReadOnlyList<IReadOnlyList<ChampSelectAction>> Actions,
    string? TimerPhase);

public sealed record ChampSelectResolution(
    int LocalPlayerCellId,
    int? CellChampionId,
    int? PickIntent,
    int? ActionChampionId,
    int? ChampionId,
    int? RoleId,
    IReadOnlyList<int> TheirTeam,
    string? TimerPhase);

public static class ChampSelectResolver
{
    public static ChampSelectResolution? Resolve(JsonElement session)
    {
        if (session.ValueKind != JsonValueKind.Object ||
            !session.TryGetProperty("localPlayerCellId", out var local) ||
            !local.TryGetInt32(out var localCellId) ||
            !session.TryGetProperty("myTeam", out var myTeam) || myTeam.ValueKind != JsonValueKind.Array)
            return null;

        JsonElement? ownCell = null;
        foreach (var member in myTeam.EnumerateArray())
        {
            if (member.ValueKind != JsonValueKind.Object ||
                !member.TryGetProperty("cellId", out var cell) ||
                !cell.TryGetInt32(out var cellId) || cellId != localCellId)
                continue;
            ownCell = member;
            break;
        }
        if (ownCell is null) return null;
        var cellValue = ownCell.Value;
        var cellChampion = ComplianceRules.PositiveInt(cellValue, "championId");
        var intent = ComplianceRules.PositiveInt(cellValue, "championPickIntent");
        var actionChampion = ComplianceRules.ResolveOwnActionChampionId(session, localCellId);
        var championId = cellChampion ?? intent ?? actionChampion;
        string? position = null;
        if (cellValue.TryGetProperty("assignedPosition", out var positionValue) &&
            positionValue.ValueKind == JsonValueKind.String)
            position = positionValue.GetString();

        return new ChampSelectResolution(
            localCellId,
            cellChampion,
            intent,
            actionChampion,
            championId,
            ComplianceRules.RoleIdFromPosition(position),
            ComplianceRules.ResolveTheirTeamChampionIds(session),
            ComplianceRules.ResolveTimerPhase(session));
    }

    public static ChampSelectResolution? Resolve(ChampSelectSession session)
    {
        var ownCell = session.MyTeam.FirstOrDefault(x => x.CellId == session.LocalPlayerCellId);
        if (ownCell is null) return null;
        var inProgress = session.Actions.SelectMany(x => x)
            .Where(x => x.ActorCellId == session.LocalPlayerCellId &&
                        string.Equals(x.Type, "pick", StringComparison.Ordinal) &&
                        x.ChampionId is > 0)
            .ToList();
        var action = inProgress.FirstOrDefault(x => !x.Completed) ?? inProgress.FirstOrDefault();
        var championId = ownCell.ChampionId is > 0
            ? ownCell.ChampionId
            : ownCell.ChampionPickIntent is > 0
                ? ownCell.ChampionPickIntent
                : action?.ChampionId;
        var enemyIds = session.TheirTeam
            .Select(x => x.ChampionId is > 0 ? x.ChampionId : x.ChampionPickIntent)
            .Where(x => x is > 0)
            .Select(x => x!.Value)
            .ToArray();
        return new ChampSelectResolution(
            session.LocalPlayerCellId,
            ownCell.ChampionId is > 0 ? ownCell.ChampionId : null,
            ownCell.ChampionPickIntent is > 0 ? ownCell.ChampionPickIntent : null,
            action?.ChampionId,
            championId,
            ComplianceRules.RoleIdFromPosition(ownCell.AssignedPosition),
            enemyIds,
            session.TimerPhase);
    }

    public static ChampSelectSession? Parse(JsonElement session)
    {
        if (session.ValueKind != JsonValueKind.Object ||
            !session.TryGetProperty("localPlayerCellId", out var local) || !local.TryGetInt32(out var localCellId))
            return null;

        static int? ReadId(JsonElement value, string name) => ComplianceRules.PositiveInt(value, name);
        static string? ReadString(JsonElement value, string name) => ComplianceRules.NonBlankString(value, name);

        static IReadOnlyList<ChampSelectMember> ReadMembers(JsonElement value)
        {
            if (value.ValueKind != JsonValueKind.Array) return [];
            var result = new List<ChampSelectMember>();
            foreach (var item in value.EnumerateArray())
            {
                if (item.ValueKind != JsonValueKind.Object ||
                    !item.TryGetProperty("cellId", out var cell) || !cell.TryGetInt32(out var cellId))
                    continue;
                result.Add(new ChampSelectMember(
                    cellId,
                    ReadId(item, "championId"),
                    ReadId(item, "championPickIntent"),
                    ReadString(item, "assignedPosition")));
            }
            return result;
        }

        var myTeam = session.TryGetProperty("myTeam", out var mine) ? ReadMembers(mine) : [];
        var theirTeam = session.TryGetProperty("theirTeam", out var theirs) ? ReadMembers(theirs) : [];
        var actions = new List<IReadOnlyList<ChampSelectAction>>();
        if (session.TryGetProperty("actions", out var actionRows) && actionRows.ValueKind == JsonValueKind.Array)
        {
            foreach (var row in actionRows.EnumerateArray())
            {
                var parsed = new List<ChampSelectAction>();
                var values = row.ValueKind == JsonValueKind.Array ? row.EnumerateArray() : new[] { row }.AsEnumerable();
                foreach (var action in values)
                {
                    if (action.ValueKind != JsonValueKind.Object ||
                        !action.TryGetProperty("actorCellId", out var actor) || !actor.TryGetInt32(out var actorCell))
                        continue;
                    var type = ReadString(action, "type") ?? string.Empty;
                    var completed = action.TryGetProperty("completed", out var done) && done.ValueKind == JsonValueKind.True;
                    parsed.Add(new ChampSelectAction(actorCell, type, ReadId(action, "championId"), completed));
                }
                actions.Add(parsed);
            }
        }
        var timerPhase = session.TryGetProperty("timer", out var timer)
            ? ReadString(timer, "phase")
            : null;
        return new ChampSelectSession(localCellId, myTeam, theirTeam, actions, timerPhase);
    }
}

