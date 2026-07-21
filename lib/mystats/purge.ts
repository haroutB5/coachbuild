// ─────────────────────────────────────────────────────────────────────────────
// lib/mystats/purge.ts — season-boundary purge orchestration for
// coachbuild.my_matches, extracted out of scripts/purge-mystats-preseason.mjs
// so it's testable with a mocked sql (same "queries in an orchestration
// function, script just calls + prints" split as lib/mystats/ingest.ts).
//
// IDEMPOTENT BY CONSTRUCTION: the DELETE's WHERE clause re-evaluates
// game_creation < SEASON_START_MS against whatever rows currently exist — a
// second run simply finds nothing left to delete (rowsDeleted: 0) rather
// than erroring or double-counting, and the cursor reset is a plain
// INSERT ... ON CONFLICT DO UPDATE (safe to run any number of times).
// ─────────────────────────────────────────────────────────────────────────────

import type { getSql } from "@/lib/pro/db";
import { SEASON_START_MS, SEASON_PATCH_PREFIX, checkSeasonAnomaly, type MySeasonCheckRow } from "./season";

export interface SeasonAnomaly extends MySeasonCheckRow {
  reason: string;
}

export interface SeasonPurgeResult {
  seasonStartIso: string;
  rowsBefore: number;
  rowsDeleted: number;
  rowsKept: number;
  /** Count of remaining rows whose patch does NOT start with
   *  SEASON_PATCH_PREFIX — should always be 0 after a clean purge; a
   *  non-zero count means game_creation and patch disagree on at least one
   *  surviving row (see `anomalies` for the specific rows). */
  offPatchRemaining: number;
  /** Every row (before the delete) where game_creation and patch disagreed
   *  on which side of the season boundary it falls — reported, never acted
   *  on (game_creation alone decides keep/purge). */
  anomalies: SeasonAnomaly[];
}

interface RawMatchRow {
  match_id: string;
  game_creation: string;
  patch: string;
}

export async function runSeasonPurge(sql: NonNullable<ReturnType<typeof getSql>>): Promise<SeasonPurgeResult> {
  const before = (await sql`
    SELECT match_id, game_creation, patch FROM coachbuild.my_matches
  `) as unknown as RawMatchRow[];

  const anomalies: SeasonAnomaly[] = [];
  for (const r of before) {
    const row: MySeasonCheckRow = { matchId: r.match_id, gameCreation: r.game_creation, patch: r.patch };
    const reason = checkSeasonAnomaly(row);
    if (reason) anomalies.push({ ...row, reason });
  }

  const seasonStartIso = new Date(SEASON_START_MS).toISOString();
  const deleted = (await sql`
    DELETE FROM coachbuild.my_matches WHERE game_creation < ${seasonStartIso}::timestamptz
    RETURNING match_id
  `) as unknown as { match_id: string }[];

  const remainingRows = (await sql`SELECT count(*)::int AS n FROM coachbuild.my_matches`) as unknown as { n: number }[];
  const offPatchRows = (await sql`
    SELECT count(*)::int AS n FROM coachbuild.my_matches WHERE patch NOT LIKE ${SEASON_PATCH_PREFIX + "%"}
  `) as unknown as { n: number }[];

  // See this file's header re: why the cursor resets after a purge.
  await sql`
    INSERT INTO coachbuild.my_ingest_cursor (id, next_start, backfill_done, updated_at)
    VALUES (1, 0, false, now())
    ON CONFLICT (id) DO UPDATE SET next_start = 0, backfill_done = false, updated_at = now()
  `;

  return {
    seasonStartIso,
    rowsBefore: before.length,
    rowsDeleted: deleted.length,
    rowsKept: remainingRows[0]?.n ?? 0,
    offPatchRemaining: offPatchRows[0]?.n ?? 0,
    anomalies,
  };
}
