#!/usr/bin/env node
// Backfills cs / game_duration_sec (migration 0021) for coachbuild.my_matches
// rows ingested BEFORE that migration -- those rows have both columns NULL.
//
// Same shape and the same reasons as scripts/backfill-mystats-kda.mjs, which
// exists because this exact situation already happened once with KDA. Read that
// file's header for the full rationale; the differences from it are:
//
//  1. IT WALKS EVERY LINKED ACCOUNT, not just the active one. The KDA backfill
//     predates multi-account and is active-only, which means a second linked
//     account's rows would silently never be filled. Each account is re-fetched
//     with ITS OWN puuid and ITS OWN regional routing (resolved per account via
//     lib/pro/regionMap.ts) -- handing account A's match id to account B's
//     extractor finds no participant and burns a paced Riot call to accomplish
//     nothing, which is the failure the KDA script's own header warns about.
//     Nothing here reads or writes `active`, so running this never switches
//     which account My Stats is showing.
//
//  2. NO coachless/recommend lookup. cs and game_duration_sec come straight off
//     the match-v5 payload, so there is no patch gate and no build cache --
//     every attempted row resolves to a real number or to a logged failure,
//     never to an honest-but-null third state.
//
// RESUMABLE BY CONSTRUCTION: the SELECT is `WHERE cs IS NULL`, so a row this
// run (or a prior interrupted one) already updated is never re-selected. Safe to
// Ctrl-C and re-run.
//
// STRICTLY SEQUENTIAL through lib/pro/pacer.ts, like every other Riot-calling
// script here. The pacer only serialises WITHIN a process (CLAUDE.md gotcha
// (d)), so do NOT run this alongside an ingest cron, a scheduled task, or
// another Riot script -- the operator serialises.
//
// Run via:
//   npx tsx scripts/backfill-mystats-cs.mjs [limit]
import { loadEnvLocal } from "./_env.mjs";

loadEnvLocal();

const { getSql } = await import("../lib/pro/db.ts");
const { getMatch, RiotRequestError } = await import("../lib/pro/riot.ts");
const { extractMyMatch } = await import("../lib/mystats/extract.ts");
const { routingForServer } = await import("../lib/pro/regionMap.ts");

const limitArg = Number(process.argv[2]) || undefined;

async function main() {
  const sql = getSql();
  if (!sql) throw new Error("DATABASE_URL missing");
  if (!process.env.RIOT_API_KEY) throw new Error("RIOT_API_KEY missing");

  const accounts = await sql`
    SELECT id, riot_id, puuid, region FROM coachbuild.my_account ORDER BY id
  `;
  console.log(`${accounts.length} linked account(s).`);

  let updated = 0;
  let attempted = 0;
  const failures = [];

  for (const acct of accounts) {
    const routing = routingForServer(acct.region);
    if (!routing) {
      // Never guess a cluster -- a wrong regional host 404s every match id and
      // would report the whole account as failed for a reason that is ours.
      console.log(`${acct.riot_id}: region "${acct.region}" does not map to a Riot cluster, skipping`);
      failures.push({ account: acct.riot_id, reason: `unmapped region ${acct.region}` });
      continue;
    }

    const pending = await sql`
      SELECT match_id FROM coachbuild.my_matches
      WHERE puuid = ${acct.puuid} AND cs IS NULL
      ORDER BY game_creation DESC
    `;
    const rows = limitArg ? pending.slice(0, limitArg) : pending;
    console.log(
      `${acct.riot_id} (${acct.region}): ${pending.length} row(s) missing cs` +
        (limitArg ? `; processing ${rows.length} (limit=${limitArg})` : "") +
        "."
    );

    for (const { match_id: matchId } of rows) {
      attempted += 1;
      try {
        const raw = await getMatch(routing.regional, matchId);
        const row = extractMyMatch(raw, acct.puuid);
        if (!row) {
          console.log(`  ${matchId}: puuid not found in participants, skipping`);
          failures.push({ matchId, reason: "puuid not in participants" });
          continue;
        }
        await sql`
          UPDATE coachbuild.my_matches
          SET cs = ${row.cs}, game_duration_sec = ${row.gameDurationSec}
          WHERE puuid = ${acct.puuid} AND match_id = ${matchId}
        `;
        updated += 1;
        const mins = row.gameDurationSec / 60;
        const rate = mins > 0 ? (row.cs / mins).toFixed(1) : "n/a";
        console.log(`  ${matchId}: cs=${row.cs} dur=${row.gameDurationSec}s (${rate}/min)`);
      } catch (err) {
        if (err instanceof RiotRequestError) {
          console.log(`  ${matchId}: riot ${err.status} ${err.message}, skipping`);
          failures.push({ matchId, reason: `riot ${err.status}` });
          continue;
        }
        throw err;
      }
    }
  }

  console.log("");
  console.log(`Updated ${updated} of ${attempted} attempted row(s).`);
  if (failures.length > 0) {
    console.log(`${failures.length} failure(s):`);
    for (const f of failures) console.log(`  ${f.matchId ?? f.account}: ${f.reason}`);
  }
  console.log(JSON.stringify({ attempted, updated, failures }, null, 2));
  if (failures.length > 0) process.exitCode = 1;
}

main().catch((err) => {
  if (err?.name === "RiotUnavailableError" || err?.name === "DbUnavailableError") {
    console.error(`backfill-mystats-cs: ${err.message}`);
    process.exit(1);
  }
  console.error("backfill-mystats-cs failed:", err);
  process.exit(1);
});
