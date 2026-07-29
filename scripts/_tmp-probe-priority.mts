import { loadEnvLocal } from "./_env.mjs";
loadEnvLocal();
const { getSql } = await import("../lib/pro/db.ts");
const sql = getSql()!;

const mine = await sql`
  SELECT champion_id, count(*)::int AS games
  FROM coachbuild.my_matches
  GROUP BY champion_id ORDER BY games DESC`;
console.log("my_matches distinct champions:", mine.length, "total games:", mine.reduce((a: number, r: any) => a + r.games, 0));
console.log("top 12:", mine.slice(0, 12).map((r: any) => `${r.champion_id}:${r.games}`).join(" "));

const feat = await sql`SELECT count(*)::int AS n FROM coachbuild.otp_featured`;
console.log("otp_featured rows:", feat[0].n);

const cover = await sql`
  SELECT count(*)::int AS n FROM coachbuild.otp_featured f
  WHERE f.champion_id IN (SELECT DISTINCT champion_id FROM coachbuild.my_matches)`;
console.log("my champions WITH a featured one-trick:", cover[0].n);

const depth = await sql`
  SELECT f.champion_id, count(m.match_id)::int AS stored
  FROM coachbuild.otp_featured f
  LEFT JOIN coachbuild.otp_matches m ON m.puuid = f.puuid AND m.champion_id = f.champion_id
  WHERE f.champion_id IN (SELECT DISTINCT champion_id FROM coachbuild.my_matches)
  GROUP BY f.champion_id ORDER BY stored ASC`;
console.log("depth for my champions (stored featured games), asc:");
console.log(depth.map((r: any) => `${r.champion_id}:${r.stored}`).join(" "));
const tot = await sql`SELECT count(*)::int AS n FROM coachbuild.otp_matches`;
console.log("otp_matches total rows:", tot[0].n);
const mm = await sql`SELECT max(game_creation) AS newest, count(*)::int AS n FROM coachbuild.my_matches`;
console.log("my_matches newest:", mm[0].newest, "n:", mm[0].n);
