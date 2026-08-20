// ─────────────────────────────────────────────────────────────────────────────
// lib/retention/prune.ts — bounded, logged, time-based retention for the four
// match/bookkeeping tables that had NO retention policy of any kind.
//
// WHY THIS EXISTS. Every FETCH in this codebase is 90-day bounded
// (`freshStartTimeEpochSec()`), but until now nothing ever DELETED a row once
// written. `pro_matches`, `otp_matches`, `prostage_matches` and
// `otp_featured_scanned` therefore grew monotonically for the life of the app:
// measured on this box, the pro side alone adds ~900-1,500 rows/day at ~2 KB
// (five jsonb columns, `purchase_order` being the fat one) = 60-90 MB/month
// against Neon's 0.5 GB free-tier ceiling. The failure mode at that ceiling is
// worse than an outage: READS KEEP WORKING AND WRITES START FAILING, so it
// presents as data quietly going stale rather than as anything breaking. Three
// DELETEs existed in the whole repo before this file (lib/draft/ingest.ts x2,
// lib/mystats/purge.ts) and none of them covered these four tables.
//
// ── WHY THE DELETE IS SAFE, AND HOW THAT SAFETY IS ENFORCED ─────────────────
//
// The invariant is NOT "90 days feels like enough history". It is:
//
//     the prune predicate is the strict COMPLEMENT of the read predicate,
//     plus a grace margin, derived from the SAME constant.
//
// Every user-serving read of these tables is bounded by
// `<time column> > now() - make_interval(days => FRESH_WINDOW_DAYS)` — see
// app/api/pros/route.ts (soloq + prostage), app/api/players/route.ts (the
// LEFT JOIN's ON clause) and app/api/otp/route.ts. A row outside that window
// cannot be returned to a user today, so deleting it changes nothing served.
//
// RETENTION_DAYS is therefore computed from FRESH_WINDOW_DAYS rather than
// written down again (see the constants below). A future edit that shortens
// the prune window to inside the served window is a test failure, not a
// silent data loss — lib/retention/__tests__/prune.test.ts asserts the
// ordering and asserts the day parameter at EVERY registered table, because a
// shared constant proven at one call site says nothing about the others.
//
// ── THE GRACE MARGIN, AND WHY IT IS NOT ZERO ────────────────────────────────
//
// The exact complement of `col > now() - 90d` is `col <= now() - 90d`, and
// pruning at exactly that boundary is defensible on paper. It is not worth it
// in practice: it puts every clock-skew, timezone, statement-timing and
// read-replica-lag question directly on top of an irreversible DELETE. Seven
// days of margin removes that entire class of question and costs ~8% of
// steady-state storage (~20 MB) against 60-90 MB/month prevented. A row we
// keep for seven extra days is free; a row we delete seven seconds early is a
// user-visible hole with no undo.
//
// ── BOUNDED BATCHES, NOT ONE DELETE ─────────────────────────────────────────
//
// A single unbounded `DELETE FROM coachbuild.pro_matches WHERE ...` would, on
// the first run's backlog, hold one long write transaction and pin the compute
// awake for its whole duration — which is precisely the class of unattended
// database work that exhausted this project's compute quota on 2026-08-20. So:
//
//   * the cutoff is resolved ONCE, from the DATABASE's clock (not the host's),
//     and reused verbatim for every batch — so a long run cannot creep forward
//     into newer rows as it goes, and the cutoff we log is the cutoff we used;
//   * rows are deleted in batches of `batchSize`, each its own statement and
//     therefore its own implicit transaction on the HTTP driver — nothing
//     holds a transaction open across batches;
//   * every run is bounded TWICE, by `maxRowsPerRun` and by a wall-clock
//     `budgetMs`, whichever hits first. A run that hits either stops early and
//     reports `capped: true` rather than grinding. The backlog is drained
//     across successive runs.
//
// ── FAILURE IS ALWAYS SURVIVABLE ────────────────────────────────────────────
//
// `pruneTableSafely` / `runRetentionPruneSafely` never throw. Retention is
// maintenance; an ingest run that fetched real data must never be failed by a
// housekeeping DELETE, and the database being unreachable (as it is at the
// time of writing — every query 402s on an exhausted quota) must degrade to
// "we did not prune this time", never to "the ingest broke".
//
// ── VISIBILITY ──────────────────────────────────────────────────────────────
//
// Silent maintenance is how this class of problem hides. Every run reports
// table / rows deleted / cutoff / duration through the injected `log`, returns
// the same as structured data, AND records a durable row per table in
// coachbuild.ingest_health (key `retention:<table>`), which the maintenance
// digest already reads. A run that could not drain its backlog records
// `ok:false` deliberately: "still behind" is exactly the thing you want to see
// weeks before the ceiling, and it clears itself the moment a run drains.
// ─────────────────────────────────────────────────────────────────────────────

import type { getSql } from "@/lib/pro/db";
import { FRESH_WINDOW_DAYS } from "@/lib/pro/fresh";
import { recordIngestRun } from "@/lib/ingestHealth";

type Sql = NonNullable<ReturnType<typeof getSql>>;

/** Extra days kept BEYOND the served window before a row becomes eligible for
 *  deletion. See this file's header: the point is to put clock skew, timezone
 *  and statement-timing questions comfortably far away from an irreversible
 *  DELETE, not to keep useful history. */
export const RETENTION_GRACE_DAYS = 7;

/** The prune cutoff, in days. DERIVED from the read window on purpose — the
 *  two must never be independently editable, or a future narrowing of one
 *  silently starts deleting rows the other still serves. */
export const RETENTION_DAYS = FRESH_WINDOW_DAYS + RETENTION_GRACE_DAYS;

/** Prefix for this pipeline's coachbuild.ingest_health rows. */
export const RETENTION_HEALTH_PREFIX = "retention:";

export function retentionHealthKey(table: RetentionTableName): string {
  return `${RETENTION_HEALTH_PREFIX}${table}`;
}

export type RetentionTableName =
  | "pro_matches"
  | "otp_matches"
  | "prostage_matches"
  | "otp_featured_scanned";

export interface RetentionTableSpec {
  /** Bare table name under the `coachbuild` schema. */
  readonly table: RetentionTableName;
  /** The column the cutoff is applied to. NOT uniformly `game_creation` — see
   *  each entry's note; getting this wrong is a runtime "column does not
   *  exist", or worse, a correct-looking prune on the wrong axis. */
  readonly column: string;
  /** The table's two-column primary key, in order. Every one of these four
   *  tables happens to have a text/text composite PK, which is what lets one
   *  generic batched delete serve all of them. */
  readonly key: readonly [string, string];
  /** True when an ingest is allowed to run this prune unattended. See
   *  `PRUNE_BLOCKED_REASON` for the tables where it is false and why. */
  readonly autoPrune: boolean;
}

/** Why a table is present in the registry but NOT pruned automatically.
 *  Keyed by table so the reason travels with the code, not a handoff doc. */
export const PRUNE_BLOCKED_REASON: Partial<Record<RetentionTableName, string>> = {
  otp_matches:
    "app/api/otp/featured/route.ts selects from coachbuild.otp_matches with NO " +
    "time bound and NO LIMIT (WHERE puuid = $1 AND champion_id = $2 ORDER BY " +
    "game_creation DESC), and buildFeaturedModel aggregates over every row it " +
    "returns — sample size, item pick rates, winrate, rune/spell counts and the " +
    "game log. Unlike every other read of these tables, that route SERVES rows " +
    "older than the fresh window today, so pruning would silently change the " +
    "numbers on the Featured OTP card. Bound that query to FRESH_WINDOW_DAYS " +
    "(which would also make it agree with its sibling /api/otp, which is already " +
    "bounded) before setting autoPrune: true here.",
};

/**
 * THE REGISTRY. Adding a table here is a claim that every user-serving read of
 * it is bounded to FRESH_WINDOW_DAYS — verified call site by call site, not
 * assumed from the table's name.
 */
export const RETENTION_TABLES: readonly RetentionTableSpec[] = [
  {
    // Reads: app/api/pros/route.ts (both soloq branches) and
    // app/api/players/route.ts both carry the FRESH_WINDOW_DAYS bound.
    // app/api/pros/team-players/route.ts looks a row up by (match_id,
    // champion_id) with no bound, but it can only ever be asked about a
    // match_id obtained from the bounded list route, and it degrades to
    // EMPTY_RESULT + no-store rather than erroring. The ingest's own dedup
    // read is scoped to `match_id = ANY(<Riot's 90-day id page>)`, so a
    // pruned row's id can never be offered to it again.
    table: "pro_matches",
    column: "game_creation",
    key: ["match_id", "puuid"],
    autoPrune: true,
  },
  {
    // NOT `game_creation` — this table's time column is `game_datetime`
    // (migrations/0002_prostage.sql). A blanket "prune on game_creation" rule
    // applied here is a runtime error, not a subtle bug, but it is exactly the
    // kind of thing a table-shaped rule gets wrong.
    //
    // Reads: app/api/pros/route.ts's three prostage branches all carry
    // `game_datetime > now() - make_interval(days => FRESH_WINDOW_DAYS)`. The
    // comps enrichment (same file) and app/api/pros/team-players.ts are keyed
    // on game_ids derived from those bounded results. lib/prostage/liveIngest
    // .ts's "already have this game" guard only ever asks about games being
    // played right now, which the cutoff cannot reach. Tournament staleness
    // ordering reads prostage_ingest_attempts, not this table.
    table: "prostage_matches",
    column: "game_datetime",
    key: ["game_id", "player_link"],
    autoPrune: true,
  },
  {
    // NOT A MATCH TABLE. One row per (account, match) the deep walk has ASKED
    // RIOT ABOUT — stored or rejected — so that off-champion matches are never
    // re-fetched (migrations/0019_otp_featured_deep.sql: a stateless diff would
    // pay a Riot call to re-reject the same games on every pass, thousands per
    // sweep). It has no game-time column at all; `scanned_at` is when we made
    // the call, not when the game was played.
    //
    // WHY `scanned_at` IS NEVERTHELESS THE CORRECT KEY, and why the same 90-day
    // number here is a coincidence of arithmetic rather than the same rule:
    // the walk only ever sees ids from a Riot id page bounded by
    // `startTime: freshStartTimeEpochSec()`, so a match scanned at time s was
    // necessarily PLAYED at some g <= s. It leaves Riot's 90-day id window for
    // good at g + 90d, and g + 90d <= s + 90d. So once now() > s + 90d, that id
    // can never be offered to the walk again and the ledger row can never save
    // another Riot call. Deleting it is a provable no-op for the walk.
    //
    // DO NOT "improve" this by joining to otp_matches to find the real game
    // time. Migration 0019 records `stored` precisely so the outcome survives
    // "without inferring it from a join that would silently change meaning if
    // otp_matches were ever pruned" — and the rows that carry ALL the value are
    // the `stored = false` ones, which have no otp_matches row to join to. A
    // join-based prune would delete exactly the rejections the table exists to
    // remember and re-spend the Riot budget it exists to save.
    table: "otp_featured_scanned",
    column: "scanned_at",
    key: ["puuid", "match_id"],
    autoPrune: true,
  },
  {
    // Registered, implemented, and deliberately NOT run — see
    // PRUNE_BLOCKED_REASON.otp_matches. Left in the registry rather than
    // deleted so the blocker is discoverable from the code that would do the
    // deleting, and so enabling it is a one-word change once the read path is
    // bounded.
    table: "otp_matches",
    column: "game_creation",
    key: ["match_id", "puuid"],
    autoPrune: false,
  },
];

/** The batched delete has to interpolate table/column identifiers, which
 *  parameters cannot carry. Those identifiers come exclusively from the frozen
 *  literal registry above, so this is defence in depth rather than a live
 *  concern — but a future refactor that builds a spec from config or an env var
 *  must fail loudly here rather than reach `sql.unsafe`. */
const SAFE_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

function assertSafeIdentifiers(spec: RetentionTableSpec): void {
  for (const ident of [spec.table, spec.column, spec.key[0], spec.key[1]]) {
    if (!SAFE_IDENTIFIER.test(ident)) {
      throw new Error(`unsafe SQL identifier in retention spec: ${JSON.stringify(ident)}`);
    }
  }
}

export function retentionSpec(table: RetentionTableName): RetentionTableSpec {
  const spec = RETENTION_TABLES.find((t) => t.table === table);
  if (!spec) throw new Error(`no retention spec registered for ${table}`);
  assertSafeIdentifiers(spec);
  return spec;
}

/** Tables an unattended ingest is allowed to prune. */
export function autoPruneTables(): RetentionTableName[] {
  return RETENTION_TABLES.filter((t) => t.autoPrune).map((t) => t.table);
}

export interface PruneOptions {
  /** Rows deleted per statement. Each batch is its own implicit transaction. */
  batchSize?: number;
  /** Hard ceiling on rows deleted in one run, across all batches. */
  maxRowsPerRun?: number;
  /** Wall-clock budget for one table's prune, in ms. */
  budgetMs?: number;
  /** Days of history to keep. Defaults to RETENTION_DAYS; overriding this
   *  BELOW FRESH_WINDOW_DAYS is refused (see pruneTable). */
  retentionDays?: number;
  /** Minimum hours between two prunes of the same table. The ingests that call
   *  this are paged walks invoked many times per sweep; without this the prune
   *  would re-run on every page. */
  minIntervalHours?: number;
  /** Set false to skip the interval check (tests, and a deliberate manual run). */
  respectInterval?: boolean;
  log?: (msg: string) => void;
  /** Injectable clock, for duration measurement only. The CUTOFF always comes
   *  from the database's now(), never from here. */
  nowMs?: () => number;
}

export interface PruneResult {
  table: RetentionTableName;
  /** ISO-8601 UTC. Rows with `column <= cutoff` were eligible. Null when the
   *  run was skipped before a cutoff was resolved. */
  cutoff: string | null;
  rowsDeleted: number;
  batches: number;
  durationMs: number;
  /** True when the run stopped on `maxRowsPerRun` or `budgetMs` with eligible
   *  rows still present — i.e. the backlog is not drained. */
  capped: boolean;
  /** Set when the run did no work: "throttled" (ran too recently),
   *  "blocked" (autoPrune false), or "error". */
  skipped: "throttled" | "blocked" | "error" | null;
  error: string | null;
}

const DEFAULTS = {
  batchSize: 500,
  maxRowsPerRun: 20_000,
  budgetMs: 20_000,
  minIntervalHours: 20,
} as const;

interface CutoffRow {
  cutoff: string;
}

/** Resolves the cutoff from the DATABASE's clock, once per run, in the same
 *  `now() - make_interval(days => ...)` form the read paths use — so the two
 *  cannot express the boundary differently. Rendered as explicit UTC ISO-8601
 *  so it round-trips through `::timestamptz` unambiguously and reads correctly
 *  in a log. */
async function resolveCutoff(sql: Sql, retentionDays: number): Promise<string> {
  const rows = (await sql`
    SELECT to_char(
      (now() - make_interval(days => ${retentionDays})) AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    ) AS cutoff
  `) as unknown as CutoffRow[];
  const cutoff = rows[0]?.cutoff;
  if (typeof cutoff !== "string" || cutoff.length === 0) {
    throw new Error("could not resolve retention cutoff from the database clock");
  }
  return cutoff;
}

/** True when this table was pruned within `minIntervalHours`. Evaluated
 *  against the DATABASE's clock for the same reason the cutoff is.
 *
 *  FAILS CLOSED: if the health row cannot be read, we do not prune. A missing
 *  ROW (never pruned) is a go; a failing QUERY is not. Deleting rows on the
 *  strength of a query we could not run is the wrong side to err on. */
async function isThrottled(
  sql: Sql,
  table: RetentionTableName,
  minIntervalHours: number
): Promise<boolean> {
  const rows = (await sql`
    SELECT (last_run_at > now() - make_interval(hours => ${minIntervalHours})) AS throttled
    FROM coachbuild.ingest_health
    WHERE ingest = ${retentionHealthKey(table)}
  `) as unknown as { throttled: boolean }[];
  return rows[0]?.throttled === true;
}

/**
 * Prunes ONE table. Throws on database failure — callers that must not fail
 * (every ingest) use `pruneTableSafely`.
 */
export async function pruneTable(
  sql: Sql,
  table: RetentionTableName,
  opts: PruneOptions = {}
): Promise<PruneResult> {
  const spec = retentionSpec(table);
  const now = opts.nowMs ?? (() => Date.now());
  const startedMs = now();
  const log = opts.log ?? (() => {});

  const batchSize = opts.batchSize ?? DEFAULTS.batchSize;
  const maxRowsPerRun = opts.maxRowsPerRun ?? DEFAULTS.maxRowsPerRun;
  const budgetMs = opts.budgetMs ?? DEFAULTS.budgetMs;
  const minIntervalHours = opts.minIntervalHours ?? DEFAULTS.minIntervalHours;
  const retentionDays = opts.retentionDays ?? RETENTION_DAYS;

  const base: PruneResult = {
    table,
    cutoff: null,
    rowsDeleted: 0,
    batches: 0,
    durationMs: 0,
    capped: false,
    skipped: null,
    error: null,
  };

  // A retention window inside the window the app still SERVES would delete
  // rows a live read can return. There is no override for this and there
  // should not be one — a caller that wants a shorter window wants a
  // different feature.
  if (retentionDays <= FRESH_WINDOW_DAYS) {
    throw new Error(
      `retentionDays (${retentionDays}) must exceed FRESH_WINDOW_DAYS (${FRESH_WINDOW_DAYS}) — ` +
        `a shorter window would delete rows the read paths still serve`
    );
  }

  if (opts.respectInterval !== false && (await isThrottled(sql, table, minIntervalHours))) {
    log(`[retention] ${table}: skipped, pruned within the last ${minIntervalHours}h`);
    return { ...base, durationMs: now() - startedMs, skipped: "throttled" };
  }

  const cutoff = await resolveCutoff(sql, retentionDays);

  let rowsDeleted = 0;
  let batches = 0;
  let capped = false;

  for (;;) {
    // SELECT the batch's keys first, then DELETE by primary key. Selecting and
    // deleting in one unbounded statement is what we are avoiding; doing the
    // LIMIT inside the DELETE's own subquery works too, but this form keeps
    // every DELETE a pure indexed PK lookup and makes the batch's exact
    // contents assertable in a test.
    const keyRows = (await sql`
      SELECT ${sql.unsafe(spec.key[0])} AS k1, ${sql.unsafe(spec.key[1])} AS k2
      FROM ${sql.unsafe(`coachbuild.${spec.table}`)}
      WHERE ${sql.unsafe(spec.column)} <= ${cutoff}::timestamptz
      LIMIT ${batchSize}
    `) as unknown as { k1: string; k2: string }[];

    if (keyRows.length === 0) break;

    const k1 = keyRows.map((r) => r.k1);
    const k2 = keyRows.map((r) => r.k2);
    await sql`
      DELETE FROM ${sql.unsafe(`coachbuild.${spec.table}`)} t
      USING unnest(${k1}::text[], ${k2}::text[]) AS k(a, b)
      WHERE t.${sql.unsafe(spec.key[0])} = k.a AND t.${sql.unsafe(spec.key[1])} = k.b
    `;

    rowsDeleted += keyRows.length;
    batches += 1;

    // A short page means we drained everything eligible — stop without paying
    // for one more empty SELECT.
    if (keyRows.length < batchSize) break;
    if (rowsDeleted >= maxRowsPerRun) {
      capped = true;
      break;
    }
    if (now() - startedMs >= budgetMs) {
      capped = true;
      break;
    }
  }

  const durationMs = now() - startedMs;
  log(
    `[retention] ${table}: deleted ${rowsDeleted} row(s) older than ${cutoff} ` +
      `in ${batches} batch(es), ${durationMs}ms${capped ? " (CAPPED — backlog not drained)" : ""}`
  );

  return { ...base, cutoff, rowsDeleted, batches, durationMs, capped };
}

/** Best-effort durable status, one row per table, in the table the maintenance
 *  digest already reads. Never throws — losing the status write must not be
 *  confused with the prune itself failing (same posture as
 *  lib/draft/ingest.ts's recordDirectionCheckHealth). */
async function recordPruneHealth(sql: Sql, result: PruneResult): Promise<void> {
  try {
    if (result.skipped === "throttled" || result.skipped === "blocked") return;
    const ok = result.error === null && !result.capped;
    const error =
      result.error !== null
        ? result.error
        : result.capped
          ? `backlog not drained: deleted ${result.rowsDeleted} row(s) up to ${result.cutoff} ` +
            `and stopped on the per-run cap; the next ingest continues`
          : null;
    await recordIngestRun(sql, retentionHealthKey(result.table), { ok, error });
  } catch {
    // Deliberately swallowed — see this function's doc comment.
  }
}

/**
 * `pruneTable` + durable health row, and NEVER throws.
 *
 * This is the entry point every ingest uses. A retention failure — including
 * the database being entirely unreachable, which it is as this ships — must
 * degrade to "we did not prune this time", never to a failed ingest run that
 * did real work.
 */
export async function pruneTableSafely(
  sql: Sql,
  table: RetentionTableName,
  opts: PruneOptions = {}
): Promise<PruneResult> {
  const log = opts.log ?? (() => {});
  const now = opts.nowMs ?? (() => Date.now());

  let spec: RetentionTableSpec;
  try {
    spec = retentionSpec(table);
  } catch (err) {
    return {
      table,
      cutoff: null,
      rowsDeleted: 0,
      batches: 0,
      durationMs: 0,
      capped: false,
      skipped: "error",
      error: (err as Error).message,
    };
  }

  if (!spec.autoPrune) {
    const reason = PRUNE_BLOCKED_REASON[table] ?? "not enabled for automatic pruning";
    log(`[retention] ${table}: BLOCKED, not pruned — ${reason}`);
    return {
      table,
      cutoff: null,
      rowsDeleted: 0,
      batches: 0,
      durationMs: 0,
      capped: false,
      skipped: "blocked",
      error: null,
    };
  }

  const startedMs = now();
  try {
    const result = await pruneTable(sql, table, opts);
    await recordPruneHealth(sql, result);
    return result;
  } catch (err) {
    const message = (err as Error).message;
    log(`[retention] ${table}: FAILED — ${message}`);
    const failed: PruneResult = {
      table,
      cutoff: null,
      rowsDeleted: 0,
      batches: 0,
      durationMs: now() - startedMs,
      capped: false,
      skipped: "error",
      error: message,
    };
    await recordPruneHealth(sql, failed);
    return failed;
  }
}

/**
 * Prunes several tables in sequence, never throwing. Sequential on purpose:
 * these run at the tail of an ingest on a 0.25 CU compute, and the whole point
 * is to not spike it.
 */
export async function runRetentionPruneSafely(
  sql: Sql,
  tables: readonly RetentionTableName[],
  opts: PruneOptions = {}
): Promise<PruneResult[]> {
  const results: PruneResult[] = [];
  for (const table of tables) {
    results.push(await pruneTableSafely(sql, table, opts));
  }
  return results;
}
