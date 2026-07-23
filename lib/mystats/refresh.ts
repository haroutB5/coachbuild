// ─────────────────────────────────────────────────────────────────────────────
// lib/mystats/refresh.ts — on-demand incremental refresh, triggered by a page
// view (POST /api/mystats/refresh, components/hextech/MyStatsRefresher.tsx)
// rather than only the daily cron (app/api/ingest/mystats/route.ts). Exists
// so "today's games" can show up the moment the user checks My Stats instead
// of waiting for the next 20:00 UTC cron tick.
//
// SAFE-BY-COOLDOWN, not safe-by-obscurity: this endpoint has no auth (unlike
// /api/ingest/mystats's CRON_SECRET gate) because it's meant to be hit by
// every My Stats page view. What makes that safe against Riot-quota abuse
// (CLAUDE.md gotcha (d) — the key's 20/s+100/2min budget is shared across
// EVERY process that calls it) is REFRESH_COOLDOWN_MS below: however many
// times the endpoint is called, at most one incremental ingest actually runs
// per cooldown window. The cooldown clock is stored server-side
// (coachbuild.my_ingest_cursor.last_incremental_at, migration 0013) rather
// than trusted to the client, so it can't be bypassed by refreshing the page
// or clearing local state.
// ─────────────────────────────────────────────────────────────────────────────

import { getSql } from "@/lib/pro/db";
import { getMyAccount } from "./account";
import { runMyStatsIngest } from "./ingest";

/** Named per the brief — 3 minutes. Long enough that a user rapidly
 *  switching tabs back to My Stats can't trigger more than one real ingest
 *  run; short enough that "checked a few minutes apart" still catches a
 *  just-finished game. */
export const REFRESH_COOLDOWN_MS = 3 * 60 * 1000;

/** Pure decision function — kept separate from the DB/ingest orchestration
 *  below so it's trivially unit-testable. `lastAt === null` (never run
 *  before) always elapses. */
export function shouldRunIncremental(lastAt: Date | null, now: Date, cooldownMs: number): boolean {
  if (lastAt === null) return true;
  return now.getTime() - lastAt.getTime() >= cooldownMs;
}

async function getLastIncrementalAt(sql: NonNullable<ReturnType<typeof getSql>>): Promise<Date | null> {
  const rows = (await sql`
    SELECT last_incremental_at FROM coachbuild.my_ingest_cursor WHERE id = 1
  `) as unknown as { last_incremental_at: string | null }[];
  const raw = rows[0]?.last_incremental_at;
  return raw ? new Date(raw) : null;
}

/** Upserts the id=1 cursor row so this works even before a backfill has ever
 *  persisted one (migration 0012 seeds it, but stay defensive — same
 *  ON CONFLICT shape lib/mystats/ingest.ts's persistCursor uses). Only
 *  touches last_incremental_at; next_start/backfill_done keep their
 *  existing values (or DEFAULT on a genuine first insert; backfill mode
 *  owns those columns, not this function). */
async function stampLastIncrementalAt(sql: NonNullable<ReturnType<typeof getSql>>, at: Date): Promise<void> {
  await sql`
    INSERT INTO coachbuild.my_ingest_cursor (id, last_incremental_at)
    VALUES (1, ${at.toISOString()})
    ON CONFLICT (id) DO UPDATE SET last_incremental_at = EXCLUDED.last_incremental_at
  `;
}

export type MyStatsRefreshResult =
  | { accountUnresolved: true }
  | { refreshed: false; skipped: true; reason: "cooldown" }
  | { refreshed: true; skipped: false; newGames: number; latest: string | null }
  | { refreshed: false; skipped: false; error: true };

/** Orchestrates one refresh attempt. Never throws -- a Riot/DB error inside
 *  the ingest call is caught and turned into `{refreshed:false, error:true}`
 *  so the endpoint can never 500 the client; the page keeps showing whatever
 *  /api/mystats/summary already had cached. */
export async function runMyStatsRefresh(sql: NonNullable<ReturnType<typeof getSql>>): Promise<MyStatsRefreshResult> {
  // Cheap DB-only check (no Riot call) -- an account that has never resolved
  // stays that way until the cron/backfill path resolves it. Deliberately
  // NOT ensureMyAccount here: that would attempt a live Riot resolution on
  // every single page view for an unresolved account, with no cooldown
  // protecting it (this guard runs BEFORE the cooldown check below).
  const account = await getMyAccount(sql);
  if (!account) {
    return { accountUnresolved: true };
  }

  const now = new Date();
  const lastAt = await getLastIncrementalAt(sql);
  if (!shouldRunIncremental(lastAt, now, REFRESH_COOLDOWN_MS)) {
    return { refreshed: false, skipped: true, reason: "cooldown" };
  }

  try {
    const result = await runMyStatsIngest({ mode: "incremental" });
    if (result.accountUnresolved) {
      // Resolved a moment ago (read above), gone by the time ingest ran --
      // vanishingly unlikely (this table's id=1 row is never deleted), but
      // stay consistent with the same guard rather than falling through to
      // an error state.
      return { accountUnresolved: true };
    }
    await stampLastIncrementalAt(sql, now);
    const latestRows = (await sql`
      SELECT max(game_creation) AS latest FROM coachbuild.my_matches
    `) as unknown as { latest: string | null }[];
    const latest = latestRows[0]?.latest ?? null;
    return { refreshed: true, skipped: false, newGames: result.matchesUpserted, latest };
  } catch {
    // Fail-soft (per this feature's brief): DbUnavailableError/
    // RiotUnavailableError/any transport throw all collapse to the same
    // client-facing shape -- the cooldown is deliberately NOT stamped here,
    // since the failing call never actually reached Riot in the
    // RiotUnavailableError case (missing key) and a DB outage means the
    // stamp write would fail anyway; letting the next call retry sooner
    // costs nothing extra (still gated by the SAME unstamped cooldown from
    // the last successful run, if any).
    return { refreshed: false, skipped: false, error: true };
  }
}
