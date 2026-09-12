using System.Text;
using System.Text.Json;

namespace CoachBuild.Core;

/// <summary>
/// Builds a <see cref="LaneScoreGame"/> out of whatever the League client hands
/// back when a game ends.
///
/// <para><b>Read this before changing a field name below.</b> This parser was
/// written WITHOUT a live client to measure against: the League client was not
/// running on the development machine (the app's own log records
/// <c>lcu_discovery_failed</c> across all four discovery layers), so the exact
/// spelling the platform uses for a participant's position could not be
/// confirmed. Rather than pick one spelling and hope, the parser <b>probes a
/// list of candidates and records which one actually matched</b> in
/// <see cref="LaneScoreGame.PositionSource"/>, and
/// <see cref="Describe"/> writes a key inventory to the log. The first real
/// ranked game therefore turns this from a guess into a measurement, and the
/// line naming the winning field is in companion.log.</para>
///
/// <para><b>And when nothing matches, it says so.</b> An unresolved position
/// yields <c>OpponentChampionId = null</c>, which makes the card ask the user
/// which of the five enemies they laned against. That is the brief's explicit
/// instruction and it is the whole reason this can ship un-measured: a wrong
/// opponent silently poisons the recommendation forever, an unknown one costs
/// the user one tap.</para>
/// </summary>
public static class LaneScoreCapture
{
    /// <summary>
    /// Where a game id might live. <c>gameId</c> is the one every shape of this
    /// payload has ever used; the rest are cheap insurance.
    /// </summary>
    private static readonly string[] GameIdKeys = ["gameId", "matchId", "id"];

    /// <summary>
    /// Where the queue might live. This one MATTERS more than the others,
    /// because failing to read it means the ranked-only gate fails closed and
    /// the feature silently never fires.
    /// </summary>
    private static readonly string[] QueueIdKeys = ["queueId", "gameQueueConfigId", "queue"];

    /// <summary>
    /// Where a participant's lane might live, most specific first.
    /// <c>teamPosition</c>/<c>individualPosition</c> are the match-history
    /// spellings; <c>selectedPosition</c> is the one the end-of-game block has
    /// historically used. All are probed; the winner is reported.
    /// </summary>
    private static readonly string[] PositionKeys =
        ["teamPosition", "individualPosition", "detectedTeamPosition", "selectedPosition", "position", "lane"];

    /// <summary>
    /// The queue, numeric where the payload has one, else from the end-of-game
    /// block's <c>queueType</c>. The REAL end-of-game block carries no numeric
    /// queue id at all, only <c>queueType</c> and <c>ranked</c> (gaming PC,
    /// ranked, 2026-09-11 23:58), so the ranked gate failed closed on it and
    /// capture fell back to a match history that had not caught up yet. Only
    /// the two ranked spellings map; anything else stays unknown.
    /// </summary>
    private static int? ReadQueueId(JsonElement root) =>
        ReadInt(root, QueueIdKeys) ?? ReadString(root, ["queueType"])?.Trim().ToUpperInvariant() switch
        {
            "RANKED_SOLO_5X5" => RankedQueues.SoloDuo,
            "RANKED_FLEX_SR" => RankedQueues.Flex,
            _ => null,
        };

    /// <summary>
    /// Where a participant's ROLE might live. This is the secondary
    /// discriminator, and it exists for exactly one reason: <b>the ADC and the
    /// support both report lane <c>BOTTOM</c></b>, so position alone can never
    /// separate them and every bot-lane game was landing in
    /// <c>ambiguous:2-enemies-at-bottom</c> and asking the user to pick. The
    /// live client on this machine publishes it as
    /// <c>participant.timeline.role</c> alongside
    /// <c>participant.timeline.lane</c> (a real captured participant:
    /// <c>{"championId":202,"teamId":100,"lane":"NONE","role":"SOLO"}</c>), so
    /// <c>role</c> leads. The rest are the same cheap insurance the other key
    /// lists carry, and the winner is reported the same probe-and-record way.
    /// </summary>
    private static readonly string[] RoleKeys = ["role", "playerRole", "teamRole"];

    private static readonly string[] ChampionIdKeys = ["championId", "champianId", "skinId"];
    private static readonly string[] TeamIdKeys = ["teamId", "team"];
    private static readonly string[] ChampionNameKeys = ["championName", "skinName", "championKey"];

    /// <summary>
    /// Attempts a capture. Returns null when this is not a ranked game we can
    /// record — which is a normal, quiet outcome, not an error.
    /// </summary>
    /// <param name="payload">
    /// The end-of-game stats block, or one match-history entry. Both are
    /// accepted; the shape is detected rather than declared.
    /// </param>
    /// <param name="ownPuuid">
    /// The local player's puuid from <c>/lol-summoner/v1/current-summoner</c>.
    /// Used to identify which participant is the user when the payload carries
    /// no local-player flag of its own.
    /// </param>
    public static LaneScoreGame? TryBuild(JsonElement payload, string? ownPuuid, DateTimeOffset now)
    {
        if (payload.ValueKind != JsonValueKind.Object) return null;

        var root = UnwrapGame(payload);

        var queueId = ReadQueueId(root);
        // Ranked only, checked here so that a non-ranked game costs one integer
        // read and never touches the store.
        if (!RankedQueues.IsRanked(queueId)) return null;

        var matchId = ReadGameId(root);
        if (string.IsNullOrWhiteSpace(matchId)) return null;

        var participants = ReadParticipants(root);
        if (participants.Count == 0) return null;

        var me = FindLocalPlayer(participants, ownPuuid);
        if (me is null || me.ChampionId <= 0 || me.TeamId is null or <= 0) return null;

        var enemies = participants
            .Where(participant => participant.TeamId is not null && participant.TeamId != me.TeamId)
            .Where(participant => participant.ChampionId > 0)
            .ToArray();

        var enemyIds = enemies.Select(participant => participant.ChampionId).Distinct().ToArray();
        // A match-list summary may contain only the local player. It cannot
        // supply an opponent picker; the service must fetch the full game.
        if (enemyIds.Length == 0) return null;

        // The opponent, or an honest null. Note that BOTH sides must have a
        // position: knowing that I was TOP tells me nothing if no enemy says
        // which of them was.
        Participant? opponent = null;
        string positionSource;
        if (me.Position is { } minePosition)
        {
            var candidates = enemies
                .Where(participant => string.Equals(participant.Position, minePosition, StringComparison.Ordinal))
                .ToArray();
            if (candidates.Length == 1)
            {
                opponent = candidates[0];
                positionSource = me.PositionKey ?? "position";
            }
            else if (candidates.Length > 1 &&
                     me.Role is { } myRole &&
                     NarrowByRole(candidates, myRole) is { } soleByRole)
            {
                // BOT LANE. The ADC and the support both report BOTTOM, so the
                // lane alone can never separate them and this used to ask the
                // user every single bot-lane game. Role is only consulted here,
                // once the lane has already failed, and only when it resolves to
                // exactly one enemy.
                opponent = soleByRole;
                positionSource = $"{me.PositionKey ?? "position"}+{me.RoleKey ?? "role"}";
            }
            else
            {
                // Zero matches (the enemy team's positions are missing or
                // spelled differently) or more than one that role could not
                // separate either — because a role was missing, said NONE, or
                // both enemies claim the same one. Both are ambiguous, and
                // ambiguous means ask.
                positionSource = candidates.Length == 0
                    ? $"unmatched:{me.PositionKey}={minePosition}"
                    : $"ambiguous:{candidates.Length}-enemies-at-{minePosition}";
            }
        }
        else
        {
            positionSource = "absent";
        }

        return new LaneScoreGame
        {
            MatchId = matchId!,
            PlayedAt = ReadTimestamp(root) ?? now.ToString("O"),
            QueueId = queueId!.Value,
            MyChampionId = me.ChampionId,
            MyChampionName = me.ChampionName,
            RoleId = ResolveRoleId(me.Position, me.Role),
            OpponentChampionId = opponent?.ChampionId,
            OpponentChampionName = opponent?.ChampionName,
            EnemyChampionIds = enemyIds,
            PositionSource = positionSource,
            CapturedAt = now.ToString("O"),
        };
    }

    /// <summary>
    /// A key inventory of the payload — <b>names and value kinds only, never
    /// values</b>. This is what makes the shape verifiable from a real game
    /// without putting puuids, summoner names or anything else identifying into
    /// a log file the user is routinely asked to send us.
    /// </summary>
    public static string Describe(JsonElement payload)
    {
        if (payload.ValueKind != JsonValueKind.Object) return $"root={payload.ValueKind}";

        var builder = new StringBuilder();
        var root = UnwrapGame(payload);
        builder.Append("root{").Append(Keys(root)).Append('}');

        var participants = ReadParticipantElements(root);
        if (participants.Count > 0)
            builder.Append(" participant{").Append(Keys(participants[0])).Append('}');
        else
            builder.Append(" participants=none");

        return builder.ToString();
    }

    private static string Keys(JsonElement element) => element.ValueKind == JsonValueKind.Object
        ? string.Join(',', element.EnumerateObject()
            .Select(property => $"{property.Name}:{property.Value.ValueKind}")
            .Take(60))
        : element.ValueKind.ToString();

    /// <summary>
    /// Match history nests the game one or two levels down
    /// (<c>{games:{games:[...]}}</c>). If the caller hands us the envelope
    /// rather than one game, take the newest game out of it.
    /// </summary>
    private static JsonElement UnwrapGame(JsonElement payload)
    {
        var current = payload;
        for (var depth = 0; depth < 3; depth++)
        {
            if (current.ValueKind == JsonValueKind.Object &&
                current.TryGetProperty("games", out var games))
            {
                if (games.ValueKind == JsonValueKind.Array)
                {
                    // Newest last is the match-history convention; if it is not,
                    // the caller passed one game and never reaches here anyway.
                    var last = default(JsonElement);
                    var any = false;
                    foreach (var game in games.EnumerateArray()) { last = game; any = true; }
                    return any ? last : current;
                }
                current = games;
                continue;
            }
            break;
        }
        return current;
    }

    private sealed record Participant(
        int ChampionId,
        int? TeamId,
        string? Position,
        string? PositionKey,
        string? Role,
        string? RoleKey,
        string? ChampionName,
        string? Puuid,
        bool LocalFlag);

    private static List<JsonElement> ReadParticipantElements(JsonElement root)
    {
        var result = new List<JsonElement>();
        if (root.ValueKind != JsonValueKind.Object) return result;

        // Flat: match-history's `participants`.
        if (root.TryGetProperty("participants", out var flat) && flat.ValueKind == JsonValueKind.Array)
        {
            result.AddRange(flat.EnumerateArray());
            if (result.Count > 0) return result;
        }

        // Nested: the end-of-game block's `teams[].players[]`.
        if (root.TryGetProperty("teams", out var teams) && teams.ValueKind == JsonValueKind.Array)
        {
            foreach (var team in teams.EnumerateArray())
            {
                if (team.ValueKind != JsonValueKind.Object) continue;
                if (!team.TryGetProperty("players", out var players) ||
                    players.ValueKind != JsonValueKind.Array) continue;
                result.AddRange(players.EnumerateArray());
            }
        }

        return result;
    }

    private static List<Participant> ReadParticipants(JsonElement root)
    {
        var result = new List<Participant>();
        if (root.ValueKind != JsonValueKind.Object) return result;

        if (root.TryGetProperty("participants", out var flat) && flat.ValueKind == JsonValueKind.Array)
        {
            foreach (var element in flat.EnumerateArray())
            {
                if (ReadParticipant(element, null) is not { } participant) continue;
                if (participant.Puuid is null && ReadInt(element, ["participantId"]) is { } id &&
                    root.TryGetProperty("participantIdentities", out var identities) && identities.ValueKind == JsonValueKind.Array)
                {
                    var matching = identities.EnumerateArray()
                        .Where(identity => ReadInt(identity, ["participantId"]) == id)
                        .ToArray();
                    if (matching.Length == 1 && matching[0].TryGetProperty("player", out var player))
                        participant = participant with { Puuid = ReadString(player, ["puuid"]) };
                }
                result.Add(participant);
            }
            if (result.Count > 0) return result;
        }

        if (root.TryGetProperty("teams", out var teams) && teams.ValueKind == JsonValueKind.Array)
        {
            foreach (var team in teams.EnumerateArray())
            {
                if (team.ValueKind != JsonValueKind.Object) continue;
                var teamId = ReadInt(team, TeamIdKeys);
                if (!team.TryGetProperty("players", out var players) ||
                    players.ValueKind != JsonValueKind.Array) continue;
                foreach (var element in players.EnumerateArray())
                {
                    if (ReadParticipant(element, teamId) is { } participant) result.Add(participant);
                }
            }
        }

        return result;
    }

    private static Participant? ReadParticipant(JsonElement element, int? inheritedTeamId)
    {
        if (element.ValueKind != JsonValueKind.Object) return null;

        var championId = ReadInt(element, ChampionIdKeys) ?? 0;
        var teamId = ReadInt(element, TeamIdKeys) ?? inheritedTeamId;
        var (position, positionKey) = ReadPosition(element);
        var (role, roleKey) = ReadRole(element);
        var championName = ReadString(element, ChampionNameKeys);
        var puuid = ReadString(element, ["puuid"]);
        var localFlag =
            ReadBool(element, "isLocalPlayer") ??
            ReadBool(element, "localPlayer") ??
            false;

        return new Participant(
            championId, teamId, position, positionKey, role, roleKey, championName, puuid, localFlag);
    }

    /// <summary>
    /// The position, and the NAME OF THE FIELD it came from. The second half is
    /// the point: it is what tells us, from a real game, which spelling this
    /// client version actually uses.
    /// </summary>
    private static (string? Position, string? Key) ReadPosition(JsonElement element)
    {
        foreach (var key in PositionKeys)
        {
            var direct = ReadString(element, [key]);
            if (Normalize(direct) is { } normalized) return (normalized, key);
        }

        // Match history hides lane/role under `timeline` on some versions.
        if (element.TryGetProperty("timeline", out var timeline) &&
            timeline.ValueKind == JsonValueKind.Object)
        {
            foreach (var key in PositionKeys)
            {
                var nested = ReadString(timeline, [key]);
                if (Normalize(nested) is { } normalized) return (normalized, "timeline." + key);
            }
        }

        // The stats sub-object is the other place it has lived.
        if (element.TryGetProperty("stats", out var stats) && stats.ValueKind == JsonValueKind.Object)
        {
            foreach (var key in PositionKeys)
            {
                var nested = ReadString(stats, [key]);
                if (Normalize(nested) is { } normalized) return (normalized, "stats." + key);
            }
        }

        return (null, null);
    }

    /// <summary>
    /// The role, and the NAME OF THE FIELD it came from — probed and recorded
    /// exactly the way <see cref="ReadPosition"/> handles the lane, top level
    /// first, then <c>timeline</c>, then <c>stats</c>, because those are the
    /// three places this client has put it.
    ///
    /// <para>Role is a SECONDARY discriminator only. It is never read as a lane
    /// and never used unless the lane already came back ambiguous.</para>
    /// </summary>
    private static (string? Role, string? Key) ReadRole(JsonElement element)
    {
        foreach (var key in RoleKeys)
        {
            var direct = ReadString(element, [key]);
            if (NormalizeRole(direct) is { } normalized) return (normalized, key);
        }

        if (element.TryGetProperty("timeline", out var timeline) &&
            timeline.ValueKind == JsonValueKind.Object)
        {
            foreach (var key in RoleKeys)
            {
                var nested = ReadString(timeline, [key]);
                if (NormalizeRole(nested) is { } normalized) return (normalized, "timeline." + key);
            }
        }

        if (element.TryGetProperty("stats", out var stats) && stats.ValueKind == JsonValueKind.Object)
        {
            foreach (var key in RoleKeys)
            {
                var nested = ReadString(stats, [key]);
                if (NormalizeRole(nested) is { } normalized) return (normalized, "stats." + key);
            }
        }

        return (null, null);
    }

    /// <summary>
    /// The role id to STORE for the local player, which is not always the one
    /// the lane alone implies.
    ///
    /// <para><b>Why this is not just <see cref="ComplianceRules.RoleIdFromPosition"/>.</b>
    /// Match history reports <c>timeline.lane = BOTTOM</c> for BOTH bot laners,
    /// so a support's game was being written as role 3 (bottom) while champ
    /// select — which reads <c>assignedPosition</c> and therefore says
    /// <c>utility</c> — asks for role 4. The user's support games and ADC games
    /// piled into one bucket, and the "Your lane history" panel for a support
    /// showed a mixture of two different roles (or, queried as 4, nothing at
    /// all). Role is the only field that can tell the two apart, so it is
    /// consulted here for the same reason <see cref="NarrowByRole"/> consults
    /// it, and for that reason ONLY.</para>
    ///
    /// <para><b>Only bottom, only support, never invented.</b> A lane that is
    /// not bottom is returned untouched — role has nothing to add to TOP. A
    /// <c>carry</c> at bottom stays 3, which is what it already was. And a role
    /// that is missing, <c>NONE</c>, or any spelling we do not recognise keeps
    /// today's answer of 3 rather than being read as evidence of anything:
    /// absence is not a support classification, and a wrong role id would
    /// silently file the game in a bucket the user never plays.</para>
    ///
    /// <para>This is about the value STORED. It does not participate in
    /// opponent matching, which still narrows on the raw role token — a support
    /// game records role 4 AND still resolves the enemy support as the
    /// opponent.</para>
    /// </summary>
    /// <param name="position">
    /// A canonical lane from <see cref="Normalize"/> (this is what
    /// <c>Participant.Position</c> holds).
    /// </param>
    /// <param name="role">
    /// The role token. <see cref="NormalizeRole"/> is applied again here, and it
    /// is idempotent over its own output ("support" -> "support"), so a raw
    /// <c>DUO_SUPPORT</c> and an already-canonical <c>support</c> give the same
    /// answer — the caller cannot get a different result than a test does.
    /// </param>
    public static int? ResolveRoleId(string? position, string? role)
    {
        var roleId = ComplianceRules.RoleIdFromPosition(position);
        if (roleId == LaneRoles.Bottom &&
            string.Equals(NormalizeRole(role), "support", StringComparison.Ordinal))
            return LaneRoles.Utility;
        return roleId;
    }

    /// <summary>
    /// Canonicalises a role to a token that can be compared between two
    /// participants.
    ///
    /// <para>Two properties are load-bearing. <b>First, <c>DUO_CARRY</c> and
    /// <c>DUO_SUPPORT</c> must land on different tokens</b> — collapsing them
    /// would make the narrowing pick the wrong bot laner, which is precisely the
    /// silent poisoning this feature refuses to do. Note that
    /// <see cref="Normalize"/> is NOT reusable here: it maps <c>SOLO</c> to null
    /// and answers in LANE vocabulary, which is a different question.</para>
    ///
    /// <para><b>Second, an unusable role yields null, and null never matches
    /// anything.</b> <c>NONE</c>, <c>INVALID</c>, blank, and any spelling we do
    /// not recognise all mean "the client is not telling us", and the correct
    /// response to that is the existing ambiguous path that asks the user — not
    /// a coin flip between two enemies.</para>
    /// </summary>
    public static string? NormalizeRole(string? raw)
    {
        var value = raw?.Trim().ToUpperInvariant();
        return value switch
        {
            "DUO_CARRY" or "CARRY" or "ADC" => "carry",
            "DUO_SUPPORT" or "SUPPORT" or "SUPP" => "support",
            "SOLO" => "solo",
            "DUO" => "duo",
            // NONE, INVALID, empty and every unknown spelling deliberately fall
            // here. Unusable means ask, never guess.
            _ => null,
        };
    }

    /// <summary>
    /// Canonicalises the many spellings of a lane to the five
    /// <see cref="ComplianceRules.RoleIdFromPosition"/> understands.
    ///
    /// <para><c>NONE</c> and <c>INVALID</c> are deliberately mapped to null
    /// rather than to a lane. The client uses them to mean "we do not know",
    /// and the app's own log shows it emitting exactly that
    /// (<c>position=NONE</c>) — turning a stated unknown into a guessed lane is
    /// the specific failure this feature must not have.</para>
    /// </summary>
    public static string? Normalize(string? raw)
    {
        var value = raw?.Trim().ToUpperInvariant();
        return value switch
        {
            "TOP" => "top",
            "JUNGLE" or "JGL" => "jungle",
            "MIDDLE" or "MID" => "middle",
            "BOTTOM" or "BOT" or "ADC" or "DUO_CARRY" => "bottom",
            "UTILITY" or "SUPPORT" or "SUP" or "DUO_SUPPORT" => "utility",
            _ => null,
        };
    }

    /// <summary>
    /// Which participant is the user. The explicit flag wins; puuid is the
    /// fallback. If neither is available we return null and the whole capture is
    /// abandoned — recording somebody else's lane would be worse than recording
    /// nothing.
    /// </summary>
    private static Participant? FindLocalPlayer(List<Participant> participants, string? ownPuuid)
    {
        var flagged = participants.Where(participant => participant.LocalFlag).ToArray();
        if (flagged.Length == 1) return flagged[0];

        if (!string.IsNullOrWhiteSpace(ownPuuid))
        {
            var matched = participants
                .Where(participant => string.Equals(participant.Puuid, ownPuuid, StringComparison.OrdinalIgnoreCase))
                .ToArray();
            if (matched.Length == 1) return matched[0];
        }

        return null;
    }

    /// <summary>
    /// The one enemy in an already-lane-ambiguous set whose role matches mine,
    /// or null if that is not exactly one.
    ///
    /// <para>Null is returned for zero matches and for two-or-more alike, and in
    /// both cases the caller keeps the existing ambiguous path. An enemy whose
    /// own role was unusable carries <c>Role == null</c>, which matches nothing —
    /// so a missing role on either side degrades to asking, never to a guess.</para>
    /// </summary>
    private static Participant? NarrowByRole(Participant[] candidates, string myRole)
    {
        var matched = candidates
            .Where(participant => participant.Role is not null &&
                                  string.Equals(participant.Role, myRole, StringComparison.Ordinal))
            .ToArray();
        return matched.Length == 1 ? matched[0] : null;
    }

    private static string? ReadGameId(JsonElement root)
    {
        foreach (var key in GameIdKeys)
        {
            if (!root.TryGetProperty(key, out var value)) continue;
            switch (value.ValueKind)
            {
                case JsonValueKind.Number when value.TryGetInt64(out var number) && number > 0:
                    return number.ToString(System.Globalization.CultureInfo.InvariantCulture);
                case JsonValueKind.String:
                    var text = value.GetString()?.Trim();
                    if (!string.IsNullOrEmpty(text)) return text;
                    break;
            }
        }
        return null;
    }

    /// <summary>The ranked summary's id, used only to request its full match.</summary>
    public static string? RankedMatchId(JsonElement payload)
    {
        var identity = GameIdentity(payload);
        return RankedQueues.IsRanked(identity.QueueId) ? identity.MatchId : null;
    }

    /// <summary>Identity is available before the end-of-game participants have settled.</summary>
    public static (string? MatchId, int? QueueId) GameIdentity(JsonElement payload)
    {
        var root = UnwrapGame(payload);
        return root.ValueKind == JsonValueKind.Object
            ? (ReadGameId(root), ReadQueueId(root))
            : (null, null);
    }

    private static string? ReadTimestamp(JsonElement root)
    {
        foreach (var key in new[] { "gameCreationDate", "gameEndTimestamp", "gameCreation" })
        {
            if (!root.TryGetProperty(key, out var value)) continue;
            if (value.ValueKind == JsonValueKind.String)
            {
                var text = value.GetString()?.Trim();
                if (!string.IsNullOrEmpty(text)) return text;
            }
            if (value.ValueKind == JsonValueKind.Number && value.TryGetInt64(out var epochMs) && epochMs > 0)
                return DateTimeOffset.FromUnixTimeMilliseconds(epochMs).ToString("O");
        }
        return null;
    }

    private static int? ReadInt(JsonElement element, string[] keys)
    {
        if (element.ValueKind != JsonValueKind.Object) return null;
        foreach (var key in keys)
        {
            if (element.TryGetProperty(key, out var value) &&
                value.ValueKind == JsonValueKind.Number &&
                value.TryGetInt32(out var number))
                return number;
        }
        return null;
    }

    private static string? ReadString(JsonElement element, string[] keys)
    {
        if (element.ValueKind != JsonValueKind.Object) return null;
        foreach (var key in keys)
        {
            if (element.TryGetProperty(key, out var value) && value.ValueKind == JsonValueKind.String)
            {
                var text = value.GetString()?.Trim();
                if (!string.IsNullOrEmpty(text)) return text;
            }
        }
        return null;
    }

    private static bool? ReadBool(JsonElement element, string key)
    {
        if (element.ValueKind != JsonValueKind.Object) return null;
        if (!element.TryGetProperty(key, out var value)) return null;
        return value.ValueKind switch
        {
            JsonValueKind.True => true,
            JsonValueKind.False => false,
            _ => null,
        };
    }
}
