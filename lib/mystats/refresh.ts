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
import { getActiveAccount } from "./account";
import { runMyStatsIngest } from "./ingest";
import { COUNTED_QUEUE_IDS } from "./queues";

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

/** PER-ACCOUNT since migration 0020. A shared cooldown would have meant
 *  switching to a second account and immediately finding its refresh blocked by
 *  the FIRST account's clock — for up to 3 minutes, on the one page view where
 *  the user is most likely to be checking whether the switch worked.
 *
 * The check and stamp are one PostgreSQL upsert, not a read followed by a
 * write. Two page views can arrive at the same time; only the request whose
 * conditional upsert returns a row owns the refresh lease. */
async function claimIncrementalAt(
  sql: NonNullable<ReturnType<typeof getSql>>,
  puuid: string,
  at: Date
): Promise<boolean> {
  const cutoff = new Date(at.getTime() - REFRESH_COOLDOWN_MS);
  const rows = (await sql`
    INSERT INTO coachbuild.my_ingest_cursor (puuid, last_incremental_at)
    VALUES (${puuid}, ${at.toISOString()})
    ON CONFLICT (puuid) DO UPDATE
      SET last_incremental_at = EXCLUDED.last_incremental_at
      WHERE coachbuild.my_ingest_cursor.last_incremental_at IS NULL
         OR coachbuild.my_ingest_cursor.last_incremental_at <= ${cutoff.toISOString()}
    RETURNING puuid
  `) as unknown as { puuid: string }[];
  return rows.length > 0;
}

/** A failed attempt must not pin the cooldown: release only the exact lease
 *  this request acquired, so a later page view can retry. */
async function releaseIncrementalClaim(
  sql: NonNullable<ReturnType<typeof getSql>>,
  puuid: string,
  at: Date
): Promise<void> {
  await sql`
    UPDATE coachbuild.my_ingest_cursor
    SET last_incremental_at = NULL
    WHERE puuid = ${puuid} AND last_incremental_at = ${at.toISOString()}
  `;
}

export type MyStatsRefreshResult =
  | { accountUnresolved: true }
  | { refreshed: false; skipped: true; reason: "cooldown" }
  | {
      refreshed: true;
      skipped: false;
      newGames: number;
      latest: string | null;
      /** Is this account's season-window history fully walked after this run?
       *  Passed straight through from the ingest (lib/mystats/ingest.ts's
       *  `historyComplete`) rather than re-derived, so there is one answer.
       *  FALSE means every figure on the My Stats page is currently computed over
       *  a PARTIAL history — which is why it is on the wire at all. */
      historyComplete: boolean;
      /** Why the walk stopped short, or null. See ingest.ts's `truncatedBy`. */
      truncatedBy: string | null;
    }
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
  let account: Awaited<ReturnType<typeof getActiveAccount>>;
  try {
    account = await getActiveAccount(sql);
  } catch {
    // The endpoint's contract is fail-soft even when the cheap guard query
    // itself is unavailable; do not turn a transient DB outage into a 500.
    return { refreshed: false, skipped: false, error: true };
  }
  if (!account) {
    return { accountUnresolved: true };
  }

  const now = new Date();
  let claimed: boolean;
  try {
    claimed = await claimIncrementalAt(sql, account.puuid, now);
  } catch {
    // No lease was acquired when the claim failed, so there is nothing to
    // release. Keep the same stable error shape as an ingest failure.
    return { refreshed: false, skipped: false, error: true };
  }
  if (!claimed) {
    return { refreshed: false, skipped: true, reason: "cooldown" };
  }

  try {
    const result = await runMyStatsIngest({ mode: "incremental" });
    if (result.accountUnresolved) {
      // Resolved a moment ago (read above), gone by the time ingest ran --
      // vanishingly unlikely (this table's id=1 row is never deleted), but
      // stay consistent with the same guard rather than falling through to
      // an error state.
      await releaseIncrementalClaim(sql, account.puuid, now);
      return { accountUnresolved: true };
    }
    // ACCOUNT-SCOPED (migration 0020): unscoped, "your latest game" would be
    // whichever of the user's accounts played most recently -- so a freshly
    // switched account with no games yet would report the OTHER account's last
    // game as its own.
    const latestRows = (await sql`
      SELECT max(game_creation) AS latest
      FROM coachbuild.my_matches
      WHERE puuid = ${account.puuid}
        AND queue_id = ANY(${COUNTED_QUEUE_IDS}::int[])
    `) as unknown as { latest: string | null }[];
    const latest = latestRows[0]?.latest ?? null;
    return {
      refreshed: true,
      skipped: false,
      newGames: result.matchesUpserted,
      latest,
      historyComplete: result.historyComplete,
      truncatedBy: result.truncatedBy,
    };
  } catch {
    try {
      await releaseIncrementalClaim(sql, account.puuid, now);
    } catch {
      // Best-effort release only. The lease expires naturally after the same
      // cooldown window if a DB outage also prevents this cleanup write.
    }
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
