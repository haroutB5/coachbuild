#!/usr/bin/env node
// Local backfill runner for pro-stage (official esports) matches. Resolves
// the active-tournament list ONCE, then walks every cursor in-process — this
// intentionally bypasses the route's per-invocation Tournaments re-lookup
// (see lib/prostage/tournaments.ts's cache note) since a single script run
// already holds the list in memory. Run via tsx:
//   npx tsx scripts/ingest-prostage.mjs
import { loadEnvLocal } from "./_env.mjs";

loadEnvLocal();

const { runProstageIngest } = await import("../lib/prostage/ingest.ts");
const { resolveActiveTournaments } = await import("../lib/prostage/tournaments.ts");

async function main() {
  const tournaments = await resolveActiveTournaments({
    log: (msg) => console.log(`  [tournaments] ${msg}`),
  });
  console.log(`resolved ${tournaments.length} tournament(s): ${tournaments.join(", ") || "(none)"}`);
  if (tournaments.length === 0) {
    console.log("nothing to ingest — set PROSTAGE_TOURNAMENT_SEED to override tournament resolution");
    return;
  }

  let cursor = 0;
  let totalSeen = 0;
  let totalUpserted = 0;
  const allErrors = [];

  for (;;) {
    console.log(`batch: cursor=${cursor} tournament=${tournaments[cursor]}`);
    const result = await runProstageIngest({
      cursor,
      tournaments,
      onProgress: (msg) => console.log(`  ${msg}`),
    });
    totalSeen += result.rowsSeen;
    totalUpserted += result.rowsUpserted;
    allErrors.push(...result.errors);
    console.log(
      `  ${result.tournament}: saw ${result.rowsSeen} rows, upserted ${result.rowsUpserted}` +
        (result.errors.length ? `, ${result.errors.length} errors` : "")
    );
    if (result.nextCursor === null) break;
    cursor = result.nextCursor;
  }

  console.log(JSON.stringify({ tournaments, totalSeen, totalUpserted, errors: allErrors }, null, 2));
  if (allErrors.length > 0) process.exitCode = 1;
}

main().catch((err) => {
  if (err?.name === "DbUnavailableError") {
    console.error(`ingest-prostage: ${err.message}`);
    process.exit(1);
  }
  console.error("ingest-prostage failed:", err);
  process.exit(1);
});
