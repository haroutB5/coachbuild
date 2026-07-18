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
import { getAccountByRiotId, getMatchIdsByPuuid, RiotRequestError } from "./riot";
import { RiotUnavailableError } from "./errors";
import type { LolProsAccountRaw } from "./types";

/** P3(d) fix (2026-07-17 Fable review): distinguishes a DEFINITIVE Riot
 *  rejection (4xx other than 429 — the puuid/riotId genuinely doesn't
 *  resolve) from a TRANSIENT failure (network/fetch throw, 5xx, or 429
 *  rate-limit) that says nothing about whether the account is actually
 *  good. A non-RiotRequestError is always transient (fetch threw before
 *  Riot even returned a response, or the response body failed to parse) —
 *  see resolveAccount's doc comment for why this matters (there's no roster
 *  cron re-check to self-heal a wrongly-inactive account). */
function isTransientRiotError(err: unknown): boolean {
  if (err instanceof RiotRequestError) return err.status >= 500 || err.status === 429;
  return true;
}

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
 *  no puuid AND no riot id to fall back on), OR when every attempted path
 *  failed but at least one of those failures was TRANSIENT (P3(d) fix,
 *  2026-07-17 — see isTransientRiotError above) — caller should skip+log
 *  WITHOUT touching the account's stored `active` state (lib/pro/
 *  ingestRoster.ts's ingestOnePro only upserts when this returns non-null,
 *  so null leaves an existing DB row completely alone). Before this fix, a
 *  one-off network blip or a Riot 503/429 on the puuid probe fell through
 *  to the SAME "both attempts failed" path a genuine 400/404 does, silently
 *  flipping a perfectly good, already-active account to `active: false` —
 *  sticky, since there's no separate roster cron to re-check and self-heal
 *  it. Only a DEFINITIVE rejection (every attempted path came back a clean
 *  4xx-not-429, or there was nothing to attempt) may downgrade `active`. */
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

  let sawTransientFailure = false;

  // 1. Try the lolpros puuid directly.
  if (lolprosPuuid) {
    try {
      await getMatchIdsByPuuid(routing.regional, lolprosPuuid, { count: 1 });
      return { ...base, puuid: lolprosPuuid, riotId: riotId ?? account.summoner_name ?? lolprosPuuid, active: true };
    } catch (err) {
      if (err instanceof RiotUnavailableError) throw err;
      if (isTransientRiotError(err)) sawTransientFailure = true;
      // RiotRequestError (definitive 4xx) or a transient blip either way ->
      // fall through and still TRY the riotId fallback (a different Riot
      // endpoint — worth attempting even after a transient hit on this one).
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
        if (isTransientRiotError(err)) sawTransientFailure = true;
        // fall through to unresolved
      }
    }
  }

  // A transient blip anywhere in the chain -> skip this pass without
  // touching `active` at all (see this function's doc comment).
  if (sawTransientFailure) return null;

  // Every attempted path definitively failed (clean 4xx-not-429, or nothing
  // was attempted) — store what we have (if anything) as inactive.
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
