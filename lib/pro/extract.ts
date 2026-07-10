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

/** Splits a match's participants by teamId into the tracked player's ally
 *  side (own team, INCLUDING self) and the enemy side, by championId. Order
 *  within each array is source (participant array) order — cheap and stable,
 *  not role-sorted since teamPosition can be "" and this must stay total.
 *  Returns null unless BOTH sides have exactly 5 champions — queue=420
 *  (ranked solo/duo, the only queue lib/pro/ingestMatches.ts ingests) is
 *  always 5v5, so this should always succeed in practice, but a truncated
 *  fetch or a remake with missing participants must never store a partial
 *  side (dpm.lol-style comps rows are all-or-nothing on the frontend). */
export function extractTeamComps(match: RiotMatch, puuid: string): ExtractedTeamComps | null {
  const participant = match.info.participants.find((p) => p.puuid === puuid);
  if (!participant) return null;
  const ally = match.info.participants.filter((p) => p.teamId === participant.teamId).map((p) => p.championId);
  const enemy = match.info.participants.filter((p) => p.teamId !== participant.teamId).map((p) => p.championId);
  if (ally.length !== 5 || enemy.length !== 5) return null;
  return { allyChampionIds: ally, enemyChampionIds: enemy };
}

/** Returns null (caller must skip+log) when the participant's role can't be
 *  mapped — never store a row with a guessed role. */
export function extractMatch(match: RiotMatch, timeline: RiotTimeline, puuid: string): ExtractedMatch | null {
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
  };
}
