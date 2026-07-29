// ─────────────────────────────────────────────────────────────────────────────
// lib/retryTransport.ts — generic bounded retry-with-backoff for any async
// operation (an HTTP transport call, a higher-level fetch+decode call, etc).
// Added 2026-07-29 to fix two separate scheduled-ingest failures that were
// each growing their own bespoke one-off retry:
//   - scripts/ingest-draft.mjs: 12 champions failing "curl transport failed
//     (exit 28)" (timeout) against u.gg's stats2 CDN on the 2026-07-27 run.
//   - scripts/ingest-prostage.mjs: intermittent "CargoExport returned a
//     non-JSON response (Cloudflare challenge?)" against Leaguepedia, 2 of 4
//     scheduled runs on 2026-07-29 — its existing single 10s-delayed retry
//     (see git history of scripts/ingest-prostage.mjs) wasn't always enough.
// Both are the SAME shape (a bounded retry, finite delays, never a tight
// loop) applied to different failure classes and different endpoints, so
// this is one tested utility instead of two divergent copies. See each call
// site for why its specific delaysMs/shouldRetry was chosen — this file
// makes no assumption about what's "enough" for any particular endpoint.
//
// Deliberately NOT a general-purpose "retry anything forever" helper:
// `delaysMs` is a finite, explicit array. A caller that wants "propagate
// immediately, no retry" just doesn't use this at all — see e.g.
// lib/prostage/cargo.ts's cargoQueryWithRetry, which has its OWN mandated
// (and much longer, ~4.5min) ratelimit-cooldown-retry-once contract for
// api.php specifically. This helper is unrelated to that contract and must
// never be used to reimplement or loosen it.
// ─────────────────────────────────────────────────────────────────────────────

export interface RetryOptions {
  /** Delay (ms) before each retry attempt. Length = number of retries, so
   *  total attempts = delaysMs.length + 1. Defaults to two retries (three
   *  total attempts): 5s, then 15s. */
  delaysMs?: number[];
  /** Decide whether a given error is worth retrying at all. Defaults to
   *  "retry any error" — pass this when only a specific failure shape
   *  (e.g. a particular error class) should be retried, so an unrelated bug
   *  (a programming error, a DB error) doesn't silently get masked behind a
   *  multi-attempt retry loop before finally surfacing. */
  shouldRetry?: (err: unknown) => boolean;
  /** Fired just before each retry's delay — callers use this for progress
   *  logging (never required for correctness). `attempt` is 1-indexed
   *  (the retry about to happen, not the attempt that just failed). */
  onRetry?: (attempt: number, err: unknown, delayMs: number) => void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Runs `fn`, retrying on failure per `opts`. Any error not matched by
 * `shouldRetry` (default: everything matches) propagates immediately
 * without consuming a retry. Once every attempt (1 + delaysMs.length) has
 * been exhausted, the LAST error is thrown — never silently swallowed into
 * a fallback value.
 */
export async function retryWithBackoff<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const delays = opts.delaysMs ?? [5_000, 15_000];
  const shouldRetry = opts.shouldRetry ?? (() => true);

  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      const isLastAttempt = attempt === delays.length;
      if (isLastAttempt || !shouldRetry(err)) throw err;
      const delayMs = delays[attempt];
      opts.onRetry?.(attempt + 1, err, delayMs);
      await sleep(delayMs);
    }
  }
}

/**
 * Convenience wrapper for the common case: a `(url: string) => Promise<string>`
 * transport (matches both lib/draft/ugg.ts's UggTransport and
 * lib/prostage/cargo.ts's CargoExportTransport shapes) wrapped so every call
 * through it gets the retry policy applied automatically. Equivalent to
 * calling `retryWithBackoff(() => transport(url), opts)` at every call site
 * by hand.
 */
export function withRetryTransport(
  transport: (url: string) => Promise<string>,
  opts: RetryOptions = {}
): (url: string) => Promise<string> {
  return (url: string) => retryWithBackoff(() => transport(url), opts);
}
