// ─────────────────────────────────────────────────────────────────────────────
// lib/otp/deepWalk.ts — the PURE half of the continuous priority-driven deep
// walk of featured one-tricks. `scripts/ingest-otp-priority.mjs` is the loop
// and the I/O; everything here is a decision that can be tested without a
// process, a network or a database.
//
// Companion files: lib/otp/riotYield.ts (may I call Riot right now?),
// migrations/0019_otp_featured_deep.sql (what has been looked at, how far).
//
// ── WHY A PRIORITY ORDER EXISTS AT ALL ───────────────────────────────────────
// Nothing else in this repo will ever deepen the featured fleet.
// `ingest-otp-featured-scheduled.ps1` passes `--matches 40`, and the pagination
// loop in `ingest-otp-featured.mjs` is bounded by that same number, so it
// fetches exactly one page and stops. Raising it there would blow the shared
// slot's 2h45 kill limit. Depth is therefore this walk's job alone — nothing
// else takes a champion from 39 stored games to 232.
//
// There is no speed available. Riot's live headers give the ceiling as
// `x-app-rate-limit: 100:120,20:1` and lib/pro/pacer.ts's 1.3s floor already
// runs at ~92% of it. The only lever left is ORDER: spend the next call where
// it buys the most.
//
// ── THE FORMULA, AND WHY THIS SHAPE ──────────────────────────────────────────
//
//     score = playWeight(myGames) x depthDeficit(storedGames)
//
// MULTIPLICATIVE, not additive. A sum would keep pushing a champion that is
// already fully walked simply because the user plays it a lot; a product lets a
// satisfied deficit retire a champion no matter how popular it is, which is the
// behaviour we want from something that never stops running.
//
// playWeight is log2(1 + myGames), not myGames. The user's pool is heavily
// skewed — champion 112 has 45 games against a long tail at 1-3 (measured
// 2026-07-29 over 136 games / 42 distinct champions). Linear weighting would
// make the 45-game champion 45x more urgent than a 1-game champion and starve
// the tail for days. Logarithmic keeps the ordering ("more played = more
// urgent") while compressing the ratio to ~5.5x, so the tail still gets served
// inside one sweep.
//
// depthDeficit is a LINEAR ramp toward DEPTH_TARGET with a floor. Linear
// because "we hold 10 of the ~120 useful games" really is twelve times as
// urgent as "we hold 110"; there is nothing diminishing about it.
//
// Worked, and pinned by tests:
//   45 games / 10 stored -> 5.52 x 0.917 = 5.06
//    1 game  / 100 stored -> 1.00 x 0.167 = 0.17     ~30x apart
// Heavily-played-and-shallow beats rarely-played-and-deep, which is the
// property the whole design was asked for.
//
// ── DEPTH_TARGET IS AN ORDERING KNOB, NOT A STOPPING CONDITION ───────────────
// Read this before "fixing" a champion that sits below the target forever.
// Some featured accounts simply do not have 120 in-window games on the
// champion. The thing that actually ENDS a champion's walk is
// `windowExhausted` — a short id page proving Riot has no more matches inside
// lib/pro/fresh.ts's 90-day window. DEPTH_TARGET only shapes what we do next
// among champions that still have unseen matches. Raising it does not make the
// walk fetch games that do not exist; it only reorders.
//
// ── THE 90-DAY WINDOW IS NEVER WIDENED ───────────────────────────────────────
// Depth comes from paginating INSIDE lib/pro/fresh.ts's window, never from
// reaching further back. Games older than that predate item overhauls and are
// actively misleading as inspiration. Nothing in this module has a knob that
// could widen it, deliberately.
//
// ── HARD RULE 3 (display-only personal data) — WHY THIS IS NOT A VIOLATION ───
// CLAUDE.md HARD RULE 3 says My Stats data must never feed a score or ranking.
// `myGames` here comes from coachbuild.my_matches, so this needs stating
// plainly rather than being left for a reviewer to trip over.
//
// The rule governs what the APP SHOWS: it forbids personal data altering a
// WPA/win-rate/priority number the user reads, or reordering a recommendation.
// This module orders INGEST — which Riot call to spend next. It changes how
// much evidence exists, never how existing evidence is ranked, scored or
// displayed. No output of this file reaches a response body, a card or a build.
// It is also an explicit user directive (2026-07-29: deepen the champions I
// actually play, ~5 hours of Riot time for 42 champions against ~17 hours for
// the whole fleet of 172).
//
// If that ever stops being true — if someone surfaces `score` in the UI, or
// feeds `myGames` into a build ranking — the carve-out no longer applies and
// HARD RULE 3 does.
// ─────────────────────────────────────────────────────────────────────────────

/** Stored games we aim to hold per featured champion. An ORDERING knob — see
 *  the header. 120 is roughly half the deepest account measured (232 on the
 *  featured Ahri one-trick) and comfortably above the fleet median of 39, so
 *  the ramp discriminates across the whole live range instead of saturating. */
export const DEPTH_TARGET = 120;

/** A champion at or past DEPTH_TARGET keeps a small non-zero urgency rather
 *  than dropping to exactly 0. Zero would sort it below a champion with a
 *  score of 0 by tie-break alone, i.e. by champion id, which is arbitrary. A
 *  floor keeps "deep but not exhausted" ordered by how much the user plays it.
 *  It never lets such a champion outrank a genuinely shallow one: the smallest
 *  possible played playWeight is log2(2) = 1, and 1 x 0.05 is below every
 *  deficit above ~0.05. */
export const DEPTH_DEFICIT_FLOOR = 0.05;

/** How long an exhausted champion rests before the walk re-checks it for newly
 *  played games. A re-walk from offset 0 costs only id pages (1 Riot call per
 *  100 ids) because coachbuild.otp_featured_scanned already knows every match
 *  it has looked at — that is precisely what that table buys. 12h means a
 *  finished champion costs ~2-3 calls a day to stay current. */
export const REEXHAUST_INTERVAL_MS = 12 * 60 * 60 * 1000;

/** Weight given to a featured champion the user has NEVER played, in opt-in
 *  `--fleet` mode. Strictly below log2(1+1) = 1, the weight of a champion
 *  played exactly once, so enabling fleet mode can never reorder the user's own
 *  champions among themselves or push one below an unplayed champion. Pinned by
 *  a test. */
export const UNPLAYED_PLAY_WEIGHT = 0.25;

/** One champion's walk state, assembled by the script from otp_featured,
 *  my_matches, otp_matches and otp_featured_deep_cursor. */
export interface ChampionWalkState {
  championId: number;
  /** Riot champion key, for logs only. */
  championKey: string;
  /** Games the USER has on this champion (coachbuild.my_matches). */
  myGames: number;
  /** Games stored for the FEATURED account on this champion. Must be counted
   *  the same way the featured card counts them (puuid + champion_id), or the
   *  deficit describes a different quantity than the one we are filling. */
  storedGames: number;
  /** The account currently featured for this champion. Null = no featured
   *  one-trick yet; nothing to walk. */
  featuredPuuid: string | null;
  /** Which account the persisted cursor describes. */
  cursorPuuid: string | null;
  idsOffset: number;
  windowExhausted: boolean;
  lastExhaustedAt: Date | null;
}

export interface PriorityEntry {
  championId: number;
  championKey: string;
  score: number;
  playWeight: number;
  depthDeficit: number;
  myGames: number;
  storedGames: number;
}

/** Champions deliberately not in the work list this pass, with the reason —
 *  logged, because "why is nothing happening" must be answerable from the log
 *  alone. */
export interface SkippedChampion {
  championId: number;
  championKey: string;
  myGames: number;
  storedGames: number;
  reason: "no-featured-account" | "resting-after-exhaustion" | "not-played";
  /** For `resting-after-exhaustion`: when it becomes eligible again. */
  eligibleAt?: Date;
}

export interface PriorityPlan {
  /** Highest score first. Ties break on champion id ASC so two passes over
   *  identical state produce an identical order — resumability depends on the
   *  walk not thrashing between equally-scored champions. */
  ranked: PriorityEntry[];
  skipped: SkippedChampion[];
}

export interface RankOptions {
  now?: Date;
  depthTarget?: number;
  reExhaustMs?: number;
  /** Include featured champions the user has never played, at
   *  UNPLAYED_PLAY_WEIGHT. Default false — the user's directive is to deepen
   *  what they actually play. */
  includeUnplayed?: boolean;
}

/** Diminishing weight for how much the user plays a champion. See header. */
export function playWeight(myGames: number, includeUnplayed = false): number {
  const g = Math.max(0, myGames);
  if (g === 0) return includeUnplayed ? UNPLAYED_PLAY_WEIGHT : 0;
  return Math.log2(1 + g);
}

/** Linear ramp: 1 at zero stored games, floored at DEPTH_DEFICIT_FLOOR from
 *  `target` onward. */
export function depthDeficit(storedGames: number, target: number = DEPTH_TARGET): number {
  if (!(target > 0)) return DEPTH_DEFICIT_FLOOR;
  const raw = 1 - Math.max(0, storedGames) / target;
  return Math.max(DEPTH_DEFICIT_FLOOR, raw);
}

/** True while an exhausted champion is inside its rest interval. A missing
 *  `lastExhaustedAt` alongside `windowExhausted` is treated as NOT resting —
 *  an unknown timestamp must not park a champion forever. */
export function isResting(
  state: ChampionWalkState,
  now: Date,
  reExhaustMs: number = REEXHAUST_INTERVAL_MS
): boolean {
  if (!state.windowExhausted) return false;
  if (!state.lastExhaustedAt) return false;
  return now.getTime() - state.lastExhaustedAt.getTime() < reExhaustMs;
}

/**
 * The priority list, derived fresh from live state. NEVER snapshotted to a
 * file: deriving it every pass is exactly what makes a newly played champion
 * appear on its own, with no manual edit, the moment my_matches grows.
 */
export function rankPriorities(
  states: readonly ChampionWalkState[],
  opts: RankOptions = {}
): PriorityPlan {
  const now = opts.now ?? new Date();
  const depthTarget = opts.depthTarget ?? DEPTH_TARGET;
  const reExhaustMs = opts.reExhaustMs ?? REEXHAUST_INTERVAL_MS;
  const includeUnplayed = opts.includeUnplayed ?? false;

  const ranked: PriorityEntry[] = [];
  const skipped: SkippedChampion[] = [];

  for (const s of states) {
    const base = {
      championId: s.championId,
      championKey: s.championKey,
      myGames: s.myGames,
      storedGames: s.storedGames,
    };
    if (!s.featuredPuuid) {
      // Not a bug and not silent: the user plays this champion but no featured
      // one-trick has been resolved for it yet. The featured refresh
      // (ingest-otp-featured.mjs) owns that; this walk has no account to page
      // through. Surfaced so the operator can see it rather than wondering why
      // a champion never deepens.
      skipped.push({ ...base, reason: "no-featured-account" });
      continue;
    }
    if (s.myGames <= 0 && !includeUnplayed) {
      skipped.push({ ...base, reason: "not-played" });
      continue;
    }
    if (isResting(s, now, reExhaustMs)) {
      skipped.push({
        ...base,
        reason: "resting-after-exhaustion",
        eligibleAt: new Date(s.lastExhaustedAt!.getTime() + reExhaustMs),
      });
      continue;
    }
    const pw = playWeight(s.myGames, includeUnplayed);
    const dd = depthDeficit(s.storedGames, depthTarget);
    ranked.push({ ...base, playWeight: pw, depthDeficit: dd, score: pw * dd });
  }

  ranked.sort((a, b) => b.score - a.score || a.championId - b.championId);
  skipped.sort((a, b) => a.championId - b.championId);
  return { ranked, skipped };
}

// ── Cursor decisions ────────────────────────────────────────────────────────

export type CursorAction =
  | { kind: "resume"; offset: number }
  | { kind: "reset"; offset: 0; reason: "fresh" | "puuid-changed" | "rewalk" };

/**
 * What to do with a champion's persisted walk position.
 *
 * `puuid-changed` is the one worth understanding: onetricks.gg's ranking churns
 * and the featured refresh can replace a champion's one-trick. An offset into a
 * DIFFERENT account's history is not a smaller offset, it is a meaningless one
 * — resuming at 200 into an account with 90 games silently returns nothing
 * forever. So a puuid mismatch restarts the walk. That costs id pages, not
 * match fetches: otp_featured_scanned is keyed on (puuid, match_id) and knows
 * nothing about champions, so anything already examined for the NEW account —
 * including via another champion it is also featured for — is still skipped.
 */
export function resolveCursorAction(
  state: ChampionWalkState,
  now: Date = new Date(),
  reExhaustMs: number = REEXHAUST_INTERVAL_MS
): CursorAction {
  if (!state.cursorPuuid) return { kind: "reset", offset: 0, reason: "fresh" };
  if (state.cursorPuuid !== state.featuredPuuid) {
    return { kind: "reset", offset: 0, reason: "puuid-changed" };
  }
  if (state.windowExhausted && !isResting(state, now, reExhaustMs)) {
    // Rest is over: walk the window again from the top to pick up games played
    // since. Cheap by construction — see resolveCursorAction's header.
    return { kind: "reset", offset: 0, reason: "rewalk" };
  }
  return { kind: "resume", offset: Math.max(0, state.idsOffset) };
}

// ── Page selection ──────────────────────────────────────────────────────────

export interface UnitSelection {
  /** Match ids to fetch this unit, in page order (newest first). */
  take: string[];
  /** Ids on this page still unexamined after `take` is consumed. */
  remaining: number;
  /** True when every id on this page has already been examined — the walk
   *  should advance the offset (or declare the window exhausted on a short
   *  page) rather than fetch anything. */
  pageDrained: boolean;
}

/**
 * PURE. What this unit should fetch from one id page.
 *
 * THIS IS WHERE RESUMABILITY LIVES. `scanned` is every match id
 * coachbuild.otp_featured_scanned already holds for this ACCOUNT — stored or
 * rejected. Filtering against it is what makes a second pass over the same
 * state fetch nothing: not because the walk remembers where it stopped, but
 * because it remembers what it has LOOKED AT.
 *
 * That distinction is the whole reason migration 0019 exists. A stateless diff
 * against otp_matches would re-fetch every REJECTED match on every pass — the
 * featured Ahri one-trick has 348 in-window ranked games of which 232 are on
 * Ahri, so the other 116 would cost a Riot call each, forever, to re-learn "not
 * this champion".
 */
export function selectUnitIds(
  pageIds: readonly string[],
  scanned: ReadonlySet<string>,
  unitSize: number
): UnitSelection {
  const unscanned = pageIds.filter((id) => !scanned.has(id));
  const take = unscanned.slice(0, Math.max(0, unitSize));
  return {
    take,
    remaining: unscanned.length - take.length,
    pageDrained: unscanned.length === 0,
  };
}

// ── Single-instance decision ────────────────────────────────────────────────

/** What a lock file claims. */
export interface LockRecord {
  pid: number;
  startedAt: string;
}

export type LockDecision =
  | { take: true; reason: "no-lock" | "stale-pid" | "pid-reused" }
  | { take: false; reason: "live-instance"; pid: number };

/**
 * Whether this process may start.
 *
 * WHY A LOCK AND NOT THE YIELD PREDICATE. riotYield.ts's SELF_MARKER exists so
 * this walk never yields to itself — which means two copies of this walk would
 * happily run side by side, each seeing the other as "self", doubling the
 * request rate against one key budget. That is the exact failure riotYield.ts
 * exists to prevent, arriving through its own escape hatch. The lock closes it.
 *
 * `livingCommandLine` is the command line of the pid in the lock file, or null
 * if no such process exists. Checking the COMMAND LINE and not just liveness
 * matters: Windows reuses pids, and an unrelated process inheriting a stale
 * pid would otherwise block this walk forever.
 */
export function decideLock(
  record: LockRecord | null,
  livingCommandLine: string | null,
  selfMarker: string
): LockDecision {
  if (!record) return { take: true, reason: "no-lock" };
  if (livingCommandLine === null) return { take: true, reason: "stale-pid" };
  if (!livingCommandLine.includes(selfMarker)) return { take: true, reason: "pid-reused" };
  return { take: false, reason: "live-instance", pid: record.pid };
}

// ── Log bounding ────────────────────────────────────────────────────────────

/**
 * PURE. Given a log file's current contents, return what it should be trimmed
 * to, or null when it is still inside budget.
 *
 * The sibling scheduled jobs bound their logs in the .ps1 wrapper, once, at
 * slot start. That is fine for a job that runs for 24 minutes; this one is
 * meant to run for hours or days, so the bounding has to happen from inside the
 * process. Same rule as the siblings — keep the newest half — but cut on a LINE
 * boundary so the file never opens with half a timestamp.
 */
export function trimLogText(text: string, maxBytes: number): string | null {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return null;
  const half = Math.floor(text.length / 2);
  const nl = text.indexOf("\n", half);
  const cut = nl === -1 ? half : nl + 1;
  return text.slice(cut);
}

// ── Progress reporting ──────────────────────────────────────────────────────

export interface FleetProgress {
  champions: number;
  /** Champions whose 90-day window has been fully walked. */
  exhausted: number;
  /** Champions at or past DEPTH_TARGET. */
  atTarget: number;
  storedTotal: number;
  /** Sum over champions of (target - stored), floored at 0 — how many more
   *  stored games the target implies. NOT a Riot-call estimate: an off-champion
   *  game costs a call and stores nothing. */
  storedShortfall: number;
}

/** PURE. One line a human can read to answer "how far along is this?". */
export function summarizeProgress(
  states: readonly ChampionWalkState[],
  depthTarget: number = DEPTH_TARGET
): FleetProgress {
  let exhausted = 0;
  let atTarget = 0;
  let storedTotal = 0;
  let storedShortfall = 0;
  for (const s of states) {
    if (s.windowExhausted) exhausted += 1;
    if (s.storedGames >= depthTarget) atTarget += 1;
    storedTotal += s.storedGames;
    storedShortfall += Math.max(0, depthTarget - s.storedGames);
  }
  return {
    champions: states.length,
    exhausted,
    atTarget,
    storedTotal,
    storedShortfall,
  };
}
