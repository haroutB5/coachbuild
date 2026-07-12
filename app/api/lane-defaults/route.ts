import { NextResponse } from "next/server";
import type { ApiError } from "@/lib/types";
import { getLaneDefaults } from "@/lib/laneDefaults";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const defaults = await getLaneDefaults();
    return NextResponse.json(defaults, {
      headers: {
        // Changes at most once per patch — same long cache as /api/champions.
        // NOTE (see lib/laneDefaults.ts COST NOTE): a stone-cold instance
        // computing this for the first time can be slow (up to SWEEP_BUDGET_MS,
        // 20s) — consider a warm-up cron hit rather than relying on organic
        // first-load traffic.
        "Cache-Control": "s-maxage=86400, stale-while-revalidate=604800",
      },
    });
  } catch (err) {
    // getLaneDefaults() itself degrades to STATIC_FALLBACK internally and
    // should not throw — this is defense-in-depth only.
    console.error("[/api/lane-defaults] Unexpected error:", err);
    const body: ApiError = { error: "Internal server error" };
    return NextResponse.json(body, { status: 500 });
  }
}
