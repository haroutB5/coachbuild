import { NextRequest, NextResponse } from "next/server";
import { isAuthorized } from "@/lib/pro/auth";
import { DbUnavailableError, RiotUnavailableError } from "@/lib/pro/errors";
import { runMyStatsIngest } from "@/lib/mystats/ingest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Cron-invoked (vercel.json, see that file's header comment for WHY this
// time slot) with no query params -> always "incremental" mode (today's new
// games only, see lib/mystats/ingest.ts's header). `mode=backfill` is for
// manual/debug driving only — scripts/ingest-mystats.mjs is the normal way
// to run a backfill, since it can loop until done in one long-running
// process without a 60s serverless budget; this route accepting the mode
// too is just for parity/manual poking, one page per call.
export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const modeParam = searchParams.get("mode");
  const mode = modeParam === "backfill" ? "backfill" : "incremental";

  const startParam = searchParams.get("start");
  if (startParam && !/^\d+$/.test(startParam)) {
    return NextResponse.json({ error: "Invalid start param" }, { status: 400 });
  }
  const pageSizeParam = searchParams.get("pageSize");
  if (pageSizeParam && !/^\d+$/.test(pageSizeParam)) {
    return NextResponse.json({ error: "Invalid pageSize param" }, { status: 400 });
  }

  try {
    const result = await runMyStatsIngest({
      mode,
      start: startParam ? parseInt(startParam, 10) : undefined,
      pageSize: pageSizeParam ? parseInt(pageSizeParam, 10) : undefined,
    });
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    if (err instanceof DbUnavailableError) {
      return NextResponse.json({ error: "DATABASE_URL not configured" }, { status: 503 });
    }
    if (err instanceof RiotUnavailableError) {
      return NextResponse.json({ error: "RIOT_API_KEY not configured" }, { status: 503 });
    }
    console.error("[/api/ingest/mystats] Unexpected error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
