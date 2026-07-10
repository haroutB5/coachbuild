#!/usr/bin/env node
// Pre-warms the migration-0005 item build order (purchase_order /
// lolesports_game_id / timeline_status) for prostage games that haven't been
// resolved yet. Same lazy resolve+walk the GET /api/prostage/timeline route
// runs on first request — this just does it ahead of time, in bulk, so a
// tournament is warm before anyone opens it.
//
// Resumable via a `WHERE timeline_status IS NULL` cursor (grouped by game_id):
// a finished game has status 'ok'/'unavailable' and drops out of the next run;
// a game that hit a TRANSIENT failure stays NULL and is retried. Re-running
// after a partial run / crash just picks up where it left off — no separate
// cursor bookkeeping.
//
// Sequential by design (ONE game at a time): each game's livestats walk already
// fires WALK_CONCURRENCY (12) parallel details fetches at feed.lolesports.com;
// parallelizing games on top would invite the 429s that TAINT a once-only
// completed-game build. Do NOT parallelize.
//
// Usage:
//   npx tsx scripts/backfill-prostage-timelines.mjs [limit]
// `limit` (default 3) caps DISTINCT GAMES touched this run. Deliberately small —
// validate on a few, then raise explicitly to pre-warm a whole tournament.
import { loadEnvLocal } from "./_env.mjs";

loadEnvLocal();

const { getSql } = await import("../lib/pro/db.ts");
const { computeGameTimelines } = await import("../lib/prostage/resolveGame.ts");

const limit = Number(process.argv[2]) || 3;

async function main() {
  const sql = getSql();
  if (!sql) throw new Error("DATABASE_URL missing");

  const games = await sql`
    SELECT game_id,
           min(game_datetime) AS game_datetime,
           min(overview_page) AS overview_page
    FROM coachbuild.prostage_matches
    WHERE timeline_status IS NULL
    GROUP BY game_id
    ORDER BY min(game_datetime) DESC
    LIMIT ${limit}
  `;

  console.log(`backfill-prostage-timelines: ${games.length} game(s) to process (limit=${limit})`);

  let ok = 0;
  let unavailable = 0;
  let transient = 0;
  const errors = [];

  for (const g of games) {
    const rows = await sql`
      SELECT player_link, team, champion_id
      FROM coachbuild.prostage_matches
      WHERE game_id = ${g.game_id}
    `;
    const dbRows = rows.map((r) => ({
      player_link: r.player_link,
      team: r.team,
      champion_id: r.champion_id,
    }));
    const gameDatetime = new Date(g.game_datetime).toISOString();

    let result;
    try {
      result = await computeGameTimelines(g.game_id, gameDatetime, g.overview_page, dbRows);
    } catch (err) {
      errors.push(`${g.game_id}: ${err.message}`);
      console.log(`  ${g.game_id}: ERROR ${err.message}`);
      continue;
    }

    if (result.status === "transient") {
      transient += 1;
      console.log(`  ${g.game_id}: transient (${result.reason}) — left NULL for retry`);
      continue;
    }

    if (result.status === "unavailable") {
      await sql`
        UPDATE coachbuild.prostage_matches
        SET timeline_status = 'unavailable'
        WHERE game_id = ${g.game_id}
      `;
      unavailable += 1;
      console.log(`  ${g.game_id}: unavailable (${result.reason})`);
      continue;
    }

    // ok — persist each player's build order (unmatched players get []).
    let items = 0;
    for (const r of rows) {
      const order = result.byPlayer.get(r.player_link) ?? [];
      items += order.length;
      await sql`
        UPDATE coachbuild.prostage_matches
        SET purchase_order = ${JSON.stringify(order)}::jsonb,
            lolesports_game_id = ${result.lolesportsGameId},
            timeline_status = 'ok'
        WHERE game_id = ${g.game_id} AND player_link = ${r.player_link}
      `;
    }
    ok += 1;
    console.log(
      `  ${g.game_id}: ok — lolesportsGameId=${result.lolesportsGameId}, ` +
        `${result.byPlayer.size}/${rows.length} players matched, ${items} total purchases`
    );
  }

  console.log(JSON.stringify({ processed: games.length, ok, unavailable, transient, errors }, null, 2));
  if (errors.length > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error("backfill-prostage-timelines failed:", err.message);
  process.exit(1);
});
