#!/usr/bin/env node
// One-off seed of non-EUW pros (KR/LPL/NA) into coachbuild.pros /
// coachbuild.pro_accounts. lolpros.gg's public ladder is EUW-only, so
// famous KR/LPL/NA pros (Faker etc.) never surface through the regular
// roster ingest (scripts/ingest-roster.mjs). See lib/pro/seedCrossregion.ts
// for the two-tier strategy (lolpros profile-by-slug, then Leaguepedia
// SoloqueueIds for whatever tier 1 misses).
//
//   npx tsx scripts/seed-crossregion.mjs [--skip-leaguepedia]
//
// Idempotent (all DB writes are upserts) -- safe to rerun; a rerun with
// --skip-leaguepedia is a fast way to pick up new lolpros profiles without
// touching the rate-limited Leaguepedia tier.
import { loadEnvLocal } from "./_env.mjs";

loadEnvLocal();

const { runSeedCrossregion } = await import("../lib/pro/seedCrossregion.ts");
const { getSql } = await import("../lib/pro/db.ts");

const skipLeaguepedia = process.argv.includes("--skip-leaguepedia");

async function main() {
  console.log(`seeding cross-region pros (skipLeaguepedia=${skipLeaguepedia})...`);
  const result = await runSeedCrossregion({
    skipLeaguepedia,
    onProgress: (msg) => console.log(`  ${msg}`),
  });

  console.log(JSON.stringify(result, null, 2));

  const sql = getSql();
  if (sql) {
    const rows = await sql`
      SELECT COUNT(DISTINCT p.id)::int AS count
      FROM coachbuild.pros p
      JOIN coachbuild.pro_accounts pa ON pa.pro_id = p.id
      WHERE pa.region <> 'EUW'
    `;
    console.log(`verification: pros with a non-EUW account = ${rows[0]?.count ?? 0}`);
  } else {
    console.log("verification skipped: DATABASE_URL not configured");
  }

  if (result.errors.length > 0) process.exitCode = 1;
}

main().catch((err) => {
  if (err?.name === "DbUnavailableError") {
    console.error(`seed-crossregion: ${err.message}`);
    process.exit(1);
  }
  console.error("seed-crossregion failed:", err);
  process.exit(1);
});
