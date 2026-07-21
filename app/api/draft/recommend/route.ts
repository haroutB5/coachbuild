import { NextRequest, NextResponse } from "next/server";
import type { ApiError, RoleId } from "@/lib/types";
import { DbUnavailableError } from "@/lib/pro/errors";
import { computeDraftRecommend } from "@/lib/draft/recommend";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Mirrors draftLiveSync.ts's MAX_DRAFT_ENEMIES — the server enforces the
 *  same cap defensively rather than trusting the client. */
const MAX_ENEMIES = 5;

function parsePositiveInt(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const n = parseInt(raw, 10);
  return n > 0 ? n : null;
}

/**
 * GET /api/draft/recommend?lane=<0-4>&enemies=<csv>&laneOpp=<id>&hover=<id>
 * See lib/draft/recommend.ts's header comment for the full contract
 * (laneOpp explicit-or-inferred, meta.laneOppInferred). Cache discipline
 * (plan §4): populated -> s-maxage=300/stale-while-revalidate=600;
 * empty/pending/degraded -> no-store (never let a transient/empty result get
 * pinned at the edge — same posture as /api/patch-movers).
 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);

  const laneParam = searchParams.get("lane");
  if (!laneParam || !/^\d+$/.test(laneParam)) {
    const body: ApiError = { error: "Missing or invalid lane param (0-4)" };
    return NextResponse.json(body, { status: 400 });
  }
  const laneNum = parseInt(laneParam, 10);
  if (laneNum < 0 || laneNum > 4) {
    const body: ApiError = { error: "Invalid lane (must be 0-4 -- 5/auto is not a concrete lane)" };
    return NextResponse.json(body, { status: 400 });
  }
  const lane = laneNum as RoleId;

  const enemiesParam = searchParams.get("enemies");
  const enemies: number[] = [];
  if (enemiesParam) {
    const seen = new Set<number>();
    for (const token of enemiesParam.split(",")) {
      const trimmed = token.trim();
      if (!trimmed) continue;
      const id = parsePositiveInt(trimmed);
      if (id === null) {
        const body: ApiError = { error: `Invalid enemies entry: "${trimmed}"` };
        return NextResponse.json(body, { status: 400 });
      }
      if (seen.has(id)) continue;
      seen.add(id);
      enemies.push(id);
      if (enemies.length >= MAX_ENEMIES) break;
    }
  }

  let laneOpp: number | null = null;
  const laneOppParam = searchParams.get("laneOpp");
  if (laneOppParam) {
    laneOpp = parsePositiveInt(laneOppParam);
    if (laneOpp === null) {
      const body: ApiError = { error: `Invalid laneOpp: "${laneOppParam}"` };
      return NextResponse.json(body, { status: 400 });
    }
  }

  let hover: number | null = null;
  const hoverParam = searchParams.get("hover");
  if (hoverParam) {
    hover = parsePositiveInt(hoverParam);
    if (hover === null) {
      const body: ApiError = { error: `Invalid hover: "${hoverParam}"` };
      return NextResponse.json(body, { status: 400 });
    }
  }

  try {
    const result = await computeDraftRecommend({ lane, enemies, laneOpp, hover });

    const populated = !result.pending && result.plays.length > 0;
    const headers = populated
      ? { "Cache-Control": "s-maxage=300, stale-while-revalidate=600" }
      : { "Cache-Control": "no-store" };

    return NextResponse.json(result, { status: 200, headers });
  } catch (err) {
    if (err instanceof DbUnavailableError) {
      const body: ApiError = { error: "DATABASE_URL not configured" };
      return NextResponse.json(body, { status: 503, headers: { "Cache-Control": "no-store" } });
    }
    console.error("[/api/draft/recommend] Unexpected error:", err);
    const body: ApiError = { error: "Internal server error" };
    return NextResponse.json(body, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}
