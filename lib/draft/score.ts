// ─────────────────────────────────────────────────────────────────────────────
// lib/draft/score.ts — PURE scoring engine for the "Draft" champ-select
// recommender (see _research/draft-feature-plan.md §3). No network, no DB —
// every input is already-decoded matchup/baseline data; this file only does
// arithmetic + ranking, which is what makes it exhaustively unit-testable.
//
// Formula (locked by the plan, do not retune without updating both the
// constants AND the exhaustive test list below):
//   shrinkFactor(n)              = n / (n + K)
//   shrunkDelta(mWr, bWr, n)     = n < N_FLOOR ? null : (mWr - bWr) * shrinkFactor(n)
//   playScore(c)                 = baselineWr(c) + Σ w_i * shrunkDelta_i   (null terms OMITTED, not zeroed)
//   banScore(m vs t)             = max(0, (baselineWr(m) - matchupWr(m,t)) * shrinkFactor(n)) * presence(t)
//
// `n/(n+K)` shrinks a matchup's observed delta toward "no effect" the fewer
// games it's backed by — it isolates the MATCHUP's effect from the
// champion's own overall strength (raw matchup winrate alone is confounded
// by baseline strength; see counterpick-research.md). N_FLOOR is a HARD
// floor, separate from the shrink math: below 30 games a term is dropped
// entirely (never included, even at ~0 weight) rather than trusted at all.
// ─────────────────────────────────────────────────────────────────────────────

/** Shrinkage constant — matchup deltas are pulled toward zero by n/(n+K). */
export const K = 200;
/** Hard floor: a matchup with fewer than this many games contributes NOTHING
 *  to a play's score (the term is omitted, not included at ~0 weight). */
export const N_FLOOR = 30;
/** Weight for the user's DIRECT lane opponent (the one occupying the same
 *  lane slot — tagged `isDirectLaneOpp` by the caller). */
export const W_DIRECT = 1.0;
/** Weight for every other (off-lane / non-lane-opponent) enemy pick. */
export const W_OFFLANE = 0.2;
/** Pool cutoff — a champion must clear this pickrate (in the same lane+tier)
 *  to be considered a viable recommendation at all. */
export const POOL_MIN_PICKRATE = 0.005;
/** Pool cutoff, playrate PROXY (audit P1-1, 2026-07-21): with pickrate
 *  always null right now (see ChampBaseline's doc comment — the rankings
 *  decoder is a deliberate stub), filterPoolByPickrate alone is a total
 *  no-op — nothing was gating the pool at all, so a champion with a
 *  128-game sample (a one-trick off-role artifact, e.g. Yuumi/Bard/Braum
 *  showing up in a Top pool) could out-rank real lane staples on baseline
 *  winrate alone. Live-verified against Neon: a 5000-total-games floor
 *  (summed across every opponent row for that champ+role — the SAME
 *  aggregate lib/draft/ingest.ts already derives baselineWr from) trims
 *  role 0's pool 173->111 and role 3's 173->53, removing exactly this class
 *  of artifact while keeping every real lane-viable champion. This is a
 *  PROXY for pickrate (more games this patch ~ more picked), not a
 *  replacement — filterPoolByPickrate stays in place and becomes load-
 *  bearing again the moment the rankings decoder is filled in. */
export const POOL_MIN_TOTAL_GAMES = 5000;
/** How much banrate contributes to a ban target's "presence" relative to
 *  pickrate — plan says "pickrate + SMALL banrate term"; 0.25 is this file's
 *  chosen weight for that "small" (tunable without touching the shape of the
 *  formula — isolated here as a named constant, not inlined). */
const PRESENCE_BANRATE_WEIGHT = 0.25;

/** A candidate's per-(patch,tier,role) baseline stats. `pickrate`/`banrate`
 *  are nullable: this ship's ingest (see lib/draft/ingest.ts) could not
 *  live-verify u.gg's rankings-endpoint JSON shape (network-blocked from the
 *  build environment — see lib/draft/ugg.ts's header comment) and degrades
 *  to null for both rather than risk fabricating numbers a scoring layer
 *  depends on. Every consumer here treats null as "unknown", never as 0. */
export interface ChampBaseline {
  champId: number;
  /** 0..1 winrate for this champion in this (patch,tier,role) — see
   *  lib/draft/ingest.ts: derived from the SAME matchup rows this scorer
   *  consumes (aggregate wins/games across all opponents), not from the
   *  unverified rankings endpoint, so this field is always populated. */
  baselineWr: number;
  pickrate: number | null;
  banrate: number | null;
  /** Sum of `games` across every opponent row for this champ+role (the same
   *  aggregate baselineWr is derived from) — the playrate-proxy pool floor
   *  (POOL_MIN_TOTAL_GAMES) gates on this, and it also seeds a play's
   *  baseline confidence/minGames (see rankPlays) so an empty-enemies
   *  baseline ranking reports an honest sample size instead of a blank. */
  totalGames: number;
}

/** One decoded matchup row: `champId`'s record against `oppId` in a given
 *  (patch,tier,role) bucket. Perspective is always the FIRST id — wins/games
 *  are `champId`'s own results vs `oppId` (see lib/draft/ugg.ts's decoder). */
export interface MatchupRow {
  wins: number;
  games: number;
}

/** One enemy pick the user has entered (companion-fed or manual). Exactly
 *  one entry should carry `isDirectLaneOpp: true` — the champion occupying
 *  the user's own lane slot; every other entry is off-lane. Zero
 *  direct-lane-opponent entries is valid (opponent's lane still open). */
export interface EnemyInput {
  champId: number;
  isDirectLaneOpp: boolean;
}

export interface PlayResult {
  champId: number;
  score: number;
  /** Matchup winrate specifically vs the tagged direct-lane opponent, or
   *  null when there's no direct-lane opponent yet, or no row/sample for
   *  that pairing. Never shrunk — this is the raw observed winrate, for
   *  display (the shrunk value only feeds `score`). */
  winVsLaneOpp: number | null;
  /** "low" iff EITHER the candidate's own baseline sample (totalGames) is
   *  below K, OR a contributing enemy term (cleared N_FLOOR) was backed by
   *  fewer than K games (audit P1-1: an empty-enemies / zero-contributing-
   *  term ranking is STILL a claim about this champion's baseline winrate,
   *  and must report its real confidence, not a blanket "normal"). */
  confidence: "normal" | "low";
  /** Smallest sample size among the candidate's own baseline (totalGames)
   *  and every enemy term that contributed to `score` — ALWAYS a real
   *  number now (never null; a play always has at least its own baseline
   *  sample to report, audit P1-1). */
  minGames: number;
}

export interface BanResult {
  champId: number;
  score: number;
  /** "low" when there's no matchup row (or a below-N_FLOOR sample) between
   *  the hovered champion and this ban target — audit P2-2: previously
   *  absent entirely, so the client's defensive normalizer silently
   *  fabricated "low sample n=0" for EVERY ban regardless of real data. */
  confidence: "normal" | "low";
  /** The hover-vs-target matchup's own game count, or null when there's no
   *  row at all (never a fabricated 0 — see draftRecommend.ts's client
   *  normalizer, which now receives a real number here to pass through). */
  minGames: number | null;
}

/** Raw shrink ratio n/(n+K) — exported separately from shrunkDelta so its
 *  anchor values (n=20 -> ~9%, n=2000 -> ~91%) are testable independent of
 *  N_FLOOR's drop behavior (n=20 is itself BELOW the floor and would
 *  otherwise never surface a numeric ratio to assert against). */
export function shrinkFactor(n: number): number {
  return n / (n + K);
}

/** (matchupWr - baselineWr) * shrinkFactor(n), or null if n < N_FLOOR (term
 *  omitted entirely — callers must skip it, never treat null as 0). */
export function shrunkDelta(matchupWr: number, baselineWr: number, n: number): number | null {
  if (n < N_FLOOR) return null;
  return (matchupWr - baselineWr) * shrinkFactor(n);
}

/** Pool-cutoff filter: drops any candidate whose pickrate is KNOWN to be at
 *  or below POOL_MIN_PICKRATE. A null (unknown) pickrate is kept, never
 *  dropped — this ship's ingest can't populate pickrate at all yet (see
 *  ChampBaseline's doc comment), and excluding everyone over an unknown
 *  field would empty the entire pool. */
export function filterPoolByPickrate(candidates: ChampBaseline[]): ChampBaseline[] {
  return candidates.filter((c) => c.pickrate === null || c.pickrate > POOL_MIN_PICKRATE);
}

/** Playrate-PROXY pool floor (audit P1-1) — see POOL_MIN_TOTAL_GAMES's doc
 *  comment. Unlike filterPoolByPickrate, totalGames is NEVER null (always
 *  derived at ingest time), so this is a real, unconditional gate. */
export function filterPoolByTotalGames(candidates: ChampBaseline[]): ChampBaseline[] {
  return candidates.filter((c) => c.totalGames >= POOL_MIN_TOTAL_GAMES);
}

/** Stable sort: score DESC, champId ASC on an exact tie. Mutates nothing —
 *  returns a new array. */
function sortStable<T extends { score: number; champId: number }>(items: T[]): T[] {
  return [...items].sort((a, b) => (b.score !== a.score ? b.score - a.score : a.champId - b.champId));
}

/**
 * Ranks `pool` (already pickrate-filtered — see filterPoolByPickrate) as
 * champ-select PLAY suggestions against the given `enemies`. `matchups` is
 * keyed [candidateChampId][oppChampId] -> that candidate's own matchup row
 * vs that opponent (perspective = candidate). Returns the top 10 by score,
 * stable-tiebroken by champId.
 */
export function rankPlays(
  pool: ChampBaseline[],
  matchups: Map<number, Map<number, MatchupRow>>,
  enemies: EnemyInput[]
): PlayResult[] {
  const directOppId = enemies.find((e) => e.isDirectLaneOpp)?.champId ?? null;

  const scored: PlayResult[] = pool.map((cand) => {
    let scoreDelta = 0;
    // Seeded from the candidate's OWN baseline sample (audit P1-1) — a play
    // ALWAYS has at least this to report, so minGames/confidence are never
    // a blank "nothing to say" even when zero enemy terms contribute
    // (empty-enemies meta ranking, or every enemy term missing/below floor).
    let minGames = cand.totalGames;
    let lowConfidence = cand.totalGames < K;
    let winVsLaneOpp: number | null = null;

    for (const enemy of enemies) {
      const row = matchups.get(cand.champId)?.get(enemy.champId);
      if (!row || row.games <= 0) continue; // missing row -- term simply omitted

      const wr = row.wins / row.games;
      if (directOppId !== null && enemy.champId === directOppId) winVsLaneOpp = wr;

      const delta = shrunkDelta(wr, cand.baselineWr, row.games);
      if (delta === null) continue; // n < N_FLOOR -- omitted, not zeroed

      const weight = enemy.isDirectLaneOpp ? W_DIRECT : W_OFFLANE;
      scoreDelta += weight * delta;
      minGames = Math.min(minGames, row.games);
      if (row.games < K) lowConfidence = true;
    }

    return {
      champId: cand.champId,
      score: cand.baselineWr + scoreDelta,
      winVsLaneOpp,
      confidence: lowConfidence ? "low" : "normal",
      minGames,
    };
  });

  return sortStable(scored).slice(0, 10);
}

/** Presence weight for a ban target: known pickrate/banrate combine as
 *  pickrate + PRESENCE_BANRATE_WEIGHT*banrate; when BOTH are unknown (null —
 *  today's actual state, see ChampBaseline's doc comment) presence falls
 *  back to a neutral 1.0 multiplier, so ban ranking degrades to pure
 *  matchup-disadvantage magnitude instead of collapsing every score to the
 *  same unknown-derived constant. */
function presence(t: ChampBaseline): number {
  if (t.pickrate === null && t.banrate === null) return 1;
  return (t.pickrate ?? 0) + PRESENCE_BANRATE_WEIGHT * (t.banrate ?? 0);
}

/**
 * Ranks `pool` as BAN suggestions given the user's hovered champion `m`
 * (`hoverChampId`/`hoverBaselineWr`) and `matchupsForHover` (m's own matchup
 * rows, keyed by opponent champId t — perspective = m, same shape as one
 * inner map of rankPlays' `matchups`). Returns the top 5 by score, stable-
 * tiebroken by champId. The hovered champion itself is excluded from its own
 * ban pool.
 */
export function rankBans(
  hoverChampId: number,
  hoverBaselineWr: number,
  pool: ChampBaseline[],
  matchupsForHover: Map<number, MatchupRow>
): BanResult[] {
  const scored: BanResult[] = pool
    .filter((t) => t.champId !== hoverChampId)
    .map((t) => {
      const row = matchupsForHover.get(t.champId);
      let rawDisadvantage = 0;
      // audit P2-2: confidence/minGames come from the SAME row this score
      // is computed from — no row at all (or games<=0) is "low"/null, never
      // a fabricated number the client would otherwise default to on its
      // own (draftRecommend.ts's normalizeBan previously had nothing real
      // to normalize, since this file never sent these fields before).
      let minGames: number | null = null;
      let confidence: "normal" | "low" = "low";
      if (row && row.games > 0) {
        minGames = row.games;
        confidence = row.games < K ? "low" : "normal";
        const mWr = row.wins / row.games;
        const delta = shrunkDelta(mWr, hoverBaselineWr, row.games); // (mWr - baseline)*shrink, null if n<30
        // plan's ban formula is (baselineWr - matchupWr)*shrink = -delta
        if (delta !== null) rawDisadvantage = Math.max(0, -delta);
      }
      return { champId: t.champId, score: rawDisadvantage * presence(t), confidence, minGames };
    });

  return sortStable(scored).slice(0, 5);
}
