// ─────────────────────────────────────────────────────────────────────────────
// lib/prostage/cargo.ts — client for lol.fandom.com's Cargo API (action=cargoquery).
// Undocumented-adjacent, community-run wiki API — hard-won operational facts
// from a sister project, treat as gospel:
//   - Rate limit is PUNISHING: can trip after ONE call and stay sticky 3+ min.
//   - Serialize every request through one process-wide queue, >=30s apart.
//   - NEVER retry a ratelimited response in a tight loop. On ratelimit: wait
//     ~4.5min, retry ONCE, then propagate whatever happens (success or throw).
//   - A ratelimited/error response must NEVER be cached or recorded as "no
//     data" — callers must let the exception surface, not swallow it into [].
//   - A field requested with an underscore (e.g. "DateTime_UTC") can come
//     back keyed with a SPACE ("DateTime UTC") — read via cargoField().
//
// Data licensed CC BY-SA by Leaguepedia/Fandom — see fronty's UI attribution
// and this note as the code-side acknowledgment.
// ─────────────────────────────────────────────────────────────────────────────

const CARGO_ENDPOINT = "https://lol.fandom.com/api.php";
const USER_AGENT = "CoachBuild/0.7 (personal project; contact via GitHub haroutB5)";
const MIN_INTERVAL_MS = 30_000;
const RATELIMIT_COOLDOWN_MS = 4.5 * 60_000;

export class CargoRateLimitedError extends Error {
  constructor(message = "ratelimited") {
    super(message);
    this.name = "CargoRateLimitedError";
  }
}

export class CargoRequestError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "CargoRequestError";
    this.status = status;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Process-wide serialized pacer — same shape as lib/pro/pacer.ts but a much
// longer floor, because Cargo's limiter is far stricter than Riot's.
let chain: Promise<unknown> = Promise.resolve();
let lastCallAt = 0;

function pacedCargoCall<T>(fn: () => Promise<T>): Promise<T> {
  const run = async (): Promise<T> => {
    const wait = Math.max(0, lastCallAt + MIN_INTERVAL_MS - Date.now());
    if (wait > 0) await sleep(wait);
    lastCallAt = Date.now();
    return fn();
  };
  const scheduled = chain.then(run, run);
  chain = scheduled.then(
    () => undefined,
    () => undefined
  );
  return scheduled;
}

/** Test/script-only escape hatch: resets the shared pacer clock. */
export function __resetCargoPacerForTests(): void {
  chain = Promise.resolve();
  lastCallAt = 0;
}

export interface CargoQueryOptions {
  tables: string;
  fields: string;
  where?: string;
  orderBy?: string;
  limit?: number;
}

interface CargoApiError {
  code?: string;
  info?: string;
}

interface CargoApiResponse<T> {
  error?: CargoApiError;
  cargoquery?: { title: T }[];
}

/** One paced cargoquery call. Throws CargoRateLimitedError on a ratelimit
 *  response, CargoRequestError on any other API/HTTP error — never returns
 *  [] to mask a failure. */
export async function cargoQuery<T = Record<string, string | undefined>>(
  opts: CargoQueryOptions
): Promise<T[]> {
  return pacedCargoCall(async () => {
    const params = new URLSearchParams({
      action: "cargoquery",
      format: "json",
      tables: opts.tables,
      fields: opts.fields,
      limit: String(opts.limit ?? 500),
    });
    if (opts.where) params.set("where", opts.where);
    if (opts.orderBy) params.set("order_by", opts.orderBy);

    const res = await fetch(`${CARGO_ENDPOINT}?${params.toString()}`, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    });
    if (!res.ok) {
      throw new CargoRequestError(`HTTP ${res.status}`, res.status);
    }
    const body = (await res.json()) as CargoApiResponse<T>;
    if (body.error) {
      if (body.error.code === "ratelimited") {
        throw new CargoRateLimitedError(body.error.info ?? "ratelimited");
      }
      throw new CargoRequestError(body.error.info ?? body.error.code ?? "unknown Cargo error");
    }
    return (body.cargoquery ?? []).map((row) => row.title);
  });
}

export interface CargoRetryOptions {
  /** When true, a ratelimited response is propagated IMMEDIATELY instead of
   *  waiting out the ~4.5min cooldown — the ~270s wait is dead weight (worse,
   *  a guaranteed timeout) under a serverless route's 60s maxDuration. Used
   *  by app/api/ingest/prostage/route.ts, where the cron's next scheduled
   *  invocation acts as the retry instead. The script path
   *  (scripts/ingest-prostage.mjs, long-running, no timeout) keeps the full
   *  wait+retry-once behavior — this defaults to false. */
  fastFail?: boolean;
}

/** cargoQuery wrapped with the mandated ratelimit backoff: on a ratelimited
 *  response, wait ~4.5min and retry EXACTLY once (unless `fastFail` is set —
 *  see CargoRetryOptions). Any other error, or a second ratelimit, propagates
 *  to the caller (never silently becomes []). */
export async function cargoQueryWithRetry<T = Record<string, string | undefined>>(
  opts: CargoQueryOptions,
  retryOpts: CargoRetryOptions = {}
): Promise<T[]> {
  try {
    return await cargoQuery<T>(opts);
  } catch (err) {
    if (err instanceof CargoRateLimitedError) {
      if (retryOpts.fastFail) throw err;
      await sleep(RATELIMIT_COOLDOWN_MS);
      return cargoQuery<T>(opts);
    }
    throw err;
  }
}

/** Reads a Cargo field handling the underscore<->space quirk in both
 *  directions — some deployments key the JSON by the requested field name
 *  verbatim, others substitute spaces for underscores (observed live in a
 *  sister project on DateTime_UTC specifically; applied generically here
 *  since it costs nothing and protects any other underscored field). */
export function cargoField(
  row: Record<string, string | undefined>,
  name: string
): string | undefined {
  return row[name] ?? row[name.replace(/_/g, " ")] ?? row[name.replace(/ /g, "_")];
}
