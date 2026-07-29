// ─────────────────────────────────────────────────────────────────────────────
// lib/pro/sweepOutcome.ts — PURE: does a finished solo-queue sweep count as a
// failure?
//
// WHY (2026-07-29). scripts/ingest-matches.mjs ended with
// `if (allErrors.length > 0) process.exitCode = 1`. The 12:20 run walked all
// 1,445 qualifying accounts, upserted 200 matches, and skipped 15 accounts on
// transient Riot 429s — a healthy run by any reading — and reported exit 1 to
// Task Scheduler, identical to a run where the key was dead and nothing
// happened at all. A signal that fires on both is not a signal, and the real
// consequence is that nobody looks at it: the 07:10 run had failed the same way
// and it took a human reading the log to find out why.
//
// So the verdict is graded. Kept pure and separate from the script so the
// thresholds are testable and so "what counts as broken" is one reviewable
// decision rather than a condition buried in a runner.
// ─────────────────────────────────────────────────────────────────────────────

export interface SweepTotals {
  /** Accounts the walk actually visited. */
  accountsProcessed: number;
  /** Matches written. Deliberately NOT part of the verdict — a sweep that
   *  finds no new games is the normal steady state, not a failure. */
  matchesUpserted: number;
  /** Per-account errors accumulated across every batch. */
  errorCount: number;
  /** The walk stopped early because Riot kept rate-limiting after its own
   *  Retry-After was honoured. */
  rateLimited: boolean;
}

export interface SweepVerdict {
  exitCode: 0 | 1;
  /** One line, written to the log so Task Scheduler's exit code is never the
   *  only evidence of what happened. */
  reason: string;
}

/** Below this many errors a run is never failed on error COUNT alone,
 *  regardless of how few accounts it visited. A handful of accounts erroring
 *  (deleted account, unmapped region, a Riot blip) is the normal background
 *  rate of a 1,400-account walk. */
export const SWEEP_ERROR_FLOOR = 25;

/** Above this FRACTION of visited accounts, errors stop being background noise
 *  and start being a broken run. 5% of 1,445 is ~73 accounts — well clear of
 *  the 15 seen on a healthy run, well under the several hundred a genuine
 *  outage produces. */
export const SWEEP_ERROR_FRACTION = 0.05;

/** The error count at or below which a run of this size is still healthy. */
export function sweepErrorBudget(accountsProcessed: number): number {
  return Math.max(SWEEP_ERROR_FLOOR, Math.ceil(accountsProcessed * SWEEP_ERROR_FRACTION));
}

export function classifySweep(totals: SweepTotals): SweepVerdict {
  const { accountsProcessed, matchesUpserted, errorCount, rateLimited } = totals;

  // Ordered most-specific first: a rate-limit abort is a real failure even
  // though it usually carries only ONE error, because the walk did not finish
  // and the cause is the one that can suspend the key for the whole app.
  if (rateLimited) {
    return {
      exitCode: 1,
      reason:
        `FAILED: Riot kept rate-limiting after its own Retry-After was honoured — walk aborted ` +
        `after ${accountsProcessed} accounts. Something else is spending RIOT_API_KEY.`,
    };
  }

  if (accountsProcessed === 0) {
    // A zero-account walk is only a failure if something went wrong reaching
    // that state. A genuinely drained walk (every account fetched inside this
    // cycle) legitimately visits nothing.
    return errorCount > 0
      ? { exitCode: 1, reason: `FAILED: no accounts processed and ${errorCount} error(s).` }
      : { exitCode: 0, reason: "OK: nothing to do — every account already fetched this cycle." };
  }

  const budget = sweepErrorBudget(accountsProcessed);
  if (errorCount > budget) {
    return {
      exitCode: 1,
      reason:
        `FAILED: ${errorCount} error(s) across ${accountsProcessed} accounts exceeds the ` +
        `tolerance of ${budget}.`,
    };
  }

  if (errorCount > 0) {
    return {
      exitCode: 0,
      reason:
        `OK: ${accountsProcessed} accounts, ${matchesUpserted} matches, ` +
        `${errorCount} transient error(s) tolerated (budget ${budget}).`,
    };
  }

  return {
    exitCode: 0,
    reason: `OK: ${accountsProcessed} accounts, ${matchesUpserted} matches, no errors.`,
  };
}
