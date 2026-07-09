#!/usr/bin/env node
// Targeted match ingest for ONE pro (jump the backfill queue). Run via tsx:
//   npx tsx scripts/ingest-player.mjs <slug-or-name> [matchesPerAccount]
// Reuses ingestOneAccount so behavior/pacing is identical to the sweep.
import { loadEnvLocal } from "./_env.mjs";

loadEnvLocal();

const { ingestOneAccount } = await import("../lib/pro/ingestMatches.ts");
const { getSql } = await import("../lib/pro/db.ts");

const who = process.argv[2];
const matchesPerAccount = Number(process.argv[3]) || 20;

if (!who) {
  console.error("usage: npx tsx scripts/ingest-player.mjs <slug-or-name> [matchesPerAccount]");
  process.exit(1);
}

async function main() {
  const sql = getSql();
  if (!sql) throw new Error("DATABASE_URL missing");
  const accounts = await sql`
    SELECT pa.puuid, pa.pro_id, pa.region, pa.riot_id
    FROM coachbuild.pro_accounts pa
    JOIN coachbuild.pros p ON p.id = pa.pro_id
    WHERE pa.active = true AND (p.slug = ${who.toLowerCase()} OR p.name ILIKE ${who})
  `;
  if (accounts.length === 0) {
    console.error(`no active accounts found for "${who}"`);
    process.exit(1);
  }
  let total = 0;
  for (const account of accounts) {
    const n = await ingestOneAccount(sql, account, matchesPerAccount, (m) => console.log(`  ${m}`));
    console.log(`${account.riot_id} (${account.region}): +${n} matches`);
    total += n;
  }
  console.log(JSON.stringify({ player: who, accounts: accounts.length, matchesUpserted: total }));
}

main().catch((err) => {
  console.error("ingest-player failed:", err.message);
  process.exit(1);
});
