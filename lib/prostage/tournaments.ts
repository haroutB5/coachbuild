// ─────────────────────────────────────────────────────────────────────────────
// lib/prostage/tournaments.ts — resolves which OverviewPages to ingest from:
// currently-active/recent tier-1 leagues (LEC/LCK/LPL/LCS/MSI/Worlds) within
// ~90 days.
//
// DESIGN NOTE / deviation from a strict `League IN (...)` filter: Leaguepedia's
// Tournaments.League field enumeration wasn't independently verified before
// this shipped (probe budget was spent on ScoreboardPlayers per the brief's
// priority) — filtering on League risks a silent zero-match query if a code
// is wrong. Filtering on OverviewPage LIKE '%LEC%' etc. instead is a softer,
// harder-to-silently-break match against Leaguepedia's human-readable page
// naming convention (e.g. "LEC 2026 Summer"). See DATA-QUALITY PROBE findings
// in HANDOFF-engy.md for what was actually confirmed live.
//
// Escape hatch: PROSTAGE_TOURNAMENT_SEED env var (comma-separated OverviewPage
// list) bypasses the Tournaments lookup entirely — set it if the LIKE-pattern
// resolution ever comes back empty in production.
// ─────────────────────────────────────────────────────────────────────────────

import type { getSql } from "@/lib/pro/db";
import { cargoField, cargoQueryWithRetry } from "./cargo";
import type { CargoTournamentRow } from "./types";

const TIER1_PATTERNS = ["LEC", "LCK", "LPL", "LCS", "MSI", "World Championship", "Worlds"];
// Academy pages (e.g. "LCK Academy Series") LIKE-match TIER1_PATTERNS but
// resolve to tournaments with no ScoreboardPlayers data — live-verified
// 2026-07-10 (see DATA-QUALITY PROBE in HANDOFF-engy.md).
const EXCLUDE_PATTERNS = ["Academy"];
const MAX_TOURNAMENTS = 7; // caps Cargo calls per ScoreboardPlayers ingest pass

// A cron-drained serverless route calls resolveActiveTournaments() fresh on
// EVERY invocation (one tournament per invocation, cursor-paginated — see
// lib/prostage/ingest.ts). Without this, draining all 7 cursors would cost 7
// extra Tournaments lookups on top of the 7 ScoreboardPlayers calls. A short
// in-process memo (only effective on a WARM lambda instance reused across a
// tight drain sequence — cold starts still pay one lookup, which is fine)
// keeps the common case near the brief's "<=7 Cargo calls per run" budget.
// The local script (scripts/ingest-prostage.mjs) sidesteps this entirely by
// resolving once and passing `tournaments` explicitly to every loop step.
const CACHE_TTL_MS = 5 * 60_000;
let cache: { pages: string[]; expiresAt: number } | null = null;

function dedupe(arr: string[]): string[] {
  return Array.from(new Set(arr));
}

export interface ResolveTournamentsOptions {
  withinDays?: number;
  seedOverride?: string[];
  log?: (msg: string) => void;
  /** See CargoRetryOptions.fastFail in lib/prostage/cargo.ts — threaded
   *  through so the route path doesn't eat a ~4.5min cooldown on its own
   *  Tournaments lookup either. */
  fastFailOnRatelimit?: boolean;
}

/** Returns the OverviewPages to ingest ScoreboardPlayers for, in priority
 *  order (most recent DateStart first, capped at MAX_TOURNAMENTS). Never
 *  throws — a Tournaments-lookup failure is logged and falls back to an
 *  empty list (a caller-supplied seedOverride or PROSTAGE_TOURNAMENT_SEED
 *  is the intended recovery path, not a hardcoded guess that could go stale
 *  and silently mis-target the wrong pages). */
export async function resolveActiveTournaments(opts: ResolveTournamentsOptions = {}): Promise<string[]> {
  const log = opts.log ?? (() => {});

  if (opts.seedOverride?.length) return dedupe(opts.seedOverride).slice(0, MAX_TOURNAMENTS);

  const envSeed = process.env.PROSTAGE_TOURNAMENT_SEED;
  if (envSeed) {
    const seeded = envSeed
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (seeded.length) return dedupe(seeded).slice(0, MAX_TOURNAMENTS);
  }

  if (cache && cache.expiresAt > Date.now()) return cache.pages;

  const withinDays = opts.withinDays ?? 90;
  const now = new Date();
  const cutoff = new Date(now.getTime() - withinDays * 86_400_000).toISOString().slice(0, 10);
  const today = now.toISOString().slice(0, 10);
  const likeClauses = TIER1_PATTERNS.map((p) => `OverviewPage LIKE "%${p}%"`).join(" OR ");
  const excludeClauses = EXCLUDE_PATTERNS.map((p) => `OverviewPage NOT LIKE "%${p}%"`).join(" AND ");

  try {
    const rows = await cargoQueryWithRetry<CargoTournamentRow>(
      {
        tables: "Tournaments",
        fields: "OverviewPage, League, DateStart, Date",
        // Upper-bounded by `today` so future/unplayed tournaments (next
        // Worlds, unstarted playoffs) don't crowd out the DateStart-DESC-
        // ordered, MAX_TOURNAMENTS-capped result ahead of tournaments that
        // actually have ScoreboardPlayers data right now (live-verified
        // 2026-07-10).
        where: `(${likeClauses}) AND ${excludeClauses} AND DateStart >= "${cutoff}" AND DateStart <= "${today}"`,
        orderBy: "DateStart DESC",
        limit: 20,
      },
      { fastFail: opts.fastFailOnRatelimit }
    );
    const pages = rows
      .map((r) => cargoField(r, "OverviewPage"))
      .filter((p): p is string => Boolean(p));
    if (pages.length) {
      const result = dedupe(pages).slice(0, MAX_TOURNAMENTS);
      cache = { pages: result, expiresAt: Date.now() + CACHE_TTL_MS };
      return result;
    }
    log("Tournaments lookup returned 0 usable rows; set PROSTAGE_TOURNAMENT_SEED to override");
  } catch (err) {
    log(`Tournaments lookup failed (${(err as Error).message}); set PROSTAGE_TOURNAMENT_SEED to override`);
  }
  return [];
}

export function __resetTournamentCacheForTests(): void {
  cache = null;
}

interface StalenessRow {
  overview_page: string;
  last_ingested: string;
}

/** Reorders `pages` stalest-first, using coachbuild.prostage_matches as the
 *  source of truth for "last actually ingested" per tournament — mirrors the
 *  `last_fetched_at ASC NULLS FIRST` pattern lib/pro/ingestMatches.ts uses
 *  for pro_accounts. Never-ingested pages (no matching rows, or every attempt
 *  so far failed/ratelimited before a row was written) sort to 'epoch' and
 *  float to the front.
 *
 *  Fixes: the cron hits /api/ingest/prostage with no cursor tracking (no
 *  external pinger walks nextCursor for this route the way one does for
 *  /api/ingest/matches), so every cron invocation is cursor=0 by definition.
 *  Without this, cursor=0 would deterministically be the same DateStart-DESC
 *  head-of-list tournament forever — every OTHER tournament in the resolved
 *  list would never get ingested. Staleness ordering makes cursor=0
 *  self-rotate across the whole list over successive cron runs instead.
 *
 *  Known gap (accepted, no migration this round per the fix brief): a
 *  tournament with genuinely zero real games (e.g. an unstarted bracket)
 *  can never accumulate a prostage_matches row, so it never advances past
 *  'epoch' and would keep winning cursor=0 indefinitely — starving the rest
 *  of the list exactly like the bug this fixes. A dedicated "last attempted"
 *  tracking column (separate from "last successfully wrote a row") would
 *  close this gap; flagged as a follow-up if it's observed in practice
 *  rather than built speculatively now. */
export async function orderByStaleness(
  sql: NonNullable<ReturnType<typeof getSql>>,
  pages: string[]
): Promise<string[]> {
  if (pages.length === 0) return pages;
  const rows = (await sql`
    SELECT ov.overview_page AS overview_page,
           COALESCE(max(pm.ingested_at), 'epoch'::timestamptz) AS last_ingested
    FROM unnest(${pages}::text[]) AS ov(overview_page)
    LEFT JOIN coachbuild.prostage_matches pm ON pm.overview_page = ov.overview_page
    GROUP BY ov.overview_page
    ORDER BY last_ingested ASC
  `) as unknown as StalenessRow[];
  return rows.map((r) => r.overview_page);
}
