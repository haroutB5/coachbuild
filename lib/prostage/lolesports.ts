// ─────────────────────────────────────────────────────────────────────────────
// lib/prostage/lolesports.ts — thin client for the free/unauthenticated
// lolesports "persisted GW" API (esports-api.lolesports.com). This is the
// BRIDGE from a Leaguepedia game (what coachbuild ingests) to the numeric
// lolesports "esports game id" the livestats feed (lib/prostage/timeline.ts)
// keys on:
//
//   Leaguepedia game (tournament + teams + date + game#)
//     -> getLeagues()               -> leagueId for the tournament's league
//     -> getScheduleForLeague()     -> the match (event) by teams + date
//     -> getEventDetails(matchId)   -> games[number === game#].id  == esportsGameId
//
// Live-verified 2026-07-10 against a real T1 vs G2 MSI 2026 game: this exact
// chain resolves the Leaguepedia game to esportsGameId 115570934355614582, whose
// livestats window/details feed carries the item data. NOTE the Leaguepedia
// ScoreboardGames.RiotPlatformGameId (e.g. "LOLTMNT01_419720") is a DIFFERENT id
// space — the livestats feed 404s on it — so this schedule walk is the real
// resolution path, not that field.
//
// Same public x-api-key pattern as matchday's lib/sources/lolesports.ts: an env
// override (LOLESPORTS_API_KEY) falls back to the well-known public web-client
// key. No key of ours, no quota to protect — but every fetch still classifies a
// non-2xx / network failure as TRANSIENT (LolesportsFetchError) so the caller
// never records a transient outage as a permanent "unavailable".
// ─────────────────────────────────────────────────────────────────────────────

import { fetchWithTimeout } from "../fetchTimeout";

const BASE = "https://esports-api.lolesports.com/persisted/gw";
// Well-known public web-client key (identical to matchday's default). Overridable
// via LOLESPORTS_API_KEY if it ever rotates.
const DEFAULT_KEY = "0TvQnueqKa5mxJntVWt0w4LpLfEkrV1Ta8rQBb9Z";

function apiKey(): string {
  return process.env.LOLESPORTS_API_KEY ?? DEFAULT_KEY;
}

/** Signals a TRANSIENT failure (non-2xx HTTP, network error, unparseable body).
 *  Callers must treat this as "retry later", NEVER as "this game has no data" —
 *  a transient outage must not be persisted as a terminal `unavailable`. */
export class LolesportsFetchError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "LolesportsFetchError";
    this.status = status;
  }
}

/** GETs JSON from the persisted GW API. Throws LolesportsFetchError on any
 *  non-2xx / network / parse failure (all transient by definition here — a 404
 *  from these endpoints means a bad/rotated id, which for our resolver flow is
 *  still "can't resolve right now", not "permanently no such game"). */
async function getJson<T>(path: string): Promise<T> {
  let res: Response;
  try {
    res = await fetchWithTimeout(`${BASE}${path}`, { headers: { "x-api-key": apiKey() } });
  } catch (err) {
    throw new LolesportsFetchError(`network error: ${(err as Error).message}`);
  }
  if (!res.ok) {
    throw new LolesportsFetchError(`HTTP ${res.status} for ${path}`, res.status);
  }
  try {
    return (await res.json()) as T;
  } catch (err) {
    throw new LolesportsFetchError(`unparseable body: ${(err as Error).message}`);
  }
}

// ── getLeagues (memoized) ────────────────────────────────────────────────────

export interface LolLeague {
  id: string;
  slug: string;
  name: string;
  region?: string;
}

interface LeaguesResponse {
  data?: { leagues?: LolLeague[] };
}

let leaguesCache: Promise<LolLeague[]> | null = null;

/** All lolesports leagues (id/slug/name). Memoized per process — the league
 *  list is effectively static for the life of a request/script run. A failure
 *  is NOT memoized (the rejected promise is cleared) so a transient outage
 *  doesn't poison every later call. */
export function getLeagues(): Promise<LolLeague[]> {
  if (!leaguesCache) {
    leaguesCache = getJson<LeaguesResponse>("/getLeagues?hl=en-US")
      .then((r) => r.data?.leagues ?? [])
      .catch((err) => {
        leaguesCache = null;
        throw err;
      });
  }
  return leaguesCache;
}

export function __resetLeaguesCacheForTests(): void {
  leaguesCache = null;
}

// ── getSchedule (per league, paginated back through `older` tokens) ──────────

export interface LolScheduleTeam {
  name?: string;
  code?: string;
}

export interface LolScheduleEvent {
  startTime?: string;
  state?: string; // 'unstarted' | 'inProgress' | 'completed'
  type?: string; // 'match' | 'show'
  match?: { id?: string; teams?: LolScheduleTeam[] };
}

interface ScheduleResponse {
  data?: {
    schedule?: {
      pages?: { older?: string | null; newer?: string | null };
      events?: LolScheduleEvent[];
    };
  };
}

export interface SchedulePage {
  events: LolScheduleEvent[];
  olderToken: string | null;
}

/** One page of a league's schedule. `pageToken` (an `older` token from a prior
 *  page) walks backwards in time; omit it for the most-recent page. A
 *  league-filtered schedule commonly returns the whole history on one page
 *  (`older: null`) — verified for MSI 2026 — but this supports pagination for
 *  busier leagues. */
export async function getScheduleForLeague(
  leagueId: string,
  pageToken?: string
): Promise<SchedulePage> {
  const q = pageToken
    ? `/getSchedule?hl=en-US&leagueId=${encodeURIComponent(leagueId)}&pageToken=${encodeURIComponent(pageToken)}`
    : `/getSchedule?hl=en-US&leagueId=${encodeURIComponent(leagueId)}`;
  const r = await getJson<ScheduleResponse>(q);
  const sched = r.data?.schedule;
  return {
    events: sched?.events ?? [],
    olderToken: sched?.pages?.older ?? null,
  };
}

// ── getEventDetails (per match) ──────────────────────────────────────────────

export interface LolEventTeam {
  id?: string;
  code?: string;
}

export interface LolEventGame {
  number: number;
  id?: string;
  state?: string; // 'completed' | 'inProgress' | 'unneeded'
}

export interface LolEventDetails {
  teams: LolEventTeam[];
  games: LolEventGame[];
}

interface EventDetailsResponse {
  data?: { event?: { match?: { teams?: LolEventTeam[]; games?: LolEventGame[] } } };
}

/** Per-match detail: team ids + per-game esports ids. `games[].id` is the
 *  numeric esports game id the livestats feed keys on; `games[].number` is the
 *  1-based game-in-series number (matches the Leaguepedia GameId's trailing
 *  segment). */
export async function getEventDetails(matchId: string): Promise<LolEventDetails> {
  const r = await getJson<EventDetailsResponse>(
    `/getEventDetails?hl=en-US&id=${encodeURIComponent(matchId)}`
  );
  const m = r.data?.event?.match;
  return { teams: m?.teams ?? [], games: m?.games ?? [] };
}
