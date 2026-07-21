// ─────────────────────────────────────────────────────────────────────────────
// lib/mystats/account.ts — resolves + caches the ONE personal account this
// feature tracks. Deliberately narrow (no roster, no fallback-puuid-probe
// dance like lib/pro/puuidResolve.ts — that file exists because lolpros
// supplies an untrusted puuid that needs a live validation probe; here the
// ONLY input is a literal Riot ID, so account-v1 by-riot-id is the single
// path, no probe needed).
//
// Brief contract: the Riot ID is BELIEVED to be "MunsterHunter#EUW" — if
// that literal tag doesn't resolve, this does NOT try alternate taglines
// (EUW1, euw, etc.) or alternate gameName spellings. A wrong guess degrades
// to `accountUnresolved` everywhere (ingest + both aggregation routes) and
// stays that way until corrected (via MY_RIOT_ID/MY_RIOT_REGION env
// overrides — see below — or a manual DB fix) — never a silent auto-retry
// with a mutated tag.
// ─────────────────────────────────────────────────────────────────────────────

import { getAccountByRiotId, RiotRequestError } from "@/lib/pro/riot";
import { RiotUnavailableError } from "@/lib/pro/errors";
import { routingForServer, type RiotRouting } from "@/lib/pro/regionMap";
import type { getSql } from "@/lib/pro/db";
import type { MyAccountRow } from "./types";

/** Overridable via env so a wrong initial guess can be corrected without a
 *  code change/redeploy — the brief's literal is the default. */
export const MY_RIOT_ID = process.env.MY_RIOT_ID ?? "MunsterHunter#EUW";
export const MY_RIOT_REGION = process.env.MY_RIOT_REGION ?? "EUW";

export interface ResolvedMyAccount {
  puuid: string;
  riotId: string;
  region: string;
  routing: RiotRouting;
}

function splitRiotId(riotId: string): [string, string] | null {
  const idx = riotId.indexOf("#");
  if (idx < 0) return null;
  const gameName = riotId.slice(0, idx);
  const tagLine = riotId.slice(idx + 1);
  if (!gameName || !tagLine) return null;
  return [gameName, tagLine];
}

/** Reads the persisted account row, or null if never resolved. */
export async function getMyAccount(
  sql: NonNullable<ReturnType<typeof getSql>>
): Promise<ResolvedMyAccount | null> {
  const rows = (await sql`
    SELECT riot_id, puuid, region FROM coachbuild.my_account WHERE id = 1
  `) as unknown as Pick<MyAccountRow, "riot_id" | "puuid" | "region">[];
  const row = rows[0];
  if (!row) return null;
  const routing = routingForServer(row.region);
  if (!routing) return null; // shouldn't happen (region was validated at resolve time), but stay defensive
  return { puuid: row.puuid, riotId: row.riot_id, region: row.region, routing };
}

/** Attempts to resolve MY_RIOT_ID against Riot's account-v1 and persists the
 *  result. Returns null on a DEFINITIVE failure (account genuinely doesn't
 *  exist under this literal tag — a clean 4xx-not-429) OR a transient one
 *  (network blip / 5xx / 429) — both cases mean "not resolved right now,"
 *  and the caller (runMyStatsIngest) surfaces `accountUnresolved` either
 *  way. Unlike lib/pro/puuidResolve.ts's resolveAccount, there's no prior
 *  `active` state to protect from a false downgrade (this table has no row
 *  at all until resolution first succeeds), so the transient/definitive
 *  distinction doesn't need to be exposed to the caller — it only matters
 *  for whether a future retry is worth attempting, and retrying the SAME
 *  literal tag on the next ingest tick is always safe and cheap (one paced
 *  Riot call) regardless of which kind of failure this was. */
export async function resolveMyAccount(
  sql: NonNullable<ReturnType<typeof getSql>>
): Promise<ResolvedMyAccount | null> {
  const routing = routingForServer(MY_RIOT_REGION);
  if (!routing) return null; // MY_RIOT_REGION misconfigured — not a Riot call, nothing to retry differently

  const split = splitRiotId(MY_RIOT_ID);
  if (!split) return null; // MY_RIOT_ID misconfigured (no '#') — same, not a Riot-side failure

  const [gameName, tagLine] = split;
  try {
    const acc = await getAccountByRiotId(routing.regional, gameName, tagLine);
    const riotId = `${acc.gameName}#${acc.tagLine}`;
    await sql`
      INSERT INTO coachbuild.my_account (id, riot_id, puuid, region)
      VALUES (1, ${riotId}, ${acc.puuid}, ${MY_RIOT_REGION})
      ON CONFLICT (id) DO UPDATE SET riot_id = EXCLUDED.riot_id, puuid = EXCLUDED.puuid, region = EXCLUDED.region
    `;
    return { puuid: acc.puuid, riotId, region: MY_RIOT_REGION, routing };
  } catch (err) {
    if (err instanceof RiotUnavailableError) throw err; // no key configured -- caller must distinguish this from "unresolved"
    if (err instanceof RiotRequestError) return null; // definitive rejection (404/400) -- do NOT guess alternate tags
    return null; // transient (network throw / 5xx / 429) -- next ingest tick retries the same literal tag
  }
}

/** Convenience: cached row if present, else attempts a fresh resolution. */
export async function ensureMyAccount(
  sql: NonNullable<ReturnType<typeof getSql>>
): Promise<ResolvedMyAccount | null> {
  const existing = await getMyAccount(sql);
  if (existing) return existing;
  return resolveMyAccount(sql);
}
