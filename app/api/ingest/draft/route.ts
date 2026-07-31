import { NextRequest, NextResponse } from "next/server";
import { isAuthorized } from "@/lib/pro/auth";
import { getSql } from "@/lib/pro/db";
import { DbUnavailableError } from "@/lib/pro/errors";
import { runDraftIngest, getPersistedCursor, setPersistedCursor, type DraftIngestResult } from "@/lib/draft/ingest";
import { getIngestHealth } from "@/lib/ingestHealth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// DEVIATION FROM THE PLAN'S "RECOMMENDED" OPTION (documented, plan §2d/2e
// explicitly sanctions this fallback: "document single-tick-per-cron
// otherwise"): the plan's preferred design is a self-chaining cron that
// fires an internal fetch to itself with an incrementing cursor/hop count
// and a hard cap. That pattern needs a way to keep doing work AFTER this
// invocation's own response is sent (so hop 2+ doesn't just re-nest inside
// hop 1's same 60s budget) — Vercel's primitive for that is
// `waitUntil` from the `@vercel/functions` package, which is NOT a
// dependency of this project today. Adding it just for this route was out
// of scope for this ship.
//
// Instead: this route loops runDraftIngest IN-PROCESS, cursor advancing
// each iteration, until either the walk finishes (nextCursor === null) or a
// wall-clock budget is hit — same idea as the plan's self-chain (more than
// one batch per cron invocation), without a second HTTP round-trip or a new
// dependency. ~9 champs/batch at ~3s/champ (2 paced requests each) means
// WALL_CLOCK_BUDGET_MS below fits roughly 4-5 batches (~40 champs) per
// cron tick — a full ~170-champion walk finishes in about 4-5 daily ticks,
// well inside the 14-day patch cadence. fastFailOnRatelimit is threaded
// through (same as /api/ingest/prostage) so a sustained block on one
// champion can't eat the whole budget retrying.
const WALL_CLOCK_BUDGET_MS = 45_000; // ~15s headroom under maxDuration=60

// AUDIT P1-2 FIX (2026-07-21): this route used to always start at cursor=0
// with no persisted state — vercel.json's daily cron never passes a
// `?cursor=`, so every single invocation restarted the walk from scratch,
// processed its first ~40-champion slice, and threw away `nextCursor`
// entirely. The feature would strand on that partial pool forever (a mid-
// ingest new patch's `resolveServingPatch` picks the newest patch present
// regardless of completeness — see lib/draft/recommend.ts). Fixed via a
// one-row state table (coachbuild.draft_ingest_cursor,
// migrations/0010_draft_audit_patches.sql): when no `?cursor=` is given
// (the real cron path), the route reads the persisted cursor, runs the
// same bounded loop as before, then writes back wherever it ended up
// (wrapping to 0 on a completed walk, for the next patch's fresh start). An
// EXPLICIT `?cursor=` (manual/debug driving) is used verbatim and never
// touches the persisted state — it can't be knocked off course by, or
// interfere with, the cron's own automatic progression.
export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const cursorParam = searchParams.get("cursor");
  if (cursorParam && !/^\d+$/.test(cursorParam)) {
    return NextResponse.json({ error: "Invalid cursor param" }, { status: 400 });
  }
  const explicitCursor = cursorParam !== null;

  try {
    const sql = getSql();
    if (!sql) throw new DbUnavailableError();

    let cursor: number | null = explicitCursor ? parseInt(cursorParam!, 10) : await getPersistedCursor(sql);

    const started = Date.now();
    const batches: DraftIngestResult[] = [];

    do {
      const result = await runDraftIngest({ cursor, fastFailOnRatelimit: true });
      batches.push(result);
      cursor = result.nextCursor;
    } while (cursor !== null && Date.now() - started < WALL_CLOCK_BUDGET_MS);

    if (!explicitCursor) {
      await setPersistedCursor(sql, cursor ?? 0);
    }

    const errors = batches.flatMap((b) => b.errors);
    if (errors.length > 0) {
      console.error("[draft-ingest-cron] ingest errors:", errors);
    }

    // 2026-07-31 audit P2 (#2) — this cron is ALSO Cloudflare-blocked from
    // reaching u.gg on Vercel's egress; the real production ingest runs from
    // this box via Scheduled Task CoachBuildDraftIngest
    // (scripts/ingest-draft.mjs), which persists its own last-run status.
    // Surfaced here best-effort, never blocking the response — the Draft
    // page (lib/draft/recommend.ts's meta) is the primary user-facing home
    // for this fact; this is the operator-facing one.
    const lastScheduledRun = await getIngestHealth(sql, "draft").catch(() => null);

    return NextResponse.json({
      patch: batches.at(-1)?.patch ?? null,
      batchesRun: batches.length,
      champsProcessed: batches.reduce((sum, b) => sum + b.champCount, 0),
      rowsUpserted: batches.reduce((sum, b) => sum + b.rowsUpserted, 0),
      statsUpserted: batches.reduce((sum, b) => sum + b.statsUpserted, 0),
      skippedRows: batches.reduce((sum, b) => sum + b.skippedRows, 0),
      retentionRan: batches.some((b) => b.retentionRan),
      nextCursor: cursor,
      persistedCursor: !explicitCursor,
      errorCount: errors.length,
      lastScheduledRun,
    });
  } catch (err) {
    if (err instanceof DbUnavailableError) {
      return NextResponse.json({ error: "DATABASE_URL not configured" }, { status: 503 });
    }
    console.error("[/api/ingest/draft] Unexpected error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
