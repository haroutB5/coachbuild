#!/usr/bin/env node
// Backfills the migration-0006 columns (ally_champion_ids, enemy_champion_ids)
// on historical coachbuild.pro_matches rows ingested before those columns
// existed. Re-fetches match-v5 detail by match_id (1 call/match — no timeline
// needed, extractTeamComps only reads match.info.participants) and UPDATEs
// both columns together in place. Resumable via a `WHERE ally_champion_ids IS
// NULL` cursor (re-running after a partial run / crash just picks up where it
// left off — already-backfilled rows are ally_champion_ids IS NOT NULL and
// drop out of the WHERE clause on their own).
//
// Pacing: lib/pro/riot.ts's getMatch() already routes every call through the
// shared lib/pro/pacer.ts queue (1.3s min interval, process-wide) — this
// script doesn't need its own throttle, sequential awaits are enough.
//
// Single process by design (per the ingest scripts' existing convention) —
// do NOT parallelize match fetches, that would blow past the pacer's
// per-key rate limit modeling (it assumes one caller stream). Also do NOT run
// alongside any other Riot API consumer.
//
// Usage:
//   npx tsx scripts/backfill-team-comps.mjs [limit]
// `limit` (default 3) caps how many rows this run touches — pass a larger
// limit explicitly (or re-run repeatedly) once ready to spend that budget.
import { loadEnvLocal } from "./_env.mjs";

loadEnvLocal();

const { getSql } = await import("../lib/pro/db.ts");
const { routingForServer } = await import("../lib/pro/regionMap.ts");
const { getMatch, RiotRequestError } = await import("../lib/pro/riot.ts");
const { extractTeamComps } = await import("../lib/pro/extract.ts");

const limit = Number(process.argv[2]) || 3;

async function main() {
  const sql = getSql();
  if (!sql) throw new Error("DATABASE_URL missing");
  if (!process.env.RIOT_API_KEY) throw new Error("RIOT_API_KEY missing");

  const rows = await sql`
    SELECT pm.match_id, pm.puuid, pa.region
    FROM coachbuild.pro_matches pm
    JOIN coachbuild.pro_accounts pa ON pa.puuid = pm.puuid
    WHERE pm.ally_champion_ids IS NULL
    ORDER BY pm.match_id ASC
    LIMIT ${limit}
  `;

  console.log(`backfill-team-comps: ${rows.length} row(s) to process (limit=${limit})`);

  let updated = 0;
  let skipped = 0;
  const errors = [];

  for (const row of rows) {
    const routing = routingForServer(row.region);
    if (!routing) {
      console.log(`  ${row.match_id}: unmapped region ${row.region}, skipping`);
      skipped += 1;
      continue;
    }
    try {
      const match = await getMatch(routing.regional, row.match_id);
      const comps = extractTeamComps(match, row.puuid);
      if (!comps) {
        console.log(`  ${row.match_id}: puuid ${row.puuid} not in refetched match or not a clean 5v5, skipping`);
        skipped += 1;
        continue;
      }
      await sql`
        UPDATE coachbuild.pro_matches
        SET ally_champion_ids = ${JSON.stringify(comps.allyChampionIds)}::jsonb,
            enemy_champion_ids = ${JSON.stringify(comps.enemyChampionIds)}::jsonb
        WHERE match_id = ${row.match_id} AND puuid = ${row.puuid}
      `;
      updated += 1;
      console.log(
        `  ${row.match_id}: ally=[${comps.allyChampionIds.join(",")}] enemy=[${comps.enemyChampionIds.join(",")}]`
      );
    } catch (err) {
      if (err instanceof RiotRequestError) {
        console.log(`  ${row.match_id}: riot ${err.status}, skipping`);
        skipped += 1;
        continue;
      }
      errors.push(`${row.match_id}: ${err.message}`);
      console.log(`  ${row.match_id}: error - ${err.message}`);
    }
  }

  const summary = { processed: rows.length, updated, skipped, errors };
  console.log(JSON.stringify(summary, null, 2));
  if (errors.length > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error("backfill-team-comps failed:", err.message);
  process.exit(1);
});
