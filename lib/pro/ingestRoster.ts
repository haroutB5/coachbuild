// ─────────────────────────────────────────────────────────────────────────────
// lib/pro/ingestRoster.ts — page the lolpros ladder, resolve each pro's
// accounts to a working PUUID, upsert pros + pro_accounts. Shared core used by
// both scripts/ingest-roster.mjs (local backfill) and
// app/api/ingest/roster/route.ts (guarded, chunk-free — roster size is small
// enough to run in one serverless invocation at moderate ROSTER_SIZE).
// ─────────────────────────────────────────────────────────────────────────────

import { getSql } from "./db";
import { DbUnavailableError } from "./errors";
import { getLadderPage, getProfile } from "./lolpros";
import { resolveAccount } from "./puuidResolve";
import { roleFromLolProsPosition } from "./roleMap";
import { decideAccountRegionActivation, type AccountForRegionRule } from "./teamRegions";
import type { LolProsLadderEntry } from "./types";

const MAX_PAGES = 400; // real ladder ends well before this (empirically ~300) — hard safety cap
const LOLPROS_DELAY_MS = 300; // politeness gap between lolpros profile calls

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface RosterIngestOptions {
  rosterSize?: number;
  onProgress?: (msg: string) => void;
}

export interface RosterIngestResult {
  pagesFetched: number;
  prosSeen: number;
  prosUpserted: number;
  accountsUpserted: number;
  accountsUnresolved: number;
  errors: string[];
  /** Directive 1 (2026-07-09): team-region activation rule, applied at the
   *  end of each pro's account upsert. */
  accountsRegionActivated: number;
  accountsRegionDeactivated: number;
  unmappedTeams: string[];
}

export async function runRosterIngest(opts: RosterIngestOptions = {}): Promise<RosterIngestResult> {
  const sql = getSql();
  if (!sql) throw new DbUnavailableError();

  const rosterSize = opts.rosterSize ?? 100;
  const log = opts.onProgress ?? (() => {});

  const result: RosterIngestResult = {
    pagesFetched: 0,
    prosSeen: 0,
    prosUpserted: 0,
    accountsUpserted: 0,
    accountsUnresolved: 0,
    errors: [],
    accountsRegionActivated: 0,
    accountsRegionDeactivated: 0,
    unmappedTeams: [],
  };

  const seenSlugs = new Set<string>();
  let page = 0;

  while (result.prosSeen < rosterSize && page < MAX_PAGES) {
    page += 1;
    let entries: LolProsLadderEntry[];
    try {
      entries = await getLadderPage(page);
    } catch (err) {
      result.errors.push(`ladder page ${page}: ${(err as Error).message}`);
      break;
    }
    result.pagesFetched += 1;
    if (entries.length === 0) break;

    for (const entry of entries) {
      if (result.prosSeen >= rosterSize) break;
      if (seenSlugs.has(entry.slug)) continue;
      seenSlugs.add(entry.slug);
      result.prosSeen += 1;

      try {
        await ingestOnePro(sql, entry, result, log);
      } catch (err) {
        result.errors.push(`pro ${entry.slug}: ${(err as Error).message}`);
      }
      await sleep(LOLPROS_DELAY_MS);
    }
  }

  return result;
}

/** Exported so a targeted single-slug script (e.g. scripts/upsert-pro.mjs)
 *  can upsert one pro without paging the whole ladder — same account-
 *  resolution + team-region-rule path as the full roster sweep, no
 *  duplicated logic. `entry.uuid` is used as-is for the pros.id upsert key —
 *  callers targeting an EXISTING pro must pass that pro's real id (not a
 *  freshly-generated one), and callers targeting a brand-new pro must pass
 *  the lolpros-profile-confirmed uuid. */
export async function ingestOnePro(
  sql: NonNullable<ReturnType<typeof getSql>>,
  entry: LolProsLadderEntry,
  result: RosterIngestResult,
  log: (msg: string) => void
): Promise<void> {
  const profile = await getProfile(entry.slug).catch(() => null);

  const position = profile?.position ?? entry.position ?? null;
  const role = roleFromLolProsPosition(position);
  const team = (profile?.team?.name ?? entry.team?.name) ?? null;
  const country = profile?.country ?? entry.country ?? null;
  const name = profile?.name ?? entry.name;

  await sql`
    INSERT INTO coachbuild.pros (id, name, slug, team, role, country, updated_at)
    VALUES (${entry.uuid}, ${name}, ${entry.slug}, ${team}, ${role}, ${country}, now())
    ON CONFLICT (id) DO UPDATE SET
      name = EXCLUDED.name,
      slug = EXCLUDED.slug,
      team = EXCLUDED.team,
      role = EXCLUDED.role,
      country = EXCLUDED.country,
      updated_at = now()
  `;
  result.prosUpserted += 1;

  const accounts = profile?.accounts ?? (entry.account ? [entry.account] : []);
  for (const account of accounts) {
    const resolved = await resolveAccount(account).catch((err) => {
      log(`resolve ${entry.slug}/${account.server ?? "?"}: ${(err as Error).message}`);
      return null;
    });
    if (!resolved) {
      result.accountsUnresolved += 1;
      continue;
    }
    await sql`
      INSERT INTO coachbuild.pro_accounts (puuid, pro_id, region, riot_id, active, created_at)
      VALUES (${resolved.puuid}, ${entry.uuid}, ${resolved.region}, ${resolved.riotId}, ${resolved.active}, now())
      ON CONFLICT (puuid) DO UPDATE SET
        pro_id = EXCLUDED.pro_id,
        region = EXCLUDED.region,
        riot_id = EXCLUDED.riot_id,
        active = EXCLUDED.active
    `;
    if (resolved.active) {
      result.accountsUpserted += 1;
    } else {
      result.accountsUnresolved += 1;
    }
  }

  await applyRegionRuleToPro(sql, entry.uuid, team, result, log);
}

/** Directive 1 (2026-07-09): deactivate a pro's off-region accounts against
 *  their PRO TEAM's expected platform region (Faker/T1/LCK -> KR is the
 *  motivating case — his EUW bootcamp accounts were polluting "recent
 *  games"). Reads the pro's FULL current account set (not just the ones
 *  upserted this round) — a pro can carry accounts from an earlier ingest
 *  that no longer appear in today's lolpros profile response, and those
 *  still need the same region check. See lib/pro/teamRegions.ts for the
 *  full rule (region/unreachable/unmapped/none) and its tradeoffs. */
export async function applyRegionRuleToPro(
  sql: NonNullable<ReturnType<typeof getSql>>,
  proId: string,
  team: string | null,
  result: RosterIngestResult,
  log: (msg: string) => void
): Promise<void> {
  const accounts = (await sql`
    SELECT puuid, region, active FROM coachbuild.pro_accounts WHERE pro_id = ${proId}
  `) as unknown as AccountForRegionRule[];
  if (accounts.length === 0) return;

  const { decisions, unmappedTeam } = decideAccountRegionActivation(team, accounts);
  if (unmappedTeam) {
    log(`pro ${proId}: team "${unmappedTeam}" not in curated teamRegions map — accounts left unchanged`);
    if (!result.unmappedTeams.includes(unmappedTeam)) result.unmappedTeams.push(unmappedTeam);
  }

  for (const decision of decisions) {
    if (!decision.changed) continue;
    await sql`UPDATE coachbuild.pro_accounts SET active = ${decision.active} WHERE puuid = ${decision.puuid}`;
    if (decision.active) result.accountsRegionActivated += 1;
    else result.accountsRegionDeactivated += 1;
  }
}
