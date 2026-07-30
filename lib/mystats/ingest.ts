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
//    and PAGES FORWARD UNTIL IT OVERLAPS what is already stored (2026-07-30 —
//    see "INCREMENTAL PAGES UNTIL OVERLAP" below; it used to fetch exactly one
//    page of 30 and stop, which silently truncated a second account's history).
//    Relies on the ON CONFLICT DO NOTHING at insert time for idempotency, same
//    as lib/pro/ingestMatches.ts.
//
// ── INCREMENTAL PAGES UNTIL OVERLAP (2026-07-30, P1 fix) ────────────────────
//
// WHAT WAS WRONG. Incremental mode fetched ONE page of the newest
// INCREMENTAL_PAGE_SIZE (30) ids and stopped, and NOTHING anywhere schedules
// backfill mode — the daily cron (app/api/ingest/mystats/route.ts) and the
// page-view refresh (lib/mystats/refresh.ts) both run incremental only, and
// backfill is manual/script-only. Multi-account (migration 0020) turned that
// into two silent data holes:
//   * Link a second account -> it gets its newest 30 games and NOTHING older,
//     ever, while the page labels that "Season 2026". A confident win rate over
//     a truncated denominator.
//   * Switch away, play more than 30 games, switch back -> games 31..N fall off
//     the back of the single page and are never fetched. `backfill_done = true`
//     on the pre-existing account then blocked a deeper walk from fixing it.
// Both are HARD RULE 4 violations of the quiet kind: no error, no empty state,
// just a wrong number.
//
// THE ALGORITHM. Page forward from start=0 until a page contains a match id
// ALREADY STORED FOR THIS ACCOUNT. That is the standard correct incremental-sync
// termination condition, and it fixes both cases with one mechanism: for a
// freshly linked account with nothing stored there is no overlap to find, so
// "until overlap" keeps going until the season window is exhausted — which IS
// the backfill. No separate trigger is needed and none was added.
//
// OVERLAP ALONE IS NOT A COMPLETENESS PROOF, and this is the part that is easy
// to get wrong. "I have seen this game before" only means "fully synced" if
// everything BEHIND that point was walked too. So the walk consults the
// persisted flag first and only stops on overlap when the history is already
// known complete (`stopOnOverlap` below). Otherwise it walks to exhaustion to
// EARN that flag. Without this, a run that stopped part-way would store a fresh
// block at the front, and the NEXT run would find overlap on page 0 and declare
// itself synced over the hole it just created — the same defect one level up.
//
// WHAT `backfill_done` MEANS NOW (the reconciliation — one flag, one meaning,
// two writers who agree on it; it is NOT retired):
//
//     backfill_done = true  <=>  every match in this account's season window,
//                                down to the depth this app walks
//                                (INCREMENTAL_DEPTH_CAP == BACKFILL_CAP), has
//                                been EXAMINED at least once.
//
// That is the same thing backfill mode already meant by it (including its
// cap-reached case: "as deep as this feature goes" — see BACKFILL_CAP), so no
// migration and no column rename. What changed is that incremental mode now
// both READS it (as its stop-on-overlap licence) and WRITES it — setting it true
// when it proves the window exhausted, and CLEARING it when a per-run limit cut
// a walk short. `next_start` stays backfill-mode-only resume state: incremental
// never reads or writes it, and always re-walks from 0, which costs one cheap id
// page per 100 already-stored ids and can therefore never trust a stale offset.
// "Examined" is deliberately not "stored": a match Riot refuses to serve, or a
// pre-season row dropped by the season guard, is examined and does not hold the
// flag hostage forever.
//
// A TRUNCATION IS NEVER SILENT. Three per-run limits can stop the walk before it
// proves completeness (INCREMENTAL_CALL_BUDGET, INCREMENTAL_DEADLINE_MS,
// INCREMENTAL_MAX_PAGES). When one does, the run (a) logs the reason, (b)
// persists backfill_done = false so the NEXT run resumes the deep walk instead
// of stopping at the false overlap, and (c) reports `truncatedBy` on its result,
// which lib/mystats/refresh.ts and both routes pass through. A truncated walk
// that reported success would reintroduce exactly the bug being fixed.
//
// KILL-SAFE BY CONSTRUCTION. Matches are inserted one at a time and the flag is
// only ever written at the END of a proven walk, so a process killed mid-walk
// loses nothing, duplicates nothing (ON CONFLICT (puuid, match_id) DO NOTHING),
// and leaves backfill_done at its old value — false if it was mid-catch-up, and
// if it was true the next run's front-fill re-checks the front anyway.
//
// THE WINDOW IS NEVER WIDENED. `startTime: seasonStartEpochSec()` is passed on
// every id page in both modes, so the walk cannot reach behind the season
// boundary no matter how many pages it takes — the deep walk paginates INSIDE
// the window, exactly as scripts/ingest-otp-priority.mjs does inside
// lib/pro/fresh.ts's 90-day one. (NOTE for anyone carrying that comparison over:
// my_matches' boundary is the SEASON start, ~7 months, not 90 days. The 90-day
// figure is FRESH_WINDOW_DAYS and governs the pro/OTP pipelines, not this one.)
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
import { computeAdherence } from "./adherence";
import { ensureActiveAccount, type ResolvedMyAccount } from "./account";
import { SEASON_START_MS, isInSeason, seasonStartEpochSec } from "./season";
import { buildRecommendations, NotPlayedInRoleError } from "../recommend";
import { getLatestPatch } from "../staticData";
import type { RoleId } from "../types";
import type { ExtractedMyMatch, MyRiotMatch } from "./types";

// ── Build-adherence resolution (v0.51) ──────────────────────────────────────
//
// "Is this match on the recommended WPA build?" needs the SAME recommendation
// the Builds page itself shows -- reusing lib/recommend.ts's buildRecommendations
// directly (no self-HTTP-fetch of /api/build) is both cheaper and can't drift
// from what /api/build actually returns.
//
// CRITICAL LIMITATION (document, don't paper over): buildRecommendations has
// NO historical-patch override -- it always evaluates against
// getLatestPatch()'s CURRENT resolved patch internally, regardless of what
// patch is passed here. Comparing a match played on an OLDER patch against
// today's current-patch recommendation would be a dishonest signal (the
// recommended build for 16.9 is not "the recommended build" for a 16.5 game).
// So resolution below is gated on `patch === currentPatchLabel` -- in
// practice this means only matches from TODAY's live patch (overwhelmingly
// incremental-mode games; a long backfill walk spans many older patches and
// gets `on_wpa_build: null` for almost all of it, which is the honest
// outcome, not a bug). Once/if lib/recommend.ts grows a patch parameter, this
// gate can be dropped and every in-season row can be resolved.
//
// Cached per (championId, role, patch) WITHIN one ingest run -- a personal
// account plays a small, repeated champion pool, so this keeps the number of
// (expensive, multi-endpoint) buildRecommendations calls bounded to the
// distinct combos actually seen in the batch, not one per match. Resolution
// stays fully SEQUENTIAL (awaited inline in the same per-match loop that
// already paces Riot calls) -- no parallel fan-out is added.
export interface RecommendedSignature {
  coreItemIds: number[];
  keystoneId: number;
}

/** Exported (not just used internally by ingestOnePage below) so
 *  scripts/backfill-mystats-kda.mjs can reuse the EXACT same resolution +
 *  patch-gate + per-run cache contract for old rows that predate migration
 *  0014 — see that script's header for why reuse beats reimplementing this. */
export async function resolveRecommendedBuild(
  cache: Map<string, RecommendedSignature | null>,
  currentPatchLabel: string,
  championId: number,
  role: number,
  patch: string,
  log: (msg: string) => void
): Promise<RecommendedSignature | null> {
  if (role < 0 || role > 4) return null; // unresolved lane (ARAM/remake) -- no per-role recommendation exists
  if (patch !== currentPatchLabel) return null; // see this file's header -- only today's live patch is comparable

  const key = `${championId}:${role}:${patch}`;
  if (cache.has(key)) return cache.get(key)!;

  try {
    const [top] = await buildRecommendations(championId, role as RoleId);
    const sig: RecommendedSignature | null = top
      ? {
          coreItemIds: [top.items.first.id, top.items.second.id, top.items.third.id],
          keystoneId: top.runes.keystone.id,
        }
      : null;
    cache.set(key, sig);
    return sig;
  } catch (err) {
    // NotPlayedInRoleError (no coachless data for this champ/role/patch) or
    // any other transient failure -- both mean "no recommendation available",
    // never a thrown error that would sink the whole ingest run.
    if (!(err instanceof NotPlayedInRoleError)) {
      log(`recommend lookup for champ ${championId} role ${role}: ${err instanceof Error ? err.message : "unknown error"}`);
    }
    cache.set(key, null);
    return null;
  }
}

/** Riot match-v5 ids endpoint's own documented max `count` per call. */
export const PAGE_SIZE = 100;
/** Hard ceiling for a backfill walk (~1 year of a moderately active
 *  account) — see this file's header. Once reached, backfill is marked
 *  done even if older history exists; a personal build-inspiration feature
 *  has no need to go back further than this. */
export const BACKFILL_CAP = 400;
/** Small page for the STEADY-STATE incremental check (a history already known
 *  complete) — a handful of games/day at most, and large enough that one page
 *  reaches an already-stored game even after several missed cron ticks, which is
 *  what lets the walk stop after a single Riot call in the common case. A
 *  CATCH-UP walk uses INCREMENTAL_CATCHUP_PAGE_SIZE instead. */
export const INCREMENTAL_PAGE_SIZE = 30;

/** Page size while catching up an account whose history is NOT yet known
 *  complete. Riot charges one call per id page regardless of `count`, so a
 *  catch-up that must re-scan already-stored territory to reach the frontier
 *  crosses INCREMENTAL_DEPTH_CAP in 4 calls at 100/page instead of 14 at
 *  30/page. Same value as backfill mode's page for the same reason. */
export const INCREMENTAL_CATCHUP_PAGE_SIZE = PAGE_SIZE;

/** ONE incremental run's Riot-call ceiling — id pages and per-match fetches
 *  counted TOGETHER, because both go through the same 1.3s pacer
 *  (lib/pro/pacer.ts) against the same shared key (CLAUDE.md gotcha (d)).
 *
 *  30 IS DERIVED, NOT PICKED. Both callers of incremental mode declare
 *  `maxDuration = 60` (app/api/mystats/refresh/route.ts and
 *  app/api/ingest/mystats/route.ts). 30 paced calls is ~39s, leaving room for
 *  the DB round trips and any coachless recommend lookups and still landing
 *  inside the 60s wall WITH the cursor write done. Raising this without raising
 *  maxDuration does not fetch more games — it gets the function killed before it
 *  can record what it did. A long-running caller (scripts/**) can pass a bigger
 *  `callBudget`; nothing in the app should. */
export const INCREMENTAL_CALL_BUDGET = 30;

/** Wall-clock stop for one incremental run. The call budget bounds Riot time,
 *  but resolveRecommendedBuild's coachless lookups are not paced and not
 *  individually bounded, so a clock is the only guard that actually maps to
 *  `maxDuration`. Deliberately well under 60s — the run still has to persist its
 *  cursor and serialise a response after stopping. */
export const INCREMENTAL_DEADLINE_MS = 45_000;

/** Belt-and-braces page ceiling for one incremental run: a bound that still
 *  holds if the other two somehow do not. INCREMENTAL_DEPTH_CAP is what normally
 *  ends a catch-up walk (20 pages x 100 = 2000 ids, five times that depth). */
export const INCREMENTAL_MAX_PAGES = 20;

/** How deep an incremental catch-up will ever walk, in match ids examined.
 *  Deliberately the SAME number as BACKFILL_CAP: since 2026-07-30 both paths
 *  mean the same thing by `backfill_done`, so they must agree on where "as deep
 *  as this feature goes" is. Changing one without the other would make the flag
 *  mean two things. */
export const INCREMENTAL_DEPTH_CAP = BACKFILL_CAP;

export interface MyStatsIngestOptions {
  mode: "backfill" | "incremental";
  /** Explicit start offset — overrides the persisted cursor (backfill mode
   *  only) and is never itself persisted, mirroring lib/draft/ingest.ts's
   *  route contract (manual/debug driving can't be knocked off course by,
   *  or interfere with, the cron's own automatic progression). Ignored in
   *  incremental mode (always starts at 0 and pages forward — see this file's
   *  header). */
  start?: number;
  pageSize?: number;
  onProgress?: (msg: string) => void;
  /** Incremental mode: Riot calls this run may spend (id pages + match fetches).
   *  Defaults to INCREMENTAL_CALL_BUDGET, which is sized for a 60s serverless
   *  invocation — only a long-running script should raise it. */
  callBudget?: number;
  /** Incremental mode: wall-clock ms this run may take. `null` disables the
   *  deadline, for callers with no serverless wall (scripts/**). Defaults to
   *  INCREMENTAL_DEADLINE_MS. */
  deadlineMs?: number | null;
  /** Injectable clock — tests drive the deadline with it. */
  now?: () => number;
}

/** ONE run's spend, shared by every page of that run and mutated as calls are
 *  made. Deliberately mutable and passed down rather than returned back up: the
 *  budget has to be consulted BETWEEN individual match fetches inside a page,
 *  not just between pages, or one page of 100 new matches would blow it. */
interface RunBudget {
  /** Riot calls left. `Infinity` for backfill mode, which is script-paced and
   *  bounded by BACKFILL_CAP instead. */
  callsLeft: number;
  /** Epoch ms after which the walk must stop; null = no deadline. */
  deadlineAt: number | null;
  now: () => number;
}

/** Non-null = the walk must stop NOW, and the string says why (it is logged and
 *  returned verbatim as `truncatedBy`, so it has to read as an explanation). */
function budgetExceeded(budget: RunBudget): string | null {
  if (budget.callsLeft <= 0) return `per-run Riot call budget spent (${INCREMENTAL_CALL_BUDGET} calls)`;
  if (budget.deadlineAt !== null && budget.now() >= budget.deadlineAt) {
    return `per-run deadline reached (${INCREMENTAL_DEADLINE_MS}ms, sized for maxDuration=60)`;
  }
  return null;
}

/** Backfill mode's budget: none. That path is driven by
 *  scripts/ingest-mystats.mjs in a long-lived process and is already bounded by
 *  BACKFILL_CAP, and giving it a serverless-sized budget would silently shrink
 *  the one tool that can walk a whole history in one go. A FUNCTION rather than a
 *  shared constant because a RunBudget is mutated as calls are spent — one shared
 *  instance would be shared mutable state between concurrent runs, which happens
 *  to be harmless at Infinity and would stop being harmless the moment anyone
 *  gave it a finite value. */
function unboundedBudget(): RunBudget {
  return { callsLeft: Infinity, deadlineAt: null, now: Date.now };
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
  /** After this run: is this account's season-window history known to have been
   *  fully examined, down to INCREMENTAL_DEPTH_CAP? This is exactly the value
   *  now persisted in my_ingest_cursor.backfill_done — see this file's header
   *  for what that flag means and who writes it. */
  historyComplete: boolean;
  /** Non-null when a per-run limit stopped the walk BEFORE it could prove
   *  completeness — the reason, verbatim. The whole point of surfacing it is
   *  that a truncated sync must not read as a finished one: `historyComplete`
   *  is false whenever this is set, and the persisted flag is cleared to match.
   *  Always null in backfill mode, whose only stop conditions (exhausted
   *  history, BACKFILL_CAP) both mean "as deep as this feature walks". */
  truncatedBy: string | null;
  /** Id pages this run walked. 1 is the healthy steady state for incremental. */
  pagesWalked: number;
  errors: string[];
}

/** What one page of the walk learned. */
interface PageResult {
  /** Ids in the page, BEFORE the already-stored filter. */
  seen: number;
  upserted: number;
  /** At least one id on this page was ALREADY stored for this account before the
   *  page was processed. THE overlap signal — but only a completeness proof when
   *  the history is already known complete; see this file's header. */
  overlap: boolean;
  /** Non-null when the budget stopped this page part-way, i.e. some of its ids
   *  were never examined. A page that stopped this way must never be treated as
   *  fully walked. */
  budgetStopped: string | null;
}

/** PER-ACCOUNT since migration 0020. This was the single id=1 row, and it is
 *  the reason "just repoint the account" could never have worked: the live row
 *  reads backfill_done = true, so a brand-new account's completely empty
 *  history would have been treated as already fully walked and backfill mode
 *  would have returned a no-op forever. A missing row (an account never
 *  backfilled) correctly reads as start-from-0-and-not-done. */
async function getPersistedCursor(
  sql: NonNullable<ReturnType<typeof getSql>>,
  puuid: string
): Promise<{ nextStart: number; done: boolean }> {
  const rows = (await sql`
    SELECT next_start, backfill_done FROM coachbuild.my_ingest_cursor WHERE puuid = ${puuid}
  `) as unknown as { next_start: number; backfill_done: boolean }[];
  const row = rows[0];
  return row ? { nextStart: row.next_start, done: row.backfill_done } : { nextStart: 0, done: false };
}

/** READ-ONLY view of the completeness flag, for surfaces that need to know
 *  whether the numbers they are about to render sit on a whole history or a
 *  partial one (app/api/mystats/summary/route.ts). Exported from HERE rather than
 *  re-queried at the call site on purpose: this module defines what
 *  `backfill_done` means, and a second copy of the query is what silently misses
 *  the next change to it (CLAUDE.md gotcha (dd)). */
export async function readHistoryComplete(
  sql: NonNullable<ReturnType<typeof getSql>>,
  puuid: string
): Promise<boolean> {
  return (await getPersistedCursor(sql, puuid)).done;
}

async function persistCursor(
  sql: NonNullable<ReturnType<typeof getSql>>,
  puuid: string,
  nextStart: number,
  done: boolean
): Promise<void> {
  await sql`
    INSERT INTO coachbuild.my_ingest_cursor (puuid, next_start, backfill_done, updated_at)
    VALUES (${puuid}, ${nextStart}, ${done}, now())
    ON CONFLICT (puuid) DO UPDATE SET next_start = EXCLUDED.next_start, backfill_done = EXCLUDED.backfill_done, updated_at = now()
  `;
}

/** Incremental mode's ONLY cursor write. Touches `backfill_done` and nothing
 *  else — `next_start` keeps its existing value (or its DEFAULT 0 on a genuine
 *  first insert), because that column is backfill mode's resume offset and
 *  incremental never uses it. Two writers, one column, one meaning; see this
 *  file's header. */
async function persistHistoryComplete(
  sql: NonNullable<ReturnType<typeof getSql>>,
  puuid: string,
  complete: boolean
): Promise<void> {
  await sql`
    INSERT INTO coachbuild.my_ingest_cursor (puuid, backfill_done, updated_at)
    VALUES (${puuid}, ${complete}, now())
    ON CONFLICT (puuid) DO UPDATE SET backfill_done = EXCLUDED.backfill_done, updated_at = now()
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
  log: (msg: string) => void,
  buildCache: Map<string, RecommendedSignature | null>,
  currentPatchLabel: string,
  budget: RunBudget
): Promise<PageResult> {
  const stopBeforePage = budgetExceeded(budget);
  if (stopBeforePage) return { seen: 0, upserted: 0, overlap: false, budgetStopped: stopBeforePage };
  budget.callsLeft -= 1;
  const ids = await getMatchIdsByPuuid(account.routing.regional, account.puuid, {
    start,
    count: pageSize,
    startTime: seasonStartEpochSec(),
  });
  if (ids.length === 0) return { seen: 0, upserted: 0, overlap: false, budgetStopped: null };

  // ACCOUNT-SCOPED (migration 0020). Unscoped, this "already have it" check
  // would suppress a fetch for account B on the strength of account A's row,
  // and the game would never be stored for B at all.
  const existingRows = (await sql`
    SELECT match_id FROM coachbuild.my_matches
    WHERE puuid = ${account.puuid} AND match_id = ANY(${ids}::text[])
  `) as unknown as { match_id: string }[];
  const existing = new Set(existingRows.map((r) => r.match_id));
  const newIds = ids.filter((id) => !existing.has(id));
  // Computed from the state BEFORE this page's inserts, which is what makes it a
  // valid overlap signal: pages are disjoint offset windows, so nothing this run
  // stored on an earlier page can appear here and fake an overlap.
  const overlap = existing.size > 0;

  let upserted = 0;
  let budgetStopped: string | null = null;
  for (const matchId of newIds) {
    // Checked per MATCH, not per page: one page can be 100 unstored matches, and
    // a budget consulted only between pages would spend all 100.
    const stopMidPage = budgetExceeded(budget);
    if (stopMidPage) {
      budgetStopped = stopMidPage;
      break;
    }
    budget.callsLeft -= 1;
    try {
      const raw = await getMatch(account.routing.regional, matchId);
      const match = raw as unknown as MyRiotMatch;
      const row: ExtractedMyMatch | null = extractMyMatch(match, account.puuid);
      if (!row) {
        log(`match ${matchId}: puuid not found in participants, skipping`);
        continue;
      }
      if (!isInSeason(new Date(row.gameCreation).getTime())) {
        log(`match ${matchId}: pre-season (game_creation < ${new Date(SEASON_START_MS).toISOString()}), skipping`);
        continue;
      }
      // SEQUENTIAL, cached per (champ, role, patch) -- see resolveRecommendedBuild's header.
      const recommended = await resolveRecommendedBuild(
        buildCache,
        currentPatchLabel,
        row.championId,
        row.role,
        row.patch,
        log
      );
      const onWpaBuild = computeAdherence({
        matchItemIds: row.itemIds,
        matchKeystone: row.primaryKeystone,
        recommendedCoreItemIds: recommended?.coreItemIds ?? [],
        recommendedKeystoneId: recommended?.keystoneId ?? null,
      });
      await sql`
        INSERT INTO coachbuild.my_matches (
          puuid, match_id, queue_id, game_creation, patch, champion_id, role, opp_champion_id, win,
          kills, deaths, assists, item_ids, primary_keystone, on_wpa_build, split
        ) VALUES (
          ${account.puuid}, ${row.matchId}, ${row.queueId}, ${row.gameCreation}, ${row.patch},
          ${row.championId}, ${row.role}, ${row.oppChampionId}, ${row.win},
          ${row.kills}, ${row.deaths}, ${row.assists}, ${row.itemIds}::integer[], ${row.primaryKeystone},
          ${onWpaBuild}, ${row.split}
        )
        ON CONFLICT (puuid, match_id) DO NOTHING
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
  return { seen: ids.length, upserted, overlap, budgetStopped };
}

export async function runMyStatsIngest(opts: MyStatsIngestOptions): Promise<MyStatsIngestResult> {
  const sql = getSql();
  if (!sql) throw new DbUnavailableError();
  if (!process.env.RIOT_API_KEY) throw new RiotUnavailableError();

  const log = opts.onProgress ?? (() => {});
  const account = await ensureActiveAccount(sql);
  if (!account) {
    return {
      accountUnresolved: true,
      matchesSeen: 0,
      matchesUpserted: 0,
      nextStart: null,
      // NOT `true`. There is no account, so nothing is known about any history —
      // claiming completeness here would be the same class of confident-empty
      // answer this whole fix exists to remove.
      historyComplete: false,
      truncatedBy: null,
      pagesWalked: 0,
      errors: [],
    };
  }

  const errors: string[] = [];
  // Per-run cache, shared across every page's per-match loop below -- see
  // resolveRecommendedBuild's header for why this is keyed AND scoped this way.
  const buildCache = new Map<string, RecommendedSignature | null>();
  const currentPatchLabel = (await getLatestPatch()).label;

  if (opts.mode === "incremental") {
    return runIncrementalWalk(sql, account, opts, errors, log, buildCache, currentPatchLabel);
  }

  // backfill mode
  const pageSize = opts.pageSize ?? PAGE_SIZE;
  const explicitStart = opts.start !== undefined;
  const cursor = explicitStart
    ? { nextStart: opts.start!, done: false }
    : await getPersistedCursor(sql, account.puuid);

  if (cursor.done && !explicitStart) {
    return {
      accountUnresolved: false,
      matchesSeen: 0,
      matchesUpserted: 0,
      nextStart: null,
      historyComplete: true, // that is precisely what the flag being set means
      truncatedBy: null,
      pagesWalked: 0,
      errors: [],
    };
  }

  let start = cursor.nextStart;
  let totalSeen = 0;
  let totalUpserted = 0;
  let pagesWalked = 0;
  let done = false;

  while (totalSeen < BACKFILL_CAP) {
    const remaining = BACKFILL_CAP - totalSeen;
    const thisPageSize = Math.min(pageSize, remaining);
    log(`backfill page: start=${start} count=${thisPageSize}`);
    const { seen, upserted } = await ingestOnePage(
      sql,
      account,
      start,
      thisPageSize,
      errors,
      log,
      buildCache,
      currentPatchLabel,
      unboundedBudget()
    );
    pagesWalked += 1;
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
    await persistCursor(sql, account.puuid, nextStart, done);
  }

  return {
    accountUnresolved: false,
    matchesSeen: totalSeen,
    matchesUpserted: totalUpserted,
    nextStart: done ? null : start,
    historyComplete: done,
    // Backfill has no per-run limit: both of its stop conditions (exhausted
    // history, BACKFILL_CAP) mean "as deep as this feature walks", which is
    // completeness under this flag's definition, not truncation.
    truncatedBy: null,
    pagesWalked,
    errors,
  };
}

/**
 * INCREMENTAL MODE — pages forward from the newest game until it overlaps what is
 * already stored, or the season window runs out, or a per-run limit stops it.
 * Read this file's header before changing anything here; the ordering of the
 * three stop conditions and the `stopOnOverlap` licence are the correctness of
 * the whole feature, not implementation detail.
 */
async function runIncrementalWalk(
  sql: NonNullable<ReturnType<typeof getSql>>,
  account: ResolvedMyAccount,
  opts: MyStatsIngestOptions,
  errors: string[],
  log: (msg: string) => void,
  buildCache: Map<string, RecommendedSignature | null>,
  currentPatchLabel: string
): Promise<MyStatsIngestResult> {
  const cursor = await getPersistedCursor(sql, account.puuid);
  // THE SOUNDNESS CONDITION. Overlap only proves "fully synced" when everything
  // behind the overlap point is already known walked. When it is not, this walk
  // must reach the end of the window to EARN the flag instead.
  const stopOnOverlap = cursor.done;
  const pageSize = opts.pageSize ?? (stopOnOverlap ? INCREMENTAL_PAGE_SIZE : INCREMENTAL_CATCHUP_PAGE_SIZE);
  const now = opts.now ?? Date.now;
  const deadlineMs = opts.deadlineMs === undefined ? INCREMENTAL_DEADLINE_MS : opts.deadlineMs;
  const budget: RunBudget = {
    callsLeft: opts.callBudget ?? INCREMENTAL_CALL_BUDGET,
    deadlineAt: deadlineMs === null ? null : now() + deadlineMs,
    now,
  };

  let start = 0;
  let pagesWalked = 0;
  let totalSeen = 0;
  let totalUpserted = 0;
  let complete = false;
  let truncatedBy: string | null = null;

  for (;;) {
    if (pagesWalked >= INCREMENTAL_MAX_PAGES) {
      truncatedBy = `per-run page ceiling reached (${INCREMENTAL_MAX_PAGES} pages)`;
      break;
    }
    const overBudget = budgetExceeded(budget);
    if (overBudget) {
      truncatedBy = overBudget;
      break;
    }

    // Clamped to the policy depth, exactly as backfill mode clamps to
    // BACKFILL_CAP. Without this a caller-supplied pageSize could reach up to
    // pageSize-1 ids PAST the depth cap and spend Riot calls on games this
    // feature has already decided not to walk.
    const thisPageSize = Math.min(pageSize, INCREMENTAL_DEPTH_CAP - start);
    const page = await ingestOnePage(
      sql,
      account,
      start,
      thisPageSize,
      errors,
      log,
      buildCache,
      currentPatchLabel,
      budget
    );
    pagesWalked += 1;
    totalSeen += page.seen;
    totalUpserted += page.upserted;

    // ORDER MATTERS. budgetStopped comes FIRST: a page cut off part-way has ids
    // it never examined, so neither the short-page nor the overlap test below
    // may be read off it.
    if (page.budgetStopped) {
      truncatedBy = page.budgetStopped;
      break;
    }
    // A page shorter than REQUESTED (including empty) means Riot has no more ids
    // inside the season window — the window is exhausted, which is completeness
    // whether or not any overlap was seen. Compared against thisPageSize, not
    // pageSize: a page cut short by the depth clamp is not an exhausted window,
    // and although both answers happen to be `complete` here, reading it the
    // other way would be right by accident.
    if (page.seen < thisPageSize) {
      complete = true;
      break;
    }
    if (page.overlap && stopOnOverlap) {
      complete = true;
      break;
    }
    start += page.seen;
    if (start >= INCREMENTAL_DEPTH_CAP) {
      // As deep as this feature walks -- the same boundary, and the same
      // meaning, as backfill mode's BACKFILL_CAP.
      complete = true;
      break;
    }
  }

  if (truncatedBy) {
    // LOUD, because a truncated sync that reads as a finished one is the exact
    // defect this replaced. The persisted flag below is the durable half.
    log(
      `INCOMPLETE SYNC for ${account.riotId}: stopped after ${pagesWalked} page(s) / ` +
        `${totalSeen} ids examined WITHOUT reaching already-synced games — ${truncatedBy}. ` +
        `my_ingest_cursor.backfill_done cleared so the next run resumes the catch-up; ` +
        `this account's stats are over a PARTIAL history until it does.`
    );
  } else if (!stopOnOverlap) {
    log(
      `catch-up complete for ${account.riotId}: ${pagesWalked} page(s), ${totalSeen} ids examined, ` +
        `${totalUpserted} new matches stored`
    );
  }

  // Written when the flag CHANGES, and additionally on any truncation so the row
  // exists to be inspected (a truncation recorded only by the absence of a row
  // is not much of a record). The steady-state case -- already complete, still
  // complete -- writes nothing, so a page view costs no cursor UPDATE.
  if (complete !== cursor.done || truncatedBy) {
    await persistHistoryComplete(sql, account.puuid, complete);
  }

  return {
    accountUnresolved: false,
    matchesSeen: totalSeen,
    matchesUpserted: totalUpserted,
    nextStart: null, // incremental never resumes from an offset -- it always re-walks from 0
    historyComplete: complete,
    truncatedBy,
    pagesWalked,
    errors,
  };
}
