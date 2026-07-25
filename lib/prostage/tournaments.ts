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

// LEAGUE CODES: matched as a PREFIX (`"LCK/%"`), not a bare substring.
// Live backfill (2026-07-10) showed a bare `%LPL%`/`%LEC%` substring match
// pulls in false positives that merely CONTAIN the code as a substring of an
// unrelated name — "LPLOL/2026 Season/..." (a Brazilian-league page, not
// LPL) matched `%LPL%`, and "Schneider Electric PowerShield Cup 2026"
// matched `%LEC%` (via "El*ec*tric"). Leaguepedia's real tier-1 league pages
// all live under an `"<CODE>/..."` page-tree root (e.g.
// "LCK/2026 Season/Road to MSI"), so anchoring to that prefix excludes both
// false positives while still matching every real sub-bracket/round page.
const LEAGUE_PREFIX_PATTERNS = ["LEC", "LCK", "LPL", "LCS"];
// EVENT NAMES: kept as CONTAINS matches (no shared page-tree root to anchor
// a prefix to). "Mid-Season Invitational" added 2026-07-10 — live-verified
// the REAL 2026 MSI page is "2026 Mid-Season Invitational" (League field:
// "Mid-Season Invitational"), which does NOT contain the substring "MSI" at
// all; "MSI" is kept too since some sub-bracket pages DO contain it literally
// (e.g. "LCK/2026 Season/Road to MSI", already covered by the LCK/ prefix
// above, but other regions' "Road to MSI" pages may not share that prefix).
// "Esports World Cup" added 2026-07-19 — real 2026 page is "Esports World Cup
// 2026" (bug report: EWC 2026, Jul 15-19, was missing from Pro Play entirely).
// EWC pages don't contain "Worlds"/"World Championship" (it's a separate
// third-party event, not a Riot-run international), so none of the existing
// contains-patterns ever matched it.
// "Circuito Desafiante" added 2026-07-22 — Brazil's tier-2 circuit, where
// Bwipo's Estral Esports plays (user bug report: his official games were
// structurally invisible, same whitelist-gap class as EWC/Nemesis). This is a
// TARGETED tier-2 add for a tracked pro's league, NOT a general tier-2
// widening (user declined that in the 2026-07-14 Nemesis decision).
const EVENT_CONTAINS_PATTERNS = [
  "MSI",
  "Mid-Season Invitational",
  "World Championship",
  "Worlds",
  "Esports World Cup",
  "Circuito Desafiante",
];
// Academy pages (e.g. "LCK Academy Series") LIKE-match the LCK/ prefix but
// resolve to tournaments with no ScoreboardPlayers data — live-verified
// 2026-07-10 (see DATA-QUALITY PROBE in HANDOFF-engy.md).
const EXCLUDE_PATTERNS = ["Academy"];
export const MAX_TOURNAMENTS = 7; // caps Cargo calls per ScoreboardPlayers ingest pass; exported for scripts/ingest-prostage.mjs's --via-export path

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

export interface TournamentsQuerySpec {
  tables: "Tournaments";
  fields: string;
  where: string;
  orderBy: string;
  limit: number;
}

/** Builds the Tournaments Cargo query (WHERE clause + fields/order/limit)
 *  resolveActiveTournaments runs through cargoQueryWithRetry (api.php).
 *  Exported as a single source of truth so scripts/ingest-prostage.mjs's
 *  --via-export flag can run the IDENTICAL tier-1/Academy-exclusion/
 *  date-window filter logic through cargoExportQuery instead — the WHERE
 *  semantics must stay in lockstep between both transports. */
export function buildTournamentsQuerySpec(withinDays = 90): TournamentsQuerySpec {
  const now = new Date();
  const cutoff = new Date(now.getTime() - withinDays * 86_400_000).toISOString().slice(0, 10);
  const today = now.toISOString().slice(0, 10);
  const prefixClauses = LEAGUE_PREFIX_PATTERNS.map((p) => `OverviewPage LIKE "${p}/%"`);
  const containsClauses = EVENT_CONTAINS_PATTERNS.map((p) => `OverviewPage LIKE "%${p}%"`);
  const likeClauses = [...prefixClauses, ...containsClauses].join(" OR ");
  const excludeClauses = EXCLUDE_PATTERNS.map((p) => `OverviewPage NOT LIKE "%${p}%"`).join(" AND ");
  return {
    tables: "Tournaments",
    fields: "OverviewPage, League, DateStart, Date",
    // Upper-bounded by `today` so future/unplayed tournaments (next Worlds,
    // unstarted playoffs) don't crowd out the DateStart-DESC-ordered,
    // MAX_TOURNAMENTS-capped result ahead of tournaments that actually have
    // ScoreboardPlayers data right now (live-verified 2026-07-10).
    where: `(${likeClauses}) AND ${excludeClauses} AND DateStart >= "${cutoff}" AND DateStart <= "${today}"`,
    orderBy: "DateStart DESC",
    limit: 20,
  };
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

  // PROSTAGE_TOURNAMENT_SEED is a FALLBACK, not an override (changed
  // 2026-07-25). It used to short-circuit here, ahead of the live lookup —
  // which meant setting it to unblock an outage would PIN the tournament list
  // forever, and the app would silently stop following new splits (LEC Summer
  // starting, Summer Playoffs in September, next season) with no failure of any
  // kind. Live resolution is tried first; the seed catches the failure case.
  const envSeed = parseSeed(process.env.PROSTAGE_TOURNAMENT_SEED);

  if (cache && cache.expiresAt > Date.now()) return cache.pages;

  const withinDays = opts.withinDays ?? 90;
  const spec = buildTournamentsQuerySpec(withinDays);

  try {
    const rows = await cargoQueryWithRetry<CargoTournamentRow>(spec, { fastFail: opts.fastFailOnRatelimit });
    const pages = rows
      .map((r) => cargoField(r, "OverviewPage"))
      .filter((p): p is string => Boolean(p));
    if (pages.length) {
      const result = dedupe(pages).slice(0, MAX_TOURNAMENTS);
      cache = { pages: result, expiresAt: Date.now() + CACHE_TTL_MS };
      return result;
    }
    log("Tournaments lookup returned 0 usable rows; falling back to PROSTAGE_TOURNAMENT_SEED");
  } catch (err) {
    log(`Tournaments lookup failed (${(err as Error).message}); falling back to PROSTAGE_TOURNAMENT_SEED`);
  }

  // Fallback path. Deliberately NOT cached: a seeded list is a degraded mode,
  // so every subsequent call retries live resolution rather than settling into
  // the seed for the cache TTL.
  if (envSeed.length) {
    log(`Using PROSTAGE_TOURNAMENT_SEED fallback (${envSeed.length} tournaments)`);
    return envSeed;
  }
  return [];
}

/** Parses the comma-separated PROSTAGE_TOURNAMENT_SEED env var. */
function parseSeed(raw: string | undefined): string[] {
  if (!raw) return [];
  const seeded = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return seeded.length ? dedupe(seeded).slice(0, MAX_TOURNAMENTS) : [];
}

export function __resetTournamentCacheForTests(): void {
  cache = null;
}

interface StalenessRow {
  overview_page: string;
  last_ingested: string;
}

/** Reorders `pages` stalest-first, using coachbuild.prostage_ingest_attempts
 *  (migration 0008) as the source of truth for "last time a Cargo pass was
 *  ATTEMPTED" per tournament — mirrors the `last_fetched_at ASC NULLS FIRST`
 *  pattern lib/pro/ingestMatches.ts uses for pro_accounts. Never-attempted
 *  pages (no matching row yet) sort to 'epoch' and float to the front.
 *
 *  Fixes: the cron hits /api/ingest/prostage with no cursor tracking (no
 *  external pinger walks nextCursor for this route the way one does for
 *  /api/ingest/matches), so every cron invocation is cursor=0 by definition.
 *  Without this, cursor=0 would deterministically be the same DateStart-DESC
 *  head-of-list tournament forever — every OTHER tournament in the resolved
 *  list would never get ingested. Staleness ordering makes cursor=0
 *  self-rotate across the whole list over successive cron runs instead.
 *
 *  P2 fix (2026-07-17 Fable review): this used to proxy staleness off
 *  `max(coachbuild.prostage_matches.ingested_at)` instead — which ONLY
 *  advances when a pass actually WRITES a new row. A finished tournament
 *  (nothing new to ingest — every row already exists, `ON CONFLICT DO
 *  NOTHING` short-circuits every insert) or a ratelimited/errored Cargo call
 *  never advances that stamp, so it stayed pinned at whatever its last real
 *  ingest was — permanently "stalest," permanently winning cursor=0,
 *  permanently starving every ongoing tournament behind it. lib/prostage/
 *  ingest.ts now upserts coachbuild.prostage_ingest_attempts at the START of
 *  every tournament pass (before the Cargo call even runs), so the stamp
 *  advances on EVERY attempt regardless of outcome — closing the gap the
 *  previous version of this function flagged as a known, unclosed risk. */
export async function orderByStaleness(
  sql: NonNullable<ReturnType<typeof getSql>>,
  pages: string[]
): Promise<string[]> {
  if (pages.length === 0) return pages;
  const rows = (await sql`
    SELECT ov.overview_page AS overview_page,
           COALESCE(pia.attempted_at, 'epoch'::timestamptz) AS last_ingested
    FROM unnest(${pages}::text[]) AS ov(overview_page)
    LEFT JOIN coachbuild.prostage_ingest_attempts pia ON pia.overview_page = ov.overview_page
    ORDER BY last_ingested ASC
  `) as unknown as StalenessRow[];
  return rows.map((r) => r.overview_page);
}
