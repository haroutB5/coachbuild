// ─────────────────────────────────────────────────────────────────────────────
// lib/pro/pacer.ts — process-wide serialized pacer for Riot API calls.
//
// Riot limits: 20 req/s AND 100 req/2min per key (live header, 2026-07-29:
// `x-app-rate-limit: 100:120,20:1`). Serializing every call at a minimum
// interval keeps us under both (1.3s -> 93 calls per 120s worst case, 93% of
// the 2-minute bucket). Module-level state -> shared across every caller in the
// process, which is exactly what "process-wide" ingest needs (roster + match
// ingest both call through this single queue).
//
// ── THE FIXED INTERVAL IS NOT ENOUGH ON ITS OWN (2026-07-29) ────────────────
// The 12:20 solo-queue sweep took 15 x 429 across ~1,850 calls. The interval
// was working — measured rate over the whole run was ~91 calls/120s, right on
// the 1.3s floor. The failure was that this module was OPEN-LOOP:
//
//   1. The key is shared, and NOT only with things we can see. lib/otp/
//      riotYield.ts stops a second LOCAL script, but /api/pros/refresh,
//      /api/mystats/refresh, /api/otp/refresh and the /api/ingest/* crons all
//      spend the same RIOT_API_KEY from Vercel, each serverless invocation in
//      its own process with its own fresh copy of this pacer. Nothing local can
//      observe those. At 93% of the cap there is no room for even one of them.
//   2. After a 429 the next call went out 1.3s later regardless. A 429 threw,
//      the caller moved to the next account, and the fixed clock fired again
//      into a bucket Riot had just told us was empty. That is what turned one
//      overshoot into a burst of five consecutive 429s, three times in one run.
//      Rejected requests still count as requests; hammering an exhausted bucket
//      is the documented route from a transient 429 to a SUSPENDED KEY, which
//      blanks every surface in the app (CLAUDE.md gotcha (d)).
//
// So the pacer now has a second, independent gate: a HOLD. Two things set it —
//
//   * holdPacer(ms)              — an explicit backoff, used by lib/pro/riot.ts
//                                  to honour a 429's `Retry-After`. The server
//                                  states the delay; we never guess past it.
//   * observeRateLimitBuckets()  — the closed loop. Every non-429 response's
//                                  `x-app-rate-limit-count` is fed back in, and
//                                  crossing the reserve holds the queue until
//                                  the window is guaranteed to have rolled.
//
// A hold is MONOTONIC — it can only ever be extended, never shortened. Two
// callers racing to back off must not be able to talk each other out of it, and
// a late-arriving smaller backoff must not shorten a larger one already agreed.
// ─────────────────────────────────────────────────────────────────────────────

import { bucketOverReserve, peakCallsPerWindow, type RateBucket } from "./rateLimits";

export const MIN_INTERVAL_MS = 1300;

/**
 * How many requests of headroom to leave under each bucket's cap before this
 * process stops making calls.
 *
 * MUST stay strictly below `limit - peakCallsPerWindow(MIN_INTERVAL_MS, window)`
 * for every real bucket, or the pacer trips on its OWN traffic and throttles
 * itself to a crawl with nothing actually wrong. For Riot's `100:120` that
 * ceiling is 100 - 93 = 7, so 5 leaves a genuine margin on both sides: we trip
 * at 95, which this process alone (peak 93) cannot reach. Pinned by a test —
 * this is the number that decides whether the safety mechanism is a safety
 * mechanism or a self-inflicted outage.
 */
export const RATE_LIMIT_RESERVE = 5;

/** Ceiling on any single hold. A malformed Retry-After or a bucket we have
 *  misread must not be able to wedge a scheduled job indefinitely; the sweep
 *  runs 6-hourly, so anything past 10 minutes is better handled by failing the
 *  run loudly than by sleeping through the slot. */
export const MAX_HOLD_MS = 600_000;

let chain: Promise<unknown> = Promise.resolve();
let lastCallAt = 0;
/** Epoch ms before which no paced call may run. 0 = no hold. */
let holdUntil = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Block every paced call for at least `ms` from now.
 *
 * Monotonic: extends an existing hold, never shortens it. Clamped to
 * MAX_HOLD_MS. Returns the effective absolute deadline so a caller can log what
 * it actually agreed to rather than what it asked for.
 */
export function holdPacer(ms: number): number {
  if (!Number.isFinite(ms) || ms <= 0) return holdUntil;
  const deadline = Date.now() + Math.min(ms, MAX_HOLD_MS);
  if (deadline > holdUntil) holdUntil = deadline;
  return holdUntil;
}

/** Milliseconds remaining on the current hold (0 when not held). Exported for
 *  logging and for tests that must assert a hold WITHOUT sleeping through it. */
export function pacerHoldRemainingMs(now: number = Date.now()): number {
  return Math.max(0, holdUntil - now);
}

/**
 * Feed Riot's live bucket usage back into the pacer.
 *
 * When any bucket has crossed its reserve, hold for the FULL window length.
 * That looks blunt, and it is deliberate: the headers report how much of a
 * window is spent but not when the window STARTED, so the only delay we can
 * prove is sufficient is one whole window. Guessing shorter would be a backoff
 * that is plausible and wrong, which on this key is worse than not backing off
 * at all — the cost of being too slow is a slower sweep, the cost of being too
 * fast is every surface in the app going blank.
 *
 * Called on non-429 responses only; a 429 carries an authoritative Retry-After
 * and is handled by holdPacer directly in lib/pro/riot.ts.
 */
export function observeRateLimitBuckets(
  buckets: readonly RateBucket[],
  reserve: number = RATE_LIMIT_RESERVE
): RateBucket | null {
  // Per-bucket reserve, not one global number. RATE_LIMIT_RESERVE is sized for
  // Riot's `100:120` app bucket, where this process's own peak (93) sits
  // comfortably under the trip point (95). A SMALLER bucket — a hypothetical
  // per-method `10:10`, where our own peak in the window is 8 — would be
  // permanently over a flat reserve of 5, and the pacer would hold forever on
  // its own traffic with nothing wrong. So each bucket gets the largest reserve
  // that still leaves room for our own worst case, and a bucket we can saturate
  // unaided falls back to reserve 0: hold when genuinely AT the cap, which is
  // always correct, never when merely near it.
  const over = buckets
    .map((bucket) => ({ bucket, reserve: effectiveReserve(bucket, reserve) }))
    .map(({ bucket, reserve: r }) => bucketOverReserve([bucket], r))
    .filter((b): b is RateBucket => b !== null)
    .sort((a, b) => b.windowSec - a.windowSec)[0];
  if (!over) return null;
  holdPacer(over.windowSec * 1000);
  return over;
}

/** The largest reserve for `bucket` that this process cannot trip by itself,
 *  capped at the requested one. Exported so the arithmetic is testable rather
 *  than asserted in a comment. */
export function effectiveReserve(
  bucket: RateBucket,
  requested: number = RATE_LIMIT_RESERVE
): number {
  const ourPeak = peakCallsPerWindow(MIN_INTERVAL_MS, bucket.windowSec);
  const headroom = bucket.limit - ourPeak - 1;
  if (!Number.isFinite(headroom) || headroom <= 0) return 0;
  return Math.min(requested, headroom);
}

/** Runs `fn` no sooner than MIN_INTERVAL_MS after the previous paced call
 *  started, AND no sooner than any hold currently in force (success or failure
 *  — a failed call still consumed a request). */
export function pacedCall<T>(fn: () => Promise<T>): Promise<T> {
  const run = async (): Promise<T> => {
    // Re-evaluated in a loop rather than computed once: a hold can be EXTENDED
    // while this call is already waiting (another in-flight call taking a 429,
    // or a longer backoff agreed after ours), and a single up-front
    // `setTimeout` would sail straight through the extension.
    for (;;) {
      const now = Date.now();
      const wait = Math.max(lastCallAt + MIN_INTERVAL_MS - now, holdUntil - now);
      if (wait <= 0) break;
      await sleep(wait);
    }
    lastCallAt = Date.now();
    return fn();
  };
  const scheduled = chain.then(run, run);
  // Swallow so one caller's rejection never poisons the shared chain for
  // callers scheduled after it.
  chain = scheduled.then(
    () => undefined,
    () => undefined
  );
  return scheduled;
}

/** Test/script-only escape hatch: resets the shared pacer clock AND any hold. */
export function __resetPacerForTests(): void {
  chain = Promise.resolve();
  lastCallAt = 0;
  holdUntil = 0;
}

/** Exported so the reserve invariant above can be asserted rather than
 *  asserted-about-in-a-comment. */
export function pacerPeakCallsPerWindow(windowSec: number): number {
  return peakCallsPerWindow(MIN_INTERVAL_MS, windowSec);
}
