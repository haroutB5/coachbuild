import { NextRequest, NextResponse } from "next/server";
import { isAuthorized } from "@/lib/pro/auth";
import { DbUnavailableError, RiotUnavailableError } from "@/lib/pro/errors";
import { runMatchIngest } from "@/lib/pro/ingestMatches";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Chunked for serverless timeouts: ?cursor=<ISO timestamp>&batch=<n> processes
// n accounts per invocation (default/cron-invoked: 20, the route's own cap)
// and returns the next cursor to call with. A Vercel Hobby-plan cron can only
// fire once/day (see vercel.json) with no query params, so this default IS
// the cron's effective daily batch — finer cadence for draining the full
// account list comes from an external pinger looping this endpoint with the
// returned cursor until it's null.
//
// CURSOR CONTRACT (P2 fix, 2026-07-17 Fable review): `cursor` is a WALK-START
// ISO TIMESTAMP now, not a numeric offset — lib/pro/ingestMatches.ts's header
// comment has the full rationale (the old OFFSET walk skipped ~`batch`
// accounts per page once a page's own writes reordered the underlying
// `ORDER BY last_fetched_at` out from under it). A request with NO `cursor`
// param (the cron's daily invocation) mints a fresh walkStart internally and
// behaves exactly like the old cursor=0 call did for a single un-pinged
// invocation — this route's contract is otherwise unchanged.
//
// 60s budget math (audit 2026-07-13): each account costs 1 paced Riot call
// (getMatchIdsByPuuid) plus 2 paced calls per NEW match (getMatch +
// getMatchTimeline), all serialized through lib/pro/pacer.ts's 1.3s-floor
// queue. A never-fetched account can return up to matchesPerAccount (20, the
// runMatchIngest default) brand-new match ids, so its worst case is
// 1 + 20*2 = 41 calls * 1.3s ~= 53s — nearly the WHOLE 60s maxDuration for a
// single account. A batch of 20 such accounts (~1060s) cannot possibly
// complete in one invocation, and neither could the previous default of 5
// (~266s worst case) if it happened to draw several never-fetched accounts
// back-to-back — which, pre-tiebreaker-fix, was exactly the stuck cohort.
//
// Raised the default to 20 anyway (not throttled down to a "provably safe"
// batch of ~1) because the ingest is idempotent and resumable at the MATCH
// level: inserts are `ON CONFLICT (match_id, puuid) DO NOTHING` and
// ingestOneAccount re-queries `existing` match ids before fetching, so a
// mid-batch timeout only costs the in-flight account's `last_fetched_at`
// bump for that day — already-inserted matches aren't re-fetched, and (with
// the ordering tiebreaker above) that account simply stays at the front of
// the queue and finishes over the following day(s). Net effect: batch=20
// maximizes accounts/day for the common case (incremental re-fetch, few new
// matches) while degrading gracefully — never losing data — on the
// never-fetched worst case.
export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const cursorParam = searchParams.get("cursor");
  const batchParam = searchParams.get("batch");

  if (
    (cursorParam && Number.isNaN(Date.parse(cursorParam))) ||
    (batchParam && !/^\d+$/.test(batchParam))
  ) {
    return NextResponse.json({ error: "Invalid cursor or batch param" }, { status: 400 });
  }
  const batch = batchParam ? Math.min(parseInt(batchParam, 10), 20) : 20;

  try {
    const result = await runMatchIngest({ cursor: cursorParam ?? undefined, batch });
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
