// ─────────────────────────────────────────────────────────────────────────────
// lib/pro/riot.ts — typed Riot API client. Every call is paced through
// pacer.ts (shared process-wide queue) and requires RIOT_API_KEY — throws
// RiotUnavailableError up front (before consuming a pacer slot) when absent.
// ─────────────────────────────────────────────────────────────────────────────

import { pacedCall } from "./pacer";
import { RiotUnavailableError } from "./errors";
import type { RiotAccountDto, RiotMatch, RiotTimeline } from "./types";

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
  constructor(url: string, status: number, statusText: string) {
    super(`riot ${url} -> ${status} ${statusText}`);
    this.name = "RiotRequestError";
    this.status = status;
  }
}

async function riotFetch<T>(url: string): Promise<T> {
  const key = requireKey();
  return pacedCall(async () => {
    const res = await fetch(url, { headers: { "X-Riot-Token": key } });
    if (!res.ok) throw new RiotRequestError(url, res.status, res.statusText);
    return res.json() as Promise<T>;
  });
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

export function getMatchIdsByPuuid(
  regional: string,
  puuid: string,
  opts: { queue?: number; start?: number; count?: number } = {}
): Promise<string[]> {
  const { queue = 420, start = 0, count = 20 } = opts;
  return riotFetch<string[]>(
    `https://${regional}.api.riotgames.com/lol/match/v5/matches/by-puuid/${puuid}/ids?queue=${queue}&start=${start}&count=${count}`
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
