// ─────────────────────────────────────────────────────────────────────────────
// livePanelModel.ts — pure shaping of the companion's GET /live passthrough
// (raw Riot Live Client Data `allgamedata`) into the ONLY things LivePanel.tsx
// is allowed to render: enemy champion + normalized position. This is the
// compliance regression guard (plan §3): the raw payload's `allPlayers[]`
// rows carry `summonerName`/`riotId` fields we must NEVER read, store, or
// forward — this module reads at most `championName`/`team`/`position` off
// each row and the returned model type has no field capable of holding a
// name/id string, so a future edit that "helpfully" adds a name back in
// would have to invent a NEW field to do it (visible in any diff), not just
// populate an existing one silently.
// ─────────────────────────────────────────────────────────────────────────────

import type { ChampionRef } from "@/lib/types";
import type { LiveDataRaw } from "./companionClient";

export interface LiveEnemy {
  /** ddragon/coachless champion KEY (e.g. "LeeSin"), NOT a display name —
   *  matches Riot Live Client Data's own `championName` field, which is the
   *  internal dev id, not the pretty name. Resolved to an icon/display name
   *  via a champion key->ChampionRef index (indexChampionsByKey below), same
   *  as every other icon lookup in this app. */
  championKey: string;
  /** Short role label ("Top"/"Jg"/"Mid"/"Bot"/"Sup") or null when Live
   *  Client Data reports no position for this mode (e.g. ARAM always has an
   *  empty position field). Never a raw Riot enum string rendered as-is. */
  position: string | null;
}

export interface LivePanelModel {
  enemies: LiveEnemy[];
}

const POSITION_LABEL: Record<string, string> = {
  TOP: "Top",
  JUNGLE: "Jg",
  MIDDLE: "Mid",
  BOTTOM: "Bot",
  UTILITY: "Sup",
};

const ROLE_SORT_ORDER: Record<string, number> = {
  TOP: 0,
  JUNGLE: 1,
  MIDDLE: 2,
  BOTTOM: 3,
  UTILITY: 4,
};

function normalizePosition(position: unknown): { label: string | null; sortKey: number } {
  if (typeof position !== "string") return { label: null, sortKey: 99 };
  const upper = position.toUpperCase();
  return { label: POSITION_LABEL[upper] ?? null, sortKey: ROLE_SORT_ORDER[upper] ?? 99 };
}

interface RawPlayerRow {
  championName?: unknown;
  team?: unknown;
  position?: unknown;
}

function isRawPlayerRow(v: unknown): v is RawPlayerRow {
  return typeof v === "object" && v !== null;
}

/** Builds the enemy-only view of a live allgamedata payload. Returns null
 *  when there's nothing renderable (no live game, malformed/absent
 *  `allPlayers`, or our own champion can't be located in the roster — e.g. a
 *  spectator/replay session with no local player at all). `selfChampionKey`
 *  identifies our own side by finding the roster row whose championName
 *  matches it (Live Client Data has no separate "which team am I" field);
 *  every OTHER team is treated as enemy — in a 5v5 that's exactly the
 *  opposing team, and this degrades safely for any custom-mode roster shape
 *  it hasn't been verified against (never assumes exactly 5 per side). */
export function buildLivePanelModel(raw: LiveDataRaw | null | undefined, selfChampionKey: string): LivePanelModel | null {
  if (!raw || typeof raw !== "object") return null;
  const allPlayers = (raw as { allPlayers?: unknown }).allPlayers;
  if (!Array.isArray(allPlayers)) return null;

  let selfTeam: string | null = null;
  for (const row of allPlayers) {
    if (isRawPlayerRow(row) && row.championName === selfChampionKey && typeof row.team === "string") {
      selfTeam = row.team;
      break;
    }
  }
  if (!selfTeam) return null;

  const enemies: (LiveEnemy & { sortKey: number })[] = [];
  for (const row of allPlayers) {
    if (!isRawPlayerRow(row)) continue;
    if (row.team === selfTeam) continue; // ally or self — never treated as enemy
    if (typeof row.championName !== "string") continue;
    const { label, sortKey } = normalizePosition(row.position);
    enemies.push({ championKey: row.championName, position: label, sortKey });
  }

  enemies.sort((a, b) => a.sortKey - b.sortKey);

  return { enemies: enemies.map(({ championKey, position }) => ({ championKey, position })) };
}

/** Pure index builder: ChampionRef[] (already fetched by the caller, e.g. via
 *  /api/champions) -> Map keyed by champion KEY (not id — Live Client Data
 *  identifies champions by key, never by coachless's numeric id). */
export function indexChampionsByKey(champs: ChampionRef[]): Map<string, ChampionRef> {
  const map = new Map<string, ChampionRef>();
  for (const c of champs) map.set(c.key, c);
  return map;
}

/** Round-B P2 fix — "LivePanel churn": the enemy roster is fixed for the
 *  whole game (nobody's champion changes once InProgress), but the raw
 *  Live Client Data payload is a brand-new object reference every poll
 *  tick, so a naive setModel(buildLivePanelModel(...)) re-rendered
 *  LivePanel's whole subtree once a second, all game, for identical
 *  content. LivePanel.tsx's tick() uses this to skip the setState (and the
 *  resulting re-render) whenever the derived enemy set is byte-identical to
 *  the previous tick's — order-sensitive (buildLivePanelModel's own sort
 *  is deterministic, so a real roster never reorders on its own). */
export function sameLivePanelModel(a: LivePanelModel | null, b: LivePanelModel | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.enemies.length !== b.enemies.length) return false;
  return a.enemies.every((e, i) => e.championKey === b.enemies[i].championKey && e.position === b.enemies[i].position);
}
