import { NextRequest, NextResponse } from "next/server";
import type { ApiError, RoleId } from "@/lib/types";
import { DbUnavailableError } from "@/lib/pro/errors";
import { getSql } from "@/lib/pro/db";
import { DIAMOND_2_PLUS_TIER } from "@/lib/draft/ugg";
import { resolveServingPatch } from "@/lib/draft/servingPatch";
import {
  deriveBlindPickCandidates,
  rankBlindPicks,
  type BlindPickMatchupRow,
  type BlindPickRanking,
} from "@/lib/draft/blindPick";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Patch selection is IMPORTED from lib/draft/servingPatch.ts, not restated
// here. This route used to carry its own copy under a comment reading "keep
// patch selection byte-for-byte aligned with /api/draft/recommend" — and it
// had drifted in the way that mattered anyway: both copies counted champions
// with no `tier` predicate, so the orphaned tier-10 partition could vouch for
// a patch whose tier-15 data was half-ingested. See that module's header.
const CACHE_CONTROL = "s-maxage=300, stale-while-revalidate=600";

export interface BlindPickMeta {
  patch: string | null;
  tier: number;
  lane: RoleId;
  /** MAX(ingested_at) from the matchup rows used for this lane calculation.
   *  Null is an honest absence when no rows exist or the timestamp is missing. */
  fetchedAt: string | null;
  poolCandidates: number;
  qualifiedCandidates: number;
  excludedByLaneShare: number;
  excludedByMassGate: number;
  excludedUncomputable: number;
  returnedCandidates: number;
  topN: number;
  /** v0.109.0 — WHY the ladder is empty, stated rather than inferred.
   *
   *  This route answers HTTP 200 with `picks: []` for two situations that
   *  mean opposite things to a reader, and until now they were byte-identical
   *  on the wire apart from counters the client had to re-derive:
   *    "no-data"        — nothing ingested for this patch/tier/lane at all.
   *                       Always accompanied by top-level `pending: true`.
   *    "all-withheld"   — real candidates existed and every one was held back
   *                       by a deliberate gate (lane share, matchup mass, or
   *                       missing rows). The exclusion counters say which.
   *    "no-candidates"  — the lane produced no candidate to gate in the first
   *                       place, without being outright empty (defensive; not
   *                       reachable on today's data).
   *  Null whenever `picks` is non-empty. The distinction is load-bearing: an
   *  empty ladder caused by thin data must not render the same as one caused
   *  by no data, and the v0.108.0 rank narrowing made the thin case reachable
   *  for the first time. */
  emptyReason: "no-data" | "all-withheld" | "no-candidates" | null;
}

export interface BlindPickResponse {
  picks: ReturnType<typeof rankBlindPicks>["picks"];
  meta: BlindPickMeta;
  pending?: boolean;
}

interface MatchupDbRow {
  champ_id: number;
  opp_id: number;
  wins: number;
  games: number;
  latest_ingested_at: string | Date | null;
}

function parseLane(raw: string | null): RoleId | null {
  if (!raw || !/^\d+$/.test(raw)) return null;
  const lane = parseInt(raw, 10);
  return lane >= 0 && lane <= 4 ? (lane as RoleId) : null;
}

function timestampToIso(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  return typeof value === "string" && value.length > 0 ? value : null;
}

function emptyResponse(lane: RoleId, patch: string | null, pending = false): BlindPickResponse {
  return {
    picks: [],
    meta: {
      patch,
      tier: DIAMOND_2_PLUS_TIER,
      lane,
      fetchedAt: null,
      poolCandidates: 0,
      qualifiedCandidates: 0,
      excludedByLaneShare: 0,
      excludedByMassGate: 0,
      excludedUncomputable: 0,
      returnedCandidates: 0,
      topN: 10,
      emptyReason: pending ? "no-data" : "no-candidates",
    },
    ...(pending ? { pending: true } : {}),
  };
}

/** Single place the empty-ladder classification is decided, so the route and
 *  its tests cannot disagree about what an empty `picks` array means. */
function resolveEmptyReason(ranking: BlindPickRanking): BlindPickMeta["emptyReason"] {
  if (ranking.picks.length > 0) return null;
  const withheld = ranking.excludedByLaneShare + ranking.excludedByMassGate + ranking.excludedUncomputable;
  return withheld > 0 ? "all-withheld" : "no-candidates";
}

async function computeBlindPick(lane: RoleId): Promise<BlindPickResponse> {
  const sql = getSql();
  if (!sql) throw new DbUnavailableError();

  const patch = await resolveServingPatch(sql);
  if (!patch) return emptyResponse(lane, null, true);

  // This is the complete lane matrix, not just the candidate rows. The
  // engine's global opponent prior must see every champion in the lane so a
  // champion's own counterpick history cannot define its exposure distribution.
  const dbRows = (await sql`
    SELECT champ_id, opp_id, wins, games,
           MAX(ingested_at) OVER () AS latest_ingested_at
    FROM coachbuild.draft_matchup
    WHERE patch = ${patch} AND tier = ${DIAMOND_2_PLUS_TIER} AND role = ${lane}
  `) as unknown as MatchupDbRow[];
  if (dbRows.length === 0) return emptyResponse(lane, patch, true);

  const matchupRows: BlindPickMatchupRow[] = dbRows.map(({ champ_id, opp_id, wins, games }) => ({
    champId: champ_id,
    oppId: opp_id,
    wins,
    games,
  }));
  const candidates = deriveBlindPickCandidates(matchupRows);
  const ranking: BlindPickRanking = rankBlindPicks(candidates, matchupRows);
  const fetchedAt = timestampToIso(dbRows[0]?.latest_ingested_at);

  return {
    picks: ranking.picks,
    meta: {
      patch,
      tier: DIAMOND_2_PLUS_TIER,
      lane,
      fetchedAt,
      poolCandidates: ranking.poolCandidates,
      qualifiedCandidates: ranking.qualifiedCandidates,
      excludedByLaneShare: ranking.excludedByLaneShare,
      excludedByMassGate: ranking.excludedByMassGate,
      excludedUncomputable: ranking.excludedUncomputable,
      returnedCandidates: ranking.picks.length,
      topN: 10,
      emptyReason: resolveEmptyReason(ranking),
    },
  };
}

/** GET /api/draft/blind-pick?lane=<0-4>
 *
 * Blind-pick output depends only on patch, tier, and lane, so it is a separate
 * cacheable resource rather than a field on /api/draft/recommend (which varies
 * with every enemy edit). Populated data uses the same five-minute edge cache
 * window as the existing draft route; pending/empty/error responses are never
 * cached. */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const rawLane = searchParams.get("lane");
  if (!rawLane || !/^\d+$/.test(rawLane)) {
    const body: ApiError = { error: "Missing or invalid lane param (0-4)" };
    return NextResponse.json(body, { status: 400 });
  }

  const lane = parseLane(rawLane);
  if (lane === null) {
    const body: ApiError = { error: "Invalid lane (must be 0-4 -- 5/auto is not a concrete lane)" };
    return NextResponse.json(body, { status: 400 });
  }

  try {
    const result = await computeBlindPick(lane);
    const populated = !result.pending && result.picks.length > 0;
    const headers = populated ? { "Cache-Control": CACHE_CONTROL } : { "Cache-Control": "no-store" };
    return NextResponse.json(result, { status: 200, headers });
  } catch (err) {
    if (err instanceof DbUnavailableError) {
      const body: ApiError = { error: "DATABASE_URL not configured" };
      return NextResponse.json(body, { status: 503, headers: { "Cache-Control": "no-store" } });
    }
    console.error("[/api/draft/blind-pick] Unexpected error:", err);
    const body: ApiError = { error: "Internal server error" };
    return NextResponse.json(body, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}
