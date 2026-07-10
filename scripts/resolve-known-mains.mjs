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
//
// 2026-07-10 (round 5): 9 KR mains added from Leaguepedia's Players table
// SoloqueueIds field, pulled via CargoExport (no api.php calls spent).
// SoloqueueIds is Leaguepedia's own words "manually maintained, may be
// extremely incomplete or inaccurate" — every entry below is UNVERIFIED wiki
// data until getAccountByRiotId() below confirms it against Riot account-v1;
// a 404 there means DROP the entry, never guess an alternative tag/spelling.
// Ruler (Gen.G ADC) was on the candidate list but has NO row in
// coachbuild.pros at all (checked: chovy/kiin/canyon/duro are Gen.G's only
// pros on file) — skipped entirely, nothing to link a riot_id to.
//
// Run via tsx: npx tsx scripts/resolve-known-mains.mjs
import { loadEnvLocal } from "./_env.mjs";

loadEnvLocal();

const { getAccountByRiotId, RiotRequestError } = await import("../lib/pro/riot.ts");
const { getSql } = await import("../lib/pro/db.ts");

const KNOWN_MAINS = [
  { slug: "faker", gameName: "Hide on bush", tagLine: "KR1", region: "KR", regional: "asia" },
  // Bin (BLG top) — user-verified 2026-07-10 from dpm.lol's PRO-tagged profile
  // screenshot: active KR grind account (Master 1047 LP, 242 games this split).
  { slug: "bin", gameName: "빈 스토리", tagLine: "KR1", region: "KR", regional: "asia" },
  // --- round 5 (2026-07-10): Leaguepedia SoloqueueIds via CargoExport, all UNVERIFIED until getAccountByRiotId() below resolves them ---
  { slug: "chovy", gameName: "허거덩", tagLine: "0303", region: "KR", regional: "asia" }, // Gen.G
  { slug: "zeus", gameName: "Spring", tagLine: "bomm", region: "KR", regional: "asia" }, // Hanwha Life Esports
  { slug: "canyon", gameName: "JUGKlNG", tagLine: "kr", region: "KR", regional: "asia" }, // Gen.G
  { slug: "gumayusi", gameName: "T1 Gumayusi", tagLine: "KR1", region: "KR", regional: "asia" }, // Hanwha Life Esports — gameName has an internal space, preserved
  { slug: "kanavi", gameName: "vinaka", tagLine: "KR1", region: "KR", regional: "asia" }, // Hanwha Life Esports
  { slug: "keria", gameName: "역천괴", tagLine: "ker3", region: "KR", regional: "asia" }, // T1
  { slug: "kiin", gameName: "kiin", tagLine: "KR1", region: "KR", regional: "asia" }, // Gen.G
  { slug: "oner", gameName: "오 너", tagLine: "111", region: "KR", regional: "asia" }, // T1 — gameName has an internal space, preserved
  // Peyz — wiki markup literally had "Peyz #KR11" (space before the tag
  // separator); tried trimmed ("Peyz") first per the fix brief, only fall
  // back to the space-preserved form if account-v1 404s the trimmed one.
  { slug: "peyz", gameName: "Peyz", tagLine: "KR11", region: "KR", regional: "asia" }, // T1
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
    const riotId = `${known.gameName}#${known.tagLine}`;

    // Every wiki-sourced entry (round 5, 2026-07-10) is UNVERIFIED until this
    // call succeeds — a 404 (or any other Riot error) must be caught and
    // logged PER ENTRY, not left to crash the whole loop, since we expect
    // some of these 9 to legitimately not resolve (wiki data is "manually
    // maintained, may be extremely incomplete or inaccurate") and still want
    // every other entry's result reported.
    let acc;
    try {
      acc = await getAccountByRiotId(known.regional, known.gameName, known.tagLine);
    } catch (err) {
      if (err instanceof RiotRequestError && err.status === 404) {
        console.error(`${known.slug}: 404 — riot id "${riotId}" not found, dropping (no guess)`);
        results.push({ slug: known.slug, riotId, status: "404" });
      } else {
        console.error(`${known.slug}: riot lookup failed for "${riotId}": ${err.message}`);
        results.push({ slug: known.slug, riotId, status: "error", error: err.message });
      }
      continue;
    }

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
    results.push({ slug: known.slug, riotId, region: known.region, puuid: acc.puuid, status: "resolved" });
  }
  console.log(JSON.stringify(results, null, 2));
}

main().catch((err) => {
  console.error("resolve-known-mains failed:", err.message);
  process.exit(1);
});
