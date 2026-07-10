import { loadEnvLocal } from "./_env.mjs";
loadEnvLocal();
const { getSql } = await import("../lib/pro/db.ts");
const sql = getSql();
const rows = await sql`
  SELECT match_id, champion_id, role, game_creation,
         (game_creation > now() - make_interval(days => 90)) AS is_fresh,
         ally_champion_ids, enemy_champion_ids
  FROM coachbuild.pro_matches WHERE match_id = 'EUN1_3932695378'
`;
console.log(JSON.stringify(rows, null, 2));
