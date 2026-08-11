// ─────────────────────────────────────────────────────────────────────────────
// lib/draft/recommend.ts — DB-facing engine behind GET /api/draft/recommend
// (plan §4). Same split as lib/patchMovers.ts/app/api/patch-movers/route.ts:
// this file owns queries + orchestration (mockable sql, no NextRequest/
// NextResponse); the route stays thin (parse params, call this, set cache
// headers).
//
// CONTRACT (finalized 2026-07-21, supersedes the plan's original "tagged
// enemy (companion) or the enemy placed in the lane slot (manual)" wording,
// which left the wire encoding ambiguous — fronty's client was built against
// a position-0-is-lane-opponent guess pending this reconciliation):
//   GET ?lane=<0-4 required>&enemies=<csv>&laneOpp=<id>&hover=<id>
//   - `laneOpp`, when present AND a member of `enemies`, is the direct lane
//     opponent (companion mode: theirTeam[roleId]; manual mode: whichever
//     chip the user flagged isDirectLaneOpp).
//   - Otherwise, if `enemies` is non-empty, the direct lane opponent is
//     INFERRED statistically by LANE PRESENCE in THIS lane+patch+tier
//     (coachbuild.draft_champ_stats): whichever enemy plays this lane the
//     most. Presence is measured by KNOWN pickrate when it exists (so the
//     moment lib/draft/ugg.ts's decodeRankingsJson stub is filled in, real
//     pickrate takes over transparently) and otherwise by `total_games` —
//     the enemy's own aggregate game count in this role, ALWAYS populated at
//     ingest (lib/draft/ingest.ts) and the SAME playrate proxy the pool
//     floor already trusts (POOL_MIN_TOTAL_GAMES). This is what makes a
//     partial enemy set with one clear lane-mate (e.g. Ahri among
//     [Aatrox, Ahri, Udyr, Jinx] for mid) infer correctly TODAY, despite
//     pickrate being null. Honesty guard: when two or more enemies genuinely
//     BOTH plausibly play this lane (the runner-up's presence is within
//     LANE_OPP_DOMINANCE_RATIO of the leader's), inference stays null and
//     the user taps the chip — a wrong 1.0-weight (W_DIRECT) direct-opponent
//     term is far more damaging than no term, so we never force-pick a
//     genuinely ambiguous lane.
//   - `meta.laneOppInferred` always reports WHICH enemy (if any) was
//     actually used as the direct-lane weight (W_DIRECT), regardless of
//     whether it came from the explicit param or the statistical fallback —
//     the UI can render "countering known X" either way.
// ─────────────────────────────────────────────────────────────────────────────

import { getSql } from "@/lib/pro/db";
import { DbUnavailableError } from "@/lib/pro/errors";
import type { RoleId } from "@/lib/types";
import {
  filterPoolByPickrate,
  filterPoolByTotalGames,
  laneShare,
  POOL_MIN_PICKRATE,
  realLaneGames,
  rankBans,
  shrunkDelta,
  splitPlaysBySampleSize,
  type BanResult,
  type ChampBaseline,
  type EnemyInput,
  type MatchupRow,
  type PlayResult,
} from "@/lib/draft/score";
import { matchupEstimate } from "@/lib/draft/blindPick";
import { DIAMOND_2_PLUS_TIER } from "@/lib/draft/ugg";
import { resolveDraftPatchLabel } from "@/lib/draft/patch";
import type { DifficultyBand } from "@/lib/draft/difficulty";
import { suggestedDefense, type SuggestedDefense } from "@/lib/draft/damageProfile";
import { getChampionMeta } from "@/lib/staticData";
import { getActiveAccount } from "@/lib/mystats/account";
import { COUNTED_QUEUE_IDS } from "@/lib/mystats/queues";
import { getIngestHealth } from "@/lib/ingestHealth";

/** P3-1 (audit, 2026-07-21): a patch needs at least this many distinct
 *  champions present in draft_champ_stats before resolveServingPatch will
 *  treat it as "ready to serve" over an older, more complete patch — a
 *  brand-new patch mid-ingest (the cron processes ~40 champs/tick, see
 *  app/api/ingest/draft/route.ts) would otherwise take over serving
 *  immediately at ~9-40 champions and show a near-empty pool for most
 *  lanes. ~170 total champions exist; 120 is comfortably past the
 *  first-few-cron-ticks partial state without waiting for a full 173/173. */
const SERVING_PATCH_MIN_CHAMPS = 120;

/** Lane-opponent inference dominance guard (2026-07-21): when 2+ enemies
 *  have real presence in the user's lane, the leader must out-present the
 *  runner-up by at least this ratio to be inferred as the direct lane
 *  opponent; otherwise inference stays null and the user taps the chip.
 *  Rationale: a WRONG direct opponent applies the full W_DIRECT (1.0) weight
 *  to the wrong matchup and skews the whole list, whereas a null just means
 *  the user makes one tap — so we bias hard toward "only infer when it's
 *  unambiguous." 2.0 = the leader must have at least twice the runner-up's
 *  lane presence. Tunable; not part of the locked score.ts formula (this is
 *  opponent RESOLUTION, upstream of scoring). A single-candidate lane (only
 *  one enemy plays it at all) skips this guard — there's nothing to be
 *  ambiguous with. */
const LANE_OPP_DOMINANCE_RATIO = 2.0;

/** {games, wins} — a raw personal record, never a rate/score. */
export interface PersonalRecord {
  games: number;
  wins: number;
}

/** PlayResult + two ADDITIVE, DISPLAY-ONLY personal fields (My Stats
 *  backend, 2026-07-21). HARD USER DIRECTIVE, ratified 2026-07-21 ("Don't
 *  mix my data with the sample size"): personal record data must NEVER
 *  influence `score`/ranking/ordering anywhere in this pipeline, now or in
 *  any future change to this file. `attachPersonalRecords` below runs
 *  strictly AFTER rankPlays has already scored and sorted — it only
 *  decorates the already-final array. A shrinkage-weighted "personal delta"
 *  blended into score was considered and explicitly rejected for this ship
 *  (my own match count is anecdotal — single-digit-to-low-double-digit
 *  games per matchup, far below N_FLOOR=30 — so blending it into a
 *  cross-population score would let one player's small sample silently
 *  outweigh thousands of aggregate games). If a personal-delta scoring mode
 *  is ever wanted, it must be a SEPARATE, EXPLICITLY OPT-IN feature with its
 *  own shrinkage (K~20) — do not build it speculatively; only take this on
 *  if the user asks for it directly. */
export interface PersonalPlayResult extends PlayResult {
  /** My record playing this candidate vs the resolved lane opponent
   *  (`meta.laneOppInferred`) — null when no lane opponent is resolved yet
   *  (nothing to compare against); `{games:0,wins:0}` when one IS resolved
   *  but I've never played that exact matchup. */
  personal: PersonalRecord | null;
  /** My record playing this candidate in this lane, vs ANY opponent —
   *  always populated (never null; no recorded games renders as
   *  `{games:0,wins:0}`). */
  personalOverall: PersonalRecord;
}

export interface RecommendParams {
  lane: RoleId;
  /** Deduped positive champion ids — validation/dedup is the ROUTE's job. */
  enemies: number[];
  laneOpp: number | null;
  hover: number | null;
}

export interface RecommendMeta {
  patch: string | null;
  tier: number;
  /** P2 fix (2026-07-31 audit): the DATA's age, not the request's. Was
   *  `new Date().toISOString()` at serve time — every request, byte-for-byte
   *  identical, always "now" — so the Draft page's "Upd <date>" label
   *  silently reported today regardless of how stale the underlying
   *  draft_champ_stats rows actually were. Now sourced from
   *  MAX(ingested_at) over the pool rows actually served for this
   *  patch+tier+lane (see the poolRows query below) — the real last-ingest
   *  timestamp for the data on screen. Falls back to request time only on
   *  the pending path (no pool rows exist yet, so there IS no data age to
   *  report, and the field is never rendered in that state anyway). */
  fetchedAt: string;
  laneOppInferred: number | null;
  /** Round-B (2026-07-21) stale-data honesty fix: the patch the REST of the
   *  app considers current (lib/staticData.ts's getLatestPatch(), the same
   *  resolver lib/draft/patch.ts's resolveDraftPatchLabel() reuses at ingest
   *  time) — independent of `patch` above, which is whatever's actually
   *  SERVED (resolveServingPatch, a plain DB read of what's been ingested).
   *  The two can diverge for days at a time: the daily /api/ingest/draft
   *  cron is Cloudflare-blocked from reaching u.gg on Vercel's egress IP
   *  (see HANDOFF's "Vercel-egress probe of stats2" finding, 2026-07-21) —
   *  not fixed here, out of scope — so a patch bump can sit un-ingested
   *  indefinitely with only a manual `npm run ingest:draft` run to close the
   *  gap. Rather than silently keep serving the old patch's numbers with no
   *  signal, or showing "still being prepared" forever (the existing
   *  `pending` state, which only fires when NOTHING has been ingested for
   *  ANY patch), the client compares `patch` against `currentPatch` and
   *  surfaces an honest one-line notice when they differ but real data IS
   *  being shown. Null if the getLatestPatch() resolution itself fails (see
   *  its own fallback chain) — degrades to "no notice" rather than a
   *  false-positive staleness warning. */
  currentPatch: string | null;
  /** 2026-07-31 audit P2 (#2) — did the LAST scheduled draft ingest run
   *  (`CoachBuildDraftIngest`, scripts/ingest-draft.mjs) come back clean?
   *  Read from coachbuild.ingest_health (lib/ingestHealth.ts), written once
   *  per completed run. `null` = unknown (never run since migration 0023, or
   *  this read itself failed) — NOT the same as healthy; the client must
   *  only show a warning on an explicit `false`, never manufacture one from
   *  `null`. Independent of `patch`/`currentPatch` above: a stale served
   *  patch can exist even with a perfectly healthy last run (the run just
   *  hasn't reached today's patch yet), and conversely a run can fail while
   *  `patch` still looks fine (yesterday's data is still being served). */
  ingestHealthy: boolean | null;
  /** Best-effort summary of the last failure, or null when healthy/unknown.
   *  Truncated at the source (lib/ingestHealth.ts's MAX_ERROR_LEN) — never
   *  the full per-champion error list, just enough for a human to know
   *  where to look (the local ingest log has the rest). */
  ingestLastError: string | null;
}

/** Draft redesign plan §2.3 — additive, per-enemy analysis backing the
 *  MatchupAnalysisPopover. One entry per `params.enemies` id (deduped by the
 *  route already). `laneThreatBand` REUSES lib/draft/difficulty.ts's
 *  DifficultyBand union ("Low"/"Medium"/"High") for its label vocabulary —
 *  a deliberate type-level reuse, NOT the same axis as champion difficulty
 *  (that's kit complexity; this is matchup danger) — see
 *  `laneThreatBandFromDelta`'s own doc comment for the banding thresholds. */
export interface EnemyAnalysis {
  champId: number;
  /** True iff this is the resolved direct lane opponent (meta.laneOppInferred)
   *  — the ONLY entry that can carry non-null winRateVsYou/laneThreatBand,
   *  since those are both keyed on the (laneOpponent, hover) matchup row. */
  isLaneOpponent: boolean;
  /** REAL — the lane opponent's own win rate specifically against `hover`
   *  (draft_matchup row, champ_id=this enemy, opp_id=hover), shipped
   *  alongside `winRateVsYouGames` so the UI can show its sample size
   *  honestly. Null when this isn't the lane opponent, `hover` wasn't given,
   *  or no matchup row exists at all (never a fabricated 50%). */
  winRateVsYou: number | null;
  winRateVsYouGames: number | null;
  /** DERIVED (never a raw stat): shrunkDelta magnitude between the lane
   *  opponent's win rate vs `hover` and their own lane baseline, banded. Null
   *  below N_FLOOR (suppressed, per plan §2.3) or when the preconditions for
   *  winRateVsYou above aren't met. */
  laneThreatBand: DifficultyBand | null;
  /** DERIVED from this enemy's ddragon tags + attack/magic axes
   *  (lib/draft/damageProfile.ts) — populated for EVERY enemy, independent
   *  of lane-opponent status or `hover`. Null only on a genuine data gap
   *  (champion meta fetch failed/champion unknown). */
  suggestedDefense: SuggestedDefense | null;
}

/** Lane-threat banding thresholds (draft redesign plan §2.3) — tunable
 *  display constants, entirely separate from lib/draft/difficulty.ts's
 *  champion-complexity bands even though both return the same DifficultyBand
 *  union. |shrunkDelta| magnitude: < 0.02 -> Low, < 0.05 -> Medium, else
 *  High. Exported for direct unit testing. */
export const LANE_THREAT_LOW_MAX = 0.02;
export const LANE_THREAT_MEDIUM_MAX = 0.05;

export function laneThreatBandFromDelta(delta: number | null): DifficultyBand | null {
  if (delta === null) return null;
  const mag = Math.abs(delta);
  if (mag < LANE_THREAT_LOW_MAX) return "Low";
  if (mag < LANE_THREAT_MEDIUM_MAX) return "Medium";
  return "High";
}

export interface RecommendResult {
  /** v0.37.4: when a direct lane opponent is resolved, this is the "main"
   *  bucket from splitPlaysBySampleSize — top 10, matchup-vs-opponent
   *  games >= PLAY_MAIN_SAMPLE_FLOOR (1000). Field NAME kept for back-compat
   *  (existing clients/cached responses read `plays`); the CONTENTS now
   *  exclude any candidate with no evidence against the resolved opponent
   *  (see splitPlaysBySampleSize's doc comment). When no lane opponent is
   *  resolved, this is byte-identical to the pre-v0.37.4 single-list
   *  behavior (rankPlays' own output). */
  plays: PersonalPlayResult[];
  /** v0.37.4, NEW, additive: candidates whose matchup vs the resolved lane
   *  opponent has fewer than PLAY_MAIN_SAMPLE_FLOOR games but still clears
   *  the existing N_FLOOR (30) scoring floor — same scoring as `plays`,
   *  just too thin a sample on the one matchup that matters most to earn a
   *  "main" slot. Always [] when no lane opponent is resolved (see
   *  splitPlaysBySampleSize) — an older cached response or client that
   *  doesn't know this field exists sees a normal `plays`-only response. */
  potentialPlays: PersonalPlayResult[];
  bans: BanResult[] | null;
  meta: RecommendMeta;
  /** True when there's nothing to serve yet (no patch ingested at all, or
   *  this specific lane has zero champ_stats rows for the serving patch) —
   *  the route must never CDN-cache this (see this file's header). */
  pending?: boolean;
  /** Draft redesign plan §2.3, additive: one entry per `params.enemies` id.
   *  Always [] when `enemies` is empty, on the pending path, or if the whole
   *  computation soft-fails (see computeEnemyAnalysis's doc comment) — never
   *  throws, never taints plays/bans/meta. */
  enemyAnalysis: EnemyAnalysis[];
  /** Additive lane-share facts for Draft Assistant filters and rankings. */
  laneStats?: DraftLaneStat[];
  /** Shrunk matchup estimates against popular lane opponents. */
  matchupPreviews?: DraftMatchupPreview[];
}

export interface DraftLaneStat {
  champId: number;
  baselineWr: number | null;
  totalGames: number | null;
  laneShare: number | null;
}

export interface DraftMatchupPreviewRow {
  oppId: number;
  winRate: number;
  games: number;
  opponentLaneShare: number;
}

export interface DraftMatchupPreview {
  champId: number;
  /** Compact preview rows first; locked-enemy rows are appended so the grid
   *  can render every pair present in the loaded matrix. */
  worst: DraftMatchupPreviewRow[];
  best: DraftMatchupPreviewRow[];
}

interface ChampStatsRow {
  champ_id: number;
  winrate: number | null;
  pickrate: number | null;
  banrate: number | null;
  total_games: number | null;
  /** MAX(ingested_at) OVER () -- same value on every row of this result set,
   *  the real freshness signal for meta.fetchedAt (see that field's doc
   *  comment). A window function rather than a second query: this rides the
   *  existing per-request poolRows fetch at zero extra round trips. */
  latest_ingested_at: string | null;
}

interface MatchupDbRow {
  champ_id: number;
  opp_id: number;
  wins: number;
  games: number;
}

function aggregateGamesByChampion(rows: MatchupDbRow[]): Map<number, number> {
  const games = new Map<number, number>();
  for (const row of rows) {
    if (!Number.isFinite(row.champ_id) || !Number.isFinite(row.games) || row.games <= 0) continue;
    games.set(row.champ_id, (games.get(row.champ_id) ?? 0) + row.games);
  }
  return games;
}

function aggregateGamesByOpponent(rows: MatchupDbRow[]): Map<number, number> {
  const games = new Map<number, number>();
  for (const row of rows) {
    if (!Number.isFinite(row.opp_id) || !Number.isFinite(row.games) || row.games <= 0) continue;
    games.set(row.opp_id, (games.get(row.opp_id) ?? 0) + row.games);
  }
  return games;
}

function buildLaneStats(fullPool: ChampBaseline[], rows: MatchupDbRow[]): DraftLaneStat[] {
  const matrixGames = aggregateGamesByChampion(rows);
  // `draft_champ_stats.total_games` is itself derived as Σ_o games(c,o) by
  // the draft ingest. The fallback keeps defensive/mocked responses useful
  // when a matrix read is empty; a populated matrix is always authoritative.
  const hasMatrix = rows.length > 0;
  const totals = fullPool.map((candidate) => {
    if (!hasMatrix) return candidate.totalGames;
    return matrixGames.has(candidate.champId) ? matrixGames.get(candidate.champId)! : null;
  });
  // When the scoring pool omits a row with no usable baseline, its games still
  // belong to the matrix's lane-wide denominator. Use the complete matrix
  // total whenever it exists; the candidate total remains the no-matrix
  // fallback for defensive/mocked responses.
  const candidateTotal = totals.reduce<number>((sum, total) => sum + (total ?? 0), 0);
  const matrixTotal = Array.from(matrixGames.values()).reduce((sum, total) => sum + total, 0);
  const laneTotal = hasMatrix ? matrixTotal : candidateTotal;
  return fullPool.map((candidate, index) => {
    const totalGames = totals[index];
    return {
      champId: candidate.champId,
      baselineWr: candidate.baselineWr,
      totalGames,
      laneShare: totalGames !== null && laneTotal > 0 ? laneShare({ ...candidate, totalGames }, laneTotal) : null,
    };
  });
}

export function buildMatchupPreviews(
  fullPool: ChampBaseline[],
  rows: MatchupDbRow[],
  laneStats: DraftLaneStat[],
  previewChampIds: ReadonlySet<number>,
  lockedEnemyIds: ReadonlySet<number> = new Set()
): DraftMatchupPreview[] {
  if (rows.length === 0) return [];
  if (laneStats.some((stat) => stat.totalGames === null)) return [];
  // Use every valid matrix row for the opponent prior denominator, not just
  // candidates that survived baseline validation. A missing-baseline champion
  // is excluded from recommendations but its games still describe the lane.
  const matrixTotal = Array.from(aggregateGamesByChampion(rows).values()).reduce((sum, total) => sum + total, 0);
  const realTotal = realLaneGames(matrixTotal);
  if (realTotal <= 0 || previewChampIds.size === 0) return [];
  const opponentGames = aggregateGamesByOpponent(rows);
  const opponentShares = new Map<number, number>();
  opponentGames.forEach((games, oppId) => opponentShares.set(oppId, games / realTotal));
  const baselineByChampion = new Map(fullPool.map((candidate) => [candidate.champId, candidate.baselineWr]));
  const previewRows = new Map<number, DraftMatchupPreviewRow[]>();

  for (const row of rows) {
    if (!previewChampIds.has(row.champ_id)) continue;
    if (row.games <= 0 || row.wins < 0 || row.wins > row.games) continue;
    const baseline = baselineByChampion.get(row.champ_id);
    const opponentLaneShare = opponentShares.get(row.opp_id) ?? 0;
    if (baseline === undefined || baseline === null || opponentLaneShare < POOL_MIN_PICKRATE) continue;
    const winRate = matchupEstimate(baseline, row.wins, row.games);
    if (winRate === null || !Number.isFinite(winRate)) continue;
    const candidateRows = previewRows.get(row.champ_id) ?? [];
    candidateRows.push({ oppId: row.opp_id, winRate, games: row.games, opponentLaneShare });
    previewRows.set(row.champ_id, candidateRows);
  }

  return fullPool
    .filter((candidate) => previewChampIds.has(candidate.champId))
    .map((candidate) => {
      const rowsForChampion = previewRows.get(candidate.champId) ?? [];
      const worstPreview = [...rowsForChampion]
        .sort((a, b) => (a.winRate !== b.winRate ? a.winRate - b.winRate : a.oppId - b.oppId))
        .slice(0, 3);
      const bestPreview = [...rowsForChampion]
        .sort((a, b) => (a.winRate !== b.winRate ? b.winRate - a.winRate : a.oppId - b.oppId))
        .slice(0, 3);
      // Keep the compact best/worst slices used by the cards, then append the
      // already-loaded values for locked enemies so the grid can read every
      // candidate x locked-enemy pair without changing score/rank behavior.
      const lockedRows = rowsForChampion.filter((row) => lockedEnemyIds.has(row.oppId));
      const appendLockedRows = (previewRows: DraftMatchupPreviewRow[]): DraftMatchupPreviewRow[] => {
        const seen = new Set(previewRows.map((row) => row.oppId));
        return [...previewRows, ...lockedRows.filter((row) => !seen.has(row.oppId))];
      };
      const worst = appendLockedRows(worstPreview);
      const best = appendLockedRows(bestPreview);
      return { champId: candidate.champId, worst, best };
    })
    .filter((preview) => preview.worst.length > 0 || preview.best.length > 0);
}

/** The patch currently being served (plan §4: "meta from max(ingested_at) +
 *  latest patch present"; audit P3-1 refinement, 2026-07-21): prefers the
 *  most-recently-ingested patch that has ALREADY reached
 *  SERVING_PATCH_MIN_CHAMPS distinct champions, so a brand-new patch mid-
 *  ingest never takes over serving from a genuinely complete older one.
 *  Ordering: patches clearing the completeness bar sort first (as a group,
 *  by MAX(ingested_at) DESC among themselves); if NONE clear it yet (e.g. a
 *  fresh bootstrap with only one patch, still filling in), falls back to
 *  the newest patch present regardless of completeness — this is still a
 *  plain DB read, no network/patch-resolution call needed, and it can never
 *  point at a patch the ingest hasn't touched AT ALL (unlike calling
 *  lib/draft/patch.ts's resolver directly, which reflects ddragon's newest
 *  release regardless of ingest progress). */
async function resolveServingPatch(sql: NonNullable<ReturnType<typeof getSql>>): Promise<string | null> {
  const rows = (await sql`
    SELECT patch, count(DISTINCT champ_id)::int AS champs, MAX(ingested_at) AS latest
    FROM coachbuild.draft_champ_stats
    GROUP BY patch
    ORDER BY (count(DISTINCT champ_id) >= ${SERVING_PATCH_MIN_CHAMPS}) DESC, MAX(ingested_at) DESC
    LIMIT 1
  `) as unknown as { patch: string; champs: number; latest: string }[];
  return rows[0]?.patch ?? null;
}

/** Resolves the direct-lane-opponent champId per this file's header
 *  contract: explicit `laneOpp` (if it's actually among `enemies`) wins;
 *  otherwise inferred by LANE PRESENCE among the enemies — pickrate when
 *  known, else the `total_games` playrate proxy (see header). Ties broken by
 *  champId ascending; the dominance guard (LANE_OPP_DOMINANCE_RATIO) keeps a
 *  genuinely ambiguous two-mid lane null; null if nothing qualifies. */
async function resolveLaneOpponent(
  sql: NonNullable<ReturnType<typeof getSql>>,
  patch: string,
  lane: RoleId,
  enemies: number[],
  laneOpp: number | null
): Promise<number | null> {
  if (laneOpp !== null && enemies.includes(laneOpp)) return laneOpp;
  if (enemies.length === 0) return null;

  const rows = (await sql`
    SELECT champ_id, pickrate, total_games FROM coachbuild.draft_champ_stats
    WHERE patch = ${patch} AND tier = ${DIAMOND_2_PLUS_TIER} AND role = ${lane} AND champ_id = ANY(${enemies}::int[])
  `) as unknown as { champ_id: number; pickrate: number | null; total_games: number | null }[];

  // Measure every enemy on ONE axis: real pickrate if ANY enemy has a
  // positive one (contract-preserving — pickrate wins the moment the decoder
  // is filled in), else total_games for all (today's actual state, pickrate
  // universally null). Never mix the two axes within a single resolution.
  const anyPickrate = rows.some((r) => r.pickrate !== null && r.pickrate > 0);
  const presenceOf = (r: { pickrate: number | null; total_games: number | null }): number =>
    anyPickrate ? (r.pickrate ?? 0) : (r.total_games ?? 0);

  const scored = rows
    .map((r) => ({ champId: r.champ_id, presence: presenceOf(r) }))
    .filter((r) => r.presence > 0)
    .sort((a, b) => (b.presence !== a.presence ? b.presence - a.presence : a.champId - b.champId));

  if (scored.length === 0) return null;
  if (scored.length === 1) return scored[0].champId; // only one enemy plays this lane at all — unambiguous

  // 2+ real lane candidates: only infer when the leader clearly dominates,
  // otherwise stay null and let the user tap (honest > forced-pick).
  const [top, runnerUp] = scored;
  if (top.presence < runnerUp.presence * LANE_OPP_DOMINANCE_RATIO) return null;
  return top.champId;
}

interface MyMatchDbRow {
  champion_id: number;
  opp_champion_id: number | null;
  win: boolean;
}

/** Zeroed personal decoration — the shape callers already get for a champion
 *  with no personal games, reused for "no active account" and "personal data
 *  unavailable" so those states are indistinguishable from "you haven't played
 *  this", which is what they mean to the UI. */
function decorateEmpty(plays: PlayResult[]): PersonalPlayResult[] {
  return plays.map((p) => ({ ...p, personalOverall: { games: 0, wins: 0 }, personal: null }));
}

/** Decorates already-ranked plays with personal-record fields, in ONE extra
 *  indexed query (coachbuild.my_matches has an index on (champion_id, role,
 *  opp_champion_id) for exactly this — migration 0012). Runs strictly AFTER
 *  scoring+splitting has finished — see PersonalPlayResult's doc comment for
 *  the hard no-blending directive this depends on. Wrapped in a soft failure
 *  (`.catch`) so a missing/not-yet-migrated my_matches table degrades to
 *  all-zero personal records instead of taking down the whole recommend
 *  response — this decoration is optional display data, the ranking itself
 *  never depended on it.
 *
 *  v0.37.4: takes BOTH the main and potential lists so a single combined
 *  query covers both (never two separate my_matches round-trips for one
 *  request) — each list is decorated independently from the SAME fetched
 *  rows, preserving each one's own order. */
async function attachPersonalRecords(
  sql: NonNullable<ReturnType<typeof getSql>>,
  mainPlays: PlayResult[],
  potentialPlays: PlayResult[],
  lane: RoleId,
  laneOppInferred: number | null
): Promise<{ main: PersonalPlayResult[]; potential: PersonalPlayResult[] }> {
  const allPlays = mainPlays.length === 0 && potentialPlays.length === 0 ? [] : [...mainPlays, ...potentialPlays];
  if (allPlays.length === 0) return { main: [], potential: [] };

  // ACCOUNT SCOPING (migration 0020) — this was a REAL cross-account bleed
  // site, not a hypothetical one, and it is not on the My Stats page: these
  // rows become the Draft recommender's `personal`/`personalOverall` badges.
  // Unscoped, a second linked account would have made every "you: 7-3 on this
  // champion" badge the SUM of two players' records. The account read is
  // wrapped in the same soft `.catch` as the row query, so a DB hiccup or a
  // not-yet-migrated table still degrades to all-zero personal records rather
  // than taking down a recommend response that never depended on them.
  //
  // NO ACTIVE ACCOUNT -> no query at all. Returning zeroed records is the
  // honest answer; falling back to an unscoped read to "have something to
  // show" is exactly the bug.
  const account = await getActiveAccount(sql).catch(() => null);
  if (!account) return { main: decorateEmpty(mainPlays), potential: decorateEmpty(potentialPlays) };

  // SOLO QUEUE ONLY (2026-07-30, lib/mystats/queues.ts). These badges read
  // "you: 7-3 on this champion" on the Draft page, and the user is drafting a
  // RANKED SOLO game when they read them — a record padded with flex, normal
  // draft and quickplay games is a different claim than the one on screen.
  // Same constant, same predicate, as every /api/mystats read; the two must not
  // be able to disagree about what counts as a game.
  const champIds = allPlays.map((p) => p.champId);
  const rows = await sql`
    SELECT champion_id, opp_champion_id, win FROM coachbuild.my_matches
    WHERE puuid = ${account.puuid}
      AND queue_id = ANY(${COUNTED_QUEUE_IDS}::int[])
      AND role = ${lane} AND champion_id = ANY(${champIds}::int[])
  `.catch(() => []) as unknown as MyMatchDbRow[];

  const overall = new Map<number, PersonalRecord>();
  const vsLaneOpp = new Map<number, PersonalRecord>();
  for (const row of rows) {
    const o = overall.get(row.champion_id) ?? { games: 0, wins: 0 };
    o.games += 1;
    if (row.win) o.wins += 1;
    overall.set(row.champion_id, o);

    if (laneOppInferred !== null && row.opp_champion_id === laneOppInferred) {
      const v = vsLaneOpp.get(row.champion_id) ?? { games: 0, wins: 0 };
      v.games += 1;
      if (row.win) v.wins += 1;
      vsLaneOpp.set(row.champion_id, v);
    }
  }

  const decorate = (plays: PlayResult[]): PersonalPlayResult[] =>
    plays.map((p) => ({
      ...p,
      personalOverall: overall.get(p.champId) ?? { games: 0, wins: 0 },
      personal: laneOppInferred !== null ? vsLaneOpp.get(p.champId) ?? { games: 0, wins: 0 } : null,
    }));

  return { main: decorate(mainPlays), potential: decorate(potentialPlays) };
}

/** Draft redesign plan §2.3 — additive per-enemy analysis (see
 *  EnemyAnalysis's doc comment). Soft-fails like attachPersonalRecords: any
 *  DB/ddragon failure degrades to [] rather than taking down the whole
 *  recommend response — this is optional display data, never load-bearing
 *  for plays/bans/meta. Issues AT MOST one extra draft_matchup lookup (the
 *  resolved lane opponent vs `hover`) regardless of how many enemies are
 *  passed — suggestedDefense's per-champion getChampionMeta lookups reuse
 *  lib/staticData.ts's own in-memory champion-list cache (populated once per
 *  serverless instance), so they cost no extra network beyond that list's
 *  first fetch. A per-champion suggestedDefense failure is caught locally so
 *  ONE bad lookup never blanks the other enemies' entries. */
async function computeEnemyAnalysis(
  sql: NonNullable<ReturnType<typeof getSql>>,
  patch: string,
  lane: RoleId,
  enemies: number[],
  laneOppInferred: number | null,
  hover: number | null,
  fullPool: ChampBaseline[]
): Promise<EnemyAnalysis[]> {
  if (enemies.length === 0) return [];
  try {
    let laneOppWr: number | null = null;
    let laneOppGames: number | null = null;
    let laneThreat: DifficultyBand | null = null;

    if (laneOppInferred !== null && hover !== null) {
      const rows = (await sql`
        SELECT wins, games FROM coachbuild.draft_matchup
        WHERE patch = ${patch} AND tier = ${DIAMOND_2_PLUS_TIER} AND role = ${lane}
          AND champ_id = ${laneOppInferred} AND opp_id = ${hover}
      `) as unknown as { wins: number; games: number }[];
      const row = rows[0];
      if (row && row.games > 0) {
        laneOppWr = row.wins / row.games;
        laneOppGames = row.games;
        const laneOppBaseline = fullPool.find((c) => c.champId === laneOppInferred)?.baselineWr ?? null;
        if (laneOppBaseline !== null) {
          // shrunkDelta(their-wr-vs-you, their-own-lane-baseline, n) -- null
          // below N_FLOOR, per plan §2.3's "below floor -> suppressed".
          const delta = shrunkDelta(laneOppWr, laneOppBaseline, laneOppGames);
          laneThreat = laneThreatBandFromDelta(delta);
        }
      }
    }

    return await Promise.all(
      enemies.map(async (champId): Promise<EnemyAnalysis> => {
        const isLaneOpponent = champId === laneOppInferred;
        let defense: SuggestedDefense | null = null;
        try {
          const meta = await getChampionMeta(champId);
          if (meta) defense = suggestedDefense(meta.tags, meta.info);
        } catch {
          defense = null; // per-champion soft-fail -- never taints the others
        }
        return {
          champId,
          isLaneOpponent,
          winRateVsYou: isLaneOpponent ? laneOppWr : null,
          winRateVsYouGames: isLaneOpponent ? laneOppGames : null,
          laneThreatBand: isLaneOpponent ? laneThreat : null,
          suggestedDefense: defense,
        };
      })
    );
  } catch {
    return []; // whole-computation soft-fail -- see this fn's doc comment
  }
}

export async function computeDraftRecommend(params: RecommendParams): Promise<RecommendResult> {
  const sql = getSql();
  if (!sql) throw new DbUnavailableError();

  const fetchedAt = new Date().toISOString();
  // Fail-soft (see RecommendMeta.currentPatch's own doc comment) — this
  // resolver's own fallback chain currently never throws, but a null here
  // must never block serving the real `patch` data below.
  const currentPatch = await resolveDraftPatchLabel().catch(() => null);
  // 2026-07-31 audit P2 (#2) — soft-fail exactly like currentPatch above: a
  // missing/failed health read must degrade to "unknown" (null), never block
  // serving real data and never manufacture a false "unhealthy" warning.
  const ingestHealth = await getIngestHealth(sql, "draft").catch(() => null);
  const ingestHealthy = ingestHealth?.ok ?? null;
  const ingestLastError = ingestHealth?.ok === false ? ingestHealth.lastError : null;
  const pendingMeta = (patch: string | null): RecommendResult => ({
    plays: [],
    potentialPlays: [],
    bans: null,
    meta: { patch, tier: DIAMOND_2_PLUS_TIER, fetchedAt, laneOppInferred: null, currentPatch, ingestHealthy, ingestLastError },
    pending: true,
    enemyAnalysis: [],
  });

  const patch = await resolveServingPatch(sql);
  if (!patch) return pendingMeta(null);

  const poolRows = (await sql`
    SELECT champ_id, winrate, pickrate, banrate, total_games,
           MAX(ingested_at) OVER () AS latest_ingested_at
    FROM coachbuild.draft_champ_stats
    WHERE patch = ${patch} AND tier = ${DIAMOND_2_PLUS_TIER} AND role = ${params.lane}
  `) as unknown as ChampStatsRow[];
  // A missing baseline is not a neutral 50% baseline: it is absent evidence.
  // The scorer requires a real baseline for every candidate, so leave such a
  // row out of every derived pool rather than fabricating a number that can
  // rank it or feed its matchup deltas.
  const fullPool: ChampBaseline[] = poolRows
    .filter((r): r is ChampStatsRow & { winrate: number } => typeof r.winrate === "number" && Number.isFinite(r.winrate))
    .map((r) => ({
      champId: r.champ_id,
      baselineWr: r.winrate,
      pickrate: r.pickrate,
      banrate: r.banrate,
      totalGames: r.total_games ?? 0,
    }));
  if (fullPool.length === 0) return pendingMeta(patch);
  // Real data-freshness signal (see RecommendMeta.fetchedAt's doc comment) --
  // every row in this result set carries the same window-function value, so
  // the first is as good as any. Falls back to request time only if the
  // column somehow comes back null (defensive; the column is NOT NULL).
  const dataFetchedAt = poolRows[0]?.latest_ingested_at ?? fetchedAt;

  // The Assistant's lane-share and matchup preview figures are derived from
  // the complete champion-vs-opponent matrix for this bucket. This is a read
  // only, additive payload; it does not change the existing recommendation
  // score or the personal decoration path below.
  let allMatchupRows: MatchupDbRow[] = [];
  try {
    allMatchupRows = (await sql`
      SELECT champ_id, opp_id, wins, games
      FROM coachbuild.draft_matchup
      WHERE patch = ${patch} AND tier = ${DIAMOND_2_PLUS_TIER} AND role = ${params.lane}
    `) as unknown as MatchupDbRow[];
  } catch {
    // Lane facts are additive. A matrix read failure must not turn a valid
    // recommendation response into an error; the targeted query below still
    // preserves the original scoring path when enemies are present.
    allMatchupRows = [];
  }
  const laneStats = buildLaneStats(fullPool, allMatchupRows);

  // audit P1-1: filterPoolByPickrate alone is currently a no-op (pickrate is
  // always null — see ChampBaseline's doc comment), which left the pool
  // completely ungated and let off-role low-sample artifacts (e.g. a
  // support-only champion's ~130-game Top sample) out-rank real lane
  // staples on baseline winrate alone. filterPoolByTotalGames is the real,
  // unconditional gate right now; filterPoolByPickrate stays in the chain
  // so it becomes load-bearing again the moment the rankings decoder is
  // filled in, with no call-site change needed then.
  const pool = filterPoolByTotalGames(filterPoolByPickrate(fullPool));

  const laneOppInferred = await resolveLaneOpponent(sql, patch, params.lane, params.enemies, params.laneOpp);
  const enemyInputs: EnemyInput[] = params.enemies.map((champId) => ({
    champId,
    isDirectLaneOpp: champId === laneOppInferred,
  }));

  const matchups = new Map<number, Map<number, MatchupRow>>();
  if (params.enemies.length > 0 && pool.length > 0) {
    const poolIds = new Set(pool.map((candidate) => candidate.champId));
    const enemyIds = new Set(params.enemies);
    if (allMatchupRows.length > 0) {
      for (const row of allMatchupRows) {
        if (!poolIds.has(row.champ_id) || !enemyIds.has(row.opp_id)) continue;
        if (!matchups.has(row.champ_id)) matchups.set(row.champ_id, new Map());
        matchups.get(row.champ_id)!.set(row.opp_id, { wins: row.wins, games: row.games });
      }
    } else {
      const rows = (await sql`
        SELECT champ_id, opp_id, wins, games
        FROM coachbuild.draft_matchup
        WHERE patch = ${patch} AND tier = ${DIAMOND_2_PLUS_TIER} AND role = ${params.lane}
          AND opp_id = ANY(${params.enemies}::int[])
      `) as unknown as MatchupDbRow[];
      for (const row of rows) {
        if (!poolIds.has(row.champ_id) || !enemyIds.has(row.opp_id)) continue;
        if (!matchups.has(row.champ_id)) matchups.set(row.champ_id, new Map());
        matchups.get(row.champ_id)!.set(row.opp_id, { wins: row.wins, games: row.games });
      }
    }
  }

  // v0.37.4: partition by matchup sample size vs the resolved direct lane
  // opponent instead of a single top-10 (see splitPlaysBySampleSize's doc
  // comment) — degrades to today's unchanged single-list behavior when
  // laneOppInferred is null (empty enemies, or no enemy has known pickrate).
  const { main: rankedMain, potential: rankedPotential } = splitPlaysBySampleSize(pool, matchups, enemyInputs);

  // The page's hero cards combine this ranked feed with the separate blind-
  // pick feed. Build previews for the complete lane pool so a champion that
  // only appears in SAFEST BLIND (for example Diana) still receives the same
  // popular-opponent rows as the play cards. This remains a compact derived
  // payload: only three worst and three best rows survive per champion, plus
  // the locked-enemy rows needed to render the matchup grid completely.
  const previewChampIds = new Set(fullPool.map((candidate) => candidate.champId));
  const matchupPreviews = buildMatchupPreviews(fullPool, allMatchupRows, laneStats, previewChampIds, new Set(params.enemies));

  let bans: BanResult[] | null = null;
  if (params.hover !== null) {
    const hoverBaseline = fullPool.find((c) => c.champId === params.hover);
    if (hoverBaseline && pool.length > 0) {
      const poolIds = pool.map((c) => c.champId);
      const hoverRows = (await sql`
        SELECT opp_id, wins, games FROM coachbuild.draft_matchup
        WHERE patch = ${patch} AND tier = ${DIAMOND_2_PLUS_TIER} AND role = ${params.lane}
          AND champ_id = ${params.hover} AND opp_id = ANY(${poolIds}::int[])
      `) as unknown as { opp_id: number; wins: number; games: number }[];
      const matchupsForHover = new Map<number, MatchupRow>();
      for (const row of hoverRows) matchupsForHover.set(row.opp_id, { wins: row.wins, games: row.games });
      bans = rankBans(params.hover, hoverBaseline.baselineWr, pool, matchupsForHover);
    } else {
      bans = []; // hovered champ has no baseline in this lane -- nothing to rank against
    }
  }

  const { main: personalMain, potential: personalPotential } = await attachPersonalRecords(
    sql,
    rankedMain,
    rankedPotential,
    params.lane,
    laneOppInferred
  );

  const enemyAnalysis = await computeEnemyAnalysis(
    sql,
    patch,
    params.lane,
    params.enemies,
    laneOppInferred,
    params.hover,
    fullPool
  );

  return {
    plays: personalMain,
    potentialPlays: personalPotential,
    bans,
    meta: { patch, tier: DIAMOND_2_PLUS_TIER, fetchedAt: dataFetchedAt, laneOppInferred, currentPatch, ingestHealthy, ingestLastError },
    enemyAnalysis,
    laneStats,
    matchupPreviews,
  };
}
