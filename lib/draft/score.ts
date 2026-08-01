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
export const POOL_MIN_PICKRATE = 0.01;
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
  /** "low" iff the row's DOMINANT evidence term is thin: the candidate's own
   *  baseline sample (totalGames) is below K, OR — when a direct lane
   *  opponent is resolved — that direct-opponent matchup term (having
   *  cleared N_FLOOR) was backed by fewer than K games. Off-lane
   *  (W_OFFLANE, 0.2-weight) terms NEVER flip this flag on their own: their
   *  contribution to `score` is already shrunk to near-nothing by the
   *  weight, so flagging "low sample" off a thin off-lane term overstated
   *  exactly the noise the shrink math exists to neutralize.
   *
   *  v0.39.1 SUPERSEDES the earlier "low iff ANY contributing term (incl.
   *  off-lane) has n<K" rule — prod-observed 2026-07-21: every /draft
   *  main-list row badged "LOW SAMPLE" despite huge direct-opponent
   *  samples (e.g. Sylas n=24030 vs lane opp) purely because of a thin
   *  0.2-weight off-lane term (e.g. Udyr-mid, barely played in that lane).
   *  Main-tier rows (direct-opp n >= PLAY_MAIN_SAMPLE_FLOOR=1000, always
   *  >= K) now correctly read normal confidence. Potential-tier rows
   *  (direct-opp n in [N_FLOOR, PLAY_MAIN_SAMPLE_FLOOR)) still show "low"
   *  whenever that thin direct-opp sample is itself below K — that's the
   *  badge's honest job, since the direct-opp term IS the dominant
   *  (1.0-weight) evidence for those rows. Audit P1-1's baseline-totalGames
   *  clause (empty-enemies / zero-contributing-term rankings still report
   *  real confidence, never a blanket "normal") is unchanged. */
  confidence: "normal" | "low";
  /** Smallest sample size among the candidate's own baseline (totalGames)
   *  and every enemy term that contributed to `score` — ALWAYS a real
   *  number now (never null; a play always has at least its own baseline
   *  sample to report, audit P1-1). */
  minGames: number;
  /** Games behind `winVsLaneOpp` specifically (the direct-lane-opponent
   *  matchup row's own `games`) — v0.37.4, added for splitPlaysBySampleSize
   *  below. Deliberately a SEPARATE field from `minGames`: `minGames` can be
   *  pulled down by the candidate's own baseline sample OR by a DIFFERENT
   *  (off-lane) enemy term with a smaller game count, so it is NOT a
   *  reliable proxy for "how many games back THIS specific matchup" once
   *  more than one enemy is in play. Null under the exact same conditions
   *  as `winVsLaneOpp` (no direct opponent tagged, or no/degenerate row). */
  winVsLaneOppGames: number | null;
  /** Draft redesign plan §2.4: `score - baselineWr` — the SAME terms
   *  computeScoredPool already sums into `score`, just re-exposed as its own
   *  field (no new arithmetic, no formula change). Display-only ("Matchup
   *  Synergy" column); see `synergyBand` below for the re-banding. Empty
   *  enemies (scoreDelta never accumulates anything) -> exactly 0 -> "Even". */
  synergyDelta: number;
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
  /** 0..1 — the BAN TARGET's winrate AGAINST your hovered pick (i.e. how
   *  often they beat you). = 1 - (hover's winrate vs target), since a LoL
   *  matchup has no draws: games = hoverWins + targetWins. DIRECTION MATTERS
   *  (v0.37.2 inversion lesson): a real counter has a HIGH value here (>50%).
   *  Display-only — never enters the ban score. Null only if the row is
   *  somehow absent (can't happen past rankBans' floor, but typed for the
   *  normalizer). */
  winVsYou: number | null;
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

/** Return real lane games from the raw matchup-matrix total. The matrix is
 *  symmetric: every mirror pair has identical `games` (500/500 checked in the
 *  live evidence, e.g. (805,157) and (157,805) are both 31,150), so
 *  Σ_c Σ_o games(c,o) counts every lane game twice. Keep the correction in
 *  this one named helper so pick-rate math cannot drift between surfaces. */
export function realLaneGames(matrixGames: number): number {
  if (!Number.isFinite(matrixGames) || matrixGames <= 0) return 0;
  return matrixGames / 2;
}

/** Lane share within one (patch, tier, role) bucket: this champion's
 *  aggregate games divided by the real lane-wide game total. The input is the
 *  raw aggregate from the symmetric matchup matrix; realLaneGames() applies
 *  the single /2 correction above. */
export function laneShare(c: ChampBaseline, matrixGames: number): number {
  const totalLaneGames = realLaneGames(matrixGames);
  if (totalLaneGames <= 0) return 0;
  return c.totalGames / totalLaneGames;
}

/** Blind-Pick lane-share floor. The share proxy now supplies the popularity
 *  signal that the nullable `pickrate` column cannot provide: it is computed
 *  directly from the lane matchup matrix. `filterPoolByPickrate` stays in
 *  place for when the rankings decoder lands and populates that column. A
 *  missing share is excluded rather than treated as a fabricated zero. */
export function filterPoolByLaneShare(
  candidates: ChampBaseline[],
  shares: ReadonlyMap<number, number>,
  minShare = POOL_MIN_PICKRATE
): ChampBaseline[] {
  return candidates.filter((c) => {
    const share = shares.get(c.champId);
    return share !== undefined && share > minShare;
  });
}

/** Stable sort: score DESC, champId ASC on an exact tie. Mutates nothing —
 *  returns a new array. */
function sortStable<T extends { score: number; champId: number }>(items: T[]): T[] {
  return [...items].sort((a, b) => (b.score !== a.score ? b.score - a.score : a.champId - b.champId));
}

/** Top-N cutoff for the PLAY main list (`rankPlays`, and
 *  splitPlaysBySampleSize's "main" bucket) — unchanged from the original
 *  plan's "top 10", just named now that a second (potential) list exists
 *  alongside it. */
export const PLAY_MAIN_TOP_N = 10;
/** Top-N cutoff for splitPlaysBySampleSize's "potential" bucket (v0.37.4). */
export const PLAY_POTENTIAL_TOP_N = 5;
/** v0.37.4 sample-split floor: a candidate's matchup row vs the resolved
 *  direct lane opponent needs at least this many games to land in the
 *  "main" (top-counters) list rather than "potential" (still-scored, but
 *  under 1,000 games — a lead, not a conclusion). Independent of N_FLOOR
 *  (30, the hard floor below which the matchup term is dropped from
 *  scoring entirely) and of POOL_MIN_TOTAL_GAMES (5000, the champion's own
 *  aggregate-across-every-opponent sample) — this is specifically about
 *  ONE matchup's own sample size. */
export const PLAY_MAIN_SAMPLE_FLOOR = 1000;

/** Shared scoring core for both `rankPlays` and `splitPlaysBySampleSize` —
 *  computes every pool candidate's full PlayResult (unsorted, unsliced).
 *  Pulled out so the two callers can never silently drift apart on the
 *  scoring formula itself (v0.37.4's split is explicitly a POST-scoring
 *  partition, never a second scoring pass — see this file's header). */
function computeScoredPool(
  pool: ChampBaseline[],
  matchups: Map<number, Map<number, MatchupRow>>,
  enemies: EnemyInput[]
): PlayResult[] {
  const directOppId = enemies.find((e) => e.isDirectLaneOpp)?.champId ?? null;

  return pool.map((cand) => {
    let scoreDelta = 0;
    // Seeded from the candidate's OWN baseline sample (audit P1-1) — a play
    // ALWAYS has at least this to report, so minGames/confidence are never
    // a blank "nothing to say" even when zero enemy terms contribute
    // (empty-enemies meta ranking, or every enemy term missing/below floor).
    let minGames = cand.totalGames;
    let lowConfidence = cand.totalGames < K;
    let winVsLaneOpp: number | null = null;
    let winVsLaneOppGames: number | null = null;

    for (const enemy of enemies) {
      const row = matchups.get(cand.champId)?.get(enemy.champId);
      if (!row || row.games <= 0) continue; // missing row -- term simply omitted

      const wr = row.wins / row.games;
      if (directOppId !== null && enemy.champId === directOppId) {
        winVsLaneOpp = wr;
        winVsLaneOppGames = row.games;
      }

      const delta = shrunkDelta(wr, cand.baselineWr, row.games);
      if (delta === null) continue; // n < N_FLOOR -- omitted, not zeroed

      const weight = enemy.isDirectLaneOpp ? W_DIRECT : W_OFFLANE;
      scoreDelta += weight * delta;
      minGames = Math.min(minGames, row.games);
      // v0.39.1: confidence tracks the DOMINANT (1.0-weight direct-opp, or
      // baseline) term only -- a thin 0.2-weight off-lane term must NOT flip
      // this flag (see PlayResult.confidence's doc comment for the prod
      // repro this supersedes).
      if (enemy.isDirectLaneOpp && row.games < K) lowConfidence = true;
    }

    return {
      champId: cand.champId,
      score: cand.baselineWr + scoreDelta,
      winVsLaneOpp,
      winVsLaneOppGames,
      confidence: lowConfidence ? "low" : "normal",
      minGames,
      // = score - baselineWr, i.e. exactly `scoreDelta` -- re-derived from
      // the two already-returned fields (not just `scoreDelta` directly) so
      // this can never silently drift from the "score - baselineWr" contract
      // if the `score` expression above is ever touched.
      synergyDelta: cand.baselineWr + scoreDelta - cand.baselineWr,
    };
  });
}

// ── Matchup Synergy re-banding (draft redesign plan §2.4) ───────────────────
//
// Pure re-band of `synergyDelta` (= score - baselineWr, already computed
// above) into a 3-value display label. Thresholds are TUNABLE display
// constants, NOT part of the locked scoring formula (K/N_FLOOR/W_DIRECT/
// W_OFFLANE/pool floors/BAN_MIN_MATCHUP_GAMES) — changing them re-labels the
// same underlying numbers, it never re-scores or re-ranks anything.

export type SynergyBand = "Strong" | "Even" | "Weak";

/** >= this synergyDelta -> "Strong". 0.015 = 1.5 percentage points of
 *  shrunk-delta-weighted winrate swing, chosen as a visually-meaningful cut
 *  point well above float noise. */
export const SYNERGY_STRONG_DELTA = 0.015;
/** <= this synergyDelta -> "Weak" (note: NEGATIVE — a champion scoring worse
 *  than its own baseline against this enemy set). */
export const SYNERGY_WEAK_DELTA = -0.015;

export function synergyBand(delta: number): SynergyBand {
  if (delta >= SYNERGY_STRONG_DELTA) return "Strong";
  if (delta <= SYNERGY_WEAK_DELTA) return "Weak";
  return "Even";
}

/**
 * Ranks `pool` (already pickrate-filtered — see filterPoolByPickrate) as
 * champ-select PLAY suggestions against the given `enemies`. `matchups` is
 * keyed [candidateChampId][oppChampId] -> that candidate's own matchup row
 * vs that opponent (perspective = candidate). Returns the top 10 by score,
 * stable-tiebroken by champId. UNCHANGED by v0.37.4's sample-size split
 * below — this remains the single-list ranking used whenever no direct
 * lane opponent is resolved (see splitPlaysBySampleSize's null-directOppId
 * branch, which reproduces this exact function's output).
 */
export function rankPlays(
  pool: ChampBaseline[],
  matchups: Map<number, Map<number, MatchupRow>>,
  enemies: EnemyInput[]
): PlayResult[] {
  return sortStable(computeScoredPool(pool, matchups, enemies)).slice(0, PLAY_MAIN_TOP_N);
}

export interface PlaySplitResult {
  /** Top PLAY_MAIN_TOP_N by score among candidates whose matchup row vs the
   *  direct lane opponent has >= PLAY_MAIN_SAMPLE_FLOOR games. When no
   *  direct lane opponent is resolved, this is simply `rankPlays`' own
   *  output (byte-identical) and `potential` is always []. */
  main: PlayResult[];
  /** Top PLAY_POTENTIAL_TOP_N by score among candidates whose matchup row vs
   *  the direct lane opponent has fewer than PLAY_MAIN_SAMPLE_FLOOR games
   *  but still clears N_FLOOR (30) — SAME scoring as `main`, just too thin a
   *  sample on the ONE matchup that matters most to earn a "main" slot.
   *  Always [] when no direct lane opponent is resolved. */
  potential: PlayResult[];
}

/**
 * v0.37.4 — partitions the FULL scored pool (same formula as `rankPlays`,
 * see computeScoredPool) by sample size specifically against the resolved
 * direct lane opponent, rather than returning one top-10 list:
 *   - No row vs the direct opponent (or games < N_FLOOR=30): excluded from
 *     BOTH lists — no evidence against the one matchup that matters most
 *     means no listing, not a listing built on other enemies' evidence alone.
 *   - games >= PLAY_MAIN_SAMPLE_FLOOR (1000): eligible for `main`.
 *   - N_FLOOR <= games < PLAY_MAIN_SAMPLE_FLOOR: eligible for `potential`.
 * When no direct lane opponent is resolved (`enemies` has no
 * `isDirectLaneOpp: true` entry, or `enemies` is empty), this degrades to
 * TODAY's unchanged single-list behavior: `main` = rankPlays' own output,
 * `potential` = [] — see this file's exhaustive tests for the byte-identical
 * pin.
 */
export function splitPlaysBySampleSize(
  pool: ChampBaseline[],
  matchups: Map<number, Map<number, MatchupRow>>,
  enemies: EnemyInput[]
): PlaySplitResult {
  const directOppId = enemies.find((e) => e.isDirectLaneOpp)?.champId ?? null;
  const scored = computeScoredPool(pool, matchups, enemies);

  if (directOppId === null) {
    return { main: sortStable(scored).slice(0, PLAY_MAIN_TOP_N), potential: [] };
  }

  const main: PlayResult[] = [];
  const potential: PlayResult[] = [];
  for (const p of scored) {
    const row = matchups.get(p.champId)?.get(directOppId);
    if (!row || row.games < N_FLOOR) continue; // no evidence vs the direct opponent -- excluded from BOTH lists
    if (row.games >= PLAY_MAIN_SAMPLE_FLOOR) main.push(p);
    else potential.push(p);
  }

  return {
    main: sortStable(main).slice(0, PLAY_MAIN_TOP_N),
    potential: sortStable(potential).slice(0, PLAY_POTENTIAL_TOP_N),
  };
}

/** Ban-candidate matchup floor (v0.40.0 — hard user directive, verbatim:
 *  "dont put champs with less than 1000 games in Suggested bans"). Same
 *  threshold CLASS as PLAY_MAIN_SAMPLE_FLOOR (1000, the main play-list's
 *  sample-size split) but a separate named constant — this gates a
 *  DIFFERENT axis: the hover-vs-ban-target matchup's own game count, not
 *  the direct-lane-opponent matchup PLAY_MAIN_SAMPLE_FLOOR gates. Ban
 *  candidates are drawn from `pool` (already floored at POOL_MIN_TOTAL_GAMES
 *  = 5000 games *aggregated across every opponent*), which says nothing
 *  about any ONE opponent's specific sample — live-reproduced: a hovered
 *  Viktor's ban list surfaced Singed (n=463 vs Viktor specifically) ranked
 *  above Xerath (n=16547), because a genuine-but-tiny-sample disadvantage
 *  can still out-score a well-sampled one on raw shrunk-delta magnitude. A
 *  target whose matchup vs the hovered champion has fewer than this many
 *  games is excluded from the ban pool ENTIRELY (not merely flagged "low
 *  confidence") — a sub-1000-game sample is fringe noise, not a trustworthy
 *  counter-pick signal. */
export const BAN_MIN_MATCHUP_GAMES = 1000;

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
    .map((t): BanResult | null => {
      const row = matchupsForHover.get(t.champId);
      // v0.40.0: no row, or a sub-BAN_MIN_MATCHUP_GAMES row, is excluded
      // from the ban pool ENTIRELY -- see that constant's doc comment. This
      // floor (1000) is strictly narrower than N_FLOOR (30, shrunkDelta's
      // own hard floor below which a term is dropped from scoring): every
      // row that reaches the return below already clears both floors, so
      // shrunkDelta can never return null past this point.
      if (!row || row.games < BAN_MIN_MATCHUP_GAMES) return null;

      const minGames = row.games;
      // BAN_MIN_MATCHUP_GAMES (1000) > K (200), so this is "normal" for
      // every surviving candidate today -- kept as a real check (not
      // hardcoded) so it stays correct if either constant is ever retuned
      // independently of the other.
      const confidence: "normal" | "low" = row.games < K ? "low" : "normal";
      const mWr = row.wins / row.games; // hover's winrate vs this target
      const delta = shrunkDelta(mWr, hoverBaselineWr, row.games); // (mWr - baseline)*shrink; never null here
      // plan's ban formula is (baselineWr - matchupWr)*shrink = -delta
      const rawDisadvantage = delta !== null ? Math.max(0, -delta) : 0;
      // The target's winrate AGAINST you = 1 - your winrate vs them (no draws
      // in a LoL matchup). A real counter → high value → "beats you 56%".
      const winVsYou = 1 - mWr;
      return { champId: t.champId, score: rawDisadvantage * presence(t), confidence, minGames, winVsYou };
    })
    .filter((r): r is BanResult => r !== null);

  return sortStable(scored).slice(0, 5);
}
