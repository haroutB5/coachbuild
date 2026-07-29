import { loadEnvLocal } from "./_env.mjs";
loadEnvLocal();
const { getSql } = await import("../lib/pro/db.ts");
const sql = getSql()!;
const t = await sql`SELECT table_name FROM information_schema.tables
  WHERE table_schema='coachbuild' AND table_name IN ('otp_featured_scanned','otp_featured_deep_cursor')
  ORDER BY table_name`;
console.log("tables:", t.map((r: any) => r.table_name));
const s = await sql`SELECT count(*)::int AS n, count(*) FILTER (WHERE stored)::int AS stored
  FROM coachbuild.otp_featured_scanned`;
console.log("otp_featured_scanned rows:", JSON.stringify(s[0]));
const c = await sql`SELECT count(*)::int AS n FROM coachbuild.otp_featured_deep_cursor`;
console.log("otp_featured_deep_cursor rows:", c[0].n);
const m = await sql`SELECT count(*)::int AS n FROM coachbuild.otp_matches`;
console.log("otp_matches rows:", m[0].n);
const cols = await sql`SELECT column_name FROM information_schema.columns
  WHERE table_schema='coachbuild' AND table_name='otp_featured_deep_cursor' ORDER BY ordinal_position`;
console.log("cursor cols:", cols.map((r: any) => r.column_name).join(", "));
