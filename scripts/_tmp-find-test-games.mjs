import { loadEnvLocal } from "./_env.mjs";
loadEnvLocal();
const { getSql } = await import("../lib/pro/db.ts");
const sql = getSql();

const soloq = await sql`
  SELECT pm.match_id, pm.champion_id, pm.role, pm.pro_id
  FROM coachbuild.pro_matches pm
  WHERE pm.ally_champion_ids IS NOT NULL
  ORDER BY pm.match_id ASC
  LIMIT 3
`;
console.log("soloq (backfilled):", JSON.stringify(soloq));

const prostage = await sql`
  SELECT pm.game_id, pm.champion_id, pm.role, pm.tournament_display, pm.team, pm.pro_id
  FROM coachbuild.prostage_matches pm
  WHERE pm.tournament_display ILIKE '%MSI%'
  ORDER BY pm.game_datetime DESC
  LIMIT 3
`;
console.log("prostage MSI:", JSON.stringify(prostage));

// how many rows does that game_id have, and team split
if (prostage.length > 0) {
  const gid = prostage[0].game_id;
  const rows = await sql`SELECT team, champion_id FROM coachbuild.prostage_matches WHERE game_id = ${gid}`;
  console.log(`rows for ${gid}:`, JSON.stringify(rows));
}
