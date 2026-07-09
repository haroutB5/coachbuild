// ─────────────────────────────────────────────────────────────────────────────
// lib/pro/lolpros.ts — client for api.lolpros.gg (undocumented, unauthenticated).
// Verified live 2026-07-09:
//   GET /es/ladder?page=N        -> JSON array directly (20/page), each entry
//                                    carries ONE main `account` (not a list).
//                                    Empirically this endpoint only surfaces
//                                    EUW accounts (~300 pages before an empty
//                                    page) — no working region/server filter
//                                    param was found (?server=, ?region= are
//                                    silently ignored). Documented as a known
//                                    limitation, not a bug in this client —
//                                    per-account region can still differ once
//                                    we read a profile's full account list.
//   GET /es/profiles/{slug}      -> { ..., league_player: { position, accounts: [...] } }
//                                    NOT a top-level `accounts[]` as originally
//                                    assumed from the endpoint name alone —
//                                    confirmed by a live probe before building.
// Both endpoints are undocumented -> every read here is defensive: validate
// shape, never throw on a single malformed entry (log-and-skip instead).
// ─────────────────────────────────────────────────────────────────────────────

import type { LolProsAccountRaw, LolProsLadderEntry, LolProsProfile, LolProsTeamRaw } from "./types";

const BASE = "https://api.lolpros.gg/es";
const UA = "coachbuild-personal-use/0.1 (+https://coachbuild.vercel.app)";

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`lolpros ${url} -> ${res.status} ${res.statusText}`);
  return res.json();
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function toTeam(v: unknown): LolProsTeamRaw | null {
  if (!isObj(v)) return null;
  return {
    name: typeof v.name === "string" ? v.name : undefined,
    tag: typeof v.tag === "string" ? v.tag : undefined,
    slug: typeof v.slug === "string" ? v.slug : undefined,
  };
}

function toAccount(v: unknown): LolProsAccountRaw | null {
  if (!isObj(v)) return null;
  const names = Array.isArray(v.summoner_names)
    ? v.summoner_names
        .filter((n): n is Record<string, unknown> => isObj(n) && typeof n.name === "string")
        .map((n) => ({ name: n.name as string, created_at: typeof n.created_at === "string" ? n.created_at : undefined }))
    : undefined;
  return {
    uuid: typeof v.uuid === "string" ? v.uuid : undefined,
    server: typeof v.server === "string" ? v.server : undefined,
    encrypted_puuid: typeof v.encrypted_puuid === "string" ? v.encrypted_puuid : null,
    summoner_name: typeof v.summoner_name === "string" ? v.summoner_name : undefined,
    gamename: typeof v.gamename === "string" ? v.gamename : undefined,
    tagline: typeof v.tagline === "string" ? v.tagline : undefined,
    summoner_names: names,
  };
}

/** One page of the pro ladder. Returns [] on the (real) empty-tail page and
 *  on any unexpected shape — callers treat [] as "stop paging". */
export async function getLadderPage(page: number): Promise<LolProsLadderEntry[]> {
  const data = await getJson(`${BASE}/ladder?page=${page}`);
  if (!Array.isArray(data)) return [];
  const out: LolProsLadderEntry[] = [];
  for (const raw of data) {
    if (!isObj(raw) || typeof raw.uuid !== "string" || typeof raw.slug !== "string") continue;
    out.push({
      uuid: raw.uuid,
      name: typeof raw.name === "string" ? raw.name : raw.slug,
      slug: raw.slug,
      country: typeof raw.country === "string" ? raw.country : null,
      position: typeof raw.position === "string" ? raw.position : null,
      team: toTeam(raw.team),
      account: toAccount(raw.account),
    });
  }
  return out;
}

/** Full profile (all known accounts across regions/smurfs), or null if the
 *  slug 404s or the payload doesn't look like a profile. */
export async function getProfile(slug: string): Promise<LolProsProfile | null> {
  const data = await getJson(`${BASE}/profiles/${encodeURIComponent(slug)}`);
  if (!isObj(data) || typeof data.uuid !== "string") return null;
  const lp = isObj(data.league_player) ? data.league_player : {};
  const accountsRaw = Array.isArray(lp.accounts) ? lp.accounts : [];
  const accounts = accountsRaw.map(toAccount).filter((a): a is LolProsAccountRaw => a !== null);
  return {
    uuid: data.uuid,
    name: typeof data.name === "string" ? data.name : slug,
    slug: typeof data.slug === "string" ? data.slug : slug,
    country: typeof data.country === "string" ? data.country : null,
    position: typeof lp.position === "string" ? lp.position : null,
    team: toTeam(data.team) ?? (Array.isArray(data.teams) ? toTeam(data.teams[0]) : null),
    accounts,
  };
}
