import { loadEnvLocal } from "./_env.mjs";
loadEnvLocal();
const { getSql } = await import("../lib/pro/db.ts");
const sql = getSql();
const [row] = await sql`SELECT count(*)::int AS total, count(*) FILTER (WHERE ally_champion_ids IS NULL)::int AS remaining FROM coachbuild.pro_matches`;
console.log(JSON.stringify(row));
