#!/usr/bin/env node
// Local backfill runner for pro matches. Loops chunked batches until every
// active account has been processed once (cursor wraps to null). Run via tsx:
//   npx tsx scripts/ingest-matches.mjs [batchSize] [matchesPerAccount]
//
// CURSOR CONTRACT (P2 fix, 2026-07-17): cursor is now a walk-start ISO
// timestamp (lib/pro/ingestMatches.ts's header comment has the full
// rationale), not a numeric offset. `cursor` starts `undefined` here so the
// FIRST call mints its own walkStart internally; every subsequent call in
// this loop passes the SAME walkStart back via `result.nextCursor` until the
// walk drains (nextCursor === null).
import { loadEnvLocal } from "./_env.mjs";

loadEnvLocal();

const { runMatchIngest } = await import("../lib/pro/ingestMatches.ts");

const batch = Number(process.argv[2]) || Number(process.env.INGEST_BATCH) || 5;
const matchesPerAccount = Number(process.argv[3]) || Number(process.env.MATCHES_PER_ACCOUNT) || 20;

async function main() {
  let cursor; // undefined on the first call -> runMatchIngest mints walkStart=now()
  let totalAccounts = 0;
  let totalMatches = 0;
  const allErrors = [];

  for (;;) {
    console.log(`batch: cursor=${cursor ?? "(new walk)"} batch=${batch}`);
    const result = await runMatchIngest({
      cursor,
      batch,
      matchesPerAccount,
      onProgress: (msg) => console.log(`  ${msg}`),
    });
    totalAccounts += result.accountsProcessed;
    totalMatches += result.matchesUpserted;
    allErrors.push(...result.errors);
    console.log(
      `  processed ${result.accountsProcessed} accounts, upserted ${result.matchesUpserted} matches` +
        (result.errors.length ? `, ${result.errors.length} errors` : "")
    );
    if (result.nextCursor === null) break;
    cursor = result.nextCursor;
  }

  console.log(JSON.stringify({ totalAccounts, totalMatches, errors: allErrors }, null, 2));
  if (allErrors.length > 0) process.exitCode = 1;
}

main().catch((err) => {
  if (err?.name === "RiotUnavailableError" || err?.name === "DbUnavailableError") {
    console.error(`ingest-matches: ${err.message}`);
    process.exit(1);
  }
  console.error("ingest-matches failed:", err);
  process.exit(1);
});
