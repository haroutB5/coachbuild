#!/usr/bin/env node
// Local backfill runner for pro-stage (official esports) matches. Resolves
// the active-tournament list ONCE, then walks every cursor in-process — this
// intentionally bypasses the route's per-invocation Tournaments re-lookup
// (see lib/prostage/tournaments.ts's cache note) since a single script run
// already holds the list in memory. Run via tsx:
//   npx tsx scripts/ingest-prostage.mjs
//
// --via-export: routes BOTH the Tournaments resolution and the
// ScoreboardPlayers fetch through Special:CargoExport instead of api.php's
// action=cargoquery. Live-verified 2026-07-10: CargoExport is NOT subject to
// api.php's punishing rate limit (which trips most Vercel-side ingest calls),
// paced only 5s apart vs api.php's 30s floor. No-flag behavior is unchanged
// (still api.php via cargoQueryWithRetry, 30s pacing, ratelimit-cooldown-
// retry-once). See lib/prostage/cargo.ts's header comment for the full
// CargoExport contract (JSON-array response, no `where` -> Cloudflare
// challenge, `order+by` param).
//
// --via-export ALSO uses a curl-subprocess transport (scripts/_curl-
// transport.mjs), not Node's fetch, for the CargoExport calls specifically —
// live-verified 2026-07-10 that Node's own networking stack gets
// Cloudflare-403'd against this endpoint in at least one environment where
// curl succeeds reliably (see cargo.ts's P0-follow-up comment). This script
// can shell out; app/route code can't, so it stays on cargoExportQuery's
// default fetch transport (unaffected either way — the route never calls
// cargoExportQuery at all).
// --via-export ALSO retries ONCE, after a ~10s pause, on a CargoRequestError
// (the transient Cloudflare-challenge case) — live evidence from a real
// backfill run (2026-07-10): 2 of 7 cursors got "CargoExport returned a
// non-JSON response" on the first attempt, and an immediate manual retry
// succeeded both times. cargoExportQuery itself deliberately has NO retry
// (see cargo.ts's doc comment — that contract is unchanged); this retry
// lives here, script-side only, same pattern as api.php's cooldown-retry-
// once but much shorter (CargoExport's failures are a brief challenge blip,
// not a sustained rate-limit).
import { loadEnvLocal } from "./_env.mjs";
import { curlTransport } from "./_curl-transport.mjs";

loadEnvLocal();

const { runProstageIngest } = await import("../lib/prostage/ingest.ts");
const { resolveActiveTournaments, buildTournamentsQuerySpec, MAX_TOURNAMENTS } = await import(
  "../lib/prostage/tournaments.ts"
);
const { cargoExportQuery, cargoField, CargoRequestError } = await import("../lib/prostage/cargo.ts");

const viaExport = process.argv.includes("--via-export");
const EXPORT_RETRY_DELAY_MS = 10_000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** cargoExportQuery, but always through the curl transport, with a single
 *  ~10s-delayed retry on CargoRequestError (a transient Cloudflare
 *  challenge — live-verified 2026-07-10 to usually clear on one retry). A
 *  SECOND CargoRequestError propagates to the caller same as before — this
 *  is a retry-once, not a loop. A single place both the Tournaments
 *  resolution and the ScoreboardPlayers queryFn route through, so a future
 *  transport/retry-policy change only touches this one function. */
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

/** Same WHERE semantics as resolveActiveTournaments (buildTournamentsQuerySpec
 *  is the shared single source of truth), run through cargoExportQuery
 *  instead of the api.php path — no ratelimit-retry needed since CargoExport
 *  isn't subject to api.php's limiter. */
async function resolveTournamentsViaExport() {
  const spec = buildTournamentsQuerySpec();
  const rows = await cargoExportViaCurl(spec);
  const seen = new Set();
  const pages = [];
  for (const row of rows) {
    const page = cargoField(row, "OverviewPage");
    if (page && !seen.has(page)) {
      seen.add(page);
      pages.push(page);
    }
  }
  return pages.slice(0, MAX_TOURNAMENTS);
}

async function main() {
  const tournaments = viaExport
    ? await resolveTournamentsViaExport()
    : await resolveActiveTournaments({
        log: (msg) => console.log(`  [tournaments] ${msg}`),
      });
  console.log(
    `resolved ${tournaments.length} tournament(s) via ${viaExport ? "CargoExport" : "api.php"}: ` +
      `${tournaments.join(", ") || "(none)"}`
  );
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
    // No `paginate` key passed deliberately — `runProstageIngest` now
    // defaults it to true (2026-07-25, P1-1 fix). This IS the recurring
    // production path (the 3-hourly scheduled task runs this script
    // --via-export), and it used to be the exact caller that silently
    // truncated any >500-row tournament to its 500 newest rows because
    // pagination was opt-in and nothing here opted in. See
    // lib/prostage/ingest.ts's `paginate` doc comment for the full story.
    const result = await runProstageIngest({
      cursor,
      tournaments,
      onProgress: (msg) => console.log(`  ${msg}`),
      ...(viaExport ? { queryFn: cargoExportViaCurl } : {}),
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
