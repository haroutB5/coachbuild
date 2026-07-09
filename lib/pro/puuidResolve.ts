// ─────────────────────────────────────────────────────────────────────────────
// lib/pro/puuidResolve.ts — resolve a lolpros account to a PUUID that actually
// works against OUR Riot key. Strategy (per spec, 2026-07-09):
//   1. Try the lolpros-supplied encrypted_puuid directly (cheap probe: ask
//      for 1 match id — costs one paced Riot call either way).
//   2. On 400/404 (or no lolpros puuid at all), fall back to
//      account-v1/by-riot-id using gameName#tagLine.
//   3. Without RIOT_API_KEY: skip validation entirely, store the lolpros
//      puuid as-is (unresolved/inactive) so match ingest — which strictly
//      requires a validated puuid — skips it until a key is configured.
// ─────────────────────────────────────────────────────────────────────────────

import { routingForServer } from "./regionMap";
import { getAccountByRiotId, getMatchIdsByPuuid } from "./riot";
import { RiotUnavailableError } from "./errors";
import type { LolProsAccountRaw } from "./types";

export interface ResolvedAccount {
  puuid: string;
  riotId: string; // "gameName#tagLine"
  region: string; // lolpros server string, e.g. "EUW"
  platform: string;
  regional: string;
  /** true = validated against our Riot key (or no key was available to check
   *  but we still have SOMETHING to try later); false = confirmed unresolved
   *  (both puuid probe and by-riot-id fallback failed). */
  active: boolean;
}

function riotIdOf(account: LolProsAccountRaw): string | null {
  if (account.gamename && account.tagline) return `${account.gamename}#${account.tagline}`;
  if (account.summoner_name?.includes("#")) return account.summoner_name;
  return null;
}

/** Returns null when the account can't even be attempted (no region match,
 *  no puuid AND no riot id to fall back on) — caller should skip+log. */
export async function resolveAccount(account: LolProsAccountRaw): Promise<ResolvedAccount | null> {
  const routing = routingForServer(account.server);
  if (!routing) return null;

  const riotId = riotIdOf(account);
  const lolprosPuuid = account.encrypted_puuid ?? null;
  if (!lolprosPuuid && !riotId) return null;

  const base = { region: account.server as string, platform: routing.platform, regional: routing.regional };

  // No key configured: store best-effort, mark inactive so match ingest skips it.
  if (!process.env.RIOT_API_KEY) {
    if (lolprosPuuid) {
      return { ...base, puuid: lolprosPuuid, riotId: riotId ?? account.summoner_name ?? lolprosPuuid, active: false };
    }
    return null; // no puuid to store without a key to resolve one via riotId
  }

  // 1. Try the lolpros puuid directly.
  if (lolprosPuuid) {
    try {
      await getMatchIdsByPuuid(routing.regional, lolprosPuuid, { count: 1 });
      return { ...base, puuid: lolprosPuuid, riotId: riotId ?? account.summoner_name ?? lolprosPuuid, active: true };
    } catch (err) {
      if (err instanceof RiotUnavailableError) throw err;
      // RiotRequestError (400/404/etc) or network hiccup -> fall through to riotId fallback.
    }
  }

  // 2. Fallback: resolve via account-v1/by-riot-id.
  if (riotId) {
    const [gameName, tagLine] = splitRiotId(riotId);
    if (gameName && tagLine) {
      try {
        const acc = await getAccountByRiotId(routing.regional, gameName, tagLine);
        return { ...base, puuid: acc.puuid, riotId, active: true };
      } catch (err) {
        if (err instanceof RiotUnavailableError) throw err;
        // fall through to unresolved
      }
    }
  }

  // Both attempts failed — store what we have (if anything) as inactive.
  if (lolprosPuuid) {
    return { ...base, puuid: lolprosPuuid, riotId: riotId ?? account.summoner_name ?? lolprosPuuid, active: false };
  }
  return null;
}

function splitRiotId(riotId: string): [string | null, string | null] {
  const idx = riotId.indexOf("#");
  if (idx < 0) return [null, null];
  return [riotId.slice(0, idx), riotId.slice(idx + 1)];
}
