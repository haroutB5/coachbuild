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
//     INFERRED statistically: whichever enemy has the highest KNOWN pickrate
//     in THIS lane+patch+tier (coachbuild.draft_champ_stats), ties broken by
//     champId ascending. An enemy with unknown (null) or zero pickrate never
//     wins the inference — see this ship's pickrate gap (lib/draft/
//     ugg.ts's decodeRankingsJson stub), which means inference currently
//     resolves to null (no direct opponent) until that decoder is filled in.
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
  rankBans,
  rankPlays,
  type BanResult,
  type ChampBaseline,
  type EnemyInput,
  type MatchupRow,
  type PlayResult,
} from "@/lib/draft/score";
import { EMERALD_TIER } from "@/lib/draft/ugg";

/** P3-1 (audit, 2026-07-21): a patch needs at least this many distinct
 *  champions present in draft_champ_stats before resolveServingPatch will
 *  treat it as "ready to serve" over an older, more complete patch — a
 *  brand-new patch mid-ingest (the cron processes ~40 champs/tick, see
 *  app/api/ingest/draft/route.ts) would otherwise take over serving
 *  immediately at ~9-40 champions and show a near-empty pool for most
 *  lanes. ~170 total champions exist; 120 is comfortably past the
 *  first-few-cron-ticks partial state without waiting for a full 173/173. */
const SERVING_PATCH_MIN_CHAMPS = 120;

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
  fetchedAt: string;
  laneOppInferred: number | null;
}

export interface RecommendResult {
  plays: PlayResult[];
  bans: BanResult[] | null;
  meta: RecommendMeta;
  /** True when there's nothing to serve yet (no patch ingested at all, or
   *  this specific lane has zero champ_stats rows for the serving patch) —
   *  the route must never CDN-cache this (see this file's header). */
  pending?: boolean;
}

interface ChampStatsRow {
  champ_id: number;
  winrate: number | null;
  pickrate: number | null;
  banrate: number | null;
  total_games: number | null;
}

interface MatchupDbRow {
  champ_id: number;
  opp_id: number;
  wins: number;
  games: number;
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
 *  otherwise the enemy with the highest KNOWN pickrate in this lane, ties
 *  broken by champId ascending; null if nothing qualifies. */
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
    SELECT champ_id, pickrate FROM coachbuild.draft_champ_stats
    WHERE patch = ${patch} AND tier = ${EMERALD_TIER} AND role = ${lane} AND champ_id = ANY(${enemies}::int[])
  `) as unknown as { champ_id: number; pickrate: number | null }[];

  let best: { champId: number; pickrate: number } | null = null;
  for (const row of rows) {
    if (row.pickrate === null || row.pickrate <= 0) continue;
    if (!best || row.pickrate > best.pickrate || (row.pickrate === best.pickrate && row.champ_id < best.champId)) {
      best = { champId: row.champ_id, pickrate: row.pickrate };
    }
  }
  return best?.champId ?? null;
}

export async function computeDraftRecommend(params: RecommendParams): Promise<RecommendResult> {
  const sql = getSql();
  if (!sql) throw new DbUnavailableError();

  const fetchedAt = new Date().toISOString();
  const pendingMeta = (patch: string | null): RecommendResult => ({
    plays: [],
    bans: null,
    meta: { patch, tier: EMERALD_TIER, fetchedAt, laneOppInferred: null },
    pending: true,
  });

  const patch = await resolveServingPatch(sql);
  if (!patch) return pendingMeta(null);

  const poolRows = (await sql`
    SELECT champ_id, winrate, pickrate, banrate, total_games FROM coachbuild.draft_champ_stats
    WHERE patch = ${patch} AND tier = ${EMERALD_TIER} AND role = ${params.lane}
  `) as unknown as ChampStatsRow[];
  const fullPool: ChampBaseline[] = poolRows.map((r) => ({
    champId: r.champ_id,
    baselineWr: r.winrate ?? 0.5,
    pickrate: r.pickrate,
    banrate: r.banrate,
    totalGames: r.total_games ?? 0,
  }));
  if (fullPool.length === 0) return pendingMeta(patch);

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
    const poolIds = pool.map((c) => c.champId);
    const rows = (await sql`
      SELECT champ_id, opp_id, wins, games FROM coachbuild.draft_matchup
      WHERE patch = ${patch} AND tier = ${EMERALD_TIER} AND role = ${params.lane}
        AND champ_id = ANY(${poolIds}::int[]) AND opp_id = ANY(${params.enemies}::int[])
    `) as unknown as MatchupDbRow[];
    for (const row of rows) {
      if (!matchups.has(row.champ_id)) matchups.set(row.champ_id, new Map());
      matchups.get(row.champ_id)!.set(row.opp_id, { wins: row.wins, games: row.games });
    }
  }

  const plays = rankPlays(pool, matchups, enemyInputs);

  let bans: BanResult[] | null = null;
  if (params.hover !== null) {
    const hoverBaseline = fullPool.find((c) => c.champId === params.hover);
    if (hoverBaseline && pool.length > 0) {
      const poolIds = pool.map((c) => c.champId);
      const hoverRows = (await sql`
        SELECT opp_id, wins, games FROM coachbuild.draft_matchup
        WHERE patch = ${patch} AND tier = ${EMERALD_TIER} AND role = ${params.lane}
          AND champ_id = ${params.hover} AND opp_id = ANY(${poolIds}::int[])
      `) as unknown as { opp_id: number; wins: number; games: number }[];
      const matchupsForHover = new Map<number, MatchupRow>();
      for (const row of hoverRows) matchupsForHover.set(row.opp_id, { wins: row.wins, games: row.games });
      bans = rankBans(params.hover, hoverBaseline.baselineWr, pool, matchupsForHover);
    } else {
      bans = []; // hovered champ has no baseline in this lane -- nothing to rank against
    }
  }

  return {
    plays,
    bans,
    meta: { patch, tier: EMERALD_TIER, fetchedAt, laneOppInferred },
  };
}
