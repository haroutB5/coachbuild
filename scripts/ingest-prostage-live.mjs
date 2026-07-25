#!/usr/bin/env node
// Live pro-play ingest from the lolesports feed (NOT Leaguepedia). Run via tsx:
//   npx tsx scripts/ingest-prostage-live.mjs [lookbackDays] [maxGames]
//
// Complements scripts/ingest-prostage.mjs: Leaguepedia lags days-to-weeks, so
// this lands today's games today. Leaguepedia later supersedes each row with a
// richer one (items/runes) — see lib/prostage/liveIngest.ts's reconciliation note.
import { loadEnvLocal } from "./_env.mjs";

loadEnvLocal();

const { runLiveProstageIngest } = await import("../lib/prostage/liveIngest.ts");

const lookbackDays = Number(process.argv[2]) || 4;
const maxGames = Number(process.argv[3]) || 40;

const result = await runLiveProstageIngest({
  lookbackDays,
  maxGames,
  onProgress: (m) => console.log("  " + m),
});
console.log(JSON.stringify(result, null, 2));
if (result.errors.length) process.exitCode = 0; // partial failures are expected/non-fatal
