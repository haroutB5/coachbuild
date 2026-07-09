import { NextRequest, NextResponse } from "next/server";
import { isAuthorized } from "@/lib/pro/auth";
import { DbUnavailableError, RiotUnavailableError } from "@/lib/pro/errors";
import { runMatchIngest } from "@/lib/pro/ingestMatches";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Chunked for serverless timeouts: ?cursor=<offset>&batch=<n> processes n
// accounts per invocation (default 5) and returns the next cursor to call
// with. A Vercel Hobby-plan cron can only fire once/day (see vercel.json) —
// finer cadence for draining the full account list comes from an external
// pinger looping this endpoint with the returned cursor until it's null.
export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const cursorParam = searchParams.get("cursor");
  const batchParam = searchParams.get("batch");

  if ((cursorParam && !/^\d+$/.test(cursorParam)) || (batchParam && !/^\d+$/.test(batchParam))) {
    return NextResponse.json({ error: "Invalid cursor or batch param" }, { status: 400 });
  }
  const cursor = cursorParam ? parseInt(cursorParam, 10) : 0;
  const batch = batchParam ? Math.min(parseInt(batchParam, 10), 20) : 5;

  try {
    const result = await runMatchIngest({ cursor, batch });
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof DbUnavailableError) {
      return NextResponse.json({ error: "DATABASE_URL not configured" }, { status: 503 });
    }
    if (err instanceof RiotUnavailableError) {
      return NextResponse.json({ error: "RIOT_API_KEY not configured" }, { status: 503 });
    }
    console.error("[/api/ingest/matches] Unexpected error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
