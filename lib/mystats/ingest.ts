// ─────────────────────────────────────────────────────────────────────────────
// lib/mystats/ingest.ts — match backfill/incremental ingest for the ONE
// personal account this feature tracks. Shares lib/pro's low-level Riot
// client/pacer (lib/pro/riot.ts, lib/pro/pacer.ts is process-wide underneath
// it) and db client (lib/pro/db.ts) — same pattern as lib/pro/ingestMatches.ts,
// scaled down from "many accounts" to "exactly one."
//
// TWO DISTINCT MODES (per the feature brief — "initial backfill cap ~400
// matches via the script; incremental cron picks up new ones"):
//
//  - "backfill": walks FORWARD through match-v5's offset pagination
//    (start=0,100,200,...) starting from a PERSISTED cursor
//    (coachbuild.my_ingest_cursor — mirrors lib/draft/ingest.ts's
//    getPersistedCursor/setPersistedCursor pattern), so an interrupted
//    backfill run resumes without re-fetching pages already processed. Stops
//    at BACKFILL_CAP total matches examined OR when a page comes back
//    shorter than pageSize (genuinely exhausted history) — whichever comes
//    first — and marks `backfill_done` so a re-run of the script is a cheap
//    no-op instead of re-walking from scratch.
//  - "incremental": always re-checks from start=0 (Riot returns newest-first)
//    with a small page size — new games since the last run are always at
//    the front, so there is nothing to persist here. Relies entirely on the
//    ON CONFLICT DO NOTHING at insert time for idempotency, same as
//    lib/pro/ingestMatches.ts.
//
// QUEUE FILTER: deliberately NONE at the ids-fetch step (see lib/pro/riot.ts's
// getMatchIdsByPuuid — `queue` param made optional for exactly this caller).
// The brief's target queues are 420/440/400/430 (ranked+normal), but this
// ingest fetches EVERY queue (including ARAM=450) and stores all of them
// with their real queue_id — see extract.ts's header for why rows are never
// dropped for an unresolved lane. Filtering by queue happens at READ time
// (lib/mystats/aggregate.ts's callers), not at ingest time — one paginated
// stream instead of four interleaved per-queue ones, and no games are ever
// silently discarded before they're even looked at.
//
// SEASON SCOPING (user refinement, 2026-07-21): My Stats covers the CURRENT
// SEASON only (see lib/mystats/season.ts's SEASON_START_MS + its source
// citation). Applied in TWO redundant layers inside ingestOnePage below —
// `startTime` on the ids fetch (list-level) and a row-level `isInSeason`
// guard right before INSERT (belt-and-braces, since `startTime` is a
// Riot-documented list filter, not a hard per-row guarantee). BACKFILL_CAP
// now effectively caps "in-season matches examined" rather than "matches
// examined regardless of season," since pre-season ids are filtered out at
// the Riot API level before they ever count against it.
// ─────────────────────────────────────────────────────────────────────────────

import { getSql } from "@/lib/pro/db";
import { DbUnavailableError, RiotUnavailableError } from "@/lib/pro/errors";
import { getMatch, getMatchIdsByPuuid, RiotRequestError } from "@/lib/pro/riot";
import { extractMyMatch } from "./extract";
import { ensureMyAccount, type ResolvedMyAccount } from "./account";
import { SEASON_START_MS, isInSeason, seasonStartEpochSec } from "./season";
import type { MyRiotMatch } from "./types";

/** Riot match-v5 ids endpoint's own documented max `count` per call. */
export const PAGE_SIZE = 100;
/** Hard ceiling for a backfill walk (~1 year of a moderately active
 *  account) — see this file's header. Once reached, backfill is marked
 *  done even if older history exists; a personal build-inspiration feature
 *  has no need to go back further than this. */
export const BACKFILL_CAP = 400;
/** Small page for the daily incremental check — a handful of games/day at
 *  most; large enough to never miss a day even after a missed cron tick. */
export const INCREMENTAL_PAGE_SIZE = 30;

export interface MyStatsIngestOptions {
  mode: "backfill" | "incremental";
  /** Explicit start offset — overrides the persisted cursor (backfill mode
   *  only) and is never itself persisted, mirroring lib/draft/ingest.ts's
   *  route contract (manual/debug driving can't be knocked off course by,
   *  or interfere with, the cron's own automatic progression). Ignored in
   *  incremental mode (always start=0). */
  start?: number;
  pageSize?: number;
  onProgress?: (msg: string) => void;
}

export interface MyStatsIngestResult {
  /** True when there is no resolved personal account to ingest for at all
   *  (wrong tag guess, or Riot/DB unreachable at resolve time) — the ingest
   *  degrades to a no-op rather than throwing, matching the feature's
   *  "clear accountUnresolved state" contract (surfaced identically by the
   *  aggregation routes). */
  accountUnresolved: boolean;
  matchesSeen: number;
  matchesUpserted: number;
  /** Backfill mode only: the offset to resume from next time, or null once
   *  the walk is done (exhausted history or hit BACKFILL_CAP). Always null
   *  for incremental mode (nothing to resume — it starts fresh every time). */
  nextStart: number | null;
  errors: string[];
}

async function getPersistedCursor(sql: NonNullable<ReturnType<typeof getSql>>): Promise<{ nextStart: number; done: boolean }> {
  const rows = (await sql`
    SELECT next_start, backfill_done FROM coachbuild.my_ingest_cursor WHERE id = 1
  `) as unknown as { next_start: number; backfill_done: boolean }[];
  const row = rows[0];
  return row ? { nextStart: row.next_start, done: row.backfill_done } : { nextStart: 0, done: false };
}

async function persistCursor(
  sql: NonNullable<ReturnType<typeof getSql>>,
  nextStart: number,
  done: boolean
): Promise<void> {
  await sql`
    INSERT INTO coachbuild.my_ingest_cursor (id, next_start, backfill_done, updated_at)
    VALUES (1, ${nextStart}, ${done}, now())
    ON CONFLICT (id) DO UPDATE SET next_start = EXCLUDED.next_start, backfill_done = EXCLUDED.backfill_done, updated_at = now()
  `;
}

/** Fetches+extracts+inserts one page of matches starting at `start`. Returns
 *  the number of ids seen (page length, before existing-filter) and the
 *  number actually newly upserted.
 *
 *  SEASON SCOPING (user refinement, 2026-07-21 — see lib/mystats/season.ts):
 *  two layers, deliberately redundant --
 *   1. `startTime` on the ids fetch below asks Riot to never return a
 *      pre-season match id in the first place (list-level filter).
 *   2. The `isInSeason` guard right before INSERT drops any row that slips
 *      through anyway — Riot's `startTime` is documented as filtering the
 *      match LIST, not a hard per-match guarantee, so this is belt-and-
 *      braces, not decorative. A pre-season match id costs one paced Riot
 *      call to rule out (getMatch already happened by the time we can
 *      check gameCreation) but is never stored. */
async function ingestOnePage(
  sql: NonNullable<ReturnType<typeof getSql>>,
  account: ResolvedMyAccount,
  start: number,
  pageSize: number,
  errors: string[],
  log: (msg: string) => void
): Promise<{ seen: number; upserted: number }> {
  const ids = await getMatchIdsByPuuid(account.routing.regional, account.puuid, {
    start,
    count: pageSize,
    startTime: seasonStartEpochSec(),
  });
  if (ids.length === 0) return { seen: 0, upserted: 0 };

  const existingRows = (await sql`
    SELECT match_id FROM coachbuild.my_matches WHERE match_id = ANY(${ids}::text[])
  `) as unknown as { match_id: string }[];
  const existing = new Set(existingRows.map((r) => r.match_id));
  const newIds = ids.filter((id) => !existing.has(id));

  let upserted = 0;
  for (const matchId of newIds) {
    try {
      const raw = await getMatch(account.routing.regional, matchId);
      const match = raw as unknown as MyRiotMatch;
      const row = extractMyMatch(match, account.puuid);
      if (!row) {
        log(`match ${matchId}: puuid not found in participants, skipping`);
        continue;
      }
      if (!isInSeason(new Date(row.gameCreation).getTime())) {
        log(`match ${matchId}: pre-season (game_creation < ${new Date(SEASON_START_MS).toISOString()}), skipping`);
        continue;
      }
      await sql`
        INSERT INTO coachbuild.my_matches (
          match_id, queue_id, game_creation, patch, champion_id, role, opp_champion_id, win
        ) VALUES (
          ${row.matchId}, ${row.queueId}, ${row.gameCreation}, ${row.patch},
          ${row.championId}, ${row.role}, ${row.oppChampionId}, ${row.win}
        )
        ON CONFLICT (match_id) DO NOTHING
      `;
      upserted += 1;
    } catch (err) {
      if (err instanceof RiotRequestError) {
        log(`match ${matchId}: riot ${err.status}, skipping`);
        errors.push(`match ${matchId}: riot ${err.status}`);
        continue;
      }
      throw err;
    }
  }
  return { seen: ids.length, upserted };
}

export async function runMyStatsIngest(opts: MyStatsIngestOptions): Promise<MyStatsIngestResult> {
  const sql = getSql();
  if (!sql) throw new DbUnavailableError();
  if (!process.env.RIOT_API_KEY) throw new RiotUnavailableError();

  const log = opts.onProgress ?? (() => {});
  const account = await ensureMyAccount(sql);
  if (!account) {
    return { accountUnresolved: true, matchesSeen: 0, matchesUpserted: 0, nextStart: null, errors: [] };
  }

  const errors: string[] = [];

  if (opts.mode === "incremental") {
    const pageSize = opts.pageSize ?? INCREMENTAL_PAGE_SIZE;
    const { seen, upserted } = await ingestOnePage(sql, account, 0, pageSize, errors, log);
    return { accountUnresolved: false, matchesSeen: seen, matchesUpserted: upserted, nextStart: null, errors };
  }

  // backfill mode
  const pageSize = opts.pageSize ?? PAGE_SIZE;
  const explicitStart = opts.start !== undefined;
  let cursor = explicitStart ? { nextStart: opts.start!, done: false } : await getPersistedCursor(sql);

  if (cursor.done && !explicitStart) {
    return { accountUnresolved: false, matchesSeen: 0, matchesUpserted: 0, nextStart: null, errors: [] };
  }

  let start = cursor.nextStart;
  let totalSeen = 0;
  let totalUpserted = 0;
  let done = false;

  while (totalSeen < BACKFILL_CAP) {
    const remaining = BACKFILL_CAP - totalSeen;
    const thisPageSize = Math.min(pageSize, remaining);
    log(`backfill page: start=${start} count=${thisPageSize}`);
    const { seen, upserted } = await ingestOnePage(sql, account, start, thisPageSize, errors, log);
    totalSeen += seen;
    totalUpserted += upserted;
    if (seen === 0 || seen < thisPageSize) {
      // Genuinely exhausted history (short/empty page) -- done regardless of
      // whether BACKFILL_CAP was reached.
      done = true;
      start += seen;
      break;
    }
    start += seen;
  }
  if (!done && totalSeen >= BACKFILL_CAP) done = true; // cap reached -- see this file's header

  const nextStart = done ? 0 : start; // wrap to 0 once done, mirrors draft ingest cursor's convention
  if (!explicitStart) {
    await persistCursor(sql, nextStart, done);
  }

  return {
    accountUnresolved: false,
    matchesSeen: totalSeen,
    matchesUpserted: totalUpserted,
    nextStart: done ? null : start,
    errors,
  };
}
