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
// ALSO in this file: cargoExportQuery(), a client for the SAME data via
// Special:CargoExport (a wiki page, not the api.php action) — live-verified
// 2026-07-10 to NOT be subject to api.php's punishing rate limit, from an IP
// api.php was actively throttling. Key differences, all live-verified:
//   - Response is a plain JSON ARRAY of row objects, NOT api.php's
//     `{cargoquery:[{title:...}]}` envelope.
//   - A query with NO `where` clause triggers a Cloudflare bot challenge
//     (an HTML "Just a moment..." page, HTTP 200/403) instead of JSON —
//     always pass a `where`; cargoExportQuery treats any non-array JSON
//     response as a thrown error, never as an empty result.
//   - Field-name spacing quirk (DateTime_UTC -> "DateTime UTC") is the SAME
//     as api.php — cargoField() handles both transparently. Absent/null
//     Cargo fields come back as JSON `null` (not simply omitted, as api.php
//     does) — cargoField()'s `??` chain already treats `null` as missing, so
//     no change was needed there.
//   - `order by` (URLSearchParams key with a literal space, which serializes
//     to `order+by=...`) works identically to api.php's `order_by`.
//   - Much lighter rate limit — paced separately, 5s floor vs api.php's 30s,
//     with NO retry-on-failure logic (a real failure here is unusual enough
//     to just propagate; there's no known ratelimit-then-cooldown contract
//     the way there is for api.php).
//
// P0 FOLLOW-UP (2026-07-10, decided): live-probing cargoExportQuery's actual
// HTTP path showed curl succeeds against Special:CargoExport reliably, but
// Node's own networking stack (global fetch AND the classic https module,
// both with and without full browser headers) got Cloudflare-403'd 5/5
// times — a TLS/JA3-fingerprint-level block, not a header/query problem.
// Since Vercel's serverless runtime is also Node, the script path (the only
// caller of cargoExportQuery so far — the route stays on api.php) now injects
// a curl-child-process transport instead of trusting Node's fetch. Hence the
// `transport` param below: cargoExportQuery's URL-building, pacing, and
// response validation (JSON array or throw) are transport-agnostic; only the
// "make an HTTP request and hand back the raw body text" part is pluggable.
// See scripts/_curl-transport.mjs for the curl-based implementation.
//
// Data licensed CC BY-SA by Leaguepedia/Fandom — see fronty's UI attribution
// and this note as the code-side acknowledgment.
// ─────────────────────────────────────────────────────────────────────────────

import { fetchWithTimeout } from "@/lib/fetchTimeout";

const CARGO_ENDPOINT = "https://lol.fandom.com/api.php";
const CARGO_EXPORT_ENDPOINT = "https://lol.fandom.com/index.php";
const USER_AGENT = "CoachBuild/0.7 (personal project; contact via GitHub haroutB5)";
const MIN_INTERVAL_MS = 30_000;
const EXPORT_MIN_INTERVAL_MS = 5_000;
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

// Separate process-wide pacer for Special:CargoExport — much lighter floor
// than api.php's, and deliberately independent so exhausting the CargoExport
// budget can never starve/delay an api.php call (or vice versa).
let exportChain: Promise<unknown> = Promise.resolve();
let exportLastCallAt = 0;

function pacedCargoExportCall<T>(fn: () => Promise<T>): Promise<T> {
  const run = async (): Promise<T> => {
    const wait = Math.max(0, exportLastCallAt + EXPORT_MIN_INTERVAL_MS - Date.now());
    if (wait > 0) await sleep(wait);
    exportLastCallAt = Date.now();
    return fn();
  };
  const scheduled = exportChain.then(run, run);
  exportChain = scheduled.then(
    () => undefined,
    () => undefined
  );
  return scheduled;
}

/** Test/script-only escape hatch: resets the CargoExport pacer clock. */
export function __resetCargoExportPacerForTests(): void {
  exportChain = Promise.resolve();
  exportLastCallAt = 0;
}

export interface CargoQueryOptions {
  tables: string;
  fields: string;
  where?: string;
  orderBy?: string;
  limit?: number;
  /** Standard Cargo `offset` param — page N of a >500-row result set (Cargo's
   *  hard per-call row cap applies to BOTH api.php and CargoExport). Live-
   *  verified 2026-07-13 against LPL/2026 Season/Split 2 Playoffs (680 real
   *  rows): a plain limit=500 call silently truncates at row 500 with no
   *  error/warning of any kind — offset=500 on a second call returns the
   *  remaining 180. See lib/prostage/ingest.ts's paginated fetch for the
   *  consumer of this. */
  offset?: number;
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
    if (opts.offset) params.set("offset", String(opts.offset));

    const res = await fetchWithTimeout(`${CARGO_ENDPOINT}?${params.toString()}`, {
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

/** A CargoExport HTTP transport: given a fully-built URL, returns the raw
 *  response body as text (or throws on any transport-level failure — a
 *  non-2xx HTTP status, a non-zero curl exit code, a network error, etc.).
 *  cargoExportQuery() doesn't care HOW the bytes got fetched, only that it
 *  gets text back to parse/validate. */
export type CargoExportTransport = (url: string) => Promise<string>;

/** Default transport: Node's global fetch. Known live-verified caveat
 *  (2026-07-10): Cloudflare 403s Node's own TLS stack against this endpoint
 *  in at least one environment where curl succeeds — kept as the default
 *  because it's the app-code path (Next.js route/lib code can't shell out to
 *  curl), but callers that CAN shell out (scripts/ingest-prostage.mjs) should
 *  inject a curl-based transport instead (see scripts/_curl-transport.mjs). */
async function fetchExportTransport(url: string): Promise<string> {
  const res = await fetchWithTimeout(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    redirect: "follow",
  });
  if (!res.ok) {
    throw new CargoRequestError(`HTTP ${res.status}`, res.status);
  }
  return res.text();
}

/** One paced Special:CargoExport call. Returns the raw row array directly —
 *  no `{cargoquery:[{title:...}]}` envelope to unwrap, unlike cargoQuery().
 *  Throws CargoRequestError if the transport fails (non-ok HTTP by default,
 *  or whatever a custom transport throws), if the body doesn't parse as JSON
 *  (a Cloudflare challenge page is HTML), or if the parsed JSON isn't an
 *  array — NEVER returns [] to mask any of those, same contract as
 *  cargoQuery(). No retry logic: CargoExport failures are rare enough (and
 *  this isn't api.php's well-understood ratelimit-then-cooldown shape) that
 *  propagating immediately is the right default; callers that want a retry
 *  can wrap this themselves. Pacing and response validation apply
 *  regardless of which transport is plugged in — only "make the HTTP
 *  request" is pluggable. */
export async function cargoExportQuery<T = Record<string, string | undefined>>(
  opts: CargoQueryOptions,
  transport: CargoExportTransport = fetchExportTransport
): Promise<T[]> {
  return pacedCargoExportCall(async () => {
    const params = new URLSearchParams({
      title: "Special:CargoExport",
      format: "json",
      tables: opts.tables,
      fields: opts.fields,
      limit: String(opts.limit ?? 500),
    });
    if (opts.where) params.set("where", opts.where);
    // Live-verified 2026-07-10: a literal-space key here serializes to
    // `order+by=...`, which Special:CargoExport accepts (api.php instead
    // wants `order_by`, handled separately in cargoQuery() above).
    if (opts.orderBy) params.set("order by", opts.orderBy);
    if (opts.offset) params.set("offset", String(opts.offset));

    const text = await transport(`${CARGO_EXPORT_ENDPOINT}?${params.toString()}`);
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      // A Cloudflare bot-challenge page (or any other non-JSON body) —
      // treating this as [] would silently mask the failure as "no data".
      throw new CargoRequestError("CargoExport returned a non-JSON response (Cloudflare challenge?)");
    }
    if (!Array.isArray(body)) {
      throw new CargoRequestError("CargoExport response was not a JSON array");
    }
    return body as T[];
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
 *  since it costs nothing and protects any other underscored field).
 *
 *  Generic over the field's expected shape (default `string`, the common
 *  case) — `row` is deliberately typed as `Record<string, unknown>` rather
 *  than tied to `T`, because different Cargo TRANSPORTS return different
 *  runtime shapes for the SAME logical field (List-type fields are
 *  delimiter-joined strings via api.php but real JSON arrays via
 *  CargoExport; numeric fields are strings via api.php but JSON numbers via
 *  CargoExport — live-verified 2026-07-10, see types.ts's header note). The
 *  caller is expected to know (and normalize) the actual field's possible
 *  shapes — e.g. `cargoField<string | string[]>(raw, "Items")` — this
 *  helper only handles the key-lookup quirk, not shape normalization. */
export function cargoField<T = string>(
  row: Record<string, unknown>,
  name: string
): T | undefined {
  const value = row[name] ?? row[name.replace(/_/g, " ")] ?? row[name.replace(/ /g, "_")];
  return value as T | undefined;
}
