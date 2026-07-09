#!/usr/bin/env node
// One-off: resolve KNOWN pro KR mains via Riot account-v1 by-riot-id, upsert
// as an active KR pro_accounts row. Directive 1 step 3 (2026-07-09) — Faker's
// real KR main was never in our data (lolpros only ever surfaced his EUW
// bootcamp smurfs), and the new team-region backfill (apply-team-regions.mjs)
// just deactivated all 4 of those, which would otherwise leave him with ZERO
// active accounts.
//
// Deliberately conservative: only entries we can state with confidence go in
// KNOWN_MAINS — a wrong riot_id here would silently attach the WRONG
// player's games to a pro's history, worse than leaving an account missing.
// Chovy and other KR pros are NOT included — their exact riot_id/tag wasn't
// independently confirmed this round (a Leaguepedia SoloqueueIds lookup
// would confirm them, but the Leaguepedia rate limiter is burned this
// session per the fix brief) — add them here only once confirmed, never
// guessed.
//
// Run via tsx: npx tsx scripts/resolve-known-mains.mjs
import { loadEnvLocal } from "./_env.mjs";

loadEnvLocal();

const { getAccountByRiotId } = await import("../lib/pro/riot.ts");
const { getSql } = await import("../lib/pro/db.ts");

const KNOWN_MAINS = [
  { slug: "faker", gameName: "Hide on bush", tagLine: "KR1", region: "KR", regional: "asia" },
];

async function main() {
  const sql = getSql();
  if (!sql) throw new Error("DATABASE_URL missing");
  if (!process.env.RIOT_API_KEY) throw new Error("RIOT_API_KEY missing");

  const results = [];
  for (const known of KNOWN_MAINS) {
    const pro = await sql`SELECT id FROM coachbuild.pros WHERE slug = ${known.slug}`;
    if (pro.length === 0) {
      console.error(`skip ${known.slug}: no pro row found`);
      continue;
    }
    const proId = pro[0].id;

    const acc = await getAccountByRiotId(known.regional, known.gameName, known.tagLine);
    const riotId = `${known.gameName}#${known.tagLine}`;
    await sql`
      INSERT INTO coachbuild.pro_accounts (puuid, pro_id, region, riot_id, active, created_at)
      VALUES (${acc.puuid}, ${proId}, ${known.region}, ${riotId}, true, now())
      ON CONFLICT (puuid) DO UPDATE SET
        pro_id = EXCLUDED.pro_id,
        region = EXCLUDED.region,
        riot_id = EXCLUDED.riot_id,
        active = true
    `;
    const line = `${known.slug}: upserted ${riotId} (${known.region}) puuid=${acc.puuid}`;
    console.log(line);
    results.push({ slug: known.slug, riotId, region: known.region, puuid: acc.puuid });
  }
  console.log(JSON.stringify(results, null, 2));
}

main().catch((err) => {
  console.error("resolve-known-mains failed:", err.message);
  process.exit(1);
});
