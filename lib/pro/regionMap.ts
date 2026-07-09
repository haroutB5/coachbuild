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
