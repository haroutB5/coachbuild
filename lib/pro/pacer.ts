// ─────────────────────────────────────────────────────────────────────────────
// lib/pro/pacer.ts — process-wide serialized pacer for Riot API calls.
// Riot limits: 20 req/s AND 100 req/2min per key. Serializing every call at a
// minimum interval keeps us well under both (1.3s -> ~46/min, floor is 50/min).
// Module-level state -> shared across every caller in the process, which is
// exactly what "process-wide" ingest needs (roster + match ingest both call
// through this single queue).
// ─────────────────────────────────────────────────────────────────────────────

const MIN_INTERVAL_MS = 1300;

let chain: Promise<unknown> = Promise.resolve();
let lastCallAt = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Runs `fn` no sooner than MIN_INTERVAL_MS after the previous paced call
 *  resolved (success or failure — a failed call still consumed a request). */
export function pacedCall<T>(fn: () => Promise<T>): Promise<T> {
  const run = async (): Promise<T> => {
    const wait = Math.max(0, lastCallAt + MIN_INTERVAL_MS - Date.now());
    if (wait > 0) await sleep(wait);
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

/** Test/script-only escape hatch: resets the shared pacer clock. */
export function __resetPacerForTests(): void {
  chain = Promise.resolve();
  lastCallAt = 0;
}
