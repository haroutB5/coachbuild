import { NextRequest, NextResponse } from "next/server";
import { isAuthorized } from "@/lib/pro/auth";
import { DbUnavailableError } from "@/lib/pro/errors";
import { runProstageIngest } from "@/lib/prostage/ingest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// One tournament per invocation (see lib/prostage/ingest.ts's timing note —
// Cargo's 30s pacing floor across up to 7 tournaments exceeds a 60s
// maxDuration). ?cursor=<index> processes tournaments[cursor] and returns
// nextCursor; an external pinger loops this endpoint with the returned
// cursor until it's null, same pattern as /api/ingest/matches.
export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const cursorParam = searchParams.get("cursor");
  if (cursorParam && !/^\d+$/.test(cursorParam)) {
    return NextResponse.json({ error: "Invalid cursor param" }, { status: 400 });
  }
  const cursor = cursorParam ? parseInt(cursorParam, 10) : 0;

  try {
    // fastFailOnRatelimit: true — the route's 60s maxDuration can't afford
    // the ~4.5min ratelimit-retry cooldown (worse than dead code, it's a
    // guaranteed timeout mid-wait); a ratelimited call fails immediately and
    // the cron's next scheduled invocation acts as the retry instead. The
    // script path (scripts/ingest-prostage.mjs) keeps the full cooldown.
    const result = await runProstageIngest({ cursor, fastFailOnRatelimit: true });
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof DbUnavailableError) {
      return NextResponse.json({ error: "DATABASE_URL not configured" }, { status: 503 });
    }
    console.error("[/api/ingest/prostage] Unexpected error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
