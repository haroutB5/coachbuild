// ─────────────────────────────────────────────────────────────────────────────
// lib/prostage/timelineBackoff.ts — pure constants/helpers for
// app/api/prostage/timeline/route.ts's cooldown/claim mechanism (2026-07-26
// audit P1-3 security fix — see that route's header for the full mechanism).
//
// Split out of the route module because Next.js's generated route-type
// checker (.next/types/app/**/route.ts) rejects any export from a route file
// other than the small whitelisted set (GET/POST/config/runtime/dynamic/...)
// — a test-only export fails `tsc --noEmit` there, so pure/testable pieces
// live here like every other piece of route logic, and the route just
// imports them.
// ─────────────────────────────────────────────────────────────────────────────

// Claim lease — how long an in-progress compute holds the game before another
// request is allowed to attempt it. Kept a bit above the route's
// maxDuration=30 so a request that legitimately completes right at the wire
// never races its own claim.
export const CLAIM_LEASE_SEC = 45;

// Exponential backoff after a `transient` result: 60s, 120s, 240s, ... capped
// at 1h. Deliberately NOT the same short window as the claim lease — a
// transient failure (feed outage, schedule paging budget, etc.) is far more
// likely to still be broken 45s later than a normal walk is to still be
// running 45s later.
const BACKOFF_BASE_SEC = 60;
const BACKOFF_CAP_SEC = 3_600;

/** attemptCount is the count AFTER incrementing for the failure that just
 *  happened (i.e. always >= 1). Pure, exported for direct unit testing. */
export function computeBackoffSeconds(attemptCount: number): number {
  const n = Math.max(1, attemptCount);
  return Math.min(BACKOFF_BASE_SEC * 2 ** (n - 1), BACKOFF_CAP_SEC);
}

export function retryAfterHeaders(seconds: number): HeadersInit {
  return { "Retry-After": String(Math.max(1, Math.ceil(seconds))) };
}
