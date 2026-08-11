// ─────────────────────────────────────────────────────────────────────────────
// lib/draft/blindPick.ts — PURE blind-pick safety scoring. Inputs are already-
// decoded matchup rows; there is no DB, network, or champion metadata lookup
// here, so the distributional arithmetic stays exhaustively unit-testable like
// lib/draft/score.ts.
//
// The opponent prior is deliberately lane-wide: p(o) aggregates games for an
// opponent across ALL champions in this (patch, tier, role) bucket. Using
// p(o|c) would reuse the counterpick-distorted opponents that champion c has
// historically faced, which is the exposure this score is meant to measure.
//
// N_FLOOR is intentionally NOT used here. playScore drops cells below that
// floor because a thin cell is weak evidence for the one matchup being played.
// Blind-pick scoring is a distribution over the whole field: dropping thin
// cells removes rare-but-real counters and overstates safety. Shrinkage already
// handles those cells (a six-game cell has weight 6/(6+K), so it collapses back
// toward baseline without fabricating a scary tail).
//
// Pool asymmetry is deliberate: rankBlindPicks applies a lane-share floor
// because Blind Pick is a first-pick safety surface, where an off-meta pick's
// measured strength may depend on being saved for a counterpick or on an
// opponent seeing it late. Suggested Picks in recommend.ts keeps its existing
// pool because that surface explicitly allows a genuinely strong niche pick to
// sit above a popular staple.
// ─────────────────────────────────────────────────────────────────────────────

import {
  K,
  filterPoolByLaneShare,
  filterPoolByTotalGames,
  laneShare,
  realLaneGames,
  type ChampBaseline,
} from "@/lib/draft/score";

/** Engineering default, not a measured optimum: penalty for a tail below 50%. */
export const RISK_AVERSION = 0.5;
/** Engineering default, not a measured optimum: lower-tail probability mass. */
export const ES_TAIL_MASS = 0.1;
/** Engineering default, not a measured optimum: threshold for a risky field cell. */
export const BAD_MATCHUP_WR = 0.48;

/** The mass-coverage evidence gate uses the existing 30-game boundary, but
 *  does not drop those cells from any score calculation.
 *
 *  UNCHANGED at 30 by v0.109.0, on purpose, and this is the deliberate half
 *  of that release's recalibration. Individual matchup cells DID collapse
 *  with the tier-15 bucket — measured on patch 16.14, cells holding >= 30
 *  games fell from 11,930 to 5,006 in top lane and from 6,008 to 2,676 in
 *  bot — so the mechanical move would have been to scale this down by the
 *  same ~8x, to 4. That would be wrong. This number answers "is this cell
 *  real evidence about this matchup", and 4 games is not evidence of
 *  anything in either bucket. Evidence floors are absolute (same reasoning as
 *  N_FLOOR); popularity floors are relative (see score.ts's
 *  POOL_MIN_LANE_SHARE). The gate below is what absorbs the population
 *  change, because coverage is a fraction and fractions travel. */
export const MASS_GATE_MIN_GAMES = 30;

/** Minimum share of the opponent prior that must be covered by cells meeting
 *  MASS_GATE_MIN_GAMES before a champion is published.
 *
 *  v0.109.0: 0.9 -> 0.75, and the reason is what the measurement showed this
 *  gate to BE rather than what it was assumed to be. It was written as an
 *  "engineering default", and against tier-10 data it never fired once: the
 *  WORST coverage of any qualifying candidate in any lane was 0.981, so 0.9
 *  sat nine points clear of the entire distribution and excluded 0 champions
 *  in all five lanes. It was a pathology guard — the thing it catches is a
 *  champion whose field is mostly UNMEASURED, so its safety score would be an
 *  average over data that mostly does not exist.
 *
 *  MEASURED, patch 16.14, coverage over the lane-share-qualified pool:
 *    tier 10: worst 0.981 · median 0.995-0.997 · excluded at 0.9 = 0 of 220
 *    tier 15: worst 0.880 · median 0.948-0.985 · excluded at 0.9 = 4 of 229
 *  All four exclusions are top-lane champions sitting at 0.88-0.90 — i.e.
 *  88-90% of the field measured, which is an ordinary tail on a smaller
 *  bucket, not a champion nobody has played into. Holding the bar at 0.9
 *  turns a guard that never fires into a routine trimmer, and it does it
 *  silently: the candidate lands in `excludedByMassGate` and the API returns
 *  200 with a shorter (or empty) ladder.
 *
 *  0.75 restores the ORIGINAL relationship — comfortably below every real
 *  observed value in both buckets (0.88 worst), comfortably above a field
 *  that is genuinely unobserved. It excludes 0 of 229 today, which is the
 *  same thing it did at tier 10 and is the correct behaviour for a guard
 *  against a condition that is not currently happening. Thin cells are not
 *  ignored meanwhile: they stay in the distribution and matchupEstimate
 *  shrinks each one toward baseline by n/(n+K), so a six-game cell cannot
 *  fabricate a scary tail. Whatever this gate DOES exclude is reported —
 *  `excludedByMassGate` reaches the page, and an all-withheld ladder is
 *  labelled as such (see the route's `emptyReason`). */
export const MASS_COVERAGE_GATE = 0.75;
export const BLIND_PICK_TOP_N = 10;

/** One decoded row from coachbuild.draft_matchup. Perspective is champId. */
export interface BlindPickMatchupRow {
  champId: number;
  oppId: number;
  wins: number;
  games: number;
}

/** Candidate pool row. baselineWr and totalGames are derived from the same
 * matchup rows by deriveBlindPickCandidates, matching lib/draft/ingest.ts's
 * baseline derivation. The nullable presence fields exist only so the pool can
 * reuse score.ts's existing filterPoolByTotalGames without inventing popularity
 * data (pickrate/banrate remain unknown). */
export type BlindPickCandidate = ChampBaseline;

export interface BlindPickWorstMatchup {
  oppId: number;
  wr: number;
  /** Games behind THIS matchup — not the champion's lane total, which is
   *  routinely two orders of magnitude larger and says nothing about whether
   *  this specific claim is trustworthy. Singed mid holds 11,476 lane games
   *  while his worst matchup rests on 137; the row's Games column cannot carry
   *  that distinction, so the cell carries its own denominator. `wr` is already
   *  shrunk toward baseline by n/(n+K), so a thin cell cannot produce an
   *  alarming number — but the reader still deserves to see which it is. */
  games: number;
}

export interface BlindPickResult {
  rank: number;
  champId: number;
  blindScore: number;
  fieldWr: number;
  es10: number;
  badMass: number;
  worstMatchup: BlindPickWorstMatchup | null;
  /** Aggregate games for this champion across every opponent row in the lane. */
  totalGames: number;
  /** Candidate opponent prior mass covered by cells with >= 30 games. */
  coverageMass: number;
}

export interface BlindPickRanking {
  picks: BlindPickResult[];
  /** Count after the shared pool floor (score.ts's filterPoolByTotalGames,
   *  now lane-share-derived) and before the Blind-Pick lane-share floor. */
  poolCandidates: number;
  qualifiedCandidates: number;
  /** Candidates in the total-game pool that failed the lane-share floor. */
  excludedByLaneShare: number;
  /** Candidates in the lane-share pool that failed MASS_COVERAGE_GATE. */
  excludedByMassGate: number;
  /** Candidates that produced no result at all (no usable rows) — a different
   *  failure from failing the gate, counted separately so neither number lies.
   *  Expected to be 0 on real data; see rankBlindPicks. */
  excludedUncomputable: number;
}

interface AggregateRow {
  wins: number;
  games: number;
}

interface CandidateOpponent {
  oppId: number;
  wins: number;
  games: number;
  priorMass: number;
  matchupWr: number;
}

/** champId -> oppId -> summed {wins, games}. Named because it is now passed
 *  between the exported functions rather than rebuilt inside each one. */
export type ChampionAggregate = Map<number, Map<number, AggregateRow>>;

function aggregateRows(rows: BlindPickMatchupRow[]): ChampionAggregate {
  const byChampion = new Map<number, Map<number, AggregateRow>>();
  for (const row of rows) {
    if (!Number.isFinite(row.games) || row.games <= 0) continue;
    const byOpponent = byChampion.get(row.champId) ?? new Map<number, AggregateRow>();
    const current = byOpponent.get(row.oppId) ?? { wins: 0, games: 0 };
    current.wins += row.wins;
    current.games += row.games;
    byOpponent.set(row.oppId, current);
    byChampion.set(row.champId, byOpponent);
  }
  return byChampion;
}

/** Aggregate the lane-wide opponent prior p(o) across every champion row. */
export function buildOpponentPrior(rows: BlindPickMatchupRow[]): Map<number, number> {
  const byChampion = aggregateRows(rows);
  const opponentGames = new Map<number, number>();
  let totalGames = 0;

  byChampion.forEach((byOpponent) => {
    byOpponent.forEach((row, oppId) => {
      opponentGames.set(oppId, (opponentGames.get(oppId) ?? 0) + row.games);
      totalGames += row.games;
    });
  });

  if (totalGames <= 0) return new Map();
  const prior = new Map<number, number>();
  opponentGames.forEach((games, oppId) => prior.set(oppId, games / totalGames));
  return prior;
}

/** Derive each champion's baseline exactly as the ingest does: aggregate wins
 * and games across that champion's own opponent rows. */
export function deriveBlindPickCandidates(rows: BlindPickMatchupRow[]): BlindPickCandidate[] {
  const byChampion = aggregateRows(rows);
  const candidates: BlindPickCandidate[] = [];

  byChampion.forEach((byOpponent, champId) => {
    let wins = 0;
    let games = 0;
    byOpponent.forEach((row) => {
      wins += row.wins;
      games += row.games;
    });
    if (games <= 0) return;
    candidates.push({ champId, baselineWr: wins / games, pickrate: null, banrate: null, totalGames: games });
  });

  return candidates;
}

/** The shrunk matchup estimate m(c,o). There is intentionally no N_FLOOR
 * branch: every positive-game cell remains in the distribution. */
export function matchupEstimate(baselineWr: number, wins: number, games: number): number | null {
  if (!Number.isFinite(games) || games <= 0) return null;
  const rawWr = wins / games;
  return baselineWr + (games / (games + K)) * (rawWr - baselineWr);
}

function sortByMatchupRisk(a: CandidateOpponent, b: CandidateOpponent): number {
  if (a.matchupWr !== b.matchupWr) return a.matchupWr - b.matchupWr;
  return a.oppId - b.oppId;
}

/** Compute one candidate's distributional figures. `opponentPrior` is passed
 * in by rankBlindPicks so all candidates use the same global p(o); callers can
 * omit it for a standalone calculation and it will still be lane-wide. */
export function computeBlindPickCandidate(
  candidate: BlindPickCandidate,
  rows: BlindPickMatchupRow[],
  opponentPrior: Map<number, number> = buildOpponentPrior(rows),
  // Same reason `opponentPrior` is injectable: rankBlindPicks calls this once
  // per candidate, and re-aggregating all ~25k lane rows each time cost ~150ms
  // per uncached request (measured 2026-08-01 audit: 193ms lane 0, 134ms lane 2
  // — comparable to the DB query itself). Hoisted by the caller; the default
  // keeps a standalone call correct. Both defaults are pure functions of `rows`,
  // so an injected value can only ever be the same value computed earlier.
  aggregated: ChampionAggregate = aggregateRows(rows)
): BlindPickResult | null {
  const candidateRows = aggregated.get(candidate.champId);
  if (!candidateRows || candidateRows.size === 0) return null;

  let candidateWins = 0;
  let candidateGames = 0;
  candidateRows.forEach((row) => {
    candidateWins += row.wins;
    candidateGames += row.games;
  });
  if (candidateGames <= 0) return null;
  const baselineWr = candidateWins / candidateGames;

  const opponentRows: CandidateOpponent[] = [];
  let observedMass = 0;
  candidateRows.forEach((row, oppId) => {
    const priorMass = opponentPrior.get(oppId) ?? 0;
    if (priorMass <= 0) return;
    const matchupWr = matchupEstimate(baselineWr, row.wins, row.games);
    if (matchupWr === null) return;
    observedMass += priorMass;
    opponentRows.push({ oppId, wins: row.wins, games: row.games, priorMass, matchupWr });
  });

  if (observedMass <= 0 || opponentRows.length === 0) return null;

  let fieldWr = 0;
  let badMass = 0;
  let coveredMass = 0;
  for (const row of opponentRows) {
    fieldWr += row.priorMass * row.matchupWr;
    if (row.matchupWr < BAD_MATCHUP_WR) badMass += row.priorMass;
    if (row.games >= MASS_GATE_MIN_GAMES) coveredMass += row.priorMass;
  }
  fieldWr /= observedMass;
  badMass /= observedMass;
  const coverageMass = coveredMass / observedMass;

  // Expected shortfall is a mass integral, not a row average. The final row
  // is consumed fractionally so the tail is exactly ES_TAIL_MASS.
  const tailMass = observedMass * ES_TAIL_MASS;
  let remainingTail = tailMass;
  let tailWeightedWr = 0;
  for (const row of [...opponentRows].sort(sortByMatchupRisk)) {
    if (remainingTail <= 0) break;
    const takenMass = Math.min(remainingTail, row.priorMass);
    tailWeightedWr += takenMass * row.matchupWr;
    remainingTail -= takenMass;
  }
  const es10 = tailMass > 0 ? tailWeightedWr / tailMass : null;
  if (es10 === null) return null;

  const worst = [...opponentRows].sort(sortByMatchupRisk)[0];
  return {
    rank: 0,
    champId: candidate.champId,
    blindScore: fieldWr - RISK_AVERSION * Math.max(0, 0.5 - es10),
    fieldWr,
    es10,
    badMass,
    worstMatchup: worst ? { oppId: worst.oppId, wr: worst.matchupWr, games: worst.games } : null,
    totalGames: candidateGames,
    coverageMass,
  };
}

/** Apply the shared lane-share pool floor, then the mass-based publication
 * gate, and return the ranked top-N plus explicit counts for every deliberate
 * exclusion. Ties are deterministic by champion id. */
export function rankBlindPicks(
  candidates: BlindPickCandidate[],
  rows: BlindPickMatchupRow[],
  topN = BLIND_PICK_TOP_N
): BlindPickRanking {
  // Both derived from `rows` ONCE and threaded through every candidate — see
  // computeBlindPickCandidate's params for the cost of not doing this.
  const aggregated = aggregateRows(rows);
  const opponentPrior = buildOpponentPrior(rows);
  // deriveBlindPickCandidates sets totalGames to Σ_o games(c,o); summing every
  // candidate therefore gives the lane-wide denominator Σ_c Σ_o games(c,o).
  const totalLaneGames = candidates.reduce((sum, candidate) => sum + candidate.totalGames, 0);
  const shares = new Map(candidates.map((candidate) => [candidate.champId, laneShare(candidate, totalLaneGames)]));
  // `candidates` is the complete lane pool here (deriveBlindPickCandidates
  // builds it from every champion with rows), so the floor's denominator is
  // passed explicitly from the same symmetric-matrix correction laneShare
  // uses above rather than left to the filter's own default.
  const totalGamePool = filterPoolByTotalGames(candidates, realLaneGames(totalLaneGames));
  const pool = filterPoolByLaneShare(totalGamePool, shares);
  const qualified: BlindPickResult[] = [];
  const excludedByLaneShare = totalGamePool.length - pool.length;
  let excludedByMassGate = 0;
  let excludedUncomputable = 0;

  for (const candidate of pool) {
    const result = computeBlindPickCandidate(candidate, rows, opponentPrior, aggregated);
    // Two different exclusions, two counters. `null` means the candidate had no
    // usable rows at all — unreachable from the route today (every pool
    // candidate has rows, and every row contributes to the prior), but folding
    // it into the mass-gate count would make that number quietly wrong the day
    // the pool filter changes, and the UI states that count as a fact.
    if (!result) {
      excludedUncomputable += 1;
      continue;
    }
    if (result.coverageMass < MASS_COVERAGE_GATE) {
      excludedByMassGate += 1;
      continue;
    }
    qualified.push(result);
  }

  qualified.sort((a, b) => (b.blindScore !== a.blindScore ? b.blindScore - a.blindScore : a.champId - b.champId));
  const picks = qualified.slice(0, Math.max(0, topN)).map((result, index) => ({ ...result, rank: index + 1 }));

  return {
    picks,
    poolCandidates: totalGamePool.length,
    qualifiedCandidates: qualified.length,
    excludedByLaneShare,
    excludedByMassGate,
    excludedUncomputable,
  };
}
