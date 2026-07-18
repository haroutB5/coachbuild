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
// cursor until it's null.
//
// NOTE (2026-07-17 Fable review, P3(h) hygiene): this cursor is a plain
// NUMERIC INDEX into the resolved+staleness-ordered tournament list — it is
// NOT the same cursor shape as /api/ingest/matches, whose cursor became a
// WALK-START ISO TIMESTAMP as part of this same review's P2 fix (see
// lib/pro/ingestMatches.ts's header CURSOR CONTRACT). Both routes still
// share the "loop until nextCursor is null" polling pattern — that part of
// the old "same pattern as /api/ingest/matches" comment was accurate and is
// kept below; only the cursor's underlying type differs between the two
// routes now, so don't assume one's cursor value is interchangeable with
// the other's.
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
    // An external pinger loops this endpoint with the returned cursor until
    // it's null — same POLLING pattern as /api/ingest/matches, different
    // cursor TYPE (see the header note above).
    const result = await runProstageIngest({ cursor, fastFailOnRatelimit: true });
    // P3(g) fix (2026-07-17 Fable review): the prostage cron (gotcha (o) in
    // CLAUDE.md) has never landed data in production despite the route
    // itself working on manual invocation — a PLAUSIBLE, UNVERIFIED root
    // cause is that Vercel's egress IPs are Cloudflare-blocked at
    // lol.fandom.com, which would surface as an HTTP 200 with a populated
    // `errors` array (runProstageIngest never throws on a per-tournament
    // Cargo failure — see its try/catch), not as a route-level 5xx. That
    // failure mode was previously INVISIBLE — the route just 200'd silently.
    // Logging the errors array (Vercel captures console.error in its
    // Functions logs) and surfacing an explicit `errorCount` in the JSON
    // response is diagnostic-only — no behavior change — so the NEXT
    // scheduled cron run's logs can actually settle this hypothesis instead
    // of it staying a guess.
    if (result.errors.length > 0) {
      console.error("[prostage-cron] ingest errors:", result.errors);
    }
    return NextResponse.json({ ...result, errorCount: result.errors.length });
  } catch (err) {
    if (err instanceof DbUnavailableError) {
      return NextResponse.json({ error: "DATABASE_URL not configured" }, { status: 503 });
    }
    console.error("[/api/ingest/prostage] Unexpected error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
