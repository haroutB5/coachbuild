import { NextResponse } from "next/server";
import { getSql } from "@/lib/pro/db";
import { runMyStatsRefresh } from "@/lib/mystats/refresh";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Worst case (first-ever check, or a long time since the last one): up to
// INCREMENTAL_PAGE_SIZE=30 new match ids, each costing one paced
// (lib/pro/pacer.ts, 1.3s/call) getMatch call -- ~40s. Matches
// /api/ingest/mystats's own maxDuration for the same underlying work.
export const maxDuration = 60;

/**
 * POST /api/mystats/refresh — on-demand incremental catch-up, meant to be
 * called once per My Stats page view (components/hextech/MyStatsRefresher.tsx
 * mounts and fires this, NOT wired into app/mystats/page.tsx yet -- see
 * HANDOFF-engy.md for the one-line wiring once the nav redesign lands).
 *
 * Safe to call as often as the client wants: lib/mystats/refresh.ts's
 * REFRESH_COOLDOWN_MS gates how often an actual Riot-hitting incremental
 * ingest runs, server-side, regardless of call volume (see that file's
 * header for the full abuse-safety argument). No CRON_SECRET auth here by
 * design -- this is the whole point, unlike /api/ingest/mystats.
 *
 * Response shapes:
 *  - `{ accountUnresolved: true }` — no resolved personal account yet.
 *  - `{ refreshed: false, skipped: true, reason: "cooldown" }` — called
 *    again before REFRESH_COOLDOWN_MS elapsed; no Riot call made.
 *  - `{ refreshed: true, skipped: false, newGames, latest }` — ran.
 *  - `{ refreshed: false, skipped: false, error: true }` — Riot/DB error;
 *    never a 500, the page keeps showing its already-cached summary.
 *
 * `no-store` unconditionally -- same private-per-user-data posture as every
 * other /api/mystats/* route (CLAUDE.md gotcha (b)).
 */
export async function POST() {
  const sql = getSql();
  if (!sql) {
    return NextResponse.json({ error: "DATABASE_URL not configured" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }

  const result = await runMyStatsRefresh(sql);
  return NextResponse.json(result, { status: 200, headers: { "Cache-Control": "no-store" } });
}
