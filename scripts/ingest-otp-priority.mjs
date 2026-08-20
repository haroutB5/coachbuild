#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// scripts/ingest-otp-priority.mjs — the CONTINUOUS, priority-driven deep walk
// of featured one-tricks. Runs for hours, yields the Riot key to the scheduled
// jobs the moment one starts, and resumes when it finishes.
//
//   npx tsx scripts/ingest-otp-priority.mjs --dry-run     # plan only, 0 Riot calls
//   npx tsx scripts/ingest-otp-priority.mjs --once        # one unit, then exit
//   npx tsx scripts/ingest-otp-priority.mjs --max-hours 10
//   npx tsx scripts/ingest-otp-priority.mjs --fleet       # spill into unplayed champions
//
// Read first: lib/otp/deepWalk.ts (the formula and why), lib/otp/riotYield.ts
// (the safety predicate), migrations/0019_otp_featured_deep.sql (the state).
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
// The scheduled jobs will NEVER deepen the fleet.
// ingest-otp-featured-scheduled.ps1 passes `--matches 40`, and the pagination
// loop in ingest-otp-featured.mjs is bounded by that same number, so it fetches
// one page and stops. Raising it there would blow that slot's 2h45 kill limit.
// Nothing else takes a champion from 39 stored games to 232.
//
// Meanwhile the key is IDLE roughly 10 hours a day: CoachBuildMatchIngest
// (01:20/07:20/13:20/19:20) and CoachBuildOtpIngest (04:20/10:20/16:20/22:20)
// occupy ~14h between them. This job is how that idle time gets used.
//
// ── THE ONE RULE THAT MATTERS ───────────────────────────────────────────────
// lib/pro/pacer.ts serialises Riot calls at 1.3s but only WITHIN a process, and
// Riot's live headers give the ceiling as `x-app-rate-limit: 100:120,20:1` —
// 100 requests per 2 minutes. The pacer's floor already runs at ~92% of it.
// There is NO headroom for a second caller, and exceeding the cap SUSPENDS the
// key for every surface in the app (CLAUDE.md gotcha (d)). So:
//
//   * the yield predicate is re-checked before EVERY unit, and again before
//     every match fetch inside a unit (5s verdict cache) — never once at
//     startup;
//   * "I could not look" counts as busy (riotYield.ts's fail-closed contract),
//     and a run of consecutive blind checks ABORTS rather than spinning;
//   * a single-instance lock stops two copies of this walk running, which the
//     yield predicate cannot catch because SELF_MARKER makes this walk
//     invisible to itself by design.
//
// ── UNIT OF WORK ────────────────────────────────────────────────────────────
// One unit = up to UNIT_MATCHES (6) match fetches for ONE champion, ~8s. Small
// on purpose: a unit is the longest this process can take to notice a scheduled
// job starting. The wrapper scripts are in RIOT_JOB_MARKERS precisely so we see
// the other job during its ~10s of npx/tsx startup, before its first Riot call.
// A unit longer than that startup would erase the margin.
//
// Everything a unit learns is persisted AS IT IS LEARNED — one row into
// otp_featured_scanned per match, immediately after fetching it — so a kill
// loses at most the single in-flight match, not the unit. Every insert is
// ON CONFLICT DO NOTHING, so a re-run duplicates nothing.
//
// ── THE 90-DAY WINDOW IS NEVER WIDENED ──────────────────────────────────────
// `startTime: freshStartTimeEpochSec()` is passed on every id page. Depth comes
// from paginating INSIDE lib/pro/fresh.ts's window, never from reaching further
// back — older games predate item overhauls and are actively misleading.
//
// ── LOGGING ─────────────────────────────────────────────────────────────────
// This process OWNS %LOCALAPPDATA%\CoachBuild\otp-priority.log and writes it
// directly, in UTF-8, bounding it itself. That is a deliberate difference from
// the sibling jobs, which let their .ps1 redirect stdout into the log and trim
// it once at slot start: that works for a 24-minute job and not for one meant
// to run for hours. Two writers on one file would also mean two encodings, the
// exact garbling ingest-otp-scheduled.ps1's header warns about. So the wrapper
// keeps its own small host log instead — see ingest-otp-priority.ps1.
// ─────────────────────────────────────────────────────────────────────────────
import { appendFileSync, readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { loadEnvLocal } from "./_env.mjs";

loadEnvLocal();

const { checkRiotJobsRunning, getProcessCommandLine, SELF_MARKER } = await import(
  "../lib/otp/riotYield.ts"
);
const {
  rankPriorities,
  resolveCursorAction,
  selectUnitIds,
  summarizeProgress,
  decideLock,
  trimLogText,
  DEPTH_TARGET,
  REEXHAUST_INTERVAL_MS,
} = await import("../lib/otp/deepWalk.ts");
const { getMatchIdsByPuuid, getMatch, getMatchTimeline, RiotRequestError } = await import("../lib/pro/riot.ts");
const { extractMatch } = await import("../lib/pro/extract.ts");
const { FEATURED_TIMELINE_GAME_LIMIT } = await import("../lib/otp/ingest.ts");
const { freshStartTimeEpochSec } = await import("../lib/pro/fresh.ts");
const { getAllChampions } = await import("../lib/staticData.ts");
const { getSql } = await import("../lib/pro/db.ts");
const { runMyStatsRefresh } = await import("../lib/mystats/refresh.ts");
const { getActiveAccount } = await import("../lib/mystats/account.ts");

// ── Tunables ────────────────────────────────────────────────────────────────

/** Matches fetched per unit. See "UNIT OF WORK" above — this is a YIELD
 *  LATENCY budget, not a throughput knob. Raising it does not make the walk
 *  faster (the pacer sets the rate); it only makes this process slower to
 *  notice a scheduled job starting. */
const UNIT_MATCHES = 6;

/** Riot's own page size for match ids. Asking for less would cost more calls
 *  per id learned; asking for more is rejected. */
const ID_PAGE_SIZE = 100;

/** How often to re-ask "is a scheduled job running?" while yielded. 30s against
 *  jobs that run 23-115 minutes is a rounding error of lost work, and it keeps
 *  the process cheap while parked. */
const YIELD_POLL_MS = 30_000;

/** Max age of a cached busy/free verdict when checking mid-unit. The probe
 *  costs a PowerShell spawn (~0.3-0.8s), so re-running it before all 6 match
 *  fetches would be a third of the unit's wall clock spent looking. 5s bounds
 *  the staleness to under four Riot calls. */
const YIELD_VERDICT_MAX_AGE_MS = 5_000;

/** How long to wait when the key is free but there is genuinely nothing to
 *  walk (every champion exhausted and resting). */
const IDLE_POLL_MS = 5 * 60_000;

/** Log a "still yielding" line this often, so a human reading the log can tell
 *  a parked process from a dead one. */
const YIELD_HEARTBEAT_MS = 15 * 60_000;

/** How often the walk refreshes the user's OWN recent games before recomputing
 *  priorities. coachbuild.my_matches only grows when the My Stats ingest runs,
 *  so without this a champion picked up today would not enter the priority list
 *  until the 20:00 UTC cron. 6h rather than literally nightly because an
 *  incremental refresh is a handful of Riot calls and a newly played champion
 *  is exactly what this walk most wants to know about.
 *
 *  NOTE: the clock is coachbuild.my_ingest_cursor.last_incremental_at, which
 *  the page-view endpoint (/api/mystats/refresh) also stamps. A user browsing
 *  My Stats therefore resets this interval — which is correct, the refresh
 *  happened, it just was not us who did it. A failed page-view attempt releases
 *  its exact lease by setting this column to NULL; that is read below as
 *  "never refreshed" and may make this walk try again, while the refresh
 *  itself remains lease-gated so the retry cannot duplicate an active run. */
const MINE_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Bounded like the sibling logs (~1MB, keep the newest half). */
const LOG_MAX_BYTES = 1024 * 1024;
const LOG_CHECK_EVERY = 100;

/** riotYield.ts fails CLOSED: an enumeration it cannot perform reads as busy.
 *  That is right for one check and wrong forever — a permanently blind process
 *  that keeps polling is not dangerous, but it is dead weight pretending to
 *  work. Abort loudly instead. 20 x 30s = 10 minutes of blindness. */
const MAX_BLIND_CHECKS = 20;

/** A 429 means something is spending the key that the predicate did not see.
 *  Back off hard and say so — this is the alarm, not a retry. */
const RATE_LIMIT_BACKOFF_MS = 120_000;

/** After this many transient failures on ONE match id, record it as examined
 *  with an unknown champion rather than retrying forever. Without this a match
 *  Riot will not serve keeps a page permanently un-drained and the walk cannot
 *  advance past it — a real deadlock, not a theoretical one. */
const MAX_TRANSIENT_RETRIES = 3;

/** extractMatch reads `timeline.info` unconditionally, so a null timeline
 *  throws. Empty frames is the "we did not fetch one" sentinel for rows
 *  outside the featured account's capped timeline queue or failed retries. */
const NO_TIMELINE = { info: { frames: [] } };

// ── Args ────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const hasFlag = (f) => argv.includes(f);
function argValue(flag, fallback) {
  const i = argv.indexOf(flag);
  if (i < 0 || i + 1 >= argv.length) return fallback;
  return argv[i + 1];
}

const DRY_RUN = hasFlag("--dry-run");
const ONCE = hasFlag("--once");
const FLEET = hasFlag("--fleet");
const VERBOSE = hasFlag("--verbose") || Boolean(process.stdout.isTTY);
// 1, not 12 (changed 2026-08-20). Neon bills compute as wall-clock ACTIVE
// seconds and this walk queries continuously, so this number multiplied by the
// trigger frequency IS the monthly bill. A 12-hour walk on an hourly trigger is
// a ~89% duty cycle, which exhausted the shared Free-plan 100 CU-hour quota 19
// days into the August 2026 period and took the shop panel's Pro/OTP blocks
// with it. See scripts/ingest-otp-priority.ps1's "DUTY CYCLE IS A NEON BILL"
// header section before raising it.
const MAX_HOURS = Number(argValue("--max-hours", "1")) || 1;

// ── Logging ─────────────────────────────────────────────────────────────────

const LOG_DIR = path.join(
  process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || ".", "AppData", "Local"),
  "CoachBuild"
);
if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
const LOG_PATH = path.join(LOG_DIR, "otp-priority.log");
const LOCK_PATH = path.join(LOG_DIR, "otp-priority.lock");

let logWrites = 0;
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try {
    appendFileSync(LOG_PATH, line, "utf8");
    if (++logWrites % LOG_CHECK_EVERY === 0) boundLog();
  } catch {
    // A log write must never take the walk down. Fall through to stdout.
  }
  if (VERBOSE) process.stdout.write(line);
}

function boundLog() {
  try {
    if (!existsSync(LOG_PATH)) return;
    if (statSync(LOG_PATH).size <= LOG_MAX_BYTES) return;
    const trimmed = trimLogText(readFileSync(LOG_PATH, "utf8"), LOG_MAX_BYTES);
    if (trimmed !== null) writeFileSync(LOG_PATH, trimmed, "utf8");
  } catch {
    /* bounding is hygiene, never a reason to stop working */
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mins = (ms) => (ms / 60000).toFixed(1);

// ── Single-instance lock ────────────────────────────────────────────────────

let holdsLock = false;

async function acquireLock() {
  let record = null;
  try {
    record = JSON.parse(readFileSync(LOCK_PATH, "utf8"));
  } catch {
    record = null;
  }
  const living = record?.pid ? await getProcessCommandLine(record.pid) : null;
  const decision = decideLock(record, living, SELF_MARKER);
  if (!decision.take) {
    log(`NOT STARTING: another walk is already running (pid ${decision.pid}). Exiting.`);
    return false;
  }
  if (decision.reason !== "no-lock") {
    log(`lock taken over (${decision.reason}, previous pid ${record?.pid ?? "?"})`);
  }
  writeFileSync(
    LOCK_PATH,
    JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
    "utf8"
  );
  holdsLock = true;
  return true;
}

function releaseLock() {
  if (!holdsLock) return;
  holdsLock = false;
  try {
    unlinkSync(LOCK_PATH);
  } catch {
    /* nothing useful to do at exit */
  }
}

// ── Yield predicate, with a short verdict cache ─────────────────────────────

let cachedVerdict = null;
let cachedVerdictAt = 0;

async function getVerdict(maxAgeMs = 0) {
  if (cachedVerdict && Date.now() - cachedVerdictAt <= maxAgeMs) return cachedVerdict;
  cachedVerdict = await checkRiotJobsRunning();
  cachedVerdictAt = Date.now();
  return cachedVerdict;
}

/** riotYield.ts returns busy-with-no-matches ONLY for the fail-closed
 *  "could not enumerate" case; a genuine detection always carries at least one
 *  match. Structural, so this does not string-match the reason text. */
const isBlindVerdict = (v) => v.busy && v.matches.length === 0;

// ── State loading ───────────────────────────────────────────────────────────

/**
 * The priority inputs, read fresh from the DB every pass. NEVER snapshotted to
 * a file — deriving it live is what makes a newly played champion appear on its
 * own the moment my_matches grows.
 *
 * `storedGames` is counted the same way the featured card counts it
 * (puuid + champion_id), not as a bare otp_matches total: otp_matches still
 * holds rows from the retired eight-account consensus walk, and counting those
 * would report depth we do not have for the account we are actually paging.
 */
/** The ACTIVE linked account's puuid, re-read on EVERY pass rather than once at
 *  startup: this script runs as a long-lived loop (the CoachBuildOtpIngest
 *  scheduled task), so the user can switch accounts underneath it, and a
 *  startup-cached puuid would keep prioritising the old account's champion pool
 *  for the rest of the run. Null on any failure -- see loadStates for what a
 *  null means (zeros, never a union). */
async function activePuuid(sql) {
  try {
    const account = await getActiveAccount(sql);
    return account?.puuid ?? null;
  } catch {
    return null;
  }
}

/** `myPuuid` scopes the my_games count to the ACTIVE linked account (migration
 *  0020). Unscoped, every linked account's champion pool would be summed into
 *  one `myGames` figure, and the deep walk would spend Riot calls deepening
 *  champions the user does not currently play on the account they are playing.
 *  A null puuid (no active account) yields my_games 0 everywhere, which is what
 *  "we do not know what you play" honestly means -- never the union. */
async function loadStates(sql, championNames, myPuuid) {
  const rows = await sql`
    SELECT
      f.champion_id,
      f.puuid            AS featured_puuid,
      f.match_routing,
      COALESCE(mm.my_games, 0)::int      AS my_games,
      COALESCE(st.stored, 0)::int        AS stored_games,
      c.puuid            AS cursor_puuid,
      COALESCE(c.ids_offset, 0)::int     AS ids_offset,
      COALESCE(c.window_exhausted, false) AS window_exhausted,
      c.last_exhausted_at
    FROM coachbuild.otp_featured f
    LEFT JOIN (
      SELECT champion_id, count(*)::int AS my_games
      FROM coachbuild.my_matches
      WHERE puuid = ${myPuuid ?? ""}
      GROUP BY champion_id
    ) mm ON mm.champion_id = f.champion_id
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS stored
      FROM coachbuild.otp_matches om
      WHERE om.puuid = f.puuid AND om.champion_id = f.champion_id
    ) st ON true
    LEFT JOIN coachbuild.otp_featured_deep_cursor c ON c.champion_id = f.champion_id
  `;
  return rows.map((r) => ({
    championId: r.champion_id,
    championKey: championNames.get(r.champion_id) ?? String(r.champion_id),
    myGames: r.my_games,
    storedGames: r.stored_games,
    featuredPuuid: r.featured_puuid ?? null,
    matchRouting: r.match_routing ?? "europe",
    cursorPuuid: r.cursor_puuid ?? null,
    idsOffset: r.ids_offset,
    windowExhausted: r.window_exhausted,
    lastExhaustedAt: r.last_exhausted_at ? new Date(r.last_exhausted_at) : null,
  }));
}

/** Champions the user plays that have NO featured one-trick at all. They cannot
 *  be walked (no account to page) and the featured refresh owns fixing that —
 *  but they must be VISIBLE, or a champion that never deepens looks like a bug
 *  in this walk. */
async function loadUnfeaturedMine(sql, championNames, myPuuid) {
  const rows = await sql`
    SELECT champion_id, count(*)::int AS my_games
    FROM coachbuild.my_matches
    WHERE puuid = ${myPuuid ?? ""}
      AND champion_id NOT IN (SELECT champion_id FROM coachbuild.otp_featured)
    GROUP BY champion_id
    ORDER BY my_games DESC
  `;
  return rows.map((r) => ({
    championId: r.champion_id,
    championKey: championNames.get(r.champion_id) ?? String(r.champion_id),
    myGames: r.my_games,
  }));
}

// ── Cursor persistence ──────────────────────────────────────────────────────

async function persistCursor(sql, opts) {
  const {
    championId,
    puuid,
    idsOffset,
    windowExhausted,
    markExhaustedNow = false,
    dScanned = 0,
    dStored = 0,
    resetTotals = false,
  } = opts;
  await sql`
    INSERT INTO coachbuild.otp_featured_deep_cursor
      (champion_id, puuid, ids_offset, window_exhausted, last_exhausted_at,
       last_worked_at, scanned_total, stored_total)
    VALUES (
      ${championId}, ${puuid}, ${idsOffset}, ${windowExhausted}::boolean,
      CASE WHEN ${markExhaustedNow}::boolean THEN now() ELSE NULL END,
      now(), ${dScanned}, ${dStored}
    )
    ON CONFLICT (champion_id) DO UPDATE SET
      puuid            = EXCLUDED.puuid,
      ids_offset       = EXCLUDED.ids_offset,
      window_exhausted = EXCLUDED.window_exhausted,
      last_exhausted_at = CASE
        WHEN ${markExhaustedNow}::boolean THEN now()
        WHEN ${resetTotals}::boolean THEN NULL
        ELSE coachbuild.otp_featured_deep_cursor.last_exhausted_at END,
      last_worked_at   = now(),
      scanned_total    = CASE WHEN ${resetTotals}::boolean THEN ${dScanned}
                              ELSE coachbuild.otp_featured_deep_cursor.scanned_total + ${dScanned} END,
      stored_total     = CASE WHEN ${resetTotals}::boolean THEN ${dStored}
                              ELSE coachbuild.otp_featured_deep_cursor.stored_total + ${dStored} END
  `;
}

async function recordScanned(sql, puuid, matchId, workedFor, matchChampionId, stored) {
  await sql`
    INSERT INTO coachbuild.otp_featured_scanned
      (puuid, match_id, worked_for_champion_id, match_champion_id, stored)
    VALUES (${puuid}, ${matchId}, ${workedFor}, ${matchChampionId}, ${stored}::boolean)
    ON CONFLICT (puuid, match_id) DO NOTHING
  `;
}

// ── One unit of work ────────────────────────────────────────────────────────

/** In-memory id-page cache, keyed by champion. A 100-id page takes ~17 units to
 *  drain at 6 matches each; without this cache every one of those units would
 *  re-fetch the same page, a 17% Riot-call overhead for nothing. It is
 *  DELIBERATELY not persisted — after a restart, re-fetching one id page is a
 *  single call and the scanned table already knows which of its ids are done. */
const pageCache = new Map();

/** Transient-failure counts per match id, this process only. See
 *  MAX_TRANSIENT_RETRIES. */
const transientFailures = new Map();

let riotCalls = 0;
let rateLimited = false;

async function runUnit(sql, state) {
  const { championId, championKey, featuredPuuid: puuid, matchRouting: routing } = state;
  const action = resolveCursorAction(state, new Date(), REEXHAUST_INTERVAL_MS);
  const resetTotals = action.kind === "reset" && action.reason === "puuid-changed";

  if (action.kind === "reset" && (state.idsOffset !== 0 || state.windowExhausted)) {
    log(`${championKey}: cursor reset (${action.reason}) — restarting the window walk at 0`);
    pageCache.delete(championId);
  }
  let offset = action.offset;

  // ── Get this champion's current id page ──
  let cached = pageCache.get(championId);
  if (!cached || cached.puuid !== puuid || cached.offset !== offset) {
    const ids = await pagedIds(routing, puuid, offset);
    if (ids === null) return; // rate limited / transport failure, already logged
    cached = { puuid, offset, ids };
    pageCache.set(championId, cached);
    log(`${championKey}: id page start=${offset} -> ${ids.length} ids`);
  }

  // An empty page means the 90-day window holds nothing past this offset.
  if (cached.ids.length === 0) {
    log(`${championKey}: window exhausted at offset ${offset} (${state.storedGames} stored)`);
    pageCache.delete(championId);
    await persistCursor(sql, {
      championId,
      puuid,
      idsOffset: offset,
      windowExhausted: true,
      markExhaustedNow: true,
      resetTotals,
    });
    return;
  }

  // RECONCILE BEFORE READING. Migration 0019's backfill of otp_featured_scanned
  // is a one-shot snapshot, and the sibling jobs keep writing otp_matches after
  // it: measured 2026-07-29, otp_matches was at 14,189 rows against 13,105
  // backfilled, a 1,084-row gap opened by the CoachBuildOtpIngest run that was
  // live at the time. Every such row is a match we demonstrably HAVE and would
  // otherwise pay a Riot call to re-fetch and re-reject.
  //
  // So the walk repairs the gap for the ids it is about to consider, one cheap
  // indexed statement per page, zero Riot calls. Same shape as 0019's backfill,
  // scoped to this page. This is not a migration afterthought — the other jobs
  // never stop writing, so the reconcile has to live on the read path.
  await sql`
    INSERT INTO coachbuild.otp_featured_scanned
      (puuid, match_id, match_champion_id, stored, scanned_at)
    SELECT puuid, match_id, min(champion_id), true, min(ingested_at)
    FROM coachbuild.otp_matches
    WHERE puuid = ${puuid} AND match_id = ANY(${cached.ids}::text[])
    GROUP BY puuid, match_id
    ON CONFLICT (puuid, match_id) DO NOTHING
  `;

  const seenRows = await sql`
    SELECT match_id, match_champion_id FROM coachbuild.otp_featured_scanned
    WHERE puuid = ${puuid} AND match_id = ANY(${cached.ids}::text[])
  `;
  const seen = new Set(seenRows.map((r) => r.match_id));
  const seenChampions = new Map(seenRows.map((r) => [r.match_id, r.match_champion_id]));
  const selection = selectUnitIds(cached.ids, seen, UNIT_MATCHES);
  // Timeline coverage is an independent, capped queue: old featured rows
  // were already marked scanned by the deep walk, but NULL skill_order still
  // needs one retryable timeline pass. Only the first N most-recent ids for
  // this featured account are eligible; non-NULL rows are done forever.
  const timelineCandidateIds =
    offset < FEATURED_TIMELINE_GAME_LIMIT
      ? cached.ids.slice(0, FEATURED_TIMELINE_GAME_LIMIT - offset)
      : [];
  const timelineRows = timelineCandidateIds.length
    ? await sql`
        SELECT match_id, skill_order FROM coachbuild.otp_matches
        WHERE puuid = ${puuid} AND match_id = ANY(${timelineCandidateIds}::text[])
      `
    : [];
  const timelineDone = new Set(
    timelineRows.filter((r) => r.skill_order != null).map((r) => r.match_id)
  );
  const timelinePending = timelineCandidateIds.filter(
    (id) =>
      !timelineDone.has(id) &&
      (!seenChampions.has(id) || seenChampions.get(id) === championId)
  );
  const timelinePendingSet = new Set(timelinePending);
  const timelineTake = timelinePending.slice(0, UNIT_MATCHES);
  const freshTake = selection.take.filter((id) => !timelinePendingSet.has(id));
  const take = [...timelineTake, ...freshTake].slice(0, UNIT_MATCHES);

  // ── Page fully examined: advance, or declare the window exhausted ──
  if (selection.pageDrained && timelinePending.length === 0) {
    pageCache.delete(championId);
    const short = cached.ids.length < ID_PAGE_SIZE;
    const nextOffset = short ? offset : offset + cached.ids.length;
    if (short) {
      log(
        `${championKey}: window exhausted — page of ${cached.ids.length} at offset ${offset} ` +
          `already fully examined (${state.storedGames} stored)`
      );
    } else {
      log(`${championKey}: page at offset ${offset} already examined, advancing to ${nextOffset}`);
    }
    await persistCursor(sql, {
      championId,
      puuid,
      idsOffset: nextOffset,
      windowExhausted: short,
      markExhaustedNow: short,
      resetTotals,
    });
    return;
  }

  // ── Fetch up to UNIT_MATCHES of them ──
  let dScanned = 0;
  let dStored = 0;
  let interrupted = false;

  for (const matchId of take) {
    const verdict = await getVerdict(YIELD_VERDICT_MAX_AGE_MS);
    if (verdict.busy) {
      log(`${championKey}: unit cut short after ${dScanned} — ${verdict.reason}`);
      interrupted = true;
      break;
    }
    const wasSeen = seen.has(matchId);
    try {
      const match = await getMatch(routing, matchId);
      riotCalls += 1;
      let timeline = NO_TIMELINE;
      let timelineFetched = false;
      const wantsTimeline = timelinePendingSet.has(matchId);
      if (wantsTimeline) {
        const timelineVerdict = await getVerdict(YIELD_VERDICT_MAX_AGE_MS);
        if (timelineVerdict.busy) {
          log(`${championKey}: timeline unit cut short after ${dScanned} - ${timelineVerdict.reason}`);
          interrupted = true;
        } else {
          try {
            timeline = await getMatchTimeline(routing, matchId);
            riotCalls += 1;
            timelineFetched = true;
          } catch (timelineErr) {
            if (timelineErr instanceof RiotRequestError && timelineErr.status === 429) throw timelineErr;
            log(`${championKey}: timeline ${matchId} failed - ${timelineErr?.message ?? timelineErr}`);
          }
        }
      }
      const row = extractMatch(match, timeline, puuid);
      const onChampion = Boolean(row) && row.championId === championId;
      if (onChampion) {
        if (wasSeen && timelineFetched) {
          await sql`
            UPDATE coachbuild.otp_matches
            SET skill_order = ${JSON.stringify(row.skillOrder)}::jsonb
            WHERE puuid = ${puuid} AND match_id = ${matchId}
              AND skill_order IS NULL
          `;
        } else {
          await sql`
            INSERT INTO coachbuild.otp_matches (
              match_id, puuid, champion_id, champion_name, role, patch, win,
              kills, deaths, assists, game_creation, game_duration_sec,
              spells, final_items, trinket, runes, skill_order
            ) VALUES (
              ${row.matchId}, ${row.puuid}, ${row.championId}, ${row.championName}, ${row.role},
              ${row.patch}, ${row.win}, ${row.kills}, ${row.deaths}, ${row.assists},
              ${row.gameCreation}, ${row.gameDurationSec},
              ${JSON.stringify(row.spells)}::jsonb, ${JSON.stringify(row.finalItems)}::jsonb,
              ${row.trinket}, ${JSON.stringify(row.runes)}::jsonb,
              ${timelineFetched ? JSON.stringify(row.skillOrder) : null}::jsonb
            )
            ON CONFLICT (match_id, puuid) DO NOTHING
          `;
          dStored += 1;
        }
      }
      // `stored` records the OUTCOME of the examination, which is what makes
      // "we fetched 348 and kept 232" readable from this table alone. A row
      // that was already present (ON CONFLICT no-op above) is still stored, so
      // recording onChampion here is accurate, not optimistic.
      await recordScanned(sql, puuid, matchId, championId, row ? row.championId : null, onChampion);
      transientFailures.delete(matchId);
      if (!wasSeen) dScanned += 1;
    } catch (err) {
      const status = err instanceof RiotRequestError ? err.status : 0;
      if (status === 429) {
        rateLimited = true;
        log(
          `RATE LIMITED (429) on ${championKey} match ${matchId}. Something is spending the key ` +
            `that the yield predicate did not see. Backing off ${mins(RATE_LIMIT_BACKOFF_MS)} min.`
        );
        interrupted = true;
        break;
      }
      if (status >= 400 && status < 500) {
        // Definitive. Riot will not serve this match on a retry, and leaving it
        // unscanned would keep this page permanently un-drained — the walk
        // would never advance past it. Record it as examined with an unknown
        // champion, which is exactly what match_champion_id NULL means.
        log(`${championKey}: match ${matchId} riot ${status} (definitive) — marking examined`);
        await recordScanned(sql, puuid, matchId, championId, null, false);
        if (!wasSeen) dScanned += 1;
        continue;
      }
      const n = (transientFailures.get(matchId) ?? 0) + 1;
      transientFailures.set(matchId, n);
      log(`${championKey}: match ${matchId} transient failure ${n}/${MAX_TRANSIENT_RETRIES} — ${err?.message ?? err}`);
      if (n >= MAX_TRANSIENT_RETRIES) {
        // Same deadlock reasoning as the 4xx branch: a match that keeps failing
        // must not hold the page open forever.
        await recordScanned(sql, puuid, matchId, championId, null, false);
        transientFailures.delete(matchId);
        if (!wasSeen) dScanned += 1;
      }
    }
  }

  // Persist AFTER the unit as well as during it. The scanned rows above are the
  // real resume state; this keeps the cursor's own totals and last_worked_at
  // honest, and is what a human reads to see progress.
  await persistCursor(sql, {
    championId,
    puuid,
    idsOffset: offset,
    windowExhausted: false,
    dScanned,
    dStored,
    resetTotals,
  });

  const timelineProcessed = take.filter((id) => timelinePendingSet.has(id)).length;
  const remaining =
    selection.remaining +
    (freshTake.length - dScanned) +
    Math.max(0, timelinePending.length - timelineProcessed);
  log(
    `${championKey}: unit +${dStored} stored / ${dScanned} examined ` +
      `(page offset ${offset}, ${remaining} unexamined left on page, ` +
      `${state.storedGames + dStored} stored on champion)`
  );

  if (rateLimited) {
    await sleep(RATE_LIMIT_BACKOFF_MS);
    rateLimited = false;
  }
  return interrupted;
}

/** One id page, or null when the call failed. */
async function pagedIds(routing, puuid, offset) {
  try {
    const ids = await getMatchIdsByPuuid(routing, puuid, {
      queue: 420,
      start: offset,
      count: ID_PAGE_SIZE,
      // NEVER widen. See lib/pro/fresh.ts and this file's header.
      startTime: freshStartTimeEpochSec(),
    });
    riotCalls += 1;
    return ids;
  } catch (err) {
    const status = err instanceof RiotRequestError ? err.status : 0;
    if (status === 429) {
      log(`RATE LIMITED (429) fetching id page. Backing off ${mins(RATE_LIMIT_BACKOFF_MS)} min.`);
      await sleep(RATE_LIMIT_BACKOFF_MS);
    } else {
      log(`id page start=${offset} failed — ${err?.message ?? err}`);
      await sleep(5_000);
    }
    return null;
  }
}

// ── Nightly / periodic new-champion check ───────────────────────────────────

/** Repeated non-actionable states in maybeRefreshMine (a broken cursor query, no
 *  active account) recur on EVERY pass — roughly every 8s — so logging them
 *  unthrottled buries them in their own volume. That is not hypothetical: the
 *  pre-2026-07-30 version of the freshness check wrote one identical line per
 *  pass for an unknown period, and the sheer repetition is what made a hard
 *  schema error read as routine noise. One line per state per 30 minutes, plus
 *  one immediately on entering a state, keeps it visible AND legible. */
const MINE_STATE_LOG_INTERVAL_MS = 30 * 60_000;
let mineStateKey = null;
let mineStateLoggedAt = 0;
let mineCheckFailures = 0;

function noteMineCheckState(key, message) {
  const now = Date.now();
  if (key === mineStateKey && now - mineStateLoggedAt < MINE_STATE_LOG_INTERVAL_MS) return;
  mineStateKey = key;
  mineStateLoggedAt = now;
  log(message);
}

/**
 * Refresh the user's OWN recent games, then let the caller recompute
 * priorities. This is Riot work and runs only after a yield check has passed.
 *
 * WHY IT COMES FIRST: coachbuild.my_matches is the only input that says which
 * champions the user plays, and it grows only when the My Stats ingest runs.
 * Recomputing priorities against a stale my_matches means a champion picked up
 * today cannot enter the list, which is precisely the "appears automatically"
 * property this walk is supposed to have.
 */
async function maybeRefreshMine(sql, myPuuid) {
  if (!myPuuid) {
    // Not an error and not actionable from here: with no active linked account
    // there is no cursor to read and runMyStatsRefresh would answer
    // accountUnresolved. Throttled because it would otherwise repeat every unit.
    noteMineCheckState("no-active-account", "no active linked account — nothing to refresh");
    return false;
  }

  let last = null;
  try {
    // PER-ACCOUNT (migration 0020). This read used `WHERE id = 1` until
    // 2026-07-30, and migration 0020 DROPPED that column — so it threw
    // `column "id" does not exist` on every pass and the catch below returned
    // false, leaving this 6h self-refresh PERMANENTLY DEAD. Scope by the active
    // puuid, exactly as loadStates/activePuuid above and
    // lib/mystats/ingest.ts's getPersistedCursor already do.
    const rows = await sql`
      SELECT last_incremental_at FROM coachbuild.my_ingest_cursor WHERE puuid = ${myPuuid}
    `;
    mineCheckFailures = 0;
    mineStateKey = null; // healthy read -- a later failure must announce itself immediately, not wait out a throttle window
    if (rows.length === 0) {
      // NORMAL EMPTY STATE, distinct from the failure branch below on purpose:
      // a freshly linked account has no cursor row until its first ingest
      // stamps one. `last` stays null, which means "never refreshed" -> refresh
      // now, which is the correct answer for a new account.
      log(`my_matches: no ingest cursor row for the active account yet — treating as never refreshed`);
    } else {
      const raw = rows[0].last_incremental_at;
      last = raw ? new Date(raw) : null;
    }
  } catch (err) {
    // A QUERY/SCHEMA error is NOT an empty state, and the old log line
    // ("my_matches freshness check failed — ...") read exactly like a transient
    // blip, which is how a dead column survived for an unknown period across
    // 2,000+ identical lines. Say plainly that the refresh is not running, and
    // throttle so the message stays legible instead of becoming the noise it
    // hid inside.
    mineCheckFailures += 1;
    noteMineCheckState(
      "cursor-query-broken",
      `MY_MATCHES SELF-REFRESH IS BROKEN — the ${mins(MINE_REFRESH_INTERVAL_MS)}min freshness ` +
        `check cannot read coachbuild.my_ingest_cursor, so my_matches is NOT being refreshed by ` +
        `this walk (${mineCheckFailures} consecutive failures). QUERY/SCHEMA ERROR: ${err?.message ?? err}`
    );
    return false;
  }
  if (last && Date.now() - last.getTime() < MINE_REFRESH_INTERVAL_MS) return false;

  log(`refreshing my_matches (last incremental ${last ? last.toISOString() : "never"})`);
  try {
    const result = await runMyStatsRefresh(sql);
    riotCalls += 1; // lower bound; the ingest paces its own calls internally
    log(`my_matches refresh: ${JSON.stringify(result)}`);
    return true;
  } catch (err) {
    log(`my_matches refresh FAILED — ${err?.message ?? err}`);
    return false;
  }
}

// ── Plan reporting ──────────────────────────────────────────────────────────

function logPlan(plan, states, unfeatured) {
  const progress = summarizeProgress(states, DEPTH_TARGET);
  log(
    `PLAN: ${plan.ranked.length} champions with work, ${plan.skipped.length} skipped | ` +
      `fleet ${progress.storedTotal} stored across ${progress.champions} featured, ` +
      `${progress.atTarget} at target(${DEPTH_TARGET}), ${progress.exhausted} window-exhausted`
  );
  const top = plan.ranked
    .slice(0, 8)
    .map(
      (e) =>
        `${e.championKey}(score ${e.score.toFixed(2)}, mine ${e.myGames}, stored ${e.storedGames})`
    )
    .join(" | ");
  if (top) log(`  next: ${top}`);
  const resting = plan.skipped.filter((s) => s.reason === "resting-after-exhaustion");
  if (resting.length) {
    log(`  resting after exhaustion: ${resting.map((s) => s.championKey).join(", ")}`);
  }
  const noAccount = plan.skipped.filter((s) => s.reason === "no-featured-account");
  if (noAccount.length) {
    log(`  featured account missing: ${noAccount.map((s) => s.championKey).join(", ")}`);
  }
  if (unfeatured.length) {
    log(
      `  played but NOT in otp_featured (nothing to walk; ingest-otp-featured.mjs owns these): ` +
        unfeatured.map((u) => `${u.championKey}(${u.myGames}g)`).join(", ")
    );
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const sql = getSql();
  if (!sql) {
    log("DATABASE_URL not set — cannot run");
    process.exitCode = 1;
    return;
  }

  const championNames = new Map((await getAllChampions()).map((c) => [c.id, c.key]));
  const startedAt = Date.now();

  if (DRY_RUN) {
    // Zero Riot calls, on purpose: this is the mode that is safe to run while a
    // scheduled job holds the key.
    const myPuuid = await activePuuid(sql);
    const states = await loadStates(sql, championNames, myPuuid);
    const unfeatured = await loadUnfeaturedMine(sql, championNames, myPuuid);
    const plan = rankPriorities(states, { includeUnplayed: FLEET });
    log(`DRY RUN — no Riot calls will be made${FLEET ? " (fleet mode)" : ""}`);
    logPlan(plan, states, unfeatured);
    const mine = states.filter((s) => s.myGames > 0);
    const shortfall = mine.reduce((a, s) => a + Math.max(0, DEPTH_TARGET - s.storedGames), 0);
    log(
      `dry run: ${mine.length} played champions have a featured one-trick; ` +
        `${shortfall} stored games short of ${DEPTH_TARGET} each`
    );
    const verdict = await checkRiotJobsRunning();
    log(`yield check right now: busy=${verdict.busy} — ${verdict.reason}`);
    return;
  }

  if (!(await acquireLock())) return;
  process.on("exit", releaseLock);
  for (const sig of ["SIGINT", "SIGTERM", "SIGBREAK"]) {
    process.on(sig, () => {
      log(`received ${sig} — releasing lock and exiting`);
      releaseLock();
      process.exit(0);
    });
  }

  log(
    `=== walk starting (pid ${process.pid}, max ${MAX_HOURS}h, unit ${UNIT_MATCHES} matches` +
      `${ONCE ? ", --once" : ""}${FLEET ? ", --fleet" : ""}) ===`
  );

  let yieldingSince = null;
  let lastHeartbeat = 0;
  let blindChecks = 0;
  let units = 0;
  let lastPlanLogAt = 0;

  for (;;) {
    const elapsed = Date.now() - startedAt;
    if (elapsed >= MAX_HOURS * 3_600_000) {
      log(`max-hours (${MAX_HOURS}) reached — exiting cleanly after ${units} units, ${riotCalls} Riot calls`);
      break;
    }

    const verdict = await getVerdict(0);
    if (verdict.busy) {
      if (isBlindVerdict(verdict)) {
        blindChecks += 1;
        if (blindChecks >= MAX_BLIND_CHECKS) {
          log(
            `ABORT: ${blindChecks} consecutive checks could not enumerate processes. ` +
              `A walk that cannot see the other jobs must not keep running.`
          );
          process.exitCode = 1;
          break;
        }
      } else {
        blindChecks = 0;
      }
      if (yieldingSince === null) {
        yieldingSince = Date.now();
        lastHeartbeat = Date.now();
        log(`YIELDING — ${verdict.reason}`);
      } else if (Date.now() - lastHeartbeat >= YIELD_HEARTBEAT_MS) {
        lastHeartbeat = Date.now();
        log(`still yielding after ${mins(Date.now() - yieldingSince)} min — ${verdict.reason}`);
      }
      await sleep(YIELD_POLL_MS);
      continue;
    }

    blindChecks = 0;
    if (yieldingSince !== null) {
      log(`RESUMING after ${mins(Date.now() - yieldingSince)} min yielded`);
      yieldingSince = null;
    }

    // ONE puuid resolution per pass, feeding both the refresh's cursor read and
    // the priority reads below. Resolved BEFORE the refresh rather than after:
    // the refresh cannot change which account is active, so both see the same
    // answer, and a second query per pass would be a second copy of one fact.
    const myPuuid = await activePuuid(sql);
    await maybeRefreshMine(sql, myPuuid);

    const states = await loadStates(sql, championNames, myPuuid);
    const statesById = new Map(states.map((s) => [s.championId, s]));
    const plan = rankPriorities(states, { includeUnplayed: FLEET });

    // Log the plan on the first pass and every 30 min after — often enough to
    // answer "what is it doing and how far along", rare enough not to drown the
    // per-unit lines.
    if (Date.now() - lastPlanLogAt >= 30 * 60_000 || lastPlanLogAt === 0) {
      lastPlanLogAt = Date.now();
      logPlan(plan, states, await loadUnfeaturedMine(sql, championNames, myPuuid));
    }

    if (plan.ranked.length === 0) {
      log(`nothing to walk right now — sleeping ${mins(IDLE_POLL_MS)} min`);
      if (ONCE) break;
      await sleep(IDLE_POLL_MS);
      continue;
    }

    const target = statesById.get(plan.ranked[0].championId);
    await runUnit(sql, target);
    units += 1;

    if (ONCE) {
      log(`--once: one unit done (${riotCalls} Riot calls), exiting`);
      break;
    }
  }

  log(`=== walk stopped after ${mins(Date.now() - startedAt)} min, ${units} units, ${riotCalls} Riot calls ===`);
}

process.on("uncaughtException", (err) => {
  log(`UNCAUGHT: ${err?.stack ?? err}`);
  releaseLock();
  process.exit(1);
});
process.on("unhandledRejection", (err) => {
  log(`UNHANDLED REJECTION: ${err?.stack ?? err}`);
  releaseLock();
  process.exit(1);
});

await main();
releaseLock();
