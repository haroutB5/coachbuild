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
//
// v0.51 addendum (My Stats build-adherence + KDA): also pulls kills/deaths/
// assists, the 6 final BUILD item slots (item0-item5 -- item6/trinket is
// never a build-path signal, deliberately excluded), the primary-tree
// keystone id, and the row's split number (lib/mystats/season.ts). These are
// always extracted regardless of role/queue -- same "never make a filtering
// decision here" posture as the rest of this file.
// ─────────────────────────────────────────────────────────────────────────────

import { creepScore, patchFromGameVersion } from "@/lib/pro/extract";
import { roleFromTeamPosition } from "@/lib/pro/roleMap";
import { splitForGameCreation } from "./season";
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

/** perks.styles[primaryStyle].selections[0].perk is the keystone -- the ONLY
 *  slot on the primary tree's first row. Returns null for a missing/malformed
 *  perks block (defensive; a real match-v5 response always has this) rather
 *  than throwing -- a keystone-less row still stores everything else. */
function primaryKeystoneFrom(participant: MyRiotParticipant): number | null {
  const primary = participant.perks?.styles?.find((s) => s.description === "primaryStyle");
  return primary?.selections?.[0]?.perk ?? null;
}

/** Final item slots 0-5 in fixed order -- item6 (trinket) is deliberately
 *  excluded, see this file's header (v0.51 addendum below). Empty slots come
 *  through as Riot's own `0` sentinel and are kept as-is (never filtered) --
 *  see lib/mystats/adherence.ts's header for why that's safe. */
function itemIdsFrom(participant: MyRiotParticipant): number[] {
  return [
    participant.item0,
    participant.item1,
    participant.item2,
    participant.item3,
    participant.item4,
    participant.item5,
  ];
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
  const gameCreation = new Date(match.info.gameCreation).toISOString();

  return {
    matchId: match.metadata.matchId,
    queueId: match.info.queueId,
    gameCreation,
    patch: patchFromGameVersion(match.info.gameVersion),
    championId: participant.championId,
    role: role ?? -1,
    oppChampionId,
    win: participant.win,
    kills: participant.kills,
    deaths: participant.deaths,
    assists: participant.assists,
    itemIds: itemIdsFrom(participant),
    primaryKeystone: primaryKeystoneFrom(participant),
    split: splitForGameCreation(match.info.gameCreation),
    // Migration 0021. RAW numerator + RAW denominator, never a rate -- the
    // formula is lib/pro/extract.ts's creepScore(), shared with the pro/OTP
    // pipelines rather than re-written here, so "CS" cannot come to mean two
    // different things in one codebase. No short-game filtering happens at
    // extraction time: a 3-minute remake is extracted and stored exactly like
    // any other game and is dropped only at aggregation (lib/mystats/cs.ts),
    // the same "extraction must never make a filtering decision" posture this
    // file's header sets out for role and queue.
    cs: creepScore(participant),
    gameDurationSec: match.info.gameDuration,
  };
}
