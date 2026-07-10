// One-off: backfill team comps for ONE fresh (within-90-day) row, for local
// route validation only — picks a row the background full-backfill hasn't
// reached yet (ORDER BY match_id ASC cursor), independent of that cursor.
import { loadEnvLocal } from "./_env.mjs";
loadEnvLocal();
const { getSql } = await import("../lib/pro/db.ts");
const { routingForServer } = await import("../lib/pro/regionMap.ts");
const { getMatch } = await import("../lib/pro/riot.ts");
const { extractTeamComps } = await import("../lib/pro/extract.ts");

const sql = getSql();
const [row] = await sql`
  SELECT pm.match_id, pm.puuid, pa.region, pm.champion_id, pm.role
  FROM coachbuild.pro_matches pm
  JOIN coachbuild.pro_accounts pa ON pa.puuid = pm.puuid
  WHERE pm.ally_champion_ids IS NULL
    AND pm.game_creation > now() - make_interval(days => 90)
  ORDER BY pm.game_creation DESC
  LIMIT 1
`;
if (!row) {
  console.log("no fresh row without comps found");
  process.exit(0);
}
console.log("target:", JSON.stringify(row));
const routing = routingForServer(row.region);
const match = await getMatch(routing.regional, row.match_id);
const comps = extractTeamComps(match, row.puuid);
console.log("comps:", JSON.stringify(comps));
if (comps) {
  await sql`
    UPDATE coachbuild.pro_matches
    SET ally_champion_ids = ${JSON.stringify(comps.allyChampionIds)}::jsonb,
        enemy_champion_ids = ${JSON.stringify(comps.enemyChampionIds)}::jsonb
    WHERE match_id = ${row.match_id} AND puuid = ${row.puuid}
  `;
  console.log("updated.");
}
