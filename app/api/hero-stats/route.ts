import { NextRequest, NextResponse } from "next/server";
import type { ApiError } from "@/lib/types";
import { getHeroStats } from "@/lib/heroStats";
import { resolveRankBracket } from "@/lib/rankBrackets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VALID_LANES = new Set(["top", "jungle", "mid", "bot", "support"]);

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);

  const champParam = searchParams.get("champ");
  const laneParam = searchParams.get("lane");

  if (!champParam || !laneParam) {
    const body: ApiError = { error: "Missing required query params: champ, lane" };
    return NextResponse.json(body, { status: 400 });
  }
  if (!/^\d+$/.test(champParam)) {
    const body: ApiError = { error: "Invalid champ param" };
    return NextResponse.json(body, { status: 400 });
  }
  if (!VALID_LANES.has(laneParam)) {
    const body: ApiError = {
      error: "Invalid lane (must be one of top, jungle, mid, bot, support)",
    };
    return NextResponse.json(body, { status: 400 });
  }
  const champId = parseInt(champParam, 10);

  // P1-1 fix (2026-07-25 audit): thread the rank bracket through, same
  // contract as /api/build's own `rank` param. Absent/'' resolves to the
  // DEFAULT bracket (Diamond+, [6,7,8,9]) via resolveRankBracket, so
  // getMostPlayedLane's no-rank-arg calls (heroContracts.ts) get the same
  // sample as everything else. An unknown or RETIRED id is a client error
  // (400), matching /api/build's posture.
  const rankParam = searchParams.get("rank");
  const bracket = resolveRankBracket(rankParam);
  if (bracket === null) {
    const body: ApiError = { error: "Invalid rank bracket" };
    return NextResponse.json(body, { status: 400 });
  }

  try {
    const stats = await getHeroStats(champId, laneParam, { leagueTiers: bracket.apiValue });
    const { winRatePct, gamesCount, degraded } = stats;
    // P1 fix (2026-07-17 Fable review): getHeroStats degrades ANY upstream
    // failure to the SAME {null, null} shape genuine no-data uses — this
    // route used to CDN-cache both identically at s-maxage=21600, so a
    // transient coachless blip pinned the empty win-rate banner (AND the
    // 5-parallel most-played-lane sweep, which reads THIS route) for 6h per
    // PoP. Never cache a degraded OR partial-null result — genuine nulls are
    // cheap to recompute, so no-store costs nothing on the happy path and
    // buys immediate self-healing on the unhappy one (CLAUDE.md gotcha (b)).
    const isHealthy = !degraded && winRatePct !== null && gamesCount !== null;
    const body = { winRatePct, gamesCount }; // wire shape stays exactly {winRatePct, gamesCount} — degraded never leaks to the client
    return NextResponse.json(body, {
      headers: {
        "Cache-Control": isHealthy
          ? "s-maxage=21600, stale-while-revalidate=86400" // same cadence as /api/build — champ+lane WPA data only moves per patch
          : "no-store",
      },
    });
  } catch (err) {
    console.error("[/api/hero-stats] Unexpected error:", err);
    const body: ApiError = { error: "Internal server error" };
    return NextResponse.json(body, { status: 500 });
  }
}
