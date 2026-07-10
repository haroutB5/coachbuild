#!/usr/bin/env node
// scripts/audit-accounts.mjs — round 6 (2026-07-10), user-reported bug: a
// tracked account can go dead (player switched regions/riot-ids, retired,
// etc.) with nothing to catch it. lib/pro/teamRegions.ts's activation rule
// only fires for a pro whose TEAM maps to a curated tier-1 team — Bwipo came
// in as ex-pro (team "Witchcraft", unmapped), so his 4 EUW accounts have
// stayed active=true since day one regardless of whether they're still
// played. This script is the complementary staleness check: it doesn't care
// what team a pro is on, only whether an ACTIVE account has produced a
// ranked-solo game in the last FRESH_WINDOW_DAYS.
//
// For each active account: ONE paced match-v5 ids call (queue=420 — the SAME
// queue ingestOneAccount() targets, so a "LIVE" verdict here means real
// ingest would actually find something; an account that only plays
// ARAM/normals would otherwise be misclassified LIVE by this check while
// staying permanently empty in practice) with count=1 and startTime =
// FRESH_WINDOW_DAYS ago. >=1 id back = LIVE, zero ids = DEAD.
//
// Persist: LIVE bumps last_audited_at (+ last_match_ts, see note below).
// DEAD sets active=false + last_audited_at. A DEAD verdict from a Riot error
// (429/5xx/network) is NEVER made — see the RiotRequestError handling below;
// only a genuine empty ids response counts as dead, matching this codebase's
// standing rule that a ratelimited/error response must never be recorded as
// "no data" (see lib/prostage/cargo.ts's header for the same principle
// applied to a different API).
//
// NOTE on last_match_ts: a single ids-only call has no game_creation
// timestamp (Riot's match-v5 ids endpoint returns bare id strings) — getting
// a real one would mean a SECOND paced call per account (getMatch), doubling
// the ~30-60min fleet-run estimate for ~1-2k accounts. Instead this sets
// last_match_ts to GREATEST(existing, now()) when LIVE — an intentional
// approximation ("confirmed active as of this audit", not "this exact game's
// timestamp"), monotonic-safe (never regresses a real value), and consistent
// with how ingestOneAccount() already does a GREATEST-preserving update. The
// field isn't read anywhere in the app/API layer (bookkeeping-only — grepped
// for readers before choosing this), so this approximation is harmless; the
// next REAL ingest pass overwrites it with a precise value regardless.
//
// Usage:
//   npx tsx scripts/audit-accounts.mjs                 # full active fleet, resumable
//   npx tsx scripts/audit-accounts.mjs --pro "Bwipo"    # just one pro's accounts (always re-checks, ignores the skip-today rule below)
//
// Resumability (fleet-wide only): an account already audited TODAY
// (last_audited_at >= start of today, server TZ) is skipped and doesn't
// consume a Riot call — safe to Ctrl-C and re-run the same day. --pro mode
// always re-checks regardless of last_audited_at (a deliberate, small,
// user-initiated check shouldn't silently no-op on a same-day re-run).
import { loadEnvLocal } from "./_env.mjs";

loadEnvLocal();

const { getMatchIdsByPuuid, RiotRequestError } = await import("../lib/pro/riot.ts");
const { routingForServer } = await import("../lib/pro/regionMap.ts");
const { freshStartTimeEpochSec } = await import("../lib/pro/fresh.ts");
const { getSql } = await import("../lib/pro/db.ts");

function parseArgs(argv) {
  let pro = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--pro") {
      pro = argv[i + 1] ?? null;
      i++;
    }
  }
  return { pro };
}

const { pro: proFilter } = parseArgs(process.argv.slice(2));

async function main() {
  const sql = getSql();
  if (!sql) throw new Error("DATABASE_URL missing");
  if (!process.env.RIOT_API_KEY) throw new Error("RIOT_API_KEY missing");

  const startTime = freshStartTimeEpochSec();

  const rows = proFilter
    ? await sql`
        SELECT pa.puuid, pa.pro_id, pa.region, pa.riot_id, pa.last_audited_at,
               p.name AS pro_name, p.team AS pro_team
        FROM coachbuild.pro_accounts pa
        JOIN coachbuild.pros p ON p.id = pa.pro_id
        WHERE pa.active = true AND (p.name ILIKE ${proFilter} OR p.slug ILIKE ${proFilter})
        ORDER BY p.name, pa.created_at
      `
    : await sql`
        SELECT pa.puuid, pa.pro_id, pa.region, pa.riot_id, pa.last_audited_at,
               p.name AS pro_name, p.team AS pro_team
        FROM coachbuild.pro_accounts pa
        JOIN coachbuild.pros p ON p.id = pa.pro_id
        WHERE pa.active = true
          AND (pa.last_audited_at IS NULL OR pa.last_audited_at < date_trunc('day', now()))
        ORDER BY pa.last_audited_at ASC NULLS FIRST
      `;

  if (rows.length === 0) {
    console.log(proFilter ? `no active accounts found for "${proFilter}"` : "no accounts due for audit (all checked today)");
    return;
  }
  console.log(`auditing ${rows.length} account(s)${proFilter ? ` for "${proFilter}"` : ""}`);

  // Grouped by pro so we can tell, after each pro's accounts are all done,
  // whether that pro just dropped to zero live accounts.
  const byPro = new Map();
  for (const row of rows) {
    if (!byPro.has(row.pro_id)) byPro.set(row.pro_id, { name: row.pro_name, team: row.pro_team, accounts: [] });
    byPro.get(row.pro_id).accounts.push(row);
  }

  let checked = 0;
  let live = 0;
  let dead = 0;
  let deactivated = 0;
  let skippedUnmapped = 0;
  const errors = [];
  const zeroLiveAccountsPros = [];
  let n = 0;
  const total = rows.length;

  for (const [proId, group] of byPro) {
    let anyLive = false;
    for (const account of group.accounts) {
      n++;
      const routing = routingForServer(account.region);
      if (!routing) {
        console.log(`[${n}/${total}] ${group.name} (${account.riot_id}, ${account.region}): unmapped region, skipping`);
        skippedUnmapped++;
        continue;
      }

      let ids;
      try {
        ids = await getMatchIdsByPuuid(routing.regional, account.puuid, {
          queue: 420,
          count: 1,
          startTime,
        });
      } catch (err) {
        if (err instanceof RiotRequestError) {
          // A 404/429/5xx is a TRANSPORT failure, not evidence of "no
          // games" — never deactivate on the strength of an error response.
          console.log(`[${n}/${total}] ${group.name} (${account.riot_id}, ${account.region}): ERROR ${err.status}, leaving untouched`);
          errors.push(`${group.name} ${account.riot_id}: ${err.message}`);
          continue;
        }
        throw err;
      }

      checked++;
      if (ids.length > 0) {
        live++;
        anyLive = true;
        await sql`
          UPDATE coachbuild.pro_accounts
          SET last_audited_at = now(),
              last_match_ts = GREATEST(COALESCE(last_match_ts, 0), ${Date.now()})
          WHERE puuid = ${account.puuid}
        `;
        console.log(`[${n}/${total}] ${group.name} (${account.riot_id}, ${account.region}): LIVE`);
      } else {
        dead++;
        deactivated++;
        await sql`
          UPDATE coachbuild.pro_accounts
          SET last_audited_at = now(),
              active = false
          WHERE puuid = ${account.puuid}
        `;
        console.log(`[${n}/${total}] ${group.name} (${account.riot_id}, ${account.region}): DEAD -> deactivated`);
      }
    }

    if (!anyLive && group.accounts.length > 0) {
      zeroLiveAccountsPros.push({
        name: group.name,
        team: group.team,
        riotIds: group.accounts.map((a) => `${a.riot_id} (${a.region})`),
      });
    }
  }

  const summary = {
    totalChecked: checked,
    live,
    dead,
    deactivated,
    skippedUnmapped,
    zeroLiveAccountsPros,
    errors,
  };
  console.log(JSON.stringify(summary, null, 2));
  if (zeroLiveAccountsPros.length > 0) {
    console.log(
      `\n${zeroLiveAccountsPros.length} pro(s) now have ZERO live accounts — feed these into a SoloqueueIds re-lookup:`
    );
    for (const p of zeroLiveAccountsPros) {
      console.log(`  - ${p.name} (${p.team ?? "no team"}): ${p.riotIds.join(", ")}`);
    }
  }
}

main().catch((err) => {
  console.error("audit-accounts failed:", err.message);
  process.exit(1);
});
