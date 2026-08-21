// ─────────────────────────────────────────────────────────────────────────────
// lib/mystats/rankSample.ts — the write half of the LP time series
// (coachbuild.my_rank_samples, migration 0027). Two exports that matter:
// `parseRankSampleBody`, which is PURE and decides what a believable rank
// reading looks like, and `insertRankSample`, which stores one and prunes the
// account's expired ones IN THE SAME STATEMENT.
//
// ── WHY THE VALIDATION IS THIS PARANOID ─────────────────────────────────────
//
// POST /api/mystats/rank-sample is reachable by anyone who knows the URL — the
// same exposure lib/mystats/accountAuth.ts's header explains for the account
// write, and for the same unavoidable reason (the League client is on
// 127.0.0.1, so the reading has to travel up from the user's machine). The
// shared secret is the real gate. This module is the second line: it decides
// what a reading has to look like before it is allowed to influence a number
// the user reads as fact.
//
// Every stored row is a CLAIM ABOUT THE USER'S RANK AT AN INSTANT, and two
// stored rows either side of a sitting are what turn "unavailable" into a
// confident signed number on screen. So the rules below are about the ways a
// single bad row silently corrupts a figure, not about tidiness:
//
//   A FUTURE READING IS POISON, NOT NOISE. `observed_at` far in the future
//   sorts to the top of the (puuid, observed_at DESC) index and satisfies
//   `sample.ms >= session.endedAtMs` for EVERY session from now until that
//   date — so one such row becomes the closing bracket of every future
//   sitting, and every LP figure on the page is measured against it. Refused,
//   with a small allowance for real clock skew on the user's own machine.
//
//   A READING OLDER THAN RETENTION IS A WRITE THAT NEVER EXISTED. The DELETE
//   clause in insertRankSample's own statement would remove it, and the
//   endpoint would still answer `ok: true`. Refused, so the accept window and
//   the retention window are one decision expressed once.
//
//   A HALF-READING OCCUPIES A KEY IT CANNOT PAY FOR. The primary key is
//   (puuid, observed_at) and the insert is ON CONFLICT DO NOTHING, so the FIRST
//   row written at an instant wins permanently. A row carrying a tier but no
//   LP can never be placed on the ladder (lib/mystats/ladder.ts fails closed),
//   so it is dead weight that also blocks a good reading arriving later for the
//   same instant. Refused.
//
// ── AND ONE PLACE IT DELIBERATELY IS NOT ────────────────────────────────────
//
// THE BOUNDARY ENFORCES COHERENCE, NOT VOCABULARY. An unrecognised TIER is
// accepted and stored. That looks like a hole and is the opposite: ladder.ts
// already fails closed on a tier it does not know, so an unknown tier renders a
// dash either way — but STORED, the reading survives, and a later build that
// learns the name can read it back. Refused, it is gone forever, and it would
// go silently: capture never surfaces an error to the user by design (spec §5).
// The same argument does not apply to `source`, which is a closed set this app
// owns rather than one Riot can extend — an unrecognised source is a value
// nobody can interpret, and it is refused (migration 0027's column comment).
// ─────────────────────────────────────────────────────────────────────────────

import type { getSql } from "@/lib/pro/db";
import { isAccountsRequestError, parseAccountsBody } from "@/lib/mystats/accountRequest";
import { RETENTION_DAYS } from "@/lib/retention/prune";

type Sql = NonNullable<ReturnType<typeof getSql>>;

/** Which capture produced a reading. A CLOSED set this app owns — see the
 *  header for why this one is an allowlist and `tier` is not. */
export const RANK_SAMPLE_SOURCES = ["companion", "cron", "page"] as const;
export type RankSampleSource = (typeof RANK_SAMPLE_SOURCES)[number];

/** How far ahead of the SERVER's clock a reading may claim to have been taken.
 *  The companion stamps `observed_at` on the user's own machine, so some skew
 *  is legitimate; a lot of it is the failure described in the header. Ten
 *  minutes is far wider than any real desktop drift and far narrower than any
 *  span that could bracket a sitting. */
export const RANK_SAMPLE_FUTURE_SKEW_MS = 10 * 60 * 1000;

/** Rows the prune clause may remove per write. Bounded so one write can never
 *  turn into an unbounded DELETE — the failure mode behind the 2026-08-20 Neon
 *  compute exhaustion was an unattended statement with no ceiling. At roughly
 *  20-40 samples a day, 500 clears well over a week of arrears in one write, so
 *  the table converges within a handful of captures even after a long outage. */
export const RANK_SAMPLE_PRUNE_LIMIT = 500;

/** Riot puuids are 78-character URL-safe-base64-ish strings today. Loose on
 *  LENGTH (a format change should not break capture), strict on CHARSET — the
 *  same split lib/mystats/accountRequest.ts uses, and for the same reason: this
 *  value identifies rows and must not be able to carry path or quote
 *  characters. */
const PUUID_RE = /^[A-Za-z0-9_-]{20,128}$/;

/** The LCU labels its 36-character LOCAL account UUID `puuid`, but Riot's
 *  public APIs cannot use it. It happens to pass PUUID_RE, so it needs an
 *  explicit refusal or it will key a permanently orphaned time series. */
const LCU_LOCAL_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Tier and division are stored as normalised uppercase tokens. Bounded in
 *  length and charset so nothing arbitrary reaches the column, but NOT checked
 *  against a list of known values — see this file's header. */
const RANK_TOKEN_RE = /^[A-Z]{1,20}$/;

/** A sane ceiling for an apex LP value. Challenger sits in the low thousands;
 *  anything above this is a broken read, not a rank, and would move the
 *  absolute ladder scale by more than the entire ladder is wide. */
const MAX_LP = 10_000;

/** Riot's absolute ladder integer includes all lower tiers as well as the LP
 *  inside the current tier. Keep a generous safety ceiling without coupling
 *  acceptance to today's tier vocabulary. */
export const MAX_CUMULATIVE_LP = 100_000;

const DAY_MS = 24 * 60 * 60 * 1000;

interface RankSampleValues {
  /** Normalised to UTC ISO-8601 with milliseconds. NORMALISATION IS LOAD-
   *  BEARING: the idempotency guarantee is a primary key on this value, so two
   *  spellings of one instant ("…+02:00" and "…Z") must collapse to one string
   *  before they can collapse to one row. */
  observedAt: string;
  tier: string | null;
  division: string | null;
  lp: number | null;
  /** Riot's own absolute ladder position. Null for the public-API sources,
   *  which do not return it; session arithmetic falls back to ladder.ts. */
  cumulativeLp: number | null;
  source: RankSampleSource;
}

/** A validated request. The companion supplies a Riot ID for server-side
 *  resolution; trusted cron/page callers may continue supplying a real puuid. */
export type RankSampleRequest = RankSampleValues &
  ({ puuid: string } | { gameName: string; tagLine: string });

/** One validated and RESOLVED reading, in the exact shape the insert writes. */
export interface RankSampleWrite extends RankSampleValues {
  puuid: string;
}

export interface RankSampleError {
  error: string;
}

export function isRankSampleError(v: RankSampleRequest | RankSampleError): v is RankSampleError {
  return typeof (v as RankSampleError).error === "string";
}

function token(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim().toUpperCase();
  return s.length === 0 ? null : s;
}

/**
 * Validates a POST /api/mystats/rank-sample body. Returns the row to write, or
 * `{ error }` naming the FIRST problem found (the route turns it into a 400).
 * Never throws — a null/garbage/non-object input is simply an invalid body.
 *
 * `nowMs` IS A PARAMETER, NOT `Date.now()`. Two reasons, and the second is the
 * one that matters: it makes every window rule deterministic under test, and it
 * forces the caller to supply the SERVER's clock. A `now` taken from the
 * request body would let a client date its own reading past the future bound
 * and park a permanent closing bracket in the table.
 */
export function parseRankSampleBody(body: unknown, nowMs: number): RankSampleRequest | RankSampleError {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "body must be a JSON object" };
  const b = body as Record<string, unknown>;

  let identity: { puuid: string } | { gameName: string; tagLine: string };
  // When either Riot-ID field is present, this is the companion/detect path.
  // Reuse the accounts endpoint's validator so legitimate Unicode names and
  // custom tagLines have ONE contract. Its detect mode deliberately ignores a
  // caller-supplied puuid, which also makes mixed old-client payloads safe.
  if (b.gameName !== undefined || b.tagLine !== undefined) {
    const detected = parseAccountsBody({ mode: "detect", gameName: b.gameName, tagLine: b.tagLine });
    if (isAccountsRequestError(detected)) return { error: detected.error };
    if (detected.mode !== "detect") return { error: "gameName and tagLine are required together" };
    identity = { gameName: detected.gameName, tagLine: detected.tagLine };
  } else {
    const puuid = typeof b.puuid === "string" ? b.puuid.trim() : "";
    if (!PUUID_RE.test(puuid)) return { error: "puuid must be 20-128 URL-safe characters" };
    if (LCU_LOCAL_UUID_RE.test(puuid)) {
      return { error: "puuid is a League-local UUID; send gameName and tagLine for server-side resolution" };
    }
    identity = { puuid };
  }

  const rawSource = typeof b.source === "string" ? b.source : "";
  if (!(RANK_SAMPLE_SOURCES as readonly string[]).includes(rawSource)) {
    return { error: `source must be one of: ${RANK_SAMPLE_SOURCES.join(", ")}` };
  }
  // The `includes` above IS the check; the cast only tells the compiler so.
  // Widening RANK_SAMPLE_SOURCES to string[] for the comparison is what loses
  // the narrowing, and it is the right trade: an `Array.includes` typed against
  // the literal union would reject the very argument it exists to test.
  const source = rawSource as RankSampleSource;

  // observedAt is a STRING only. An epoch number would be ambiguous between
  // seconds and milliseconds, and guessing wrong puts the reading in 1970 —
  // where it silently fails the retention bound below rather than corrupting
  // anything, but only by luck. Refuse the ambiguity instead.
  if (typeof b.observedAt !== "string") return { error: "observedAt must be an ISO-8601 string" };
  const observedMs = Date.parse(b.observedAt);
  if (!Number.isFinite(observedMs)) return { error: "observedAt is not a parseable ISO-8601 timestamp" };
  if (observedMs > nowMs + RANK_SAMPLE_FUTURE_SKEW_MS) {
    return { error: "observedAt is in the future" };
  }
  if (observedMs < nowMs - RETENTION_DAYS * DAY_MS) {
    return { error: `observedAt is older than the ${RETENTION_DAYS}-day retention window` };
  }

  const tier = token(b.tier);
  const division = token(b.division);
  const lp = b.lp;
  const rawCumulativeLp = b.cumulativeLp;
  let cumulativeLp: number | null = null;
  if (rawCumulativeLp !== null && rawCumulativeLp !== undefined) {
    if (
      typeof rawCumulativeLp !== "number" ||
      !Number.isInteger(rawCumulativeLp) ||
      rawCumulativeLp < 0 ||
      rawCumulativeLp > MAX_CUMULATIVE_LP
    ) {
      return { error: `cumulativeLp must be an integer between 0 and ${MAX_CUMULATIVE_LP} when supplied` };
    }
    cumulativeLp = rawCumulativeLp;
  }

  if (tier === null) {
    // UNRANKED — a real, storable observation, and the only shape in which the
    // rank columns are allowed to be empty. All three go null TOGETHER
    // (migration 0022's convention, kept by 0027); a division or an LP with no
    // tier is not an unranked reading, it is a broken one.
    if (division !== null) return { error: "division without a tier" };
    if (lp !== null && lp !== undefined) return { error: "lp without a tier" };
    if (cumulativeLp !== null) return { error: "cumulativeLp without a tier" };
    return {
      ...identity,
      observedAt: new Date(observedMs).toISOString(),
      tier: null,
      division: null,
      lp: null,
      cumulativeLp: null,
      source,
    };
  }

  if (!RANK_TOKEN_RE.test(tier)) return { error: "tier must be a short alphabetic token" };
  if (division !== null && !RANK_TOKEN_RE.test(division)) return { error: "division must be a short alphabetic token" };
  // A ranked reading with no LP can never be placed on the ladder, so it is
  // dead weight that also squats a primary key an ON CONFLICT DO NOTHING will
  // never let a good reading reclaim.
  if (typeof lp !== "number" || !Number.isInteger(lp) || lp < 0 || lp > MAX_LP) {
    return { error: `lp must be an integer between 0 and ${MAX_LP} when a tier is given` };
  }

  return {
    ...identity,
    observedAt: new Date(observedMs).toISOString(),
    tier,
    division,
    lp,
    cumulativeLp,
    source,
  };
}

export interface RankSampleWriteResult {
  /** False for a DUPLICATE, which is a SUCCESS: the reading for that instant is
   *  already on record. The route answers 200 either way (spec §4). */
  stored: boolean;
  /** Expired rows removed by the same statement. Diagnostics only. */
  pruned: number;
}

/**
 * Writes one reading and prunes the account's expired ones, in ONE statement.
 *
 * IDEMPOTENT via `ON CONFLICT (puuid, observed_at) DO NOTHING`. The companion
 * captures at app start, champ select and game end AND retries, so a duplicate
 * is the normal case, not an error case — it must never 500 (spec §4).
 *
 * PRUNE-ON-WRITE, IN THE SAME STATEMENT, is migration 0027's stated retention
 * policy and is not an optimisation for its own sake. A scheduled task with a
 * bad cadence is what exhausted the Neon compute quota on 2026-08-20; a table
 * written a few dozen times a day can be kept bounded by its own writer for the
 * cost of one extra CTE on a round trip that was happening anyway. Splitting it
 * into a second statement would double this endpoint's compute while passing
 * every behavioural test.
 *
 * The prune is scoped to the WRITING puuid (an unscoped DELETE would let one
 * linked account's capture delete another's history), carries an explicit LIMIT,
 * and is served by the primary key as an index range scan. It cannot touch the
 * row being inserted: every CTE in a statement sees the same snapshot, and the
 * accept window in parseRankSampleBody refuses anything old enough to qualify
 * anyway.
 *
 * RETENTION_DAYS is BOUND, not inlined. It is the same constant the summary
 * route's read window is derived from (FRESH_WINDOW_DAYS + grace), and the two
 * may not drift: a prune window narrower than the read window deletes samples
 * that are still being asked for.
 */
export async function insertRankSample(sql: Sql, sample: RankSampleWrite): Promise<RankSampleWriteResult> {
  const rows = (await sql`
    WITH inserted AS (
      INSERT INTO coachbuild.my_rank_samples (puuid, observed_at, tier, division, lp, cumulative_lp, source)
      VALUES (
        ${sample.puuid},
        ${sample.observedAt}::timestamptz,
        ${sample.tier},
        ${sample.division},
        ${sample.lp},
        ${sample.cumulativeLp},
        ${sample.source}
      )
      ON CONFLICT (puuid, observed_at) DO NOTHING
      RETURNING 1 AS one
    ),
    expired AS (
      SELECT puuid, observed_at
      FROM coachbuild.my_rank_samples
      WHERE puuid = ${sample.puuid}
        AND observed_at < now() - make_interval(days => ${RETENTION_DAYS})
      ORDER BY observed_at
      LIMIT ${RANK_SAMPLE_PRUNE_LIMIT}
    ),
    removed AS (
      DELETE FROM coachbuild.my_rank_samples s
      USING expired e
      WHERE s.puuid = e.puuid AND s.observed_at = e.observed_at
      RETURNING 1 AS one
    )
    SELECT
      (SELECT count(*) FROM inserted)::int AS stored,
      (SELECT count(*) FROM removed)::int AS pruned
  `) as unknown as { stored: number | null; pruned: number | null }[];

  // A driver that hands back nothing must not throw: the write may well have
  // succeeded, and a crash here would turn it into a 500 the companion retries
  // forever. Report the conservative reading instead.
  const row = rows[0];
  return { stored: (row?.stored ?? 0) > 0, pruned: row?.pruned ?? 0 };
}
