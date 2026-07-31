// ─────────────────────────────────────────────────────────────────────────────
// lib/ingestHealth.ts — durable last-run status for the ingest pipelines that
// run OUTSIDE Vercel (2026-07-31 audit P2, #2).
//
// WHY THIS EXISTS. prostage's Leaguepedia leg and draft's u.gg walk both
// already compute a per-run `errors` array and set a non-zero process exit
// code on failure (scripts/ingest-prostage.mjs, scripts/ingest-draft.mjs) —
// but that lived ONLY in a rotating local log file
// (%LOCALAPPDATA%\CoachBuild\*.log) nobody reads proactively. A run can fail
// silently for days: prostage failed on every major tournament 2026-07-31
// 14:25Z (Cloudflare challenges), draft failed 2026-07-30 on every 6xxxx-
// keyed champion id, and BOTH runs still exit "partial success" because most
// champions/tournaments DID get processed — the exact shape that makes a
// failure invisible at a glance. This failure CLASS already cost weeks once
// (CLAUDE.md gotcha (o)): the bar this table exists to clear is "the owner
// notices within a day," not a monitoring dashboard (HARD RULE against
// speculative surfaces still applies — this is a plain status row, read by
// whatever already-shown surface makes sense per ingest, not a new page).
//
// migrations/0023_ingest_health.sql: one row per named pipeline
// (coachbuild.ingest_health, PK `ingest`). recordIngestRun is the ONLY writer
// -- call it once per completed run (not per batch/tournament/champion), from
// the script that owns that run's whole-run error aggregation.
// ─────────────────────────────────────────────────────────────────────────────

import type { getSql } from "@/lib/pro/db";

type Sql = NonNullable<ReturnType<typeof getSql>>;

export interface IngestHealth {
  ingest: string;
  lastRunAt: string;
  lastSuccessAt: string | null;
  ok: boolean;
  lastError: string | null;
  lastErrorAt: string | null;
}

interface IngestHealthRow {
  ingest: string;
  last_run_at: string;
  last_success_at: string | null;
  ok: boolean;
  last_error: string | null;
  last_error_at: string | null;
}

/** Longest error summary stored — this is a status flag, not a log; the full
 *  detail already lives in the local ingest log file. Truncated, never
 *  silently dropped (a truncated-but-present error still tells the owner
 *  SOMETHING failed, which is the entire point). */
const MAX_ERROR_LEN = 2000;

/**
 * ONE upsert per completed run. `ok=true` clears `last_error`/`last_error_at`
 * and stamps `last_success_at`; `ok=false` stamps `last_error`/`last_error_at`
 * and leaves `last_success_at` at whatever it was (so a consumer can always
 * answer both "did the LAST run succeed" and "when did this last actually
 * work"). `last_run_at` is unconditional — a run happened either way.
 *
 * Never throws on its own account past the DB call itself failing — callers
 * (ingest scripts) already run this as the very last step of a long walk;
 * losing the status write must never be confused with the ingest itself
 * failing, so callers should treat this as best-effort (see each call site).
 */
export async function recordIngestRun(
  sql: Sql,
  ingest: string,
  result: { ok: boolean; error?: string | null }
): Promise<void> {
  const error = result.error ? result.error.slice(0, MAX_ERROR_LEN) : null;
  await sql`
    INSERT INTO coachbuild.ingest_health (ingest, last_run_at, last_success_at, ok, last_error, last_error_at)
    VALUES (
      ${ingest}, now(),
      ${result.ok ? new Date().toISOString() : null},
      ${result.ok}, ${result.ok ? null : error}, ${result.ok ? null : new Date().toISOString()}
    )
    ON CONFLICT (ingest) DO UPDATE SET
      last_run_at = now(),
      last_success_at = CASE WHEN ${result.ok} THEN now() ELSE coachbuild.ingest_health.last_success_at END,
      ok = ${result.ok},
      last_error = CASE WHEN ${result.ok} THEN NULL ELSE ${error} END,
      last_error_at = CASE WHEN ${result.ok} THEN NULL ELSE now() END
  `;
}

/** Read-only. Null when the ingest has never recorded a run (table empty for
 *  that key — e.g. before migration 0023 has ever been exercised) OR the
 *  query itself fails; callers must treat both the same as "unknown health,"
 *  never as "healthy." */
export async function getIngestHealth(sql: Sql, ingest: string): Promise<IngestHealth | null> {
  const rows = (await sql`
    SELECT ingest, last_run_at, last_success_at, ok, last_error, last_error_at
    FROM coachbuild.ingest_health WHERE ingest = ${ingest}
  `) as unknown as IngestHealthRow[];
  const row = rows[0];
  if (!row) return null;
  return {
    ingest: row.ingest,
    lastRunAt: row.last_run_at,
    lastSuccessAt: row.last_success_at,
    ok: row.ok,
    lastError: row.last_error,
    lastErrorAt: row.last_error_at,
  };
}
