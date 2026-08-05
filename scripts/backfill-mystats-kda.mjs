#!/usr/bin/env node
// Backfills KDA/items/keystone (+ best-effort on_wpa_build) for
// coachbuild.my_matches rows ingested BEFORE migration 0014 -- those rows
// have kills/deaths/assists/item_ids/primary_keystone/on_wpa_build all NULL
// (migration 0014's own SQL-only backfill covered `split` for free, since
// that's a pure function of game_creation already in the table -- these
// fields need a fresh Riot match-v5 fetch per row, which is exactly what
// this script does instead of a plain SQL backfill).
//
// Real match history, no third-party dependency: the user's first suggestion
// (op.gg) was rejected -- no public API -- this app already has Riot access
// (RIOT_API_KEY) and every match_id already stored, so a targeted re-fetch
// of just the missing rows is strictly better than reaching outside the
// stack for data we can derive ourselves.
//
// STRICTLY SEQUENTIAL: reuses lib/pro/riot.ts's getMatch, which is already
// paced through the SAME process-wide lib/pro/pacer.ts queue every other
// Riot-calling script/route uses (CLAUDE.md gotcha (d): the key's 20/s +
// 100/2min budget is per-key, shared across every caller regardless of which
// process makes the call). A plain `for` loop awaiting each row -- never
// Promise.all, never a second concurrent instance of this script or any
// other Riot-calling script/cron -- is what keeps this correctly paced; see
// scripts/ingest-mystats.mjs's own header for the same operator-responsible-
// for-serializing posture.
//
// RESUMABLE BY CONSTRUCTION: the SELECT is `WHERE kills IS NULL`, so any row
// this run (or a prior interrupted one) already updated is never re-selected
// -- safe to Ctrl-C and re-run at any time. No cursor table needed.
//
// on_wpa_build: reuses lib/mystats/ingest.ts's EXPORTED
// resolveRecommendedBuild. It first uses a snapshot keyed to the historical
// game's own patch; only an unsnapshotted row on today's populated
// recommendation patch may create a new snapshot. Old rows with no snapshot
// stay NULL rather than being guessed against today's build.
//
// Run via:
//   npx tsx scripts/backfill-mystats-kda.mjs [limit]
import { loadEnvLocal } from "./_env.mjs";

loadEnvLocal();

const { getSql } = await import("../lib/pro/db.ts");
const { getActiveAccount } = await import("../lib/mystats/account.ts");
const { getMatch, RiotRequestError } = await import("../lib/pro/riot.ts");
const { extractMyMatch } = await import("../lib/mystats/extract.ts");
const { computeAdherence } = await import("../lib/mystats/adherence.ts");
const { resolveRecommendedBuild } = await import("../lib/mystats/ingest.ts");
const { getLatestPatch } = await import("../lib/staticData.ts");

const limitArg = Number(process.argv[2]) || undefined;

async function main() {
  const sql = getSql();
  if (!sql) throw new Error("DATABASE_URL missing");
  if (!process.env.RIOT_API_KEY) throw new Error("RIOT_API_KEY missing");

  const account = await getActiveAccount(sql);
  if (!account) {
    console.log(JSON.stringify({ accountUnresolved: true }, null, 2));
    process.exitCode = 1;
    return;
  }

  // ACCOUNT-SCOPED (migration 0020) -- and this one is load-bearing, not
  // cosmetic: every row selected here is re-fetched from Riot USING THE ACTIVE
  // ACCOUNT'S puuid and routing. An unscoped select would hand another
  // account's match ids to this account's extractMyMatch, which looks the
  // active puuid up in the participant list, fails to find it, and logs
  // "puuid not found in participants" forever -- burning a paced Riot call per
  // row, per run, to accomplish nothing.
  const pending = await sql`
    SELECT match_id FROM coachbuild.my_matches
    WHERE puuid = ${account.puuid} AND kills IS NULL
    ORDER BY game_creation DESC
  `;
  const rows = limitArg ? pending.slice(0, limitArg) : pending;

  console.log(`Resolved account: ${account.riotId} (${account.region})`);
  console.log(`${pending.length} row(s) missing KDA/items/keystone` + (limitArg ? `; processing ${rows.length} (limit=${limitArg})` : "") + ".");

  const currentPatchLabel = (await getLatestPatch()).label;
  console.log(`Current recommend-pipeline patch: ${currentPatchLabel} (unsnapshotted rows resolve only on this exact patch).`);

  const buildCache = new Map();
  let updated = 0;
  let onWpaResolvedCount = 0;
  const failures = [];

  for (const { match_id: matchId } of rows) {
    try {
      const raw = await getMatch(account.routing.regional, matchId);
      const row = extractMyMatch(raw, account.puuid);
      if (!row) {
        console.log(`  ${matchId}: puuid not found in participants, skipping`);
        failures.push({ matchId, reason: "puuid not in participants" });
        continue;
      }

      const recommended = await resolveRecommendedBuild(
        sql,
        buildCache,
        currentPatchLabel,
        row.championId,
        row.role,
        row.patch,
        (msg) => console.log(`  ${msg}`)
      );
      const onWpaBuild = computeAdherence({
        matchItemIds: row.itemIds,
        matchKeystone: row.primaryKeystone,
        recommendedCoreItemIds: recommended?.coreItemIds ?? [],
        recommendedKeystoneId: recommended?.keystoneId ?? null,
      });

      await sql`
        UPDATE coachbuild.my_matches
        SET kills = ${row.kills}, deaths = ${row.deaths}, assists = ${row.assists},
            item_ids = ${row.itemIds}::integer[], primary_keystone = ${row.primaryKeystone},
            on_wpa_build = ${onWpaBuild},
            wpa_recommendation_patch = ${recommended ? row.patch : null}
        WHERE puuid = ${account.puuid} AND match_id = ${matchId}
      `;
      updated += 1;
      if (onWpaBuild !== null) onWpaResolvedCount += 1;
      console.log(
        `  ${matchId}: patch=${row.patch} kills=${row.kills} deaths=${row.deaths} assists=${row.assists} onWpaBuild=${onWpaBuild}`
      );
    } catch (err) {
      if (err instanceof RiotRequestError) {
        console.log(`  ${matchId}: riot ${err.status} ${err.message}, skipping`);
        failures.push({ matchId, reason: err.message });
        continue;
      }
      throw err;
    }
  }

  console.log("");
  console.log(`Updated ${updated} of ${rows.length} attempted row(s). on_wpa_build resolved (non-null) for ${onWpaResolvedCount}.`);
  if (failures.length > 0) {
    console.log(`${failures.length} failure(s):`);
    for (const f of failures) console.log(`  ${f.matchId}: ${f.reason}`);
  }
  console.log("");
  console.log(
    JSON.stringify(
      { totalPending: pending.length, attempted: rows.length, updated, onWpaResolvedCount, failures },
      null,
      2
    )
  );
  if (failures.length > 0) process.exitCode = 1;
}

main().catch((err) => {
  if (err?.name === "RiotUnavailableError" || err?.name === "DbUnavailableError") {
    console.error(`backfill-mystats-kda: ${err.message}`);
    process.exit(1);
  }
  console.error("backfill-mystats-kda failed:", err);
  process.exit(1);
});
