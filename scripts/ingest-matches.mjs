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
//
// EXIT CODE CONTRACT (2026-07-29): this used to be
// `if (allErrors.length > 0) process.exitCode = 1`, which reported the healthy
// 12:20 run (1,445 accounts walked, 200 matches upserted, 15 accounts skipped
// on transient Riot 429s) with the same exit 1 as a run where the key was dead.
// Task Scheduler could not tell them apart and so neither could anyone reading
// it. The verdict now comes from lib/pro/sweepOutcome.ts's `classifySweep` —
// graded, pure, and tested — and its one-line reason is printed so the exit
// code is never the only evidence.
import { loadEnvLocal } from "./_env.mjs";

loadEnvLocal();

const { runMatchIngest } = await import("../lib/pro/ingestMatches.ts");
const { classifySweep } = await import("../lib/pro/sweepOutcome.ts");

const batch = Number(process.argv[2]) || Number(process.env.INGEST_BATCH) || 5;
const matchesPerAccount = Number(process.argv[3]) || Number(process.env.MATCHES_PER_ACCOUNT) || 20;

async function main() {
  let cursor; // undefined on the first call -> runMatchIngest mints walkStart=now()
  let totalAccounts = 0;
  let totalMatches = 0;
  let rateLimited = false;
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
    // A rate-limit abort must break the loop even though it also sets
    // nextCursor to null — checked explicitly so the intent survives any future
    // change to how the walk signals completion.
    if (result.rateLimited) {
      rateLimited = true;
      console.error(
        "  RATE LIMITED by Riot after its own Retry-After was honoured — stopping the walk " +
          "rather than spending the rest of the budget on it."
      );
      break;
    }
    if (result.nextCursor === null) break;
    cursor = result.nextCursor;
  }

  const verdict = classifySweep({
    accountsProcessed: totalAccounts,
    matchesUpserted: totalMatches,
    errorCount: allErrors.length,
    rateLimited,
  });

  console.log(JSON.stringify({ totalAccounts, totalMatches, rateLimited, errors: allErrors }, null, 2));
  console.log(verdict.reason);
  process.exitCode = verdict.exitCode;
}

main().catch((err) => {
  if (err?.name === "RiotUnavailableError" || err?.name === "DbUnavailableError") {
    console.error(`ingest-matches: ${err.message}`);
    process.exit(1);
  }
  console.error("ingest-matches failed:", err);
  process.exit(1);
});
