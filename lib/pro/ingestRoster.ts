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

async function ingestOnePro(
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
}
