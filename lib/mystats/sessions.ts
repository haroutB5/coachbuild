// ─────────────────────────────────────────────────────────────────────────────
// lib/mystats/sessions.ts — counted games -> sittings, and a sitting -> an LP
// delta with an honest confidence. PURE: no DB, no network, no clock.
//
// ── WHAT A SESSION IS ───────────────────────────────────────────────────────
//
// One sitting of play. The boundary is a gap of >= SESSION_GAP_HOURS (8h)
// between the CREATION times of consecutive counted games — the user's own
// choice, phrased as "only sleep ends it". Effectively one session per waking
// day.
//
// MIDNIGHT IS NEVER A BOUNDARY. That is the requirement this module exists for
// ("a session that runs past midnight must NOT split into two"), and it falls
// out of the gap rule by construction rather than from a special case: nothing
// here looks at a calendar date at all. Sessions are LABELLED by their start,
// so a sitting that runs 22:40 -> 01:32 is one session dated the earlier day.
//
// GAPS ARE MEASURED CREATION TO CREATION. True idle time between two games is
// roughly one game shorter than the measured gap, so the effective threshold is
// nearer 7h30m of real idleness than 8h. At an 8h threshold that difference
// cannot change a verdict for any realistic history, and the spec is explicit:
// document it, do not add anything to compensate.
//
// (The spec's stated reason for creation-to-creation — that my_matches has no
// duration column — is factually wrong: `game_duration_sec` exists and already
// feeds the CS headline. The DECISION still stands on its own merits, and this
// module keeps the boundary rule exactly as approved. It does use the duration
// for two things the boundary rule does not touch: the session's `endedAt`, so
// a rendered time range says when play actually stopped, and the end-of-game
// instants the LP bracket is measured against, since LP is awarded when a game
// ENDS, not when it was created.)
//
// ── THE LP BRACKET ──────────────────────────────────────────────────────────
//
// Riot's match API has never returned per-game LP change, so a session's LP
// movement can only be measured as the difference between two rank READINGS
// taken either side of it (coachbuild.my_rank_samples, migration 0027). The
// whole difficulty is deciding when that difference is honestly attributable to
// this session and when it is not, which is what `sessionLpDelta` reports as a
// confidence:
//
//   exact         a reading before the first game and a reading at/after the
//                 last game, with no OTHER counted game resolving between them.
//                 Render a plain signed number.
//   approximate   a real difference over a bracket that is too wide (it
//                 contains games from another sitting) or too narrow (capture
//                 started or stopped mid-sitting). Render the number WITH A
//                 MARKER plus the reason.
//   unavailable   no two readings bracket this session at all. Every session
//                 that predates LP capture is here. Render a DASH. Never a
//                 number derived from the win count — that is invention, not
//                 estimation, and it is explicitly forbidden.
//
// A GAME IS "IN THE BRACKET" WHEN IT ENDED IN (open, close]. That is the exact
// set of games whose LP movement the difference actually contains, which makes
// the contamination test a set comparison rather than a heuristic: if that set
// is precisely this session's games, the number is this session's.
//
// KNOWN LIMITATION, DELIBERATELY NOT CODED FOR: LP decay. Master+ accounts lose
// LP to inactivity, so a bracket whose closing reading is days after the sitting
// would fold decay into the figure. It cannot happen below Master, which is
// where this account plays, and the fix (a staleness downgrade) would cost
// `exact` coverage today for a case that has never occurred. Revisit if the
// account reaches Master.
// ─────────────────────────────────────────────────────────────────────────────

import { ladderPoints, type LadderPosition } from "@/lib/mystats/ladder";

/** The gap that ends a sitting. The user chose 8h over 3/4/6 — see the spec's
 *  "decisions taken (do not re-litigate)". */
export const SESSION_GAP_HOURS = 8;

/** The same number in milliseconds, which is what the comparison uses. */
export const SESSION_GAP_MS = SESSION_GAP_HOURS * 60 * 60 * 1000;

/** Longest game duration this module will believe, in seconds. A stored value
 *  above it is treated as missing rather than trusted: League games do not run
 *  three hours, and a corrupt duration would push a session's `endedAt` far
 *  into the future and drag unrelated games into its LP bracket. */
const MAX_PLAUSIBLE_GAME_SEC = 3 * 60 * 60;

/** One counted (ranked solo) game, in the shape `coachbuild.my_matches` hands
 *  back. `gameCreation` is accepted as an ISO string (what the driver returns),
 *  epoch milliseconds, or a Date, so callers and tests need no adapter. */
export interface SessionMatchInput {
  gameCreation: string | number | Date;
  win: boolean;
  /** `my_matches.game_duration_sec`. Null is normal for older rows. */
  gameDurationSec?: number | null;
}

/** One sitting. Times are carried BOTH as ISO strings (for the API payload)
 *  and as epoch ms (so no consumer has to re-parse to compare). */
export interface PlaySession {
  /** ISO-8601 UTC of the FIRST game's creation. The session's label. */
  startedAt: string;
  /** ISO-8601 UTC of the LAST game's end (creation + duration when known). */
  endedAt: string;
  startedAtMs: number;
  endedAtMs: number;
  wins: number;
  losses: number;
  games: number;
  /** Every game's END instant, ascending. The LP bracket is measured against
   *  these because LP is awarded when a game ends. */
  gameEndsMs: number[];
}

/** One row of `coachbuild.my_rank_samples`. The public Riot API does not return
 *  cumulativeLp, so null/absent means ladder.ts must derive the same integer. */
export interface RankSample extends LadderPosition {
  observedAt: string | number | Date;
  cumulativeLp?: number | null;
}

export type LpDeltaConfidence = "exact" | "approximate" | "unavailable";

export type LpDeltaReason =
  /** unavailable: not one usable reading exists. The state of every session
   *  played before LP capture shipped. */
  | "no-samples"
  /** unavailable: readings exist but none of them bracket THIS session — they
   *  all sit on one side of it, or only one end could be found. */
  | "unbracketed"
  /** approximate: the bracket holds counted games that are not this session's.
   *  `extraGames` says how many. */
  | "extra-games"
  /** approximate: no reading before the first game, so the bracket opens part
   *  way through the sitting and the figure covers only the rest of it. */
  | "partial-open"
  /** approximate: no reading at or after the last game, so the bracket closes
   *  early and the figure covers only the start of the sitting. */
  | "partial-close"
  /** approximate: both ends are inside the sitting. */
  | "partial-bracket";

export interface SessionLpDelta {
  /** Signed LP moved. Null EXACTLY when confidence is "unavailable". */
  value: number | null;
  confidence: LpDeltaConfidence;
  reason?: LpDeltaReason;
  /** Present only on "approximate": counted games inside the bracket that
   *  belong to another sitting. May be 0 when the bracket is partial rather
   *  than contaminated. */
  extraGames?: number;
}

/** Epoch ms, or null when the value cannot be read as a time. Never NaN: a NaN
 *  timestamp propagates into every comparison and silently makes a session
 *  vanish or swallow the whole history. */
function toMs(v: string | number | Date | null | undefined): number | null {
  if (v == null) return null;
  const ms = v instanceof Date ? v.getTime() : typeof v === "number" ? v : Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * Groups counted games into sittings, OLDEST FIRST.
 *
 * Input order is not trusted — the rows arrive newest-first from the route's
 * `ORDER BY game_creation DESC`, and a grouping that assumed ascending order
 * would put every game in its own session without failing anything visibly.
 *
 * Rows whose timestamp cannot be read are DROPPED, not defaulted. A row with a
 * broken creation time is one missing game; the same row defaulted to 0 or to
 * `now()` is a phantom session at the epoch or a corrupted current one.
 */
export function groupSessions(matches: readonly SessionMatchInput[]): PlaySession[] {
  const usable = matches
    .map((m) => {
      const startMs = toMs(m.gameCreation);
      if (startMs === null) return null;
      const durSec = m.gameDurationSec;
      const validDuration =
        typeof durSec === "number" && Number.isFinite(durSec) && durSec > 0 && durSec <= MAX_PLAUSIBLE_GAME_SEC;
      return { startMs, endMs: validDuration ? startMs + Math.round(durSec * 1000) : startMs, win: m.win === true };
    })
    .filter((m): m is { startMs: number; endMs: number; win: boolean } => m !== null)
    .sort((a, b) => a.startMs - b.startMs);

  const sessions: PlaySession[] = [];
  // The CREATION time of the previous game. Tracked separately from the
  // session's `endedAtMs` because the boundary is measured creation-to-creation
  // while `endedAtMs` is an END time, and one field cannot honestly be both.
  let previousStartMs = Number.NEGATIVE_INFINITY;

  for (const m of usable) {
    const open = sessions[sessions.length - 1];
    // THE BOUNDARY, and the only place it is expressed. `>=` is deliberate: a
    // gap of exactly 8h starts a new session.
    if (open === undefined || m.startMs - previousStartMs >= SESSION_GAP_MS) {
      sessions.push({
        startedAt: iso(m.startMs),
        endedAt: iso(m.endMs),
        startedAtMs: m.startMs,
        endedAtMs: m.endMs,
        wins: m.win ? 1 : 0,
        losses: m.win ? 0 : 1,
        games: 1,
        gameEndsMs: [m.endMs],
      });
    } else {
      open.games += 1;
      if (m.win) open.wins += 1;
      else open.losses += 1;
      open.gameEndsMs.push(m.endMs);
      // A later game can end BEFORE an earlier long one (games are ordered by
      // creation, not by end), so the session's end is the max, not the last.
      if (m.endMs > open.endedAtMs) {
        open.endedAtMs = m.endMs;
        open.endedAt = iso(m.endMs);
      }
    }
    previousStartMs = m.startMs;
  }

  for (const s of sessions) s.gameEndsMs.sort((a, b) => a - b);
  return sessions;
}

interface UsableSample {
  ms: number;
  points: number;
}

/** Riot's LCU already supplies the absolute ladder integer. It is the source
 *  of truth when present; league-v4 does not return it, so cron/page readings
 *  continue through the independently tested ladder conversion. A malformed
 *  present value fails closed rather than being treated as absent. */
function samplePoints(sample: RankSample): number | null {
  if (sample.cumulativeLp !== null && sample.cumulativeLp !== undefined) {
    const value = sample.cumulativeLp;
    const hasRankedTier = typeof sample.tier === "string" && sample.tier.trim().length > 0;
    return hasRankedTier && Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  return ladderPoints(sample);
}

/**
 * The LP moved during one sitting, with the confidence that movement can be
 * attributed to it.
 *
 * `allSessions` is the COMPLETE ascending list `session` came from. It is not
 * decoration: the "no other counted game resolved inside the bracket" rule
 * cannot be evaluated from one session in isolation, and passing a partial list
 * makes contamination invisible rather than making the answer approximate. The
 * route therefore groups the account's whole stored season and only then slices
 * off the ten it displays.
 */
export function sessionLpDelta(
  session: PlaySession,
  samples: readonly RankSample[],
  allSessions: readonly PlaySession[]
): SessionLpDelta {
  // Readings we cannot place on the ladder are DISCARDED, not zeroed: an
  // unranked reading or an unknown tier scored as 0 LP produces a delta of a
  // couple of thousand points that looks like a spectacular session.
  const usable: UsableSample[] = samples
    .map((s) => {
      const ms = toMs(s.observedAt);
      const points = samplePoints(s);
      return ms === null || points === null ? null : { ms, points };
    })
    .filter((s): s is UsableSample => s !== null)
    .sort((a, b) => a.ms - b.ms);

  if (usable.length === 0) return { value: null, confidence: "unavailable", reason: "no-samples" };

  // OPEN: the last reading at or before the first game started. A champ-select
  // or app-start capture lands exactly there, so the bound is inclusive.
  // Failing that, the earliest reading INSIDE the sitting — a real but partial
  // measurement, which is a marked estimate rather than nothing (the user's
  // decision 3: "unknown LP shows a best estimate, MARKED").
  const pre = lastWhere(usable, (s) => s.ms <= session.startedAtMs);
  const openIsPre = pre !== null;
  const open =
    pre ?? firstWhere(usable, (s) => s.ms > session.startedAtMs && s.ms < session.endedAtMs);

  // CLOSE: the earliest reading at or after the last game ended — where the
  // game-end capture lands. Failing that, the latest reading inside the sitting
  // and strictly after `open`.
  const post = firstWhere(usable, (s) => s.ms >= session.endedAtMs);
  const closeIsPost = post !== null;
  const openMs = open?.ms ?? Number.NEGATIVE_INFINITY;
  const close = post ?? lastWhere(usable, (s) => s.ms > openMs && s.ms < session.endedAtMs);

  if (open === null || close === null || close.ms <= open.ms) {
    return { value: null, confidence: "unavailable", reason: "unbracketed" };
  }

  const rawValue = close.points - open.points;
  // Keep the same signed-zero guarantee ladderDelta provides to its callers.
  const value = rawValue === 0 ? 0 : rawValue;

  const inBracket = (endMs: number) => endMs > open.ms && endMs <= close.ms;
  let bracketGames = 0;
  for (const s of allSessions) for (const endMs of s.gameEndsMs) if (inBracket(endMs)) bracketGames += 1;
  const ownGamesInBracket = session.gameEndsMs.filter(inBracket).length;
  const extraGames = bracketGames - ownGamesInBracket;

  if (openIsPre && closeIsPost && extraGames === 0) return { value, confidence: "exact" };

  const reason: LpDeltaReason = !openIsPre && !closeIsPost
    ? "partial-bracket"
    : !openIsPre
      ? "partial-open"
      : !closeIsPost
        ? "partial-close"
        : "extra-games";

  return { value, confidence: "approximate", reason, extraGames };
}

/** How many sittings /api/mystats/summary carries, and the ONE number that
 *  decides it (spec §7: "the last 10"). It lives here rather than in the route
 *  because a Next.js route file may export only its handlers and its segment
 *  config, and because the panel's heading will want to state the same number —
 *  the RECENT_GAMES_LIMIT lesson, where a cap in two places quietly served five
 *  rows under a heading that said twenty. */
export const SESSIONS_LIMIT = 10;

/** ONE row of the summary payload's `sessions` array — spec §7, exactly these
 *  five fields.
 *
 *  It is a SEPARATE type from PlaySession on purpose. PlaySession carries four
 *  fields the arithmetic needs and no consumer should see, and one of them —
 *  `gameEndsMs` — holds a timestamp per game in the whole season. Emitting the
 *  session objects straight onto the response would render perfectly and
 *  quietly ship a few hundred numbers nobody reads. */
export interface SessionSummary {
  startedAt: string;
  endedAt: string;
  wins: number;
  losses: number;
  lpDelta: SessionLpDelta;
}

/**
 * The whole payload block in one call: group everything, price each sitting,
 * and hand back the newest `limit` of them, NEWEST FIRST.
 *
 * ORDER OF OPERATIONS IS THE POINT. Grouping runs over the account's COMPLETE
 * stored history and the LP delta is computed against that complete list,
 * because "no other counted game resolved inside the bracket" cannot be
 * evaluated from a slice — a caller that sliced first would silently upgrade
 * every contaminated bracket to `exact`, which is the one failure this feature
 * cannot have (a confident wrong number, HARD RULE 4). Only after every delta
 * is priced does the list get cut down to what the panel shows.
 *
 * NEWEST FIRST matches `recentGames` and the way the page already reads. The
 * slice therefore comes off the END of the ascending list, not the start.
 */
export function summarizeSessions(
  matches: readonly SessionMatchInput[],
  samples: readonly RankSample[],
  limit: number = SESSIONS_LIMIT
): SessionSummary[] {
  const all = groupSessions(matches);
  const shown = all.slice(Math.max(0, all.length - Math.max(0, limit)));
  return shown
    .map((session) => ({
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      wins: session.wins,
      losses: session.losses,
      lpDelta: sessionLpDelta(session, samples, all),
    }))
    .reverse();
}

function firstWhere(list: readonly UsableSample[], pred: (s: UsableSample) => boolean): UsableSample | null {
  for (const s of list) if (pred(s)) return s;
  return null;
}

function lastWhere(list: readonly UsableSample[], pred: (s: UsableSample) => boolean): UsableSample | null {
  for (let i = list.length - 1; i >= 0; i -= 1) if (pred(list[i])) return list[i];
  return null;
}
