#!/usr/bin/env node
// Initial/backfill runner for the personal "My Stats" match tracker. Loops
// chunked backfill pages (lib/mystats/ingest.ts's persisted cursor) until
// the walk is done (BACKFILL_CAP reached or history exhausted), then prints
// the resolved account + a top-5-by-games personal champion table straight
// from the DB (same aggregation lib/mystats/aggregate.ts's summarizeByChampion
// uses, done here directly against the just-ingested rows for a plain report
// — no HTTP round-trip needed). Run via tsx:
//   npx tsx scripts/ingest-mystats.mjs [pageSize]
//
// QUOTA GOTCHA (CLAUDE.md gotcha (d)): the Riot key's 20/s + 100/2min budget
// is PER-KEY, shared across every process calling it — never run this
// concurrently with the pro cron windows (vercel.json: /api/ingest/matches
// 06:00, /api/ingest/prostage 07:00 -- Cargo not Riot, /api/ingest/draft
// 08:00 -- u.gg not Riot, /api/ingest/mystats 20:00) or another manual Riot
// script (ingest-player.mjs, ingest-roster.mjs, audit-accounts.mjs). This
// script does not check for a concurrent process itself (same as
// ingest-matches.mjs) — the operator is responsible for serializing.
import { loadEnvLocal } from "./_env.mjs";

loadEnvLocal();

const { runMyStatsIngest } = await import("../lib/mystats/ingest.ts");
const { getSql } = await import("../lib/pro/db.ts");
const { getActiveAccount } = await import("../lib/mystats/account.ts");
const { summarizeByChampion } = await import("../lib/mystats/aggregate.ts");

const pageSize = Number(process.argv[2]) || undefined;

async function main() {
  let totalSeen = 0;
  let totalUpserted = 0;
  const allErrors = [];
  let accountUnresolved = false;

  for (;;) {
    const result = await runMyStatsIngest({
      mode: "backfill",
      pageSize,
      onProgress: (msg) => console.log(`  ${msg}`),
    });
    if (result.accountUnresolved) {
      accountUnresolved = true;
      break;
    }
    totalSeen += result.matchesSeen;
    totalUpserted += result.matchesUpserted;
    allErrors.push(...result.errors);
    console.log(
      `batch: seen=${result.matchesSeen} upserted=${result.matchesUpserted}` +
        (result.errors.length ? ` errors=${result.errors.length}` : "")
    );
    if (result.nextStart === null) break;
  }

  if (accountUnresolved) {
    console.log(JSON.stringify({ accountUnresolved: true, totalSeen, totalUpserted, errors: allErrors }, null, 2));
    process.exitCode = 1;
    return;
  }

  const sql = getSql();
  const account = await getActiveAccount(sql);

  // ACCOUNT-SCOPED (migration 0020). Unscoped, this report's "top 5 personal
  // champions" would be every linked account's pool added together -- a
  // plausible-looking table describing nobody.
  const rows = account
    ? await sql`
        SELECT champion_id, role, opp_champion_id, win, game_creation
        FROM coachbuild.my_matches
        WHERE puuid = ${account.puuid}
      `
    : [];
  const records = rows.map((r) => ({
    championId: r.champion_id,
    role: r.role,
    oppChampionId: r.opp_champion_id,
    win: r.win,
    gameCreation: r.game_creation,
  }));
  const byChampion = summarizeByChampion(records);
  // Collapse role-split rows into one per-champion line for the report table
  // (summarizeByChampion groups by champion+role — a champion played in two
  // roles shows as two rows there, which is correct for the API but noisy
  // for a "top 5 champions" headline; re-aggregate across role here).
  const perChampion = new Map();
  for (const r of byChampion) {
    const e = perChampion.get(r.championId) ?? { championId: r.championId, games: 0, wins: 0 };
    e.games += r.games;
    e.wins += r.wins;
    perChampion.set(r.championId, e);
  }
  const top5 = [...perChampion.values()]
    .map((e) => ({ ...e, winrate: e.wins / e.games }))
    .sort((a, b) => b.games - a.games)
    .slice(0, 5);

  console.log("");
  console.log(`Resolved account: ${account?.riotId ?? "(unresolved)"} (${account?.region ?? "?"})`);
  console.log(`Rows in coachbuild.my_matches for THIS account: ${rows.length}`);
  console.log("Top 5 personal champions by games:");
  for (const c of top5) {
    console.log(`  champion ${c.championId}: ${c.games} games, ${(c.winrate * 100).toFixed(1)}% winrate (${c.wins}W-${c.games - c.wins}L)`);
  }
  console.log("");
  console.log(
    JSON.stringify(
      { riotId: account?.riotId, totalRows: rows.length, totalSeen, totalUpserted, top5, errors: allErrors },
      null,
      2
    )
  );
  if (allErrors.length > 0) process.exitCode = 1;
}

main().catch((err) => {
  if (err?.name === "RiotUnavailableError" || err?.name === "DbUnavailableError") {
    console.error(`ingest-mystats: ${err.message}`);
    process.exit(1);
  }
  console.error("ingest-mystats failed:", err);
  process.exit(1);
});
