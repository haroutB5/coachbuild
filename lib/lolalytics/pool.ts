// ─────────────────────────────────────────────────────────────────────────────
// lib/lolalytics/pool.ts — champion-pool provider seam + pool/overall split
// for the /draft counter-pick strip. Deliberately dependency-free (no
// server imports) so the client strip can import the split directly.
//
// POOL SOURCE PRECEDENCE (user directive 2026-09-08): the companion's LCU
// data (most-played/mastery via the bridge) is preferred; the mystats
// ingest is slated for retirement, so it is ONLY a fallback when the LCU
// pool is unavailable. No companion endpoint exposes a champion pool TODAY
// (checked 2026-09-08: the bridge carries champ-select state, most-played
// LANE, and rank samples — no mastery/pool surface), so the LCU input is an
// explicit optional prop threaded from the page (`lcuPoolChampIds`, null
// until such an endpoint exists) and the seam below prefers it the moment it
// is non-empty. Adding the endpoint later must not touch this file — only
// the call site that fills the prop.
// ─────────────────────────────────────────────────────────────────────────────

export type CounterPickPoolSource = "lcu" | "mystats" | "none";

export interface CounterPickPool {
  champIds: number[];
  source: CounterPickPoolSource;
}

/**
 * One place the precedence lives. An LCU pool with at least one id wins;
 * otherwise the mystats fallback (played-lane pool champIds); otherwise
 * "none" with an empty list. Never throws — bad inputs degrade to "none".
 */
export function resolveCounterPickPool(args: {
  lcuPoolChampIds?: number[] | null;
  mystatsPoolChampIds?: number[] | null;
}): CounterPickPool {
  const clean = (ids: number[] | null | undefined): number[] =>
    Array.isArray(ids) ? ids.filter((id) => Number.isInteger(id) && id > 0) : [];
  const lcu = clean(args.lcuPoolChampIds);
  if (lcu.length > 0) return { champIds: lcu, source: "lcu" };
  const mystats = clean(args.mystatsPoolChampIds);
  if (mystats.length > 0) return { champIds: mystats, source: "mystats" };
  return { champIds: [], source: "none" };
}

export interface PoolSplitSuggestion {
  champId: number;
}

export interface CounterPickSplit<T extends PoolSplitSuggestion> {
  /** Ranked suggestions ∩ the user's pool, rank order preserved. */
  poolPicks: T[];
  /** Global top-N EXCLUDING poolPicks members (no duplicate rows across the
   *  two groups). */
  overallPicks: T[];
  poolSource: CounterPickPoolSource;
}

/**
 * Pure rank-preserving split. "Intersect with the user's pool first, fall
 * back to global top 5": poolPicks is the intersection (cap poolLimit),
 * overallPicks is the global top overallLimit with pool members removed. An
 * empty pool (source "none") yields poolPicks: [] and the plain global top
 * — the caller renders the "overall" group alone, which IS the fallback.
 */
export function splitCounterSuggestions<T extends PoolSplitSuggestion>(
  ranked: readonly T[],
  pool: CounterPickPool,
  poolLimit: number = 5,
  overallLimit: number = 5
): CounterPickSplit<T> {
  const poolSet = new Set(pool.champIds);
  const poolPicks = ranked.filter((s) => poolSet.has(s.champId)).slice(0, poolLimit);
  const poolPickIds = new Set(poolPicks.map((s) => s.champId));
  const overallPicks = ranked.filter((s) => !poolPickIds.has(s.champId)).slice(0, overallLimit);
  return { poolPicks, overallPicks, poolSource: pool.source };
}
