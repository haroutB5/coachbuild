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
  // --- round 7 (2026-07-10): zero-live-accounts follow-up. Leaguepedia
  // SoloqueueIds via CargoExport for the pros round-6's staleness sweep +
  // round-7's stale-puuid fix left with zero active accounts. Same rule as
  // round 5: UNVERIFIED until getAccountByRiotId() confirms it; a 404 drops
  // the entry, never guess an alternative tag/spelling. Multi-account pros
  // get one entry per candidate account (both upsert if both resolve).
  { slug: "berserker", gameName: "LYON", tagLine: "09012", region: "KR", regional: "asia" }, // Lyon Gaming
  { slug: "berserker", gameName: "qaxu", tagLine: "KR1", region: "KR", regional: "asia" }, // Lyon Gaming
  { slug: "corejj", gameName: "리퀴드 코어장전", tagLine: "KR1", region: "KR", regional: "asia" }, // Team Liquid — gameName has an internal space, preserved
  { slug: "corejj", gameName: "From Iron", tagLine: "1123", region: "NA", regional: "americas" }, // Team Liquid — gameName has an internal space, preserved
  { slug: "delight", gameName: "플레이리스트겨울", tagLine: "KR1", region: "KR", regional: "asia" }, // Hanwha Life Esports
  { slug: "doran", gameName: "어리고싶다", tagLine: "KR1", region: "KR", regional: "asia" }, // T1
  { slug: "duro", gameName: "Duro", tagLine: "Gen", region: "KR", regional: "asia" }, // Gen.G
  { slug: "impact", gameName: "TL IMPACT", tagLine: "XDDD", region: "NA", regional: "americas" }, // Sentinels — gameName has an internal space, preserved
  { slug: "jojopyun", gameName: "KOIIIIIIIII", tagLine: "1234", region: "NA", regional: "americas" }, // Movistar KOI
  { slug: "jojopyun", gameName: "jjjjjjjjjjjj", tagLine: "1234", region: "KR", regional: "asia" }, // Movistar KOI
  { slug: "kellin", gameName: "댕청잇", tagLine: "kr123", region: "KR", regional: "asia" }, // BNK FEARX
  { slug: "kellin", gameName: "참새크면비둘기", tagLine: "kr1", region: "KR", regional: "asia" }, // BNK FEARX
  // Massu — wiki markup had a space before the tag separator on the KR
  // entry ("하쿠지 #3636"); try trimmed first per the fix brief, only fall
  // back to the space-preserved form if account-v1 404s the trimmed one.
  { slug: "massu", gameName: "KaiGyt", tagLine: "0187", region: "NA", regional: "americas" }, // FlyQuest
  { slug: "massu", gameName: "하쿠지", tagLine: "3636", region: "KR", regional: "asia" }, // FlyQuest
  { slug: "peanut", gameName: "Peanut", tagLine: "kr11", region: "KR", regional: "asia" }, // Hanwha Life Esports
  { slug: "viper", gameName: "Blue", tagLine: "KR33", region: "KR", regional: "asia" }, // Hanwha Life Esports
  { slug: "zeka", gameName: "suis", tagLine: "kr7", region: "KR", regional: "asia" }, // Hanwha Life Esports
  { slug: "zeka", gameName: "Kiruru", tagLine: "kr7", region: "KR", regional: "asia" }, // Hanwha Life Esports
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
