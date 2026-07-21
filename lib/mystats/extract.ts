// ─────────────────────────────────────────────────────────────────────────────
// lib/mystats/extract.ts — pure extraction: one Riot match-v5 response ->
// one coachbuild.my_matches row. No I/O — easy to unit test with fixtures.
//
// Deliberately DOES NOT mirror lib/pro/extract.ts's extractMatch, which
// returns null (skip the whole match) when teamPosition doesn't resolve to a
// concrete role. This feature's contract explicitly wants the OPPOSITE: an
// ARAM game (no teamPosition at all) or any other role-unresolved match is
// still stored — role degrades to -1 (MyRoleId's unresolved sentinel) and
// oppChampionId degrades to null, rather than the row vanishing. The feature
// spec is explicit: "store with queue id anyway, filterable" — a caller
// that only wants lane stats can filter role!=-1 or a specific queue_id
// itself; extraction must never make that filtering decision by dropping
// data.
// ─────────────────────────────────────────────────────────────────────────────

import { patchFromGameVersion } from "@/lib/pro/extract";
import { roleFromTeamPosition } from "@/lib/pro/roleMap";
import type { ExtractedMyMatch, MyRiotMatch, MyRiotParticipant } from "./types";

/** Finds the enemy-side participant occupying the SAME teamPosition as the
 *  tracked player (the "lane opponent"). Returns null whenever that's not a
 *  clean, unambiguous lookup:
 *   - `role` itself is null (teamPosition blank/unrecognized — ARAM, remake)
 *   - zero enemy participants share that teamPosition (shouldn't happen in a
 *     normal 5v5 but Riot's data has edge cases — never guess)
 *   - MORE than one enemy participant shares it (duplicate/ambiguous —
 *     degrade rather than pick arbitrarily, same "wrong-but-silent is worse
 *     than absent" posture as lib/pro/extract.ts's team-comps functions) */
function findLaneOpponent(
  participants: MyRiotParticipant[],
  self: MyRiotParticipant,
  role: number | null
): number | null {
  if (role === null) return null;
  const candidates = participants.filter(
    (p) => p.teamId !== self.teamId && roleFromTeamPosition(p.teamPosition) === role
  );
  return candidates.length === 1 ? candidates[0].championId : null;
}

/** Returns null only when `puuid` isn't a participant in this match at all
 *  (shouldn't happen given the match id came from this same puuid's own
 *  match-ids fetch, but keeps this function total/defensive rather than
 *  assuming). Every other case returns a row — see this file's header. */
export function extractMyMatch(match: MyRiotMatch, puuid: string): ExtractedMyMatch | null {
  const participant = match.info.participants.find((p) => p.puuid === puuid);
  if (!participant) return null;

  const role = roleFromTeamPosition(participant.teamPosition);
  const oppChampionId = findLaneOpponent(match.info.participants, participant, role);

  return {
    matchId: match.metadata.matchId,
    queueId: match.info.queueId,
    gameCreation: new Date(match.info.gameCreation).toISOString(),
    patch: patchFromGameVersion(match.info.gameVersion),
    championId: participant.championId,
    role: role ?? -1,
    oppChampionId,
    win: participant.win,
  };
}
