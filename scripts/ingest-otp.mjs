#!/usr/bin/env node
// Local runner for the OTP (one-trick) pipeline. Run via tsx:
//   npx tsx scripts/ingest-otp.mjs                 # walk champions stalest-first
//   npx tsx scripts/ingest-otp.mjs --champion 112  # one champion, discovery + matches
//   npx tsx scripts/ingest-otp.mjs --champions 6   # how many champions this pass
//   npx tsx scripts/ingest-otp.mjs --discover-only
//
// THIS IS THE PRIMARY DISCOVERY PATH, not a convenience wrapper. The
// serverless route (app/api/ingest/otp/route.ts) deliberately runs the MATCH
// half only, because op.gg's reachability from Vercel egress is unverified and
// this repo has already lost weeks of prostage ingest to exactly that
// assumption (CLAUDE.md gotcha (o)). Same split, same reason.
//
// PACING: every Riot call in this process is serialised at 1.3s through
// lib/pro/pacer.ts, shared with every other Riot-calling script. Do not run
// this alongside ingest-matches.mjs or ingest-mystats.mjs — they contend for
// one key budget (gotcha (d)) and the pacer only serialises WITHIN a process.
import { loadEnvLocal } from "./_env.mjs";

loadEnvLocal();

const { discoverOtpAccounts, runOtpMatchIngest, MATCHES_PER_ACCOUNT } = await import(
  "../lib/otp/ingest.ts"
);
const { getAllChampions } = await import("../lib/staticData.ts");
const { getSql } = await import("../lib/pro/db.ts");

function argValue(flag, fallback) {
  const i = process.argv.indexOf(flag);
  if (i < 0 || i + 1 >= process.argv.length) return fallback;
  return process.argv[i + 1];
}

const discoverOnly = process.argv.includes("--discover-only");
const onlyChampion = argValue("--champion", null);
const championBudget = parseInt(argValue("--champions", "6"), 10);
const log = (msg) => console.log(`[otp] ${msg}`);

const sql = getSql();
if (!sql) {
  console.error("[otp] DATABASE_URL not configured");
  process.exit(1);
}
if (!process.env.RIOT_API_KEY) {
  console.error("[otp] RIOT_API_KEY not configured");
  process.exit(1);
}

const champions = await getAllChampions();
if (!champions.length) {
  console.error("[otp] champion list unavailable (ddragon fetch failed)");
  process.exit(1);
}
const byId = new Map(champions.map((c) => [c.id, c]));

/** Champions to work this pass, stalest-discovery-first. A champion with NO
 *  cursor row has never been discovered and sorts to the very front, so a
 *  cold database fills in champion order over successive runs rather than
 *  re-working whatever happens to be alphabetically first. */
async function pickChampions() {
  if (onlyChampion) {
    const id = parseInt(onlyChampion, 10);
    const champ = byId.get(id);
    if (!champ) {
      console.error(`[otp] unknown champion id ${id}`);
      process.exit(1);
    }
    return [champ];
  }
  const ids = champions.map((c) => c.id);
  const rows = await sql`
    SELECT ch.id AS champion_id
    FROM unnest(${ids}::int[]) AS ch(id)
    LEFT JOIN coachbuild.otp_champion_cursor cur ON cur.champion_id = ch.id
    ORDER BY COALESCE(cur.last_attempted_at, 'epoch'::timestamptz) ASC
    LIMIT ${championBudget}
  `;
  return rows.map((r) => byId.get(r.champion_id)).filter(Boolean);
}

const targets = await pickChampions();
log(`working ${targets.length} champion(s): ${targets.map((c) => c.name).join(", ")}`);

let totalAccounts = 0;
let totalMatches = 0;

for (const champ of targets) {
  log(`--- ${champ.name} (${champ.id}) ---`);
  try {
    const discovery = await discoverOtpAccounts(champ.id, champ.key, { log });
    totalAccounts += discovery.accountsUpserted;
    log(
      `${champ.name}: ${discovery.candidatesSeen} candidate(s) seen, ${discovery.accountsUpserted} account(s) upserted`
    );
    for (const err of discovery.errors) log(`  ! ${err}`);
  } catch (err) {
    log(`${champ.name}: discovery failed: ${err.message}`);
    continue;
  }

  if (discoverOnly) continue;

  try {
    // batch is generous here (unlike the 60s-bound route) — this process has
    // no wall-clock ceiling, only the pacer's 1.3s floor.
    const ingest = await runOtpMatchIngest({
      championId: champ.id,
      batch: 8,
      matchesPerAccount: MATCHES_PER_ACCOUNT,
      log,
    });
    totalMatches += ingest.matchesUpserted;
    log(
      `${champ.name}: ${ingest.accountsProcessed} account(s) processed, ${ingest.matchesUpserted} match(es) stored`
    );
    for (const err of ingest.errors) log(`  ! ${err}`);
  } catch (err) {
    log(`${champ.name}: match ingest failed: ${err.message}`);
  }
}

log(`done — ${totalAccounts} account(s) upserted, ${totalMatches} match(es) stored`);
