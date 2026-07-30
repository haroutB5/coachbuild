// ─────────────────────────────────────────────────────────────────────────────
// lib/pro/regionMap.ts — lolpros `server` string -> Riot platform + regional
// routing. Unknown servers are skip-and-log (never throw to callers).
// ─────────────────────────────────────────────────────────────────────────────

export interface RiotRouting {
  platform: string; // e.g. "euw1" — account-v1 / summoner-v4 host
  regional: string; // e.g. "europe" — match-v5 host
}

// Regional routing per Riot's match-v5 docs (OCE moved under `americas`
// alongside NA/BR/LAN/LAS in 2023; RU/TR route under `europe`).
const ROUTING: Record<string, RiotRouting> = {
  EUW: { platform: "euw1", regional: "europe" },
  EUNE: { platform: "eun1", regional: "europe" },
  TR: { platform: "tr1", regional: "europe" },
  RU: { platform: "ru", regional: "europe" },
  NA: { platform: "na1", regional: "americas" },
  BR: { platform: "br1", regional: "americas" },
  LAN: { platform: "la1", regional: "americas" },
  LAS: { platform: "la2", regional: "americas" },
  OCE: { platform: "oc1", regional: "americas" },
  KR: { platform: "kr", regional: "asia" },
  JP: { platform: "jp1", regional: "asia" },
  VN: { platform: "vn2", regional: "sea" },
  PH: { platform: "ph2", regional: "sea" },
  SG: { platform: "sg2", regional: "sea" },
  TH: { platform: "th2", regional: "sea" },
  TW: { platform: "tw2", regional: "sea" },
};

/** Returns null for unmapped servers — caller must skip+log, never throw. */
export function routingForServer(server: string | undefined | null): RiotRouting | null {
  if (!server) return null;
  return ROUTING[server.toUpperCase()] ?? null;
}

/** Reverse lookup: Riot PLATFORM id ("euw1") -> this table's own server key
 *  ("EUW") plus its routing. Derived from ROUTING above rather than declared
 *  as a second literal map, so the two directions can never drift apart.
 *
 *  WHY THIS EXISTS (My Stats multi-account, v0.83). A tagLine is NOT a region
 *  and cannot be turned into one: the user's own second account is
 *  "K1ayer#swift", and `routingForServer("swift")` returns null — a custom tag
 *  carries no routing information whatsoever. Neither does the League client's
 *  own current-summoner payload (a real capture in _capture/ has gameName,
 *  tagLine and puuid, and no region/platformId/locale field of any kind). The
 *  authoritative answer comes from Riot's own account-v1
 *  `region/by-game/lol/by-puuid` endpoint, which answers with a platform id
 *  ("euw1") — verified live 2026-07-29 against the stored puuid, HTTP 200
 *  {"game":"lol","region":"euw1"}, and it returns the same answer from ANY
 *  regional route, so no bootstrap region is needed to ask the question. This
 *  function converts that answer into the app's existing region vocabulary so
 *  my_account.region keeps the same "EUW"-style values migration 0012 stored.
 *
 *  Case-insensitive on input; null (never a guess) for an unmapped platform. */
export function routingForPlatform(
  platform: string | undefined | null
): { server: string; routing: RiotRouting } | null {
  if (!platform) return null;
  const wanted = platform.toLowerCase();
  for (const [server, routing] of Object.entries(ROUTING)) {
    if (routing.platform === wanted) return { server, routing };
  }
  return null;
}
