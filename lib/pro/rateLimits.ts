// ─────────────────────────────────────────────────────────────────────────────
// lib/pro/rateLimits.ts — PURE parsers for Riot's rate-limit response headers.
//
// WHY THIS EXISTS (2026-07-29). lib/pro/pacer.ts paced every Riot call at a
// fixed 1.3s and then threw away the only thing Riot tells us about the state
// of the budget it is pacing against. That made the pacer OPEN-LOOP: it ran at
// ~92% of `x-app-rate-limit: 100:120` forever, could not tell whether anything
// else was spending the same key, and — worse — after a 429 it kept firing into
// an already-exhausted bucket at 1.3s intervals, because a 429 propagated as an
// exception and the next call's wait was computed from the same fixed clock.
// Rejected requests still count as requests to Riot. Repeatedly hammering an
// exhausted bucket is how a transient 429 escalates into a key suspension, and
// a suspended key blanks every surface in the app (CLAUDE.md gotcha (d)).
//
// Everything here is pure string->number parsing so the closed loop in pacer.ts
// is unit-testable without a single network call.
//
// HEADER SHAPES (Riot, observed and documented):
//   x-app-rate-limit          "100:120,20:1"      limit:windowSeconds pairs
//   x-app-rate-limit-count    "93:120,1:1"        count:windowSeconds pairs
//   x-method-rate-limit       same shape, per-endpoint
//   x-method-rate-limit-count same shape
//   retry-after               "5"                 seconds (Riot sends integers)
//   x-rate-limit-type         "application" | "method" | "service"
//
// The `windowSeconds` component is the JOIN KEY between the limit header and
// the count header — never positional order. Riot has changed the order of the
// pairs between endpoints, and a positional zip would silently compare a 1s
// count against a 120s limit, which reads as "miles under the cap" at the exact
// moment you are over it.
// ─────────────────────────────────────────────────────────────────────────────

/** One rate-limit bucket with its live usage, both sides keyed on the same
 *  window length. */
export interface RateBucket {
  /** Requests already spent in the current window, per Riot. */
  count: number;
  /** Cap for this window. */
  limit: number;
  /** Window length in seconds — also the join key between the two headers. */
  windowSec: number;
}

/** A `n:windowSec` pair from either the limit or the count header. */
interface Pair {
  value: number;
  windowSec: number;
}

function parsePairs(header: string | null | undefined): Pair[] {
  if (!header) return [];
  const out: Pair[] = [];
  for (const chunk of header.split(",")) {
    const [rawValue, rawWindow] = chunk.trim().split(":");
    const value = Number(rawValue);
    const windowSec = Number(rawWindow);
    if (!Number.isFinite(value) || !Number.isFinite(windowSec)) continue;
    if (value < 0 || windowSec <= 0) continue;
    out.push({ value, windowSec });
  }
  return out;
}

/**
 * Join a limit header against a count header on their shared window length.
 *
 * A bucket appears in the result ONLY when both headers describe it. A limit
 * with no matching count tells us nothing about usage, and a count with no
 * matching limit has nothing to be compared against — inventing a value for the
 * missing half would be exactly the "plausible but wrong" reading that makes a
 * backoff dangerous, so both are dropped.
 */
export function parseRateBuckets(
  limitHeader: string | null | undefined,
  countHeader: string | null | undefined
): RateBucket[] {
  const limits = parsePairs(limitHeader);
  const counts = parsePairs(countHeader);
  const buckets: RateBucket[] = [];
  for (const limit of limits) {
    const count = counts.find((c) => c.windowSec === limit.windowSec);
    if (!count) continue;
    buckets.push({ count: count.value, limit: limit.value, windowSec: limit.windowSec });
  }
  return buckets;
}

/** Lower bound on a Retry-After we will honour. Riot sends whole seconds and
 *  `0` would mean "retry instantly", which is precisely the behaviour that got
 *  us here. */
export const MIN_RETRY_AFTER_SEC = 1;

/** Upper bound. A malformed or hostile header must not be able to wedge a
 *  scheduled job for hours — 10 minutes is longer than any real Riot backoff
 *  and short enough that the next 6-hourly sweep is unaffected. */
export const MAX_RETRY_AFTER_SEC = 600;

/**
 * `Retry-After` in seconds, or null when the header is absent/unparseable.
 *
 * Riot sends integer seconds. HTTP also permits an absolute date, and some
 * proxies rewrite it that way, so both forms are accepted; the date form is
 * resolved against `now` (injectable for tests) and clamped the same way.
 *
 * Returning null is meaningful: it is "the server did NOT state a delay", which
 * the caller must answer with its own conservative default rather than with
 * zero.
 */
export function parseRetryAfterSec(
  header: string | null | undefined,
  now: number = Date.now()
): number | null {
  if (header == null) return null;
  const text = header.trim();
  if (!text) return null;

  const asNumber = Number(text);
  if (Number.isFinite(asNumber)) {
    if (asNumber < 0) return null;
    return clampRetryAfter(asNumber);
  }

  const asDate = Date.parse(text);
  if (Number.isNaN(asDate)) return null;
  const deltaSec = (asDate - now) / 1000;
  if (deltaSec <= 0) return MIN_RETRY_AFTER_SEC;
  return clampRetryAfter(deltaSec);
}

function clampRetryAfter(sec: number): number {
  return Math.min(MAX_RETRY_AFTER_SEC, Math.max(MIN_RETRY_AFTER_SEC, Math.ceil(sec)));
}

/**
 * Worst-case number of calls ONE process at `minIntervalMs` can put into a
 * window of `windowSec` seconds.
 *
 * This is the arithmetic that sets the safe reserve in pacer.ts. At the 1.3s
 * floor against a 120s window it is 93 — so a reserve of 5 against a limit of
 * 100 (trip at 95) cannot be tripped by this process on its own, and any trip
 * is real evidence of a second spender. A reserve of 8 would trip at 92 and the
 * pacer would throttle itself into the ground every window with nothing wrong.
 *
 * The `+1` is not an off-by-one: a window can contain a call at t=0 AND a call
 * at every subsequent interval boundary up to t=windowSec.
 */
export function peakCallsPerWindow(minIntervalMs: number, windowSec: number): number {
  if (minIntervalMs <= 0) return Number.POSITIVE_INFINITY;
  return Math.floor((windowSec * 1000) / minIntervalMs) + 1;
}

/**
 * The bucket closest to exhaustion that has already crossed its reserve, or
 * null when every bucket still has headroom.
 *
 * `reserve` is an ABSOLUTE number of requests, not a fraction, because the
 * quantity that matters is "how many calls can a second process land before we
 * are over", and that is a count. `Math.max(1, limit - reserve)` keeps the
 * threshold meaningful for a small bucket (Riot's `20:1`) where the reserve
 * would otherwise swallow the whole limit.
 */
export function bucketOverReserve(
  buckets: readonly RateBucket[],
  reserve: number
): RateBucket | null {
  let worst: RateBucket | null = null;
  for (const bucket of buckets) {
    const threshold = Math.max(1, bucket.limit - reserve);
    if (bucket.count < threshold) continue;
    if (worst === null || bucket.windowSec > worst.windowSec) worst = bucket;
  }
  return worst;
}
