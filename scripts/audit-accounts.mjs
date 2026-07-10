#!/usr/bin/env node
// scripts/audit-accounts.mjs — round 7 (2026-07-10), stale-PUUID follow-up.
// Round 6 (below) built the staleness check; round 7 fixes a class of
// accounts that 400 on EVERY pass instead of returning a clean LIVE/DEAD
// verdict: lolpros-sourced puuids that our Riot key can no longer decrypt
// (classic Riot "cannot decrypt PUUID" 400, distinct from 404/429/5xx). Two
// observed shapes: (a) the riot ID has since been reassigned to a fresh
// puuid — a same-riot_id row already holds it (duplicate — deactivate the
// stale twin, never write a puuid that collides with pro_accounts' PK), or
// (b) the riot ID itself is gone (account-v1 404 — dead, unresolvable).
//
// ---- original round-6 header follows ----
//
// user-reported bug: a tracked account can go dead (player switched
// regions/riot-ids, retired, etc.) with nothing to catch it.
// lib/pro/teamRegions.ts's activation rule only fires for a pro whose TEAM
// maps to a curated tier-1 team — Bwipo came in as ex-pro (team
// "Witchcraft", unmapped), so his 4 EUW accounts have stayed active=true
// since day one regardless of whether they're still played. This script is
// the complementary staleness check: it doesn't care what team a pro is on,
// only whether an ACTIVE account has produced a ranked-solo game in the last
// FRESH_WINDOW_DAYS.
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

const { getMatchIdsByPuuid, getAccountByRiotId, RiotRequestError } = await import("../lib/pro/riot.ts");
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

// Split "gameName#tagLine" on the LAST '#' — gameName itself can't contain
// '#' per Riot's rules, but be defensive rather than assume the FIRST '#' is
// the separator (matches the pattern used when riot_ids were originally
// constructed from account-v1 lookups elsewhere in this codebase).
function splitRiotId(riotId) {
  const idx = riotId.lastIndexOf("#");
  if (idx === -1) return null;
  return { gameName: riotId.slice(0, idx), tagLine: riotId.slice(idx + 1) };
}

// Attempt to recover a 400-ing account by re-resolving its puuid via
// account-v1. Never mutates the DB itself — callers persist based on the
// returned outcome so the caller's logging/counters stay in one place.
async function reresolveStalePuuid(sql, account, routing) {
  const split = splitRiotId(account.riot_id);
  if (!split) {
    return { outcome: "error", message: `riot_id "${account.riot_id}" has no '#' separator, cannot re-resolve` };
  }

  let acc;
  try {
    acc = await getAccountByRiotId(routing.regional, split.gameName, split.tagLine);
  } catch (err) {
    if (err instanceof RiotRequestError && err.status === 404) {
      return { outcome: "unresolvable-404" };
    }
    if (err instanceof RiotRequestError) {
      return { outcome: "error", message: `account-v1 ${err.status}: ${err.message}` };
    }
    // transient (network/etc) — let the caller's outer try/catch decide;
    // surface as error rather than throwing so the account is never left
    // half-processed.
    return { outcome: "error", message: err.message };
  }

  if (acc.puuid === account.puuid) {
    // account-v1 confirms the SAME puuid we already have, yet match-v5 still
    // 400s it — not the stale-duplicate case this fix targets. Leave
    // untouched rather than guess.
    return { outcome: "same-puuid" };
  }

  const existing = await sql`SELECT riot_id FROM coachbuild.pro_accounts WHERE puuid = ${acc.puuid}`;
  if (existing.length > 0) {
    // Duplicate case: another row (the "twin") already holds this puuid.
    // pro_accounts.puuid is PRIMARY KEY — writing it here would be a
    // constraint violation. The row in hand is the stale one; deactivate it.
    return { outcome: "duplicate", holderRiotId: existing[0].riot_id };
  }

  return { outcome: "updated", newPuuid: acc.puuid };
}

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
  let reresolved = 0;
  let duplicateDeactivated = 0;
  let deadUnresolvable = 0;
  const errors = [];
  const zeroLiveAccountsPros = [];
  let n = 0;
  const total = rows.length;

  for (const [proId, group] of byPro) {
    let anyLive = false;
    for (const account of group.accounts) {
      n++;
      const label = `[${n}/${total}] ${group.name} (${account.riot_id}, ${account.region})`;

      // Whole-account try/catch: a transient Neon "fetch failed" or any
      // other unexpected error on ONE account must not abort the run —
      // killed two passes today before this hardening.
      try {
        const routing = routingForServer(account.region);
        if (!routing) {
          console.log(`${label}: unmapped region, skipping`);
          skippedUnmapped++;
          continue;
        }

        let puuidToUse = account.puuid;
        let ids;
        try {
          ids = await getMatchIdsByPuuid(routing.regional, puuidToUse, {
            queue: 420,
            count: 1,
            startTime,
          });
        } catch (err) {
          if (!(err instanceof RiotRequestError)) throw err;

          if (err.status !== 400) {
            // A 404/429/5xx is a TRANSPORT failure, not evidence of "no
            // games" — never deactivate on the strength of an error response.
            console.log(`${label}: ERROR ${err.status}, leaving untouched`);
            errors.push(`${group.name} ${account.riot_id}: ${err.message}`);
            continue;
          }

          // 400 — the lolpros-sourced puuid our Riot key can't decrypt.
          // Attempt account-v1 re-resolution before giving up.
          const resolved = await reresolveStalePuuid(sql, account, routing);

          if (resolved.outcome === "unresolvable-404") {
            await sql`
              UPDATE coachbuild.pro_accounts
              SET active = false, last_audited_at = now()
              WHERE puuid = ${account.puuid}
            `;
            deadUnresolvable++;
            console.log(`${label}: 400 -> account-v1 404 (riot id gone), deactivated (DEAD-UNRESOLVABLE)`);
            continue;
          }

          if (resolved.outcome === "duplicate") {
            await sql`
              UPDATE coachbuild.pro_accounts
              SET active = false, last_audited_at = now()
              WHERE puuid = ${account.puuid}
            `;
            duplicateDeactivated++;
            console.log(
              `${label}: 400 -> account-v1 resolved to a puuid already held by "${resolved.holderRiotId}" — duplicate of ${account.riot_id}, deactivated stale row`
            );
            continue;
          }

          if (resolved.outcome === "same-puuid") {
            console.log(`${label}: 400 -> account-v1 confirms same puuid, still unresolved, leaving untouched`);
            errors.push(`${group.name} ${account.riot_id}: 400 persists, account-v1 confirms same puuid`);
            continue;
          }

          if (resolved.outcome === "error") {
            console.log(`${label}: 400 -> re-resolve failed (${resolved.message}), leaving untouched`);
            errors.push(`${group.name} ${account.riot_id}: re-resolve failed: ${resolved.message}`);
            continue;
          }

          // resolved.outcome === "updated"
          await sql`
            UPDATE coachbuild.pro_accounts
            SET puuid = ${resolved.newPuuid}
            WHERE puuid = ${account.puuid}
          `;
          reresolved++;
          puuidToUse = resolved.newPuuid;
          console.log(`${label}: 400 -> re-resolved puuid ${account.puuid} -> ${resolved.newPuuid}, re-probing`);

          try {
            ids = await getMatchIdsByPuuid(routing.regional, puuidToUse, {
              queue: 420,
              count: 1,
              startTime,
            });
          } catch (err2) {
            if (err2 instanceof RiotRequestError) {
              console.log(`${label}: re-probe after re-resolve ERROR ${err2.status}, puuid fixed but leaving verdict untouched`);
              errors.push(`${group.name} ${account.riot_id}: re-probe after re-resolve: ${err2.message}`);
              continue;
            }
            throw err2;
          }
        }

        checked++;
        if (ids.length > 0) {
          live++;
          anyLive = true;
          await sql`
            UPDATE coachbuild.pro_accounts
            SET last_audited_at = now(),
                last_match_ts = GREATEST(COALESCE(last_match_ts, 0), ${Date.now()})
            WHERE puuid = ${puuidToUse}
          `;
          console.log(`${label}: LIVE`);
        } else {
          dead++;
          deactivated++;
          await sql`
            UPDATE coachbuild.pro_accounts
            SET last_audited_at = now(),
                active = false
            WHERE puuid = ${puuidToUse}
          `;
          console.log(`${label}: DEAD -> deactivated`);
        }
      } catch (err) {
        console.log(`${label}: unexpected error, leaving untouched: ${err.message}`);
        errors.push(`${group.name} ${account.riot_id}: unexpected: ${err.message}`);
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
    reresolved,
    duplicateDeactivated,
    deadUnresolvable,
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
