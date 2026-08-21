#!/usr/bin/env node
// scripts/db-ping.mjs - "is the database there?", as a process exit code.
//
// WHY THIS EXISTS: scripts/ingest-otp.mjs has NO retry for a transport-level
// failure. On 2026-08-21 a ~10 minute "TypeError: fetch failed" to Neon made it
// fail EVERY remaining champion in sequence, print "done", and exit 0 - a
// 144-champion queue evaporated in 12 minutes and only an external monitor
// noticed. Until that script grows a retry, the supervisor
// (scripts/supervise-otp-ingest.ps1) gates every chunk on this probe so a blip
// costs one chunk instead of the whole queue.
//
// Deliberately NOT a query against any ingest table: it must answer
// "reachable?" and nothing else, so it stays valid whatever the schema is
// doing and costs one round trip.
//
// Reads DATABASE_URL from the environment ONLY. It does not load .env.local,
// because the caller's whole job is to have resolved the database explicitly
// (scripts/_cbnew-db.ps1) and a fallback here would let the probe pass against
// a database the ingest is not writing to.
//
//   node node_modules/tsx/dist/cli.mjs scripts/db-ping.mjs
//   exit 0 = reachable, 1 = not
import { Pool, neonConfig } from "@neondatabase/serverless";

neonConfig.poolQueryViaFetch = true;

const url = process.env.DATABASE_URL;
if (!url) {
  console.log("PING_FAIL DATABASE_URL not set");
  process.exit(1);
}

// Log WHICH endpoint answered, never the credential. This is the line that
// makes "which database did that chunk write to?" answerable after the fact.
const endpoint = /@([^./]+)\./.exec(url)?.[1] ?? "unknown-endpoint";
const pool = new Pool({ connectionString: url });
try {
  await pool.query("SELECT 1");
  console.log(`PING_OK ${endpoint}`);
  process.exitCode = 0;
} catch (err) {
  console.log(`PING_FAIL ${endpoint} ${err?.message ?? err}`);
  process.exitCode = 1;
} finally {
  await pool.end().catch(() => {});
}
