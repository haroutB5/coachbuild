#!/usr/bin/env node
// Backfills the migration-0006 columns (ally_champion_ids, enemy_champion_ids)
// on historical coachbuild.pro_matches rows ingested before those columns
// existed. Re-fetches match-v5 detail by match_id (1 call/match — no timeline
// needed, extractTeamComps only reads match.info.participants) and UPDATEs
// both columns together in place. Resumable via a `WHERE ally_champion_ids IS
// NULL` cursor (re-running after a partial run / crash just picks up where it
// left off — already-backfilled rows are ally_champion_ids IS NOT NULL and
// drop out of the WHERE clause on their own).
//
// --reorder / --force (2026-07-11): lib/pro/extract.ts's extractTeamComps now
// ROLE-ORDERS each side (see its doc comment + orderChampionIdsByRole) instead
// of leaving source order. The 1134 rows backfilled by the plain (no-flag)
// mode above were stored WITHOUT role ordering. --reorder re-walks EVERY row
// (drops the `ally_champion_ids IS NULL` filter) and overwrites both columns
// unconditionally via the updated extractTeamComps. --force is accepted as a
// synonym (same behavior) since either reads naturally depending on framing
// ("reorder existing data" vs "force a re-write").
//
// --reorder resume cursor: there's no spare column on pro_matches to mark
// "already re-done" (adding one is unwarranted for a single one-time re-walk),
// so progress is tracked in a small local JSON file instead
// (scripts/.backfill-team-comps-reorder-cursor.json — gitignored-by-convention
// scratch state, NOT app data). It stores the last successfully-UPDATEd
// match_id; a --reorder run reads it on startup and resumes with
// `WHERE pm.match_id > $cursor` (same `ORDER BY pm.match_id ASC` the plain
// mode already uses, so the ordering is deterministic across runs). The
// cursor file is deleted once a --reorder run completes with zero remaining
// rows, so a later re-run starts a fresh full pass rather than silently
// no-op'ing forever.
//
// Pacing: lib/pro/riot.ts's getMatch() already routes every call through the
// shared lib/pro/pacer.ts queue (1.3s min interval, process-wide) — this
// script doesn't need its own throttle, sequential awaits are enough.
//
// Single process by design (per the ingest scripts' existing convention) —
// do NOT parallelize match fetches, that would blow past the pacer's
// per-key rate limit modeling (it assumes one caller stream). Also do NOT run
// alongside any other Riot API consumer.
//
// Usage:
//   npx tsx scripts/backfill-team-comps.mjs [limit]              # plain: only NULL rows
//   npx tsx scripts/backfill-team-comps.mjs [limit] --reorder     # re-walk ALL rows, resumable
//   npx tsx scripts/backfill-team-comps.mjs [limit] --force       # same as --reorder
// `limit` (default 3) caps how many rows this run touches — pass a larger
// limit explicitly (or re-run repeatedly) once ready to spend that budget.
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvLocal } from "./_env.mjs";

loadEnvLocal();

const { getSql } = await import("../lib/pro/db.ts");
const { routingForServer } = await import("../lib/pro/regionMap.ts");
const { getMatch, RiotRequestError } = await import("../lib/pro/riot.ts");
const { extractTeamComps } = await import("../lib/pro/extract.ts");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CURSOR_FILE = path.join(__dirname, ".backfill-team-comps-reorder-cursor.json");

const args = process.argv.slice(2);
const reorder = args.includes("--reorder") || args.includes("--force");
const limitArg = args.find((a) => /^\d+$/.test(a));
const limit = Number(limitArg) || 3;

function readCursor() {
  if (!existsSync(CURSOR_FILE)) return null;
  try {
    const { lastMatchId } = JSON.parse(readFileSync(CURSOR_FILE, "utf8"));
    return typeof lastMatchId === "string" ? lastMatchId : null;
  } catch {
    return null; // corrupt/partial cursor file -> treat as no cursor, safe to restart
  }
}

function writeCursor(lastMatchId) {
  writeFileSync(CURSOR_FILE, JSON.stringify({ lastMatchId, updatedAt: new Date().toISOString() }, null, 2));
}

function clearCursor() {
  if (existsSync(CURSOR_FILE)) unlinkSync(CURSOR_FILE);
}

async function main() {
  const sql = getSql();
  if (!sql) throw new Error("DATABASE_URL missing");
  if (!process.env.RIOT_API_KEY) throw new Error("RIOT_API_KEY missing");

  const cursor = reorder ? readCursor() : null;
  if (reorder && cursor) {
    console.log(`backfill-team-comps --reorder: resuming after match_id > ${cursor}`);
  }

  const rows = reorder
    ? cursor
      ? await sql`
          SELECT pm.match_id, pm.puuid, pa.region
          FROM coachbuild.pro_matches pm
          JOIN coachbuild.pro_accounts pa ON pa.puuid = pm.puuid
          WHERE pm.match_id > ${cursor}
          ORDER BY pm.match_id ASC
          LIMIT ${limit}
        `
      : await sql`
          SELECT pm.match_id, pm.puuid, pa.region
          FROM coachbuild.pro_matches pm
          JOIN coachbuild.pro_accounts pa ON pa.puuid = pm.puuid
          ORDER BY pm.match_id ASC
          LIMIT ${limit}
        `
    : await sql`
        SELECT pm.match_id, pm.puuid, pa.region
        FROM coachbuild.pro_matches pm
        JOIN coachbuild.pro_accounts pa ON pa.puuid = pm.puuid
        WHERE pm.ally_champion_ids IS NULL
        ORDER BY pm.match_id ASC
        LIMIT ${limit}
      `;

  console.log(
    `backfill-team-comps${reorder ? " --reorder" : ""}: ${rows.length} row(s) to process (limit=${limit})`
  );

  let updated = 0;
  let skipped = 0;
  const errors = [];
  let lastMatchId = cursor;
  // Once a transient (non-Riot, e.g. network/DB) error hits row N, the
  // persisted cursor must NOT advance past N even if a later row M>N
  // succeeds in this same run — otherwise a future --reorder resume starts
  // at M+1 and N is silently never retried. `cursorFrozen` latches the first
  // such error; rows after it still get best-effort processed (and are safe
  // to reprocess again on the next run — the UPDATE is idempotent), but stop
  // writing the cursor file.
  let cursorFrozen = false;

  for (const row of rows) {
    const routing = routingForServer(row.region);
    if (!routing) {
      console.log(`  ${row.match_id}: unmapped region ${row.region}, skipping`);
      skipped += 1;
      if (reorder && !cursorFrozen) writeCursor((lastMatchId = row.match_id));
      continue;
    }
    try {
      const match = await getMatch(routing.regional, row.match_id);
      const comps = extractTeamComps(match, row.puuid);
      if (!comps) {
        console.log(`  ${row.match_id}: puuid ${row.puuid} not in refetched match or not a clean 5v5, skipping`);
        skipped += 1;
        if (reorder && !cursorFrozen) writeCursor((lastMatchId = row.match_id));
        continue;
      }
      await sql`
        UPDATE coachbuild.pro_matches
        SET ally_champion_ids = ${JSON.stringify(comps.allyChampionIds)}::jsonb,
            enemy_champion_ids = ${JSON.stringify(comps.enemyChampionIds)}::jsonb
        WHERE match_id = ${row.match_id} AND puuid = ${row.puuid}
      `;
      updated += 1;
      if (reorder && !cursorFrozen) writeCursor((lastMatchId = row.match_id));
      console.log(
        `  ${row.match_id}: ally=[${comps.allyChampionIds.join(",")}] enemy=[${comps.enemyChampionIds.join(",")}]`
      );
    } catch (err) {
      if (err instanceof RiotRequestError) {
        console.log(`  ${row.match_id}: riot ${err.status}, skipping`);
        skipped += 1;
        if (reorder && !cursorFrozen) writeCursor((lastMatchId = row.match_id));
        continue;
      }
      errors.push(`${row.match_id}: ${err.message}`);
      console.log(`  ${row.match_id}: error - ${err.message}`);
      // Transient error: freeze the persisted cursor here so a future
      // --reorder run re-attempts from this match_id forward, instead of a
      // later successful row silently pushing the cursor past it.
      cursorFrozen = true;
    }
  }

  if (reorder && rows.length < limit && !cursorFrozen) {
    // Fewer rows than requested came back -> we reached the end of the
    // table, with no unresolved transient error left dangling. Clear the
    // cursor so a future --reorder run starts a fresh full pass instead of
    // finding nothing forever.
    clearCursor();
    console.log("backfill-team-comps --reorder: reached end of table, cursor cleared");
  }

  const summary = { processed: rows.length, updated, skipped, errors, reorder, resumeCursor: lastMatchId };
  console.log(JSON.stringify(summary, null, 2));
  if (errors.length > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error("backfill-team-comps failed:", err.message);
  process.exit(1);
});
