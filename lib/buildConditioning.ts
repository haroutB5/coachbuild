// ─────────────────────────────────────────────────────────────────────────────
// buildConditioning.ts — PURE selection primitives for conditioned builds.
// No network, no wall-clock. Backs Feature 2 (sequential item optimizer) and
// Feature 1 (matchup conditioning). Kept separate from recommend.ts so the
// threshold / fallback / truncation logic is unit-testable against mock data
// (the same convention recommend.test.ts uses for the base ranking primitives).
// ─────────────────────────────────────────────────────────────────────────────

/** Minimal shape shared by every conditioned candidate list. */
export interface OccWpa {
  occurrence: number;
  wpaOverall: number;
}

function compareConditionedCandidates<T extends OccWpa>(
  a: T,
  b: T,
  idOf?: (entry: T) => number
): number {
  if (a.wpaOverall !== b.wpaOverall) return b.wpaOverall - a.wpaOverall;
  if (idOf) return idOf(a) - idOf(b);
  return 0;
}

// ── Guard thresholds ─────────────────────────────────────────────────────────
// Conditioned pools are SUBSETS of the unconditioned pool, so their absolute
// samples are much smaller. These are FLAT floors (not fractions of the
// champion's total games) because the whole point of conditioning is that the
// denominator shrinks — a 5%-of-total bar would reject almost every conditioned
// pick. Values chosen so a pick still rests on a defensible sample:
//   OPTIMIZER_MIN_SAMPLE — a legendary must have been built (conditioned on the
//     prior items) at least this many times to enter the optimized path.
//   MATCHUP_MIN_SAMPLE   — per-slot: a matchup-conditioned pick must clear this,
//     else that slot falls back to the unconditioned recommendation.
//   MATCHUP_MIN_TOTAL    — whole-matchup gate: if the matchup-conditioned games
//     total is below this, treat the matchup as unsupported and fall back fully.
export const OPTIMIZER_MIN_SAMPLE = 300;
export const MATCHUP_MIN_SAMPLE = 200;
export const MATCHUP_MIN_TOTAL = 800;
// Adoption-relative floor for the optimizer (mirrors the base engine's ADOPT_FRAC
// philosophy): a conditioned pick must clear BOTH the flat OPTIMIZER_MIN_SAMPLE
// and this fraction of the conditioned slot's total games. WITHOUT this, "highest
// WPA above a flat 300" surfaces tail spikes — verified live: Viktor's slot-2
// optimized pick came back as Archangel's Staff at just 430 conditional games /
// +3.69 WPA (a high-variance outlier), not a well-adopted conditional item.
export const OPTIMIZER_ADOPT_FRAC = 0.05;

/** Highest-WPA candidate that clears the sample guard and isn't excluded. The
 *  guard is `max(minSample, adoptFrac × pool-total-games)` — a flat floor PLUS
 *  an adoption-relative floor, so the "optimized next pick" is the highest-WPA
 *  item with genuinely meaningful conditional support, not a small-sample spike.
 *  `adoptFrac` defaults to 0 (pure flat floor) for callers that want it. Null
 *  when nothing qualifies. */
export function conditionedLeader<T extends OccWpa>(
  entries: T[],
  minSample: number,
  isExcluded?: (e: T) => boolean,
  adoptFrac = 0,
  idOf?: (entry: T) => number
): T | null {
  const total = entries.reduce((s, e) => s + e.occurrence, 0);
  const floor = Math.max(minSample, total * adoptFrac);
  const pool = entries.filter(
    (e) => e.occurrence >= floor && !(isExcluded?.(e) ?? false)
  );
  if (pool.length === 0) return null;
  return pool.slice().sort((a, b) => compareConditionedCandidates(a, b, idOf))[0];
}

/** Greedy sequential item optimizer (Feature 2).
 *  `fetchSlot(prefixItemIds)` returns the conditioned candidate pool for the
 *  NEXT slot given the items already chosen (its length is the depth: [] for
 *  slot-1, [first] for slot-2, [first,second] for slot-3). Walks up to
 *  `maxDepth` slots, truncating the moment a slot yields no candidate clearing
 *  `minSample`. Returns the chosen entries in order. Pure w.r.t. selection —
 *  the ONLY effectful thing is the injected `fetchSlot`, which the caller wires
 *  to the coachless client (and tests wire to a fixture map).
 *
 *  Depth is inherently capped at 3 by the API: it conditions on at most 2 prior
 *  legendaries (firstLegendaryId / secondLegendaryId; thirdLegendaryId is a
 *  verified no-op), so slot-4 could not be conditioned on 3 priors anyway. */
export async function buildOptimizedPath<T extends OccWpa & { itemId: number }>(
  fetchSlot: (prefixItemIds: number[]) => Promise<T[]>,
  maxDepth: number,
  minSample: number,
  seedItemIds: number[] = [],
  adoptFrac = 0
): Promise<T[]> {
  // Returns ONLY the newly-optimized picks (the caller prepends whatever seed it
  // passed). `seedItemIds` are already-committed items (e.g. the core first
  // legendary) — they pre-load the exclude set and prefix every fetchSlot call
  // so the chain never re-picks them and each slot is conditioned on the FULL
  // running prefix.
  const chosen: T[] = [];
  const usedIds = new Set<number>(seedItemIds);
  for (let depth = 0; depth < maxDepth; depth++) {
    const prefix = [...seedItemIds, ...chosen.map((c) => c.itemId)];
    const pool = await fetchSlot(prefix);
    const next = conditionedLeader(pool, minSample, (e) => usedIds.has(e.itemId), adoptFrac, (e) => e.itemId);
    if (!next) break; // conditioned samples collapsed → truncate here
    chosen.push(next);
    usedIds.add(next.itemId);
  }
  return chosen;
}

// ── Matchup per-slot resolution (Feature 1) ──────────────────────────────────

export interface Conditioned<T> {
  entry: T;
  /** true → conditioned pick used; false → fell back to the unconditioned one. */
  conditioned: boolean;
}

/** Choose between a matchup-conditioned pool and the unconditioned fallback for
 *  ONE slot. Uses the conditioned leader when it clears `minSample`; otherwise
 *  returns the unconditioned entry flagged `conditioned:false`. `isExcluded`
 *  lets the caller keep matchup item picks from colliding (e.g. don't re-pick
 *  the boots as a legendary). */
export function resolveMatchupSlot<T extends OccWpa>(
  conditionedPool: T[],
  fallback: T,
  minSample: number,
  isExcluded?: (e: T) => boolean,
  idOf?: (entry: T) => number
): Conditioned<T> {
  const leader = conditionedLeader(conditionedPool, minSample, isExcluded, 0, idOf);
  if (leader) return { entry: leader, conditioned: true };
  return { entry: fallback, conditioned: false };
}
