// ─────────────────────────────────────────────────────────────────────────────
// lib/fetchTimeout.ts — single choke point for outbound `fetch` timeouts.
//
// WHY (2026-07-25 audit, P2 security): every hot outbound fetch path in this
// app (lolesports livestats/schedule feed, ddragon, coachless, Riot, lolpros,
// Leaguepedia Cargo) used a bare `fetch(url)` with NO timeout. A hung socket
// on any one of them burned the full route `maxDuration` (30s for the
// prostage timeline walk, 90s for patch-movers) instead of failing fast —
// worse, `/api/prostage/timeline` can issue ~750 such calls in one cold
// request (see resolveGame.ts/timeline.ts), so one hung socket there could
// alone consume the entire budget that would otherwise cover hundreds of
// other calls.
//
// Route every new/edited hot-path fetch through this helper instead of
// re-adding the same 3-line AbortController dance at each call site.
// ─────────────────────────────────────────────────────────────────────────────

/** Default timeout for a general outbound call — generous enough that a
 *  genuinely slow-but-alive upstream still succeeds, tight enough that a
 *  hung socket can't eat a whole route budget on its own. */
export const DEFAULT_FETCH_TIMEOUT_MS = 8_000;

/** Tighter timeout for paths that fan out to many small calls in one request
 *  (the prostage timeline details/window walk — up to ~750 calls in one cold
 *  request) — a single slow call there should fail fast enough that the
 *  bounded concurrency + retry budget still has room to move on. */
export const FAST_FETCH_TIMEOUT_MS = 4_000;

/**
 * `fetch` with an enforced timeout. If `init.signal` is already set (e.g. a
 * caller-supplied abort for its own reasons), that signal is still honoured —
 * this adds a second, independent abort trigger on top of it rather than
 * replacing it, so an existing caller-controlled cancellation keeps working
 * exactly as before.
 */
export function fetchWithTimeout(
  input: string,
  init: RequestInit = {},
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new DOMException(`fetch timed out after ${timeoutMs}ms`, "TimeoutError"));
  }, timeoutMs);

  const callerSignal = init.signal;
  if (callerSignal) {
    if (callerSignal.aborted) controller.abort(callerSignal.reason);
    else callerSignal.addEventListener("abort", () => controller.abort(callerSignal.reason), { once: true });
  }

  return fetch(input, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
}
