// ─────────────────────────────────────────────────────────────────────────────
// laneDefaults.ts — one "flagship" champion per lane for the sidebar
// (Top/Jungle/Mid/Bot/Support — the redesign mockup shows Darius/Lee Sin/
// Viktor/Jinx/Thresh).
// ─────────────────────────────────────────────────────────────────────────────
//
// "Most played" = highest total occurrence (games) from Rune/GetKeystoneData,
// summed across the CURRENT resolved patch's high-elo data — the same
// total-games definition recommend.ts/heroStats.ts already use. Computed by
// sweeping every champion coachless has data for, per lane, and taking the
// max: genuinely computed, not hardcoded, per the brief.
//
// COST NOTE (documented deviation — read before changing CONCURRENCY/BUDGET):
// there is no champion-overview/tier-list endpoint on coachless's API (probed
// ~12 plausible endpoint names live 2026-07-12, all 404; `championIds: []`
// only returns a role-wide AGGREGATE across every champion, not a
// per-champion breakdown — no way to get "most played per lane" in fewer
// than one call per champion). A full sweep is therefore up to
// 172 champs x 5 lanes = 860 calls on a stone-cold cache. Mitigations:
//   1. coachless.ts's `post()` already opts every call into Next's 6h fetch
//      data-cache, so a warm deployment reuses cached rows instead of
//      re-fetching.
//   2. This module ALSO memoizes the finished result in-process for
//      LANE_CACHE_SUCCESS_TTL_MS with a single-flight guard (mirrors
//      staticData.ts's getLatestPatch pattern).
//   3. A wall-clock SWEEP_BUDGET_MS caps the walk — any lane not resolved by
//      the deadline falls back to the static flagship map for THAT lane
//      only, rather than blocking the caller indefinitely.
// Even so: a stone-cold serverless instance (no warm in-process cache, no
// warm Next data-cache) hitting `/api/lane-defaults` first is a real latency
// risk. Worth pointing a cron/warm-up hit at this route the same way
// prostage ingest is externally pinged (repo Gotcha (o)), rather than
// relying on organic user traffic to warm it — flagged for urgot/devy, not
// fixed here (infra decision, out of lib-module scope).
//
// LIVE VERIFICATION SCOPE: the winner-selection logic (`pickMostPlayed`) and
// the underlying occurrence sums were verified against REAL coachless
// responses on a representative per-lane candidate shortlist (not the full
// 172-champion sweep — see HANDOFF-engo.md for why running all 860 calls
// during development wasn't done, and what the shortlist run actually
// returned).

import type { ChampionRef, RoleId } from "./types";
import { getKeystoneData } from "./coachless";
import { getAllChampions, getLatestPatch } from "./staticData";

export type LaneKey = "top" | "jungle" | "mid" | "bot" | "support";

export interface LaneDefault {
  championId: number;
  championName: string;
}

const LANE_ROLE: Record<LaneKey, RoleId> = {
  top: 0,
  jungle: 1,
  mid: 2,
  bot: 3,
  support: 4,
};

const LANES: LaneKey[] = ["top", "jungle", "mid", "bot", "support"];

/** Verified-good static fallback (matches the redesign mockup's own picks —
 *  Darius/Lee Sin/Viktor/Jinx/Thresh are all real, currently-popular
 *  flagship picks for their lanes) — used ONLY when a lane's live sweep
 *  can't produce a winner at all (every probe failed, or the budget ran out
 *  before any result came back for that lane, or the champion list / patch
 *  resolution itself failed). Never silently overrides a real computed
 *  result — see getLaneDefaults / computeAllLanes. */
const STATIC_FALLBACK: Record<LaneKey, LaneDefault> = {
  top: { championId: 122, championName: "Darius" },
  jungle: { championId: 64, championName: "Lee Sin" },
  mid: { championId: 112, championName: "Viktor" },
  bot: { championId: 222, championName: "Jinx" },
  support: { championId: 412, championName: "Thresh" },
};

const CONCURRENCY = 12;
const PER_CALL_TIMEOUT_MS = 5000;
const SWEEP_BUDGET_MS = 20000; // whole-sweep wall-clock cap; see COST NOTE above
const LANE_CACHE_SUCCESS_TTL_MS = 6 * 60 * 60 * 1000; // 6h, matches coachless.ts's own fetch-cache TTL
const LANE_CACHE_FAILURE_TTL_MS = 5 * 60 * 1000;

let laneCache: {
  value: Record<LaneKey, LaneDefault>;
  resolvedAt: number;
  ok: boolean;
} | null = null;
let inFlight: Promise<Record<LaneKey, LaneDefault>> | null = null;

/** Test-only: clear the module-level cache + in-flight guard between test cases. */
export function __resetLaneDefaultsCacheForTests(): void {
  laneCache = null;
  inFlight = null;
}

/**
 * Pure: given per-champion occurrence for ONE lane, pick the max. Exported
 * for direct unit testing (no network). Returns null if every candidate has
 * zero (or unknown) occurrence — caller falls back to STATIC_FALLBACK.
 * Ties (identical occurrence) resolve to whichever candidate appears first
 * in `candidates` — deterministic, but arbitrary; not expected to matter in
 * practice given real sample sizes are in the tens/hundreds of thousands.
 */
export function pickMostPlayed(
  candidates: ChampionRef[],
  occurrenceById: Map<number, number>
): LaneDefault | null {
  let best: ChampionRef | null = null;
  let bestOcc = 0;
  for (const c of candidates) {
    const occ = occurrenceById.get(c.id) ?? 0;
    if (occ > bestOcc) {
      bestOcc = occ;
      best = c;
    }
  }
  return best ? { championId: best.id, championName: best.name } : null;
}

/** Runs `fn` over `items` with at most `limit` in flight at once. */
async function mapWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>
): Promise<void> {
  let idx = 0;
  async function worker(): Promise<void> {
    while (idx < items.length) {
      const cur = idx++;
      await fn(items[cur]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker())
  );
}

/** One lane's occurrence sweep across the full champion pool, budget-capped. */
async function sweepLane(
  champions: ChampionRef[],
  role: RoleId,
  patch: { major: number; patch: number; patchAdditions: number },
  deadline: number
): Promise<Map<number, number>> {
  const occurrenceById = new Map<number, number>();
  await mapWithConcurrency(champions, CONCURRENCY, async (champ) => {
    if (Date.now() >= deadline) return; // budget exhausted mid-sweep
    try {
      const rows = await getKeystoneData(
        champ.id,
        role,
        patch,
        AbortSignal.timeout(PER_CALL_TIMEOUT_MS)
      );
      const total = rows.reduce((s, e) => s + e.occurrence, 0);
      if (total > 0) occurrenceById.set(champ.id, total);
    } catch {
      // One champ's probe failing (timeout, 5xx, no data) never sinks the
      // whole sweep — it just can't win this lane.
    }
  });
  return occurrenceById;
}

async function computeAllLanes(): Promise<Record<LaneKey, LaneDefault>> {
  const deadline = Date.now() + SWEEP_BUDGET_MS;
  const [champions, patchInfo] = await Promise.all([
    getAllChampions(),
    getLatestPatch(),
  ]);
  const patch = {
    major: patchInfo.major,
    patch: patchInfo.patch,
    patchAdditions: patchInfo.patchAdditions,
  };

  const result = {} as Record<LaneKey, LaneDefault>;
  for (const lane of LANES) {
    if (Date.now() >= deadline) {
      result[lane] = STATIC_FALLBACK[lane];
      continue;
    }
    const occurrenceById = await sweepLane(
      champions,
      LANE_ROLE[lane],
      patch,
      deadline
    );
    result[lane] = pickMostPlayed(champions, occurrenceById) ?? STATIC_FALLBACK[lane];
  }
  return result;
}

/**
 * Returns one "most played" champion per lane, computed from live
 * occurrence data (see module header for the derivation + cost tradeoffs).
 * Memoized in-process for LANE_CACHE_SUCCESS_TTL_MS with a single-flight
 * guard, same pattern as staticData.ts's getLatestPatch. On total failure
 * (getAllChampions/getLatestPatch itself throwing) returns STATIC_FALLBACK
 * wholesale and caches that outcome for a much shorter TTL so a transient
 * outage self-heals quickly. `now` is injectable for tests; defaults to the
 * real clock.
 */
export async function getLaneDefaults(
  now: () => number = Date.now
): Promise<Record<LaneKey, LaneDefault>> {
  const t = now();
  if (laneCache) {
    const ttl = laneCache.ok ? LANE_CACHE_SUCCESS_TTL_MS : LANE_CACHE_FAILURE_TTL_MS;
    if (t - laneCache.resolvedAt < ttl) return laneCache.value;
  }
  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      const value = await computeAllLanes();
      laneCache = { value, resolvedAt: t, ok: true };
      return value;
    } catch (err) {
      console.error(
        "[laneDefaults] getLaneDefaults failed, using static fallback:",
        err
      );
      laneCache = { value: STATIC_FALLBACK, resolvedAt: t, ok: false };
      return STATIC_FALLBACK;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}
