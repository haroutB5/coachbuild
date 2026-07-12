import { NextRequest, NextResponse } from "next/server";
import type { ApiError } from "@/lib/types";
import { getHeroStats } from "@/lib/heroStats";

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

  try {
    const stats = await getHeroStats(champId, laneParam);
    return NextResponse.json(stats, {
      headers: {
        // Same cadence as /api/build — champ+lane WPA data only moves per patch.
        "Cache-Control": "s-maxage=21600, stale-while-revalidate=86400",
      },
    });
  } catch (err) {
    console.error("[/api/hero-stats] Unexpected error:", err);
    const body: ApiError = { error: "Internal server error" };
    return NextResponse.json(body, { status: 500 });
  }
}
