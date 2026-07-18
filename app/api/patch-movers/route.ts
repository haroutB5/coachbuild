import { NextRequest, NextResponse } from "next/server";
import type { ApiError, RoleId } from "@/lib/types";
import { computePatchMovers } from "@/lib/patchMovers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Cold path is ~15-20s (20 champs x 4 coachless calls, concurrency 6, plus the
// prior-patch probe) — the platform default 10s would timeout every cold hit
// (audit 2026-07-18 P1). Same convention as timeline (30) / ingest (60).
export const maxDuration = 60;

/**
 * GET /api/patch-movers?role=<laneId 0-4>
 * Biggest headline-keystone / headline-item WPA swings between the current
 * populated coachless patch and the previous one, for a lane.
 *
 * - 200 + { patch, prevPatch, movers[] } when computed → cached hard (24h SWR),
 *   since patch data is immutable once populated. movers may be capped at ~20.
 * - 200 + { unsupported: true } (no-store) when there's no previous populated
 *   patch to compare against — the UI hides the page. (Prior-patch data IS
 *   available today, so this is a defensive path, not the current state.)
 * - Empty movers → treated as degraded (fetches largely failed) → no-store, so a
 *   transient upstream glitch can't get pinned at the edge (repo Gotcha (b)).
 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const roleParam = searchParams.get("role");

  if (!roleParam || !/^\d+$/.test(roleParam)) {
    const body: ApiError = { error: "Missing or invalid role param (0-4)" };
    return NextResponse.json(body, { status: 400 });
  }
  const role = parseInt(roleParam, 10);
  // Patch movers need a CONCRETE lane (0-4); 5/auto is not a lane.
  if (role < 0 || role > 4) {
    const body: ApiError = { error: "Invalid role for patch movers (must be 0-4)" };
    return NextResponse.json(body, { status: 400 });
  }

  try {
    const result = await computePatchMovers(role as 0 | 1 | 2 | 3 | 4);

    if ("unsupported" in result) {
      // Prior-patch data unavailable → tell the UI to hide, never CDN-cache it.
      return NextResponse.json(result, {
        status: 200,
        headers: { "Cache-Control": "no-store" },
      });
    }

    if (result.movers.length === 0) {
      // Degraded (upstream fetches failed / no shared entities) — do not cache.
      return NextResponse.json(result, {
        status: 200,
        headers: { "Cache-Control": "no-store" },
      });
    }

    return NextResponse.json(result, {
      status: 200,
      headers: {
        "Cache-Control": "s-maxage=86400, stale-while-revalidate=86400",
      },
    });
  } catch (err) {
    console.error("[/api/patch-movers] Unexpected error:", err);
    const body: ApiError = { error: "Internal server error" };
    return NextResponse.json(body, { status: 500 });
  }
}
