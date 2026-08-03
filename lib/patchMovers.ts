// ─────────────────────────────────────────────────────────────────────────────
// patchMovers.ts — Feature 4 (v0.51 rewrite): biggest per-champion ROLE win
// rate shifts between the current populated coachless patch and the previous
// one, across every lane at once (no `role` param — the response covers the
// whole roster, see app/api/patch-movers/route.ts).
//
// v0.51 CHANGE OF MODEL (superseding the old WPA-swing version): the mockup
// this now serves wants "which champions got stronger/weaker in the actual
// win-rate sense," not "which single keystone/item's WPA moved the most."
// Win rate is derived via the EXACT SAME formula lib/heroStats.ts already
// uses for the champion hero-banner ("52.4% WIN · 18,402 GAMES"): the
// occurrence-weighted average of `winrateObserved` across every STARTER item
// (itemType=6) for a champ+lane — see heroStats.ts's header for why this is
// the most defensible "champion win rate" number coachless's API exposes at
// all (there is still no literal per-champion win-rate field or tier-list
// endpoint on coachless — verified there and unchanged since).
//
// CANDIDATE POOL: same curated per-role pools as before (COACHLESS HAS NO
// CHAMPION-LIST / TIER-LIST ENDPOINT — a full ladder scan would be ~170
// champions x 2 patches x 2 endpoints just for THIS feature). Now unioned
// across all 5 lanes (up to 100 candidate (champion, role) pairs — today's
// pools have no champion overlap across lanes, but the code doesn't assume
// that: see pickPrimaryRole). For a champion whose pool membership spans more
// than one role (a genuine dual-role champ), the role with the higher
// CURRENT-patch games wins — that's simply the role the account/ladder
// actually plays them in this patch, not an arbitrary pick.
//
// Cost: up to 100 candidates x 2 patches x 2 coachless calls (keystone for
// games, starter items for win rate) = up to 400 calls, bounded concurrency.
// Route CDN-caches the result 24h (see app/api/patch-movers/route.ts), so the
// expensive cold path runs at most ~once/day.
// ─────────────────────────────────────────────────────────────────────────────

import type { RoleId } from "./types";
import type { Patch } from "./coachless";
import { getKeystoneData, getGlobalItemStatistics } from "./coachless";
import {
  getLatestPatch,
  getPreviousPopulatedPatch,
  getAllChampions,
  type ResolvedPatch,
} from "./staticData";
import { getPatchNote } from "./patchNotes/lookup";

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
/** Minimum current-patch games for a champion+role to be eligible at all —
 *  raised from the old WPA model's 500 (a single keystone/item's sample) to
 *  1000 (a whole champion+lane's game count is a much larger, noisier
 *  aggregate to trust a win-rate delta from). Documented, not derived. */
export const MOVERS_MIN_GAMES = 1000;
/** Cap emitted movers -- a top-N shortlist, not an exhaustive table. */
export const MOVERS_MAX_ROWS = 12;
const MOVERS_FETCH_CONCURRENCY = 10;

/** itemType 6 = starter (see coachless.ts's getGlobalItemStatistics doc) --
 *  mirrors lib/heroStats.ts's STARTER_ITEM_TYPE exactly (see this file's
 *  header for why starter-item occurrence is the win-rate proxy). */
const STARTER_ITEM_TYPE = 6;

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** One champion+role's games/win-rate on ONE patch — the shared shape both
 *  the current- and previous-patch fetch produce. */
export interface ChampRoleWinrate {
  games: number;
  /** null when there's no starter-item data to derive a win rate from (see
   *  heroStats.ts's header) even though games > 0, or when games itself is 0. */
  winRatePct: number | null;
}

/** Per-champion-role two-patch data assembled before the pure delta
 *  computation. */
export interface ChampRoleWinrateData {
  championId: number;
  role: RoleId;
  curr: ChampRoleWinrate;
  prev: ChampRoleWinrate;
}

/** Raw mover (ids only) — the pure, unit-tested computation output. */
export interface RawMover {
  championId: number;
  role: RoleId;
  wrNow: number;
  wrPrev: number;
  deltaPp: number; // wrNow - wrPrev, percentage points, 2 decimals
  games: number; // current-patch games
}

/** Enriched mover in the API response (name + curated note resolved). */
export interface PatchMover {
  championId: number;
  championName: string;
  role: RoleId;
  wrNow: number;
  wrPrev: number;
  deltaPp: number;
  games: number;
  /** lib/patchNotes/lookup.ts's getPatchNote — null renders as "—", see that
   *  file's header. Never fabricated. */
  note: string | null;
}

export interface PatchMoversResponse {
  patch: string;
  prevPatch: string;
  movers: PatchMover[];
}

export interface PatchMoversUnsupported {
  unsupported: true;
}

// ── Pure computation (unit-tested) ───────────────────────────────────────────

/** Among every (champion, role) candidate row FOR THE SAME championId, picks
 *  the one with the highest CURRENT-patch games -- the role that champion is
 *  actually played in on this patch's data, not an arbitrary pick. Ties break
 *  on role ASC (deterministic). Exported for direct unit testing. */
export function pickPrimaryRole(rows: ChampRoleWinrateData[]): ChampRoleWinrateData | null {
  if (rows.length === 0) return null;
  return rows.slice().sort((a, b) => b.curr.games - a.curr.games || a.role - b.role)[0];
}

/** One champion-role's mover, or null when there's nothing comparable: either
 *  patch is missing a win rate, or current games doesn't clear `minGames`. */
export function computeMoverForChamp(row: ChampRoleWinrateData, minGames: number): RawMover | null {
  if (row.curr.winRatePct === null || row.prev.winRatePct === null) return null;
  if (row.curr.games < minGames) return null;
  return {
    championId: row.championId,
    role: row.role,
    wrNow: row.curr.winRatePct,
    wrPrev: row.prev.winRatePct,
    deltaPp: round2(row.curr.winRatePct - row.prev.winRatePct),
    games: row.curr.games,
  };
}

/** Groups candidate rows by championId, resolves each champion's primary
 *  role (pickPrimaryRole), computes its mover (computeMoverForChamp), then
 *  sorts by |deltaPp| desc and caps. Pure — deterministic given its inputs. */
export function computeRankedMovers(
  rows: ChampRoleWinrateData[],
  opts: { minGames: number; maxRows: number }
): RawMover[] {
  const byChamp = new Map<number, ChampRoleWinrateData[]>();
  for (const r of rows) {
    const arr = byChamp.get(r.championId);
    if (arr) arr.push(r);
    else byChamp.set(r.championId, [r]);
  }

  const movers: RawMover[] = [];
  for (const champRows of Array.from(byChamp.values())) {
    const primary = pickPrimaryRole(champRows);
    if (!primary) continue;
    const mover = computeMoverForChamp(primary, opts.minGames);
    if (mover) movers.push(mover);
  }

  return movers
    .slice()
    .sort((a, b) => Math.abs(b.deltaPp) - Math.abs(a.deltaPp) || a.championId - b.championId)
    .slice(0, opts.maxRows);
}

// ── Orchestrator (injectable for tests) ──────────────────────────────────────

export interface PatchMoversDeps {
  getCurrentPatch: () => Promise<ResolvedPatch>;
  getPrevPatch: (current: ResolvedPatch) => Promise<ResolvedPatch | null>;
  /** Games + win rate for one champion+role on one patch — see this file's
   *  header for the derivation (mirrors lib/heroStats.ts's getHeroStats). */
  fetchWinrate: (champId: number, role: RoleId, patch: Patch) => Promise<ChampRoleWinrate>;
  championNames: () => Promise<Map<number, string>>;
  /** lib/patchNotes/lookup.ts's getPatchNote, keyed on the CURRENT patch's
   *  label (this feature describes "what changed this patch"). */
  getNote: (patch: string, championId: number) => string | null;
  /** Override the curated per-role pool map (tests). */
  pool?: Record<0 | 1 | 2 | 3 | 4, number[]>;
}

const patchOf = (p: ResolvedPatch): Patch => ({
  major: p.major,
  patch: p.patch,
  patchAdditions: p.patchAdditions,
});

/** Bounded-concurrency map (avoids hammering coachless with all candidates at
 *  once). */
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

async function fetchWinrateViaCoachless(
  champId: number,
  role: RoleId,
  patch: Patch
): Promise<ChampRoleWinrate> {
  const [keystoneData, starterData] = await Promise.all([
    getKeystoneData(champId, role, patch),
    getGlobalItemStatistics(champId, role, patch, null, STARTER_ITEM_TYPE),
  ]);
  const games = keystoneData.reduce((s, e) => s + e.occurrence, 0);
  if (games === 0) return { games: 0, winRatePct: null };

  const starterTotal = starterData.reduce((s, e) => s + e.occurrence, 0);
  if (starterTotal === 0) return { games, winRatePct: null };

  const weighted =
    starterData.reduce((s, e) => s + e.winrateObserved * e.occurrence, 0) / starterTotal;
  return { games, winRatePct: round1(weighted) };
}

export const defaultPatchMoversDeps: PatchMoversDeps = {
  getCurrentPatch: getLatestPatch,
  getPrevPatch: getPreviousPopulatedPatch,
  fetchWinrate: fetchWinrateViaCoachless,
  championNames: async () => {
    const champs = await getAllChampions();
    return new Map(champs.map((c) => [c.id, c.name]));
  },
  getNote: getPatchNote,
};

/**
 * Compute patch movers across every lane. Returns `{ unsupported: true }`
 * when there is no previous populated patch to compare against. Never throws
 * for a single-champ fetch failure — those are swallowed to a null win rate
 * so one bad candidate can't sink the whole report.
 */
export async function computePatchMovers(
  deps: PatchMoversDeps = defaultPatchMoversDeps
): Promise<PatchMoversResponse | PatchMoversUnsupported> {
  const current = await deps.getCurrentPatch();
  const previous = await deps.getPrevPatch(current);
  if (!previous) return { unsupported: true };

  const pool = deps.pool ?? ROLE_CHAMPION_POOL;
  const curP = patchOf(current);
  const prevP = patchOf(previous);

  const candidates: { championId: number; role: RoleId }[] = [];
  for (const role of [0, 1, 2, 3, 4] as const) {
    for (const championId of pool[role]) {
      candidates.push({ championId, role });
    }
  }

  const rows = await mapLimit(candidates, MOVERS_FETCH_CONCURRENCY, async ({ championId, role }) => {
    const safe = async (p: Promise<ChampRoleWinrate>): Promise<ChampRoleWinrate> => {
      try {
        return await p;
      } catch {
        return { games: 0, winRatePct: null };
      }
    };
    const [curr, prev] = await Promise.all([
      safe(deps.fetchWinrate(championId, role, curP)),
      safe(deps.fetchWinrate(championId, role, prevP)),
    ]);
    const data: ChampRoleWinrateData = { championId, role, curr, prev };
    return data;
  });

  const ranked = computeRankedMovers(rows, {
    minGames: MOVERS_MIN_GAMES,
    maxRows: MOVERS_MAX_ROWS,
  });

  const names = await deps.championNames();
  const movers: PatchMover[] = ranked.map((m) => ({
    championId: m.championId,
    championName: names.get(m.championId) ?? `#${m.championId}`,
    role: m.role,
    wrNow: m.wrNow,
    wrPrev: m.wrPrev,
    deltaPp: m.deltaPp,
    games: m.games,
    note: deps.getNote(current.label, m.championId),
  }));

  return { patch: current.label, prevPatch: previous.label, movers };
}
