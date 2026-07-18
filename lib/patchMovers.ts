// ─────────────────────────────────────────────────────────────────────────────
// patchMovers.ts — Feature 4: biggest WPA swings between the current populated
// coachless patch and the previous populated patch, per lane.
//
// COACHLESS HAS NO CHAMPION-LIST / TIER-LIST ENDPOINT (verified: 6 candidate
// paths all 404'd). So "most-played champs for the role" cannot be pulled in one
// call — a full ladder scan would be ~170 champions × 2 patches × 2 endpoints.
// Instead we bound the candidate set to a curated per-role pool of the meta
// champions for that lane, fetch each champ's current+previous headline keystone
// and headline first-legendary, RANK the pool by current-patch games, keep the
// top N, and emit the biggest |WPA delta| rows. This is an honest approximation:
// the DATA (WPA deltas) is real; only the candidate SELECTION is a curated pool
// rather than an exhaustive ladder ranking. See HANDOFF "Known Issues".
//
// Cost: |pool| × 4 coachless calls (keystone cur/prev, item1 cur/prev), run with
// bounded concurrency. Shares the Next fetch-cache with the build route for the
// unconditioned default-tier bodies, and the route CDN-caches the result 24h, so
// the expensive cold path runs at most ~once/day/role.
// ─────────────────────────────────────────────────────────────────────────────

import type { RoleId } from "./types";
import type { Patch, RuneEntry, ItemEntry } from "./coachless";
import { getKeystoneData, getGlobalItemStatistics } from "./coachless";
import {
  getLatestPatch,
  getPreviousPopulatedPatch,
  getAllChampions,
  resolveRune,
  resolveItem,
  type ResolvedPatch,
} from "./staticData";

// ── Curated per-role candidate pools (numeric champion ids) ──────────────────
// Meta champions per lane. A wrong/absent id simply returns no data and is
// skipped (each fetch is wrapped in try/catch), so the pool is robust to drift.
export const ROLE_CHAMPION_POOL: Record<0 | 1 | 2 | 3 | 4, number[]> = {
  // TOP
  0: [266, 122, 86, 875, 164, 114, 24, 58, 150, 516, 82, 887, 92, 54, 98, 897, 83, 17, 106, 240],
  // JUNGLE
  1: [64, 234, 104, 120, 141, 19, 76, 60, 254, 59, 56, 203, 200, 131, 5, 33, 245, 62, 11, 154],
  // MID
  2: [103, 157, 238, 112, 134, 61, 777, 84, 7, 711, 99, 55, 517, 105, 45, 3, 34, 69, 91, 4],
  // BOT / ADC
  3: [222, 51, 81, 145, 202, 236, 22, 21, 498, 67, 221, 523, 18, 360, 119, 15, 96, 29, 895, 110],
  // SUPPORT
  4: [412, 117, 111, 89, 555, 53, 497, 235, 16, 902, 43, 350, 40, 888, 12, 432, 201, 25, 267, 526],
};

// Tuning constants.
export const MOVERS_TOP_CHAMPS = 25; // rank pool by current games, keep top N
export const MOVERS_MAX_ROWS = 20; // cap emitted movers
export const MOVERS_MIN_GAMES = 500; // ignore a champ barely played in the role
const MOVERS_FETCH_CONCURRENCY = 6;

export type MoverKind = "keystone" | "item";

/** Raw mover (ids only) — the pure, unit-tested computation output. */
export interface RawMover {
  championId: number;
  lane: RoleId;
  kind: MoverKind;
  entityId: number; // rune id or item id
  prevWpa: number;
  currWpa: number;
  delta: number; // currWpa - prevWpa
  gamesCount: number; // current-patch games of the headline entity
}

/** Enriched mover in the API response (names + icon resolved). */
export interface PatchMover {
  championId: number;
  championName: string;
  lane: RoleId;
  kind: MoverKind;
  name: string;
  iconHint: string;
  prevWpa: number;
  currWpa: number;
  delta: number;
  gamesCount: number;
}

export interface PatchMoversResponse {
  patch: string;
  prevPatch: string;
  movers: PatchMover[];
}

export interface PatchMoversUnsupported {
  unsupported: true;
}

/** Per-champion two-patch data assembled before the pure delta computation. */
export interface ChampPatchData {
  championId: number;
  lane: RoleId;
  currGames: number;
  keystoneCur: RuneEntry[];
  keystonePrev: RuneEntry[];
  item1Cur: ItemEntry[];
  item1Prev: ItemEntry[];
}

// ── Pure computation (unit-tested) ───────────────────────────────────────────

function topRuneByOcc(rows: RuneEntry[]): RuneEntry | null {
  if (!rows.length) return null;
  return rows.slice().sort((a, b) => b.occurrence - a.occurrence)[0];
}
function topItemByOcc(rows: ItemEntry[]): ItemEntry | null {
  if (!rows.length) return null;
  return rows.slice().sort((a, b) => b.occurrence - a.occurrence)[0];
}

/** Movers for ONE champion: the headline keystone + headline first legendary,
 *  each ONLY when the same entity exists in BOTH patches (so the delta is a real
 *  WPA swing, not a spurious new-vs-absent jump). */
export function computeMoversForChamp(c: ChampPatchData): RawMover[] {
  const out: RawMover[] = [];

  const kCur = topRuneByOcc(c.keystoneCur);
  if (kCur) {
    const kPrev = c.keystonePrev.find((e) => e.rune === kCur.rune);
    if (kPrev) {
      out.push({
        championId: c.championId,
        lane: c.lane,
        kind: "keystone",
        entityId: kCur.rune,
        prevWpa: kPrev.wpaOverall,
        currWpa: kCur.wpaOverall,
        delta: kCur.wpaOverall - kPrev.wpaOverall,
        gamesCount: kCur.occurrence,
      });
    }
  }

  const iCur = topItemByOcc(c.item1Cur);
  if (iCur) {
    const iPrev = c.item1Prev.find((e) => e.itemId === iCur.itemId);
    if (iPrev) {
      out.push({
        championId: c.championId,
        lane: c.lane,
        kind: "item",
        entityId: iCur.itemId,
        prevWpa: iPrev.wpaOverall,
        currWpa: iCur.wpaOverall,
        delta: iCur.wpaOverall - iPrev.wpaOverall,
        gamesCount: iCur.occurrence,
      });
    }
  }

  return out;
}

/** Rank pool champs by current games, keep the top N, compute + flatten movers,
 *  sort by |delta| desc, cap. Pure — deterministic given its inputs. */
export function computeRankedMovers(
  champs: ChampPatchData[],
  opts: { topChamps: number; maxRows: number; minGames: number }
): RawMover[] {
  const eligible = champs
    .filter((c) => c.currGames >= opts.minGames)
    .sort((a, b) => b.currGames - a.currGames)
    .slice(0, opts.topChamps);
  const raw = eligible.flatMap(computeMoversForChamp);
  return raw
    .slice()
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    .slice(0, opts.maxRows);
}

// ── Orchestrator (injectable for tests) ──────────────────────────────────────

export interface PatchMoversDeps {
  getCurrentPatch: () => Promise<ResolvedPatch>;
  getPrevPatch: (current: ResolvedPatch) => Promise<ResolvedPatch | null>;
  fetchKeystone: (champId: number, role: RoleId, patch: Patch) => Promise<RuneEntry[]>;
  fetchItem1: (champId: number, role: RoleId, patch: Patch) => Promise<ItemEntry[]>;
  championNames: () => Promise<Map<number, string>>;
  resolveRuneMeta: (id: number) => Promise<{ name: string; icon: string }>;
  resolveItemMeta: (id: number) => Promise<{ name: string; icon: string }>;
  pool?: number[]; // override the curated pool (tests)
}

const patchOf = (p: ResolvedPatch): Patch => ({
  major: p.major,
  patch: p.patch,
  patchAdditions: p.patchAdditions,
});

/** Bounded-concurrency map (avoids hammering coachless with |pool|×4 at once). */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export const defaultPatchMoversDeps: PatchMoversDeps = {
  getCurrentPatch: getLatestPatch,
  getPrevPatch: getPreviousPopulatedPatch,
  fetchKeystone: (champId, role, patch) => getKeystoneData(champId, role, patch),
  fetchItem1: (champId, role, patch) =>
    getGlobalItemStatistics(champId, role, patch, [1], 1),
  championNames: async () => {
    const champs = await getAllChampions();
    return new Map(champs.map((c) => [c.id, c.name]));
  },
  resolveRuneMeta: async (id) => {
    const r = await resolveRune(id);
    return { name: r.name, icon: r.icon };
  },
  resolveItemMeta: async (id) => {
    const r = await resolveItem(id);
    return { name: r.name, icon: r.icon };
  },
};

/**
 * Compute patch movers for a lane. Returns `{ unsupported: true }` when there is
 * no previous populated patch to compare against (prior-patch data unavailable).
 * Never throws for a single-champ fetch failure — those are swallowed to [] so
 * one bad champ can't sink the whole report.
 */
export async function computePatchMovers(
  role: 0 | 1 | 2 | 3 | 4,
  deps: PatchMoversDeps = defaultPatchMoversDeps
): Promise<PatchMoversResponse | PatchMoversUnsupported> {
  const current = await deps.getCurrentPatch();
  const previous = await deps.getPrevPatch(current);
  if (!previous) return { unsupported: true };

  const pool = deps.pool ?? ROLE_CHAMPION_POOL[role];
  const curP = patchOf(current);
  const prevP = patchOf(previous);

  const champData = await mapLimit(pool, MOVERS_FETCH_CONCURRENCY, async (champId) => {
    const safe = async <T>(p: Promise<T[]>): Promise<T[]> => {
      try {
        const r = await p;
        return Array.isArray(r) ? r : [];
      } catch {
        return [];
      }
    };
    const [keystoneCur, keystonePrev, item1Cur, item1Prev] = await Promise.all([
      safe(deps.fetchKeystone(champId, role, curP)),
      safe(deps.fetchKeystone(champId, role, prevP)),
      safe(deps.fetchItem1(champId, role, curP)),
      safe(deps.fetchItem1(champId, role, prevP)),
    ]);
    const currGames = keystoneCur.reduce((s, e) => s + e.occurrence, 0);
    return { championId: champId, lane: role, currGames, keystoneCur, keystonePrev, item1Cur, item1Prev };
  });

  const ranked = computeRankedMovers(champData, {
    topChamps: MOVERS_TOP_CHAMPS,
    maxRows: MOVERS_MAX_ROWS,
    minGames: MOVERS_MIN_GAMES,
  });

  const names = await deps.championNames();
  const movers: PatchMover[] = await Promise.all(
    ranked.map(async (m) => {
      const meta =
        m.kind === "keystone"
          ? await deps.resolveRuneMeta(m.entityId)
          : await deps.resolveItemMeta(m.entityId);
      return {
        championId: m.championId,
        championName: names.get(m.championId) ?? `#${m.championId}`,
        lane: m.lane,
        kind: m.kind,
        name: meta.name,
        iconHint: meta.icon,
        prevWpa: m.prevWpa,
        currWpa: m.currWpa,
        delta: m.delta,
        gamesCount: m.gamesCount,
      };
    })
  );

  return { patch: current.label, prevPatch: previous.label, movers };
}
