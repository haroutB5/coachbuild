#!/usr/bin/env node
// Local backfill runner for the pro roster. Run via tsx (it imports the
// TypeScript core in lib/pro/ directly — shared with app/api/ingest/roster):
//   npx tsx scripts/ingest-roster.mjs [rosterSize]
import { loadEnvLocal } from "./_env.mjs";

loadEnvLocal();

const { runRosterIngest } = await import("../lib/pro/ingestRoster.ts");

const rosterSize = Number(process.argv[2]) || Number(process.env.ROSTER_SIZE) || 100;

async function main() {
  console.log(`ingesting roster (target ${rosterSize} pros)...`);
  const result = await runRosterIngest({
    rosterSize,
    onProgress: (msg) => console.log(`  ${msg}`),
  });

  console.log(JSON.stringify(result, null, 2));
  if (result.errors.length > 0) process.exitCode = 1;
}

main().catch((err) => {
  if (err?.name === "DbUnavailableError") {
    console.error(`ingest-roster: ${err.message}`);
    process.exit(1);
  }
  console.error("ingest-roster failed:", err);
  process.exit(1);
});
