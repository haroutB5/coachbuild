// ─────────────────────────────────────────────────────────────────────────────
// lib/pro/riot.ts — typed Riot API client. Every call is paced through
// pacer.ts (shared process-wide queue) and requires RIOT_API_KEY — throws
// RiotUnavailableError up front (before consuming a pacer slot) when absent.
//
// ── 429 HANDLING (2026-07-29) ───────────────────────────────────────────────
// This module used to discard the response headers entirely, which meant Riot
// was telling us how full the bucket was and when to come back and we were
// answering by firing again 1.3s later. See lib/pro/pacer.ts's header for the
// measured failure. Two things happen here now, and the order matters:
//
//   * 429  -> `Retry-After` is AUTHORITATIVE. It becomes a pacer hold, so every
//             call in this process (not just the retry) waits it out, and the
//             call is retried up to MAX_RATE_LIMIT_RETRIES times AFTER the
//             stated delay. When the header is absent we fall back to a full
//             2-minute window rather than to a guess: `x-app-rate-limit` is
//             `100:120`, so one whole window is the shortest delay we can prove
//             clears the bucket.
//   * else -> the live `x-app-rate-limit-count` / `x-method-rate-limit-count`
//             are fed back to the pacer, which holds BEFORE the cap is reached
//             rather than after. This is the part that catches a second
//             spender (a Vercel route on the same key) while there is still
//             headroom left to give up.
//
// A retry costs a request, so it is bounded and reserved for 429 alone. Every
// other status still fails the call on the first attempt exactly as before.
// ─────────────────────────────────────────────────────────────────────────────

import { holdPacer, observeRateLimitBuckets, pacedCall } from "./pacer";
import { parseRateBuckets, parseRetryAfterSec, type RateBucket } from "./rateLimits";
import { RiotUnavailableError } from "./errors";
import { fetchWithTimeout } from "../fetchTimeout";
import type {
  RiotAccountDto,
  RiotLeagueEntryDto,
  RiotMatch,
  RiotRegionDto,
  RiotTimeline,
} from "./types";

/** Attempts AFTER the first for a 429 specifically. Each one waits out the
 *  server-stated delay first, so 2 is "give Riot two chances to mean it"
 *  without turning a sustained rate limit into an unbounded hammer. */
export const MAX_RATE_LIMIT_RETRIES = 2;

/** Hold applied to a 429 that arrives with NO Retry-After. One full
 *  `x-app-rate-limit` window (100:120) — the shortest delay that provably
 *  clears the bucket when the server declines to state one. */
export const DEFAULT_429_HOLD_SEC = 120;

function requireKey(): string {
  const key = process.env.RIOT_API_KEY;
  if (!key) throw new RiotUnavailableError();
  return key;
}

/** Distinct from RiotUnavailableError: the KEY exists but Riot rejected/rate
 *  limited/errored the call. Callers that want to skip-and-continue (ingest
 *  loops) should catch this specifically rather than treating it as fatal. */
export class RiotRequestError extends Error {
  status: number;
  /** Seconds Riot asked us to wait, or null when it did not say. Null is NOT
   *  "zero" — a caller must supply its own conservative default. */
  retryAfterSec: number | null;
  /** `x-rate-limit-type`: "application" | "method" | "service", or null. */
  limitType: string | null;
  constructor(
    url: string,
    status: number,
    statusText: string,
    meta: { retryAfterSec?: number | null; limitType?: string | null } = {}
  ) {
    super(`riot ${url} -> ${status} ${statusText}`);
    this.name = "RiotRequestError";
    this.status = status;
    this.retryAfterSec = meta.retryAfterSec ?? null;
    this.limitType = meta.limitType ?? null;
  }
}

/** True for the one status this module retries. Exported so ingest loops can
 *  classify a caught error the same way rather than re-deriving `=== 429`. */
export function isRateLimited(err: unknown): err is RiotRequestError {
  return err instanceof RiotRequestError && err.status === 429;
}

/** Both bucket families Riot reports, joined on window length. The method
 *  buckets are included because a per-endpoint limit can be exhausted while the
 *  app-wide one still looks healthy. */
export function readRateBuckets(headers: Headers): RateBucket[] {
  return [
    ...parseRateBuckets(headers.get("x-app-rate-limit"), headers.get("x-app-rate-limit-count")),
    ...parseRateBuckets(
      headers.get("x-method-rate-limit"),
      headers.get("x-method-rate-limit-count")
    ),
  ];
}

async function riotAttempt<T>(url: string, key: string): Promise<T> {
  const res = await fetchWithTimeout(url, { headers: { "X-Riot-Token": key } });

  if (!res.ok) {
    const err = new RiotRequestError(url, res.status, res.statusText, {
      retryAfterSec: parseRetryAfterSec(res.headers.get("retry-after")),
      limitType: res.headers.get("x-rate-limit-type"),
    });
    if (res.status === 429) {
      // Retry-After wins outright. Deriving a hold from the count headers here
      // too would silently override the server's own statement with our
      // arithmetic, and holding for a full window on every 429 would make the
      // Retry-After path dead code that nothing exercises.
      holdPacer(1000 * (err.retryAfterSec ?? DEFAULT_429_HOLD_SEC));
    } else {
      // A 404/5xx still carries the live bucket counts, and it still SPENT a
      // request. Dropping the reading here would blind the closed loop for
      // exactly as long as a run of failures lasts — which is when the budget
      // is most likely to be under pressure.
      observeRateLimitBuckets(readRateBuckets(res.headers));
    }
    throw err;
  }

  observeRateLimitBuckets(readRateBuckets(res.headers));
  return res.json() as Promise<T>;
}

async function riotFetch<T>(url: string): Promise<T> {
  const key = requireKey();
  for (let attempt = 0; ; attempt++) {
    try {
      return await pacedCall(() => riotAttempt<T>(url, key));
    } catch (err) {
      if (isRateLimited(err) && attempt < MAX_RATE_LIMIT_RETRIES) {
        // The hold was applied inside the attempt, so the next pacedCall cannot
        // start until the server-stated delay has elapsed — there is
        // deliberately no sleep here, because the wait belongs to the whole
        // process's queue, not to this one call.
        continue;
      }
      throw err;
    }
  }
}

/** Fallback PUUID resolution when the lolpros-supplied PUUID doesn't work
 *  against our Riot key. */
export function getAccountByRiotId(
  regional: string,
  gameName: string,
  tagLine: string
): Promise<RiotAccountDto> {
  return riotFetch<RiotAccountDto>(
    `https://${regional}.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(
      gameName
    )}/${encodeURIComponent(tagLine)}`
  );
}

/** account-v1 `region/by-game/{game}/by-puuid/{puuid}` — the AUTHORITATIVE
 *  platform id ("euw1") for an account we know only by puuid.
 *
 *  Added for My Stats multi-account (v0.83). The League client tells the
 *  companion who is logged in (gameName/tagLine/puuid) but NOT where they
 *  play, and match-v5 is routed by regional cluster, so something has to
 *  supply the region. Deriving it from the tagLine is not an option — see
 *  lib/pro/regionMap.ts's routingForPlatform header for why ("K1ayer#swift").
 *
 *  Verified live 2026-07-29 against the stored MunsterHunter puuid: HTTP 200
 *  {"puuid":"...","game":"lol","region":"euw1"}, identical from both the
 *  `europe` and `americas` routes — so the `regional` argument here is just a
 *  host to talk to, NOT a filter on the answer, and a caller with no region
 *  yet can safely pass any cluster. Callers pass DEFAULT_ACCOUNT_ROUTING
 *  unless they have a better reason. */
export function getRegionByPuuid(regional: string, puuid: string): Promise<RiotRegionDto> {
  return riotFetch<RiotRegionDto>(
    `https://${regional}.api.riotgames.com/riot/account/v1/region/by-game/lol/by-puuid/${encodeURIComponent(
      puuid
    )}`
  );
}

/** Any regional cluster answers account-v1 identically (see getRegionByPuuid's
 *  header) — `europe` is the arbitrary default, not a claim about the user. */
export const DEFAULT_ACCOUNT_ROUTING = "europe";

/** league-v4 `entries/by-puuid/{puuid}` — every ranked queue this account has a
 *  standing in, as an ARRAY. Added for My Stats rank/LP (2026-07-30).
 *
 *  TAKES A PLATFORM HOST ("euw1"), NOT A REGIONAL CLUSTER. league-v4 is
 *  platform-routed, unlike match-v5 (regional) and account-v1 (any cluster
 *  answers) — the two other Riot families this repo already calls. Passing
 *  `europe` here 404s. Callers pass `routing.platform` (lib/pro/regionMap.ts).
 *
 *  RETURNS AN ARRAY, AND AN EMPTY ARRAY IS A VALID, MEANINGFUL ANSWER: it is
 *  what an UNRANKED account looks like. It is NOT an error and must not be
 *  reported as one — see lib/mystats/rank.ts's soloQueueEntry, which is the
 *  single place that turns this array into a rank.
 *
 *  Probed live 2026-07-30 against both linked accounts, HTTP 200 both times.
 *  MunsterHunter#EUW returned exactly one entry (RANKED_SOLO_5x5); K1ayer#swift
 *  returned TWO — solo AND RANKED_FLEX_SR — which is why picking an entry by
 *  index instead of by queueType would silently show a flex rank on a badge
 *  labelled solo queue for one of the two accounts already in this database. */
export function getLeagueEntriesByPuuid(
  platform: string,
  puuid: string
): Promise<RiotLeagueEntryDto[]> {
  return riotFetch<RiotLeagueEntryDto[]>(
    `https://${platform}.api.riotgames.com/lol/league/v4/entries/by-puuid/${encodeURIComponent(puuid)}`
  );
}

export function getMatchIdsByPuuid(
  regional: string,
  puuid: string,
  opts: { queue?: number; start?: number; count?: number; startTime?: number } = {}
): Promise<string[]> {
  const { queue, start = 0, count = 20, startTime } = opts;
  // startTime (epoch seconds) keeps stale bootcamp/history games out of the
  // id list entirely — cheaper than fetching then discarding at extract time.
  const startTimeParam = startTime != null ? `&startTime=${startTime}` : "";
  // `queue` is OPTIONAL now (mystats P0 fix, 2026-07-21): omitting it from
  // the URL entirely returns matches from EVERY queue (Riot's own default),
  // which lib/mystats/ingest.ts relies on to fetch a personal account's full
  // mixed-queue history in one paginated stream rather than one call per
  // queue id. Every EXISTING caller (lib/pro/ingestMatches.ts,
  // scripts/audit-accounts.mjs) already passes an explicit `queue: 420` —
  // this is a behavior-preserving widening for them, not a default change.
  const queueParam = queue != null ? `&queue=${queue}` : "";
  return riotFetch<string[]>(
    `https://${regional}.api.riotgames.com/lol/match/v5/matches/by-puuid/${puuid}/ids?start=${start}&count=${count}${queueParam}${startTimeParam}`
  );
}

export function getMatch(regional: string, matchId: string): Promise<RiotMatch> {
  return riotFetch<RiotMatch>(`https://${regional}.api.riotgames.com/lol/match/v5/matches/${matchId}`);
}

export function getMatchTimeline(regional: string, matchId: string): Promise<RiotTimeline> {
  return riotFetch<RiotTimeline>(
    `https://${regional}.api.riotgames.com/lol/match/v5/matches/${matchId}/timeline`
  );
}
