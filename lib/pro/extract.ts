// ─────────────────────────────────────────────────────────────────────────────
// lib/pro/extract.ts — turn a Riot match + timeline into a stored pro_matches
// row / ProGame shape. Pure functions, no I/O — easy to unit test.
// ─────────────────────────────────────────────────────────────────────────────

import { roleFromTeamPosition, SKILL_SLOT_LABEL } from "./roleMap";
import type {
  ProGamePurchase,
  ProGameRunes,
  RiotMatch,
  RiotParticipant,
  RiotTimeline,
  RiotTimelineEvent,
  TeamCompPlayer,
} from "./types";

export interface ExtractedMatch {
  matchId: string;
  puuid: string;
  championId: number;
  championName: string;
  role: 0 | 1 | 2 | 3 | 4;
  patch: string;
  win: boolean;
  kills: number;
  deaths: number;
  assists: number;
  gameCreation: string; // ISO
  gameDurationSec: number;
  spells: [number, number];
  finalItems: number[];
  trinket: number | null;
  purchaseOrder: ProGamePurchase[];
  skillOrder: string[];
  runes: ProGameRunes;
  cs: number; // totalMinionsKilled + neutralMinionsKilled
  damageChampions: number;
  teamKills: number; // sum of kills across the player's own team (score.ts kill-participation input)
  gold: number;
  allyChampionIds: number[] | null; // null unless the match has a clean 5v5 split; see extractTeamComps
  enemyChampionIds: number[] | null;
  allyPlayers: TeamCompPlayer[] | null; // null unless the match has a clean 5v5 split; see extractTeamPlayers
  enemyPlayers: TeamCompPlayer[] | null;
}

/** Patch "16.13" from gameVersion "16.13.567.1234". */
export function patchFromGameVersion(gameVersion: string): string {
  const parts = gameVersion.split(".");
  return parts.slice(0, 2).join(".");
}

/** Build order for one participant: undo-adjusted, chronological, consumables
 *  and wards included. ITEM_UNDO removes the most recent matching purchase
 *  (searching from the end) rather than assuming it's always the last event —
 *  a defensive choice in case of out-of-order timeline entries.
 *
 *  `ts` is emitted in SECONDS into the game (Riot's raw timeline timestamp is
 *  ms — converted here). Contract note: the original spec didn't pin a unit;
 *  seconds was chosen to match fronty's already-built purchase-timeline UI
 *  (components/ProGameCard.tsx's formatMinuteStamp(sec) + its fixtures use
 *  second-scale values like 65/420/1850) rather than leave a live mismatch. */
export function buildPurchaseOrder(timeline: RiotTimeline, participantId: number): ProGamePurchase[] {
  const order: ProGamePurchase[] = [];
  for (const frame of timeline.info.frames) {
    for (const ev of frame.events) {
      if (ev.participantId !== participantId) continue;
      if (ev.type === "ITEM_PURCHASED" && typeof ev.itemId === "number") {
        order.push({ itemId: ev.itemId, ts: Math.round(ev.timestamp / 1000) });
      } else if (ev.type === "ITEM_UNDO" && typeof ev.beforeId === "number") {
        const idx = findLastIndex(order, (p) => p.itemId === ev.beforeId);
        if (idx >= 0) order.splice(idx, 1);
      }
      // ITEM_SOLD is intentionally NOT applied here — purchaseOrder is a
      // purchase log (build order), not a live inventory snapshot. Final
      // inventory (post-sells) comes from participant.item0-6 instead.
    }
  }
  return order;
}

function findLastIndex<T>(arr: T[], pred: (v: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (pred(arr[i])) return i;
  }
  return -1;
}

/** Skill order ["Q","W","E",...] for one participant. Dedupes exact-duplicate
 *  SKILL_LEVEL_UP events (known bug since ~patch 15.17: identical events fire
 *  twice) on (participantId, skillSlot, levelUpType, timestamp), then caps at
 *  18 entries (max level) as a second safety net against any residual dupes. */
export function buildSkillOrder(timeline: RiotTimeline, participantId: number): string[] {
  const seen = new Set<string>();
  const events: RiotTimelineEvent[] = [];
  for (const frame of timeline.info.frames) {
    for (const ev of frame.events) {
      if (ev.type !== "SKILL_LEVEL_UP" || ev.participantId !== participantId) continue;
      if (typeof ev.skillSlot !== "number") continue;
      const key = `${ev.participantId}:${ev.skillSlot}:${ev.levelUpType ?? ""}:${ev.timestamp}`;
      if (seen.has(key)) continue;
      seen.add(key);
      events.push(ev);
    }
  }
  events.sort((a, b) => a.timestamp - b.timestamp);
  return events
    .slice(0, 18)
    .map((ev) => SKILL_SLOT_LABEL[ev.skillSlot as number])
    .filter((label): label is string => Boolean(label));
}

export function extractRunes(participant: RiotParticipant): ProGameRunes {
  const { perks } = participant;
  const primary = perks.styles.find((s) => s.description === "primaryStyle") ?? perks.styles[0];
  const secondary = perks.styles.find((s) => s.description === "subStyle") ?? perks.styles[1];
  const [keystoneSel, ...primaryRest] = primary?.selections ?? [];
  return {
    primaryTree: primary?.style ?? 0,
    keystone: keystoneSel?.perk ?? 0,
    primary: primaryRest.map((s) => s.perk),
    secondaryTree: secondary?.style ?? 0,
    secondary: (secondary?.selections ?? []).map((s) => s.perk),
    shards: [perks.statPerks.offense, perks.statPerks.flex, perks.statPerks.defense],
  };
}

export interface ExtractedGameStats {
  cs: number;
  damageChampions: number;
  teamKills: number;
  gold: number;
}

/** Pure extraction of just the migration-0004 stat columns from a match
 *  detail response — no timeline needed. Shared by extractMatch (new
 *  ingest) AND scripts/backfill-game-stats.mjs (historical rows: re-fetches
 *  match detail only, 1 call/match, no timeline re-fetch needed since these
 *  4 fields don't come from the timeline). Returns null when the puuid
 *  isn't in the match, mirroring extractMatch's own guard. */
export function extractGameStats(match: RiotMatch, puuid: string): ExtractedGameStats | null {
  const participant = match.info.participants.find((p) => p.puuid === puuid);
  if (!participant) return null;
  // Sum of kills across every participant on the same team (including this
  // one) — the denominator for kill participation in lib/pro/score.ts.
  const teamKills = match.info.participants
    .filter((p) => p.teamId === participant.teamId)
    .reduce((sum, p) => sum + p.kills, 0);
  return {
    cs: participant.totalMinionsKilled + participant.neutralMinionsKilled,
    damageChampions: participant.totalDamageDealtToChampions,
    teamKills,
    gold: participant.goldEarned,
  };
}

export interface ExtractedTeamComps {
  allyChampionIds: number[]; // includes the tracked player's own champion
  enemyChampionIds: number[];
}

/** Reorders a side's champion ids into role-slot order (0=Top 1=Jungle
 *  2=Mid 3=Bot/ADC 4=Support) so a mid-laner's champion always renders in
 *  the middle slot of the strip, regardless of participant/row fetch order.
 *  Falls back to the input (source) order whenever the 5 entries don't carry
 *  exactly 5 DISTINCT known roles (0-4) — a role-less or duplicate-role
 *  shape (remake/AFK/unresolved-role edge cases) must degrade to "wrong but
 *  complete," never a partial/reordered-lie array. Shared by both team-comps
 *  producers: lib/pro/extract.ts's extractTeamComps (soloq, teamPosition ->
 *  role) and app/api/pros/route.ts's prostage comps (Cargo role column). */
/** Generic form of the role-ordering rule above: reorders ANY array of
 *  entries carrying a `role` field into role-slot order (0=Top..4=Support),
 *  falling back to input (source) order under the exact same degrade
 *  condition (not exactly 5 entries, or not exactly 5 DISTINCT known roles).
 *  orderChampionIdsByRole (below) and lib/pro/extract.ts's extractTeamPlayers
 *  both delegate here so the champion-id strip and the full per-player
 *  TeamCompPlayer array can NEVER disagree on ordering for the same row —
 *  one degrade rule, one implementation, two call sites. */
/** True when every entry's role resolves to one of exactly 5 DISTINCT known
 *  values (0-4) — the same degrade condition orderByRole checks, exported
 *  separately so a caller can decide to OMIT a degraded side entirely
 *  instead of accepting orderByRole's source-order fallback (see
 *  extractTeamComps/extractTeamPlayers below — the soloq producers use this;
 *  lib/prostage/teamComps.ts's orderedSidesForGame still calls orderByRole
 *  directly and keeps its own fallback-to-source-order behavior, unchanged
 *  by this — see the P3(a) fix's HANDOFF entry for why the two producers
 *  diverge here). */
export function sideResolvesCleanly<T extends { role: number | null | undefined }>(entries: T[]): boolean {
  const roles = entries.map((e) => (typeof e.role === "number" && e.role >= 0 && e.role <= 4 ? e.role : null));
  const knownCount = roles.filter((r) => r !== null).length;
  const distinctKnown = new Set(roles.filter((r): r is number => r !== null));
  return knownCount === entries.length && distinctKnown.size === entries.length;
}

export function orderByRole<T extends { role: number | null | undefined }>(entries: T[]): T[] {
  if (!sideResolvesCleanly(entries)) return entries.slice();
  const roles = entries.map((e) => (typeof e.role === "number" && e.role >= 0 && e.role <= 4 ? e.role : null));
  return entries
    .map((e, i) => ({ entry: e, role: roles[i] as number }))
    .sort((a, b) => a.role - b.role)
    .map((x) => x.entry);
}

export function orderChampionIdsByRole(
  entries: { championId: number; role: number | null | undefined }[]
): number[] {
  return orderByRole(entries).map((e) => e.championId);
}

/** Splits a match's participants by teamId into the tracked player's ally
 *  side (own team, INCLUDING self) and the enemy side, by championId,
 *  ROLE-ORDERED (see orderChampionIdsByRole) — a mid-laner's champion always
 *  lands at index 2. Falls back to source (participant array) order when a
 *  side's teamPosition values don't resolve to exactly 5 distinct known
 *  roles (teamPosition can be "" on remade/edge-case games).
 *  Returns null unless BOTH sides have exactly 5 champions AND both sides
 *  role-resolve CLEANLY (exactly 5 distinct known roles each) — queue=420
 *  (ranked solo/duo, the only queue lib/pro/ingestMatches.ts ingests) is
 *  always 5v5, so this should always succeed in practice, but a truncated
 *  fetch or a remake with missing participants must never store a partial
 *  side (dpm.lol-style comps rows are all-or-nothing on the frontend).
 *
 *  P3(a) fix (2026-07-17 Fable review): a degraded side used to still be
 *  emitted in orderByRole's SOURCE-ORDER fallback rather than role order —
 *  but every consumer of allyChampionIds/enemyChampionIds indexes them BY
 *  ROLE POSITION (`enemyChampionIds[role]`, e.g. "who's the enemy laner in
 *  my role"), so a source-ordered array silently produced a WRONG "vs"
 *  laner with no signal anything had degraded. This violates the documented
 *  contract in CLAUDE.md's API contracts section ("role-ordered … when a
 *  side resolves cleanly, else omitted entirely — never a partial or a
 *  'wrong but silent' side"). Fixed at the producer: a degraded side now
 *  omits the WHOLE comps object (both fields stay null, matching the
 *  existing both-or-neither contract) instead of returning a plausible-
 *  looking-but-wrong array. */
export function extractTeamComps(match: RiotMatch, puuid: string): ExtractedTeamComps | null {
  const participant = match.info.participants.find((p) => p.puuid === puuid);
  if (!participant) return null;
  const allies = match.info.participants.filter((p) => p.teamId === participant.teamId);
  const enemies = match.info.participants.filter((p) => p.teamId !== participant.teamId);
  if (allies.length !== 5 || enemies.length !== 5) return null;
  const allyEntries = allies.map((p) => ({ championId: p.championId, role: roleFromTeamPosition(p.teamPosition) }));
  const enemyEntries = enemies.map((p) => ({ championId: p.championId, role: roleFromTeamPosition(p.teamPosition) }));
  if (!sideResolvesCleanly(allyEntries) || !sideResolvesCleanly(enemyEntries)) return null;
  return {
    allyChampionIds: orderChampionIdsByRole(allyEntries),
    enemyChampionIds: orderChampionIdsByRole(enemyEntries),
  };
}

/** Riot ID display name for a participant, or null when unresolvable.
 *  riotIdGameName is the current field (see RiotParticipant's doc comment in
 *  types.ts); summonerName is a legacy fallback that frequently comes back ""
 *  post-privacy-change, so an empty/whitespace string is treated the same as
 *  absent rather than trusted at face value. */
function riotParticipantName(p: RiotParticipant): string | null {
  if (p.riotIdGameName && p.riotIdGameName.trim().length > 0) return p.riotIdGameName;
  if (p.summonerName && p.summonerName.trim().length > 0) return p.summonerName;
  return null;
}

/** trackedPuuid/trackedProId: the CALLER already knows which participant is
 *  the tracked pro (it's the account this whole ingest run is for) and that
 *  pro's own coachbuild.pros.id — "cheap" per the proId contract's doc
 *  comment in lib/pro/types.ts, since neither requires a lookup. Every OTHER
 *  participant (teammates/opponents) is a random ranked player we don't
 *  track and never fuzzy-match by name, so proId stays undefined for them. */
function participantToTeamCompPlayer(
  p: RiotParticipant,
  trackedPuuid?: string,
  trackedProId?: string
): TeamCompPlayer {
  const items = [p.item0, p.item1, p.item2, p.item3, p.item4, p.item5].filter((id) => id !== 0);
  return {
    championId: p.championId,
    name: riotParticipantName(p),
    items,
    trinket: p.item6 && p.item6 !== 0 ? p.item6 : null,
    role: roleFromTeamPosition(p.teamPosition),
    ...(trackedProId !== undefined && p.puuid === trackedPuuid ? { proId: trackedProId } : {}),
  };
}

export interface ExtractedTeamPlayers {
  allyPlayers: TeamCompPlayer[];
  enemyPlayers: TeamCompPlayer[];
}

/** Sibling to extractTeamComps — same identity/5v5 guard, same
 *  orderByRole degrade rule, but returns full per-player TeamCompPlayer data
 *  (name/items/trinket/role) instead of just champion ids, for the frontend's
 *  per-player build sheet. Deliberately NOT folded into extractTeamComps
 *  itself: extractTeamComps's narrower ExtractedTeamComps shape is still what
 *  scripts/backfill-team-comps.mjs's plain (non---players) mode writes, and
 *  callers that only need champion ids shouldn't have to thread the heavier
 *  shape through. Returns null unless BOTH sides have exactly 5 champions
 *  AND both sides role-resolve cleanly — same all-or-nothing contract as
 *  extractTeamComps, including the P3(a) fix: a degraded side omits the
 *  whole result rather than falling back to a source-ordered (role-position-
 *  wrong) array — see extractTeamComps's doc comment for the full rationale. */
export function extractTeamPlayers(
  match: RiotMatch,
  puuid: string,
  trackedProId?: string
): ExtractedTeamPlayers | null {
  const participant = match.info.participants.find((p) => p.puuid === puuid);
  if (!participant) return null;
  const allies = match.info.participants.filter((p) => p.teamId === participant.teamId);
  const enemies = match.info.participants.filter((p) => p.teamId !== participant.teamId);
  if (allies.length !== 5 || enemies.length !== 5) return null;
  const allyPlayers = allies.map((p) => participantToTeamCompPlayer(p, puuid, trackedProId));
  const enemyPlayers = enemies.map((p) => participantToTeamCompPlayer(p, puuid, trackedProId));
  if (!sideResolvesCleanly(allyPlayers) || !sideResolvesCleanly(enemyPlayers)) return null;
  return {
    allyPlayers: orderByRole(allyPlayers),
    enemyPlayers: orderByRole(enemyPlayers),
  };
}

/** Returns null (caller must skip+log) when the participant's role can't be
 *  mapped — never store a row with a guessed role. `proId` is OPTIONAL and
 *  only used to stamp the tracked player's own slot in allyPlayers with his
 *  own known coachbuild.pros.id (see participantToTeamCompPlayer's doc
 *  comment) — omit it and every TeamCompPlayer.proId in the result is simply
 *  absent, same as before this field existed. */
export function extractMatch(
  match: RiotMatch,
  timeline: RiotTimeline,
  puuid: string,
  proId?: string
): ExtractedMatch | null {
  const participant = match.info.participants.find((p) => p.puuid === puuid);
  if (!participant) return null;
  const role = roleFromTeamPosition(participant.teamPosition);
  if (role === null) return null;

  const finalItems = [
    participant.item0,
    participant.item1,
    participant.item2,
    participant.item3,
    participant.item4,
    participant.item5,
  ].filter((id) => id !== 0);
  const trinket = participant.item6 && participant.item6 !== 0 ? participant.item6 : null;

  const stats = extractGameStats(match, puuid);
  if (!stats) return null; // unreachable given the participant lookup above already succeeded, but keeps this function total

  const comps = extractTeamComps(match, puuid);
  const players = extractTeamPlayers(match, puuid, proId);

  return {
    matchId: match.metadata.matchId,
    puuid,
    championId: participant.championId,
    championName: participant.championName,
    role,
    patch: patchFromGameVersion(match.info.gameVersion),
    win: participant.win,
    kills: participant.kills,
    deaths: participant.deaths,
    assists: participant.assists,
    gameCreation: new Date(match.info.gameCreation).toISOString(),
    gameDurationSec: match.info.gameDuration,
    spells: [participant.summoner1Id, participant.summoner2Id],
    finalItems,
    trinket,
    purchaseOrder: buildPurchaseOrder(timeline, participant.participantId),
    skillOrder: buildSkillOrder(timeline, participant.participantId),
    runes: extractRunes(participant),
    cs: stats.cs,
    damageChampions: stats.damageChampions,
    teamKills: stats.teamKills,
    gold: stats.gold,
    allyChampionIds: comps?.allyChampionIds ?? null,
    enemyChampionIds: comps?.enemyChampionIds ?? null,
    allyPlayers: players?.allyPlayers ?? null,
    enemyPlayers: players?.enemyPlayers ?? null,
  };
}
