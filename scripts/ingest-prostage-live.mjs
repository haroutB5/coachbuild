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
const { getSql } = await import("../lib/pro/db.ts");
const { recordIngestRun } = await import("../lib/ingestHealth.ts");

// 2026-07-31 audit P2 follow-up (re-score item 1) — this leg was the
// UNINSTRUMENTED half of the prostage scheduled run: `recordIngestRun` had
// only been wired into scripts/ingest-prostage.mjs (the Leaguepedia
// CargoExport leg), leaving this one silent. This is the specific leg that
// exists BECAUSE OF the TheShy incident (CLAUDE.md gotcha, "But do NOT
// conclude 'they didn't play' from one source's silence") — Leaguepedia lags
// days-to-weeks, so this is what makes "today's games show up today" true at
// all, and a silent failure here reintroduces exactly the class of bug that
// incident was about. Recorded under a DISTINCT key ("prostage-live") from
// the Leaguepedia leg's "prostage" key -- the two fail independently (this
// one hits lolesports' live feed, the other hits Leaguepedia/Cloudflare) and
// conflating them into one status would hide which leg actually broke.
async function recordHealth(ok, error) {
  try {
    const sql = getSql();
    if (!sql) return; // no DATABASE_URL -- nothing to record against
    await recordIngestRun(sql, "prostage-live", { ok, error: error ?? null });
  } catch (err) {
    console.error("ingest-prostage-live: failed to record ingest health (non-fatal):", err);
  }
}

const lookbackDays = Number(process.argv[2]) || 4;
const maxGames = Number(process.argv[3]) || 40;

try {
  const result = await runLiveProstageIngest({
    lookbackDays,
    maxGames,
    onProgress: (m) => console.log("  " + m),
  });
  console.log(JSON.stringify(result, null, 2));
  // Partial failures are expected/non-fatal for THIS script's exit code (see
  // the pre-existing comment below) — but they are still worth recording as
  // an unhealthy run, since "expected/non-fatal" describes the exit-code
  // policy, not whether a human should know a fetch failed.
  if (result.errors.length) {
    await recordHealth(false, result.errors.slice(0, 5).join("; "));
  } else {
    await recordHealth(true);
  }
  if (result.errors.length) process.exitCode = 0; // partial failures are expected/non-fatal
} catch (err) {
  await recordHealth(false, err instanceof Error ? err.message : String(err));
  throw err;
}
