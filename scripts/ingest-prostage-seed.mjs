#!/usr/bin/env node
// One-off backfill runner (2026-07-13, pro-consensus sample-size growth):
// ingests an EXPLICIT tournament list rather than resolveActiveTournaments'
// discovered set. Two reasons an explicit list is needed here, not the
// normal script:
//
//   1. resolveActiveTournaments filters on the TOURNAMENT's own Tournaments.
//      DateStart >= (today - 90d) — but the games we actually want live in
//      REGULAR-SEASON pages whose DateStart is earlier than that cutoff even
//      though a large tail of their individual games (per-game
//      DateTime_UTC) falls inside the 90-day freshness window /api/pros
//      queries against. Live-verified 2026-07-13: LEC/2026 Season/Spring
//      Season started 2026-03-28 (before the cutoff, so resolveActiveTournaments
//      never surfaces it) but ran games well past 2026-04-14. Same story for
//      LPL/2026 Season/Split 2, LCS/2026 Season/Spring Season, and
//      LCK/2026 Season/Rounds 1-2 — none of these are visible to the normal
//      discovery query, so they've never been ingested at all.
//   2. Re-running already-ingested PLAYOFF tournaments here too, with
//      --paginate, closes the >500-row truncation bug (see
//      lib/prostage/ingest.ts's `paginate` doc comment): LPL/2026 Season/
//      Split 2 Playoffs has 680 real rows, only 500 of which the original
//      (unpaginated) ingest captured. Upserts are idempotent
//      (ON CONFLICT (game_id, player_link) DO NOTHING), so re-running a
//      tournament that's already fully ingested is always safe and cheap.
//
// Uses the same --via-export + curl-transport + retry-once machinery as
// scripts/ingest-prostage.mjs (CargoExport's 5s pacer, not api.php's
// punishing 30s-floor/sticky-ratelimit one) plus lib/prostage/ingest.ts's
// new `paginate: true` option on every tournament (cheap no-op for
// tournaments that are already under 500 rows — one extra call that comes
// back short and stops).
//
// Run via: npx tsx scripts/ingest-prostage-seed.mjs
import { loadEnvLocal } from "./_env.mjs";
import { curlTransport } from "./_curl-transport.mjs";

loadEnvLocal();

const { runProstageIngest } = await import("../lib/prostage/ingest.ts");
const { cargoExportQuery, CargoRequestError } = await import("../lib/prostage/cargo.ts");

const EXPORT_RETRY_DELAY_MS = 10_000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Same retry-once-on-transient-Cloudflare-challenge wrapper as
 *  scripts/ingest-prostage.mjs's cargoExportViaCurl — duplicated rather than
 *  imported since it's a tiny closure and this script is meant to be a
 *  short-lived, deletable one-off (not a permanent addition to the shared
 *  ingest surface). */
async function cargoExportViaCurl(opts) {
  try {
    return await cargoExportQuery(opts, curlTransport);
  } catch (err) {
    if (!(err instanceof CargoRequestError)) throw err;
    console.log(`  [cargo-export] transient failure (${err.message}); retrying once in 10s`);
    await sleep(EXPORT_RETRY_DELAY_MS);
    return cargoExportQuery(opts, curlTransport);
  }
}

// Explicit OverviewPage list — see header comment for why these specific
// pages need an explicit seed instead of relying on discovery. Regular-season
// pages first (the actual lever — most of their games are new to the DB),
// already-ingested playoff/MSI pages last (paginate-only top-up, mostly a
// no-op beyond catching any >500-row truncation).
const SEED_TOURNAMENTS = [
  "LEC/2026 Season/Spring Season",
  "LCS/2026 Season/Spring Season",
  "LPL/2026 Season/Split 2",
  "LCK/2026 Season/Rounds 1-2",
  "LEC/2026 Season/Spring Playoffs",
  "LCS/2026 Season/Spring Playoffs",
  "LPL/2026 Season/Split 2 Playoffs",
  "LCK/2026 Season/Road to MSI",
  "2026 Mid-Season Invitational",
];

async function main() {
  console.log(`seeding ${SEED_TOURNAMENTS.length} tournament(s), paginated:\n  ${SEED_TOURNAMENTS.join("\n  ")}`);

  let cursor = 0;
  let totalSeen = 0;
  let totalUpserted = 0;
  const allErrors = [];
  const perTournament = [];

  for (;;) {
    const label = SEED_TOURNAMENTS[cursor];
    console.log(`\nbatch: cursor=${cursor} tournament=${label}`);
    const result = await runProstageIngest({
      cursor,
      tournaments: SEED_TOURNAMENTS,
      onProgress: (msg) => console.log(`  ${msg}`),
      queryFn: cargoExportViaCurl,
      paginate: true,
    });
    totalSeen += result.rowsSeen;
    totalUpserted += result.rowsUpserted;
    allErrors.push(...result.errors);
    perTournament.push({ tournament: result.tournament, rowsSeen: result.rowsSeen, rowsUpserted: result.rowsUpserted, errors: result.errors.length });
    console.log(
      `  ${result.tournament}: saw ${result.rowsSeen} rows, upserted ${result.rowsUpserted}` +
        (result.errors.length ? `, ${result.errors.length} errors` : "")
    );
    if (result.nextCursor === null) break;
    cursor = result.nextCursor;
  }

  console.log("\n=== summary ===");
  console.table(perTournament);
  console.log(JSON.stringify({ totalSeen, totalUpserted, errors: allErrors.length }, null, 2));
  if (allErrors.length > 0) {
    console.log("errors:", allErrors);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  if (err?.name === "DbUnavailableError") {
    console.error(`ingest-prostage-seed: ${err.message}`);
    process.exit(1);
  }
  console.error("ingest-prostage-seed failed:", err);
  process.exit(1);
});
