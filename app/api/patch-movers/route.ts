import { NextResponse } from "next/server";
import type { ApiError } from "@/lib/types";
import { computePatchMovers } from "@/lib/patchMovers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Cold path is now up to ~100 candidates (curated pools unioned across all 5
// lanes, v0.51 rewrite -- see lib/patchMovers.ts's header) x 2 patches x 2
// coachless calls each, at concurrency 10 -- roughly the same total call
// volume the OLD per-lane version needed across all 5 of its separate route
// hits, now done in ONE request since `role` is no longer a query param (see
// below). Bumped from 60 -> 90 for headroom; the platform default 10s would
// timeout every cold hit either way (audit 2026-07-18 P1, same rationale).
export const maxDuration = 90;

/**
 * GET /api/patch-movers
 * v0.51 rewrite: biggest per-champion ROLE win-rate shifts between the
 * current populated coachless patch and the previous one, across every lane
 * at once (superseding the old per-lane WPA-swing model — see
 * lib/patchMovers.ts's header for the full rationale).
 *
 * `role` is no longer required -- accepted-but-ignored for a transition
 * period (a stale client/bookmark passing `?role=2` still gets a 200, not a
 * 400) since the response now always covers every lane in one shot.
 *
 * - 200 + { patch, prevPatch, movers[] } when computed → cached hard (24h
 *   SWR), since patch data is immutable once populated. movers capped at ~12.
 * - 200 + { unsupported: true } (no-store) when there's no previous populated
 *   patch to compare against — the UI hides the page. (Prior-patch data IS
 *   available today, so this is a defensive path, not the current state.)
 * - Empty movers → treated as degraded (fetches largely failed) → no-store, so a
 *   transient upstream glitch can't get pinned at the edge (repo Gotcha (b)).
 */
export async function GET() {
  try {
    const result = await computePatchMovers();

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
