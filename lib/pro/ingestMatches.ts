// ─────────────────────────────────────────────────────────────────────────────
// lib/pro/ingestMatches.ts — per-account match backfill/incremental ingest.
// Chunked by design: process `batch` accounts (ordered by last_fetched_at
// ascending) per call, return the next cursor. Shared core used by both
// scripts/ingest-matches.mjs (local backfill loop) and
// app/api/ingest/matches/route.ts (guarded, serverless-timeout-safe).
// ─────────────────────────────────────────────────────────────────────────────

import { getSql } from "./db";
import { DbUnavailableError, RiotUnavailableError } from "./errors";
import { extractMatch } from "./extract";
import { freshStartTimeEpochSec } from "./fresh";
import { routingForServer } from "./regionMap";
import { getMatch, getMatchIdsByPuuid, getMatchTimeline, RiotRequestError } from "./riot";

export interface MatchIngestOptions {
  batch?: number;
  cursor?: number;
  matchesPerAccount?: number;
  onProgress?: (msg: string) => void;
}

export interface MatchIngestResult {
  accountsProcessed: number;
  matchesUpserted: number;
  nextCursor: number | null;
  errors: string[];
}

interface AccountRow {
  puuid: string;
  pro_id: string;
  region: string;
  riot_id: string;
}

export async function runMatchIngest(opts: MatchIngestOptions = {}): Promise<MatchIngestResult> {
  const sql = getSql();
  if (!sql) throw new DbUnavailableError();
  if (!process.env.RIOT_API_KEY) throw new RiotUnavailableError();

  const batch = opts.batch ?? 5;
  const cursor = opts.cursor ?? 0;
  const matchesPerAccount = opts.matchesPerAccount ?? 20;
  const log = opts.onProgress ?? (() => {});

  const result: MatchIngestResult = {
    accountsProcessed: 0,
    matchesUpserted: 0,
    nextCursor: null,
    errors: [],
  };

  const accounts = (await sql`
    SELECT puuid, pro_id, region, riot_id
    FROM coachbuild.pro_accounts
    WHERE active = true
    ORDER BY last_fetched_at ASC NULLS FIRST
    OFFSET ${cursor} LIMIT ${batch}
  `) as unknown as AccountRow[];

  for (const account of accounts) {
    result.accountsProcessed += 1;
    try {
      const upserted = await ingestOneAccount(sql, account, matchesPerAccount, log);
      result.matchesUpserted += upserted;
    } catch (err) {
      result.errors.push(`account ${account.riot_id}: ${(err as Error).message}`);
    }
  }

  result.nextCursor = accounts.length < batch ? null : cursor + batch;
  return result;
}

export async function ingestOneAccount(
  sql: NonNullable<ReturnType<typeof getSql>>,
  account: AccountRow,
  matchesPerAccount: number,
  log: (msg: string) => void
): Promise<number> {
  const routing = routingForServer(account.region);
  if (!routing) {
    log(`account ${account.riot_id}: unmapped region ${account.region}, skipping`);
    return 0;
  }

  const matchIds = await getMatchIdsByPuuid(routing.regional, account.puuid, {
    queue: 420,
    start: 0,
    count: matchesPerAccount,
    startTime: freshStartTimeEpochSec(),
  });

  let existing = new Set<string>();
  if (matchIds.length > 0) {
    const rows = (await sql`
      SELECT match_id FROM coachbuild.pro_matches
      WHERE puuid = ${account.puuid} AND match_id = ANY(${matchIds}::text[])
    `) as unknown as { match_id: string }[];
    existing = new Set(rows.map((r) => r.match_id));
  }
  const newIds = matchIds.filter((id) => !existing.has(id));

  let upserted = 0;
  let maxGameCreation: number | null = null;

  for (const matchId of newIds) {
    try {
      const match = await getMatch(routing.regional, matchId);
      const timeline = await getMatchTimeline(routing.regional, matchId);
      const row = extractMatch(match, timeline, account.puuid, account.pro_id);
      if (!row) {
        log(`match ${matchId}: unresolvable role/participant, skipping`);
        continue;
      }
      await sql`
        INSERT INTO coachbuild.pro_matches (
          match_id, puuid, pro_id, champion_id, champion_name, role, patch, win,
          kills, deaths, assists, game_creation, game_duration_sec,
          spells, final_items, trinket, purchase_order, skill_order, runes,
          cs, damage_champions, team_kills, gold, ally_champion_ids, enemy_champion_ids,
          ally_players, enemy_players
        ) VALUES (
          ${row.matchId}, ${row.puuid}, ${account.pro_id}, ${row.championId}, ${row.championName},
          ${row.role}, ${row.patch}, ${row.win}, ${row.kills}, ${row.deaths}, ${row.assists},
          ${row.gameCreation}, ${row.gameDurationSec},
          ${JSON.stringify(row.spells)}::jsonb, ${JSON.stringify(row.finalItems)}::jsonb, ${row.trinket},
          ${JSON.stringify(row.purchaseOrder)}::jsonb, ${JSON.stringify(row.skillOrder)}::jsonb, ${JSON.stringify(row.runes)}::jsonb,
          ${row.cs}, ${row.damageChampions}, ${row.teamKills}, ${row.gold},
          ${row.allyChampionIds ? JSON.stringify(row.allyChampionIds) : null}::jsonb,
          ${row.enemyChampionIds ? JSON.stringify(row.enemyChampionIds) : null}::jsonb,
          ${row.allyPlayers ? JSON.stringify(row.allyPlayers) : null}::jsonb,
          ${row.enemyPlayers ? JSON.stringify(row.enemyPlayers) : null}::jsonb
        )
        ON CONFLICT (match_id, puuid) DO NOTHING
      `;
      upserted += 1;
      const ts = new Date(row.gameCreation).getTime();
      if (maxGameCreation === null || ts > maxGameCreation) maxGameCreation = ts;
    } catch (err) {
      if (err instanceof RiotRequestError) {
        log(`match ${matchId}: riot ${err.status}, skipping`);
        continue;
      }
      throw err;
    }
  }

  await sql`
    UPDATE coachbuild.pro_accounts
    SET last_fetched_at = now(),
        last_match_ts = GREATEST(COALESCE(last_match_ts, 0), ${maxGameCreation ?? 0})
    WHERE puuid = ${account.puuid}
  `;

  return upserted;
}
