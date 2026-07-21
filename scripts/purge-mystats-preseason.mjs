#!/usr/bin/env node
// One-off (but IDEMPOTENT — see lib/mystats/purge.ts's header) purge:
// removes coachbuild.my_matches rows predating the 2026 season boundary
// (lib/mystats/season.ts's SEASON_START_MS) — needed because the initial
// backfill (run BEFORE this season-scoping refinement) pulled whatever the
// most recent ~400 matches were, some of which predate the season.
// game_creation is the AUTHORITATIVE keep/purge signal (a real Riot
// timestamp); patch is only ever used as a secondary cross-check (see
// lib/mystats/season.ts's checkSeasonAnomaly) — this script reports, but
// never acts on, a game_creation/patch disagreement. Run via:
//   npx tsx scripts/purge-mystats-preseason.mjs
import { loadEnvLocal } from "./_env.mjs";

loadEnvLocal();

const { getSql } = await import("../lib/pro/db.ts");
const { runSeasonPurge } = await import("../lib/mystats/purge.ts");

async function main() {
  const sql = getSql();
  if (!sql) throw new Error("DATABASE_URL missing");

  const result = await runSeasonPurge(sql);

  if (result.anomalies.length > 0) {
    console.log(`WARNING: ${result.anomalies.length} row(s) where game_creation and patch disagree on the season boundary:`);
    for (const a of result.anomalies) console.log(`  ${a.matchId} patch=${a.patch} game_creation=${a.gameCreation}: ${a.reason}`);
  } else {
    console.log("No game_creation/patch disagreements found across all rows -- both signals agree everywhere.");
  }

  console.log("");
  console.log(`Season start (SEASON_START_MS): ${result.seasonStartIso}`);
  console.log(`Rows before purge: ${result.rowsBefore}`);
  console.log(`Rows deleted (game_creation < season start): ${result.rowsDeleted}`);
  console.log(`Rows kept: ${result.rowsKept}`);
  console.log(
    result.offPatchRemaining === 0
      ? "Confirmed: every remaining row has patch LIKE '16.%'"
      : `WARNING: ${result.offPatchRemaining} remaining row(s) do NOT have patch LIKE '16.%' -- see anomalies above`
  );
  console.log("Backfill cursor reset (next_start=0, backfill_done=false) for a season-filtered top-up run.");

  console.log("");
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error("purge-mystats-preseason failed:", err);
  process.exit(1);
});
