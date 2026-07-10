import { loadEnvLocal } from "./_env.mjs";
loadEnvLocal();
const { getSql } = await import("../lib/pro/db.ts");
const sql = getSql();
const rows = await sql`
  SELECT match_id, champion_id, role, pro_id, game_creation, ally_champion_ids IS NOT NULL AS has_comps
  FROM coachbuild.pro_matches
  WHERE game_creation > now() - make_interval(days => 90)
    AND ally_champion_ids IS NOT NULL
  ORDER BY game_creation DESC
  LIMIT 5
`;
console.log(JSON.stringify(rows, null, 2));
