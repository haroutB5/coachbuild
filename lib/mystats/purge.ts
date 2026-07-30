// ─────────────────────────────────────────────────────────────────────────────
// lib/mystats/purge.ts — season/split-boundary purge orchestration for
// coachbuild.my_matches, extracted out of scripts/purge-mystats-preseason.mjs
// so it's testable with a mocked sql (same "queries in an orchestration
// function, script just calls + prints" split as lib/mystats/ingest.ts).
//
// IDEMPOTENT BY CONSTRUCTION: the DELETE's WHERE clause re-evaluates
// game_creation < the purge boundary against whatever rows currently exist —
// a second run simply finds nothing left to delete (rowsDeleted: 0) rather
// than erroring or double-counting, and the cursor reset is an unconditional
// UPDATE to fixed values (safe to run any number of times).
//
// ACCOUNT SCOPE (migration 0020, multi-account): this purge is deliberately
// ACCOUNT-WIDE and stays that way. It is a time-based RETENTION policy, not an
// aggregation — deleting every account's pre-boundary rows is the same
// intention applied uniformly, and it cannot blend one account's numbers into
// another's the way an unscoped SELECT would. `rowsBefore`/`rowsDeleted`/
// `rowsKept` below are therefore totals across every linked account, not the
// active one's. Read them that way.
//
// PURGE BOUNDARY (v0.51, split tagging): the cutoff used to actually DELETE
// rows is now max(SEASON_START_MS, prior-split start) — see
// lib/mystats/season.ts's SPLIT_BOUNDARIES/priorSplitStartMs. This ALWAYS
// keeps the current split + the prior split intact (the prior split is what
// the My Stats delta compares against — see lib/mystats/aggregate.ts's
// computePriorSplitWinrate) and only retires data from splits before that.
// Right now (still within split 2) this boundary is numerically IDENTICAL to
// SEASON_START_MS (split 1's start, the only split preceding split 2) — it
// only diverges once a 4th split exists and split 3 becomes current. Both
// `seasonStartIso` (unchanged, back-compat) and the new `purgeBoundaryIso`
// are reported so a caller can tell the two apart once they do diverge.
// ─────────────────────────────────────────────────────────────────────────────

import type { getSql } from "@/lib/pro/db";
import {
  SEASON_START_MS,
  SEASON_PATCH_PREFIX,
  checkSeasonAnomaly,
  priorSplitStartMs,
  type MySeasonCheckRow,
} from "./season";

export interface SeasonAnomaly extends MySeasonCheckRow {
  reason: string;
}

export interface SeasonPurgeResult {
  /** The season boundary constant — UNCHANGED meaning, kept for back-compat.
   *  See `purgeBoundaryIso` for the boundary actually used by this run's
   *  DELETE (the two coincide today; see this file's header). */
  seasonStartIso: string;
  /** The actual DELETE cutoff for this run: max(SEASON_START_MS, prior-split
   *  start). Rows with game_creation before this are purged; the prior split
   *  and everything newer always survive. */
  purgeBoundaryIso: string;
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

export async function runSeasonPurge(
  sql: NonNullable<ReturnType<typeof getSql>>,
  now: () => number = Date.now
): Promise<SeasonPurgeResult> {
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
  // See this file's header — the boundary is never allowed to move EARLIER
  // than SEASON_START_MS (Math.max), so a misconfigured/future split table
  // can never resurrect genuinely pre-season data.
  const purgeBoundaryMs = Math.max(SEASON_START_MS, priorSplitStartMs(now) ?? SEASON_START_MS);
  const purgeBoundaryIso = new Date(purgeBoundaryMs).toISOString();
  const deleted = (await sql`
    DELETE FROM coachbuild.my_matches WHERE game_creation < ${purgeBoundaryIso}::timestamptz
    RETURNING match_id
  `) as unknown as { match_id: string }[];

  const remainingRows = (await sql`SELECT count(*)::int AS n FROM coachbuild.my_matches`) as unknown as { n: number }[];
  const offPatchRows = (await sql`
    SELECT count(*)::int AS n FROM coachbuild.my_matches WHERE patch NOT LIKE ${SEASON_PATCH_PREFIX + "%"}
  `) as unknown as { n: number }[];

  // See this file's header re: why the cursor resets after a purge. EVERY
  // account's cursor resets, not just the active one (migration 0020): the
  // DELETE above is deliberately account-WIDE, so leaving a non-active
  // account's cursor claiming backfill_done would strand it with a hole its
  // next backfill would refuse to re-walk.
  await sql`
    UPDATE coachbuild.my_ingest_cursor SET next_start = 0, backfill_done = false, updated_at = now()
  `;

  return {
    seasonStartIso,
    purgeBoundaryIso,
    rowsBefore: before.length,
    rowsDeleted: deleted.length,
    rowsKept: remainingRows[0]?.n ?? 0,
    offPatchRemaining: offPatchRows[0]?.n ?? 0,
    anomalies,
  };
}
