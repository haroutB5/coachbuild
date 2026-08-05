#!/usr/bin/env node
// Re-fetches Riot match-v5 timelines and rebuilds stored skill_order values with
// the NORMAL-only extractor. Use --table to choose the source table. This is
// deliberately sequential: lib/pro/riot.ts
// routes each timeline call through the shared 1.3s pacer, which stays below
// Riot's 100 requests / 120 seconds development-key limit even when another
// local caller is not spending the key.
//
// OTP candidate selection is intentionally done in JavaScript. The eight known
// evolve/augment champions are included whenever they have a stored timeline,
// while every other champion is included only when its stored order exceeds
// that champion's own caps. Non-standard kits are data to report, not data to
// clamp to the standard 5/5/5/3 shape.
//
// Pro-match selection is narrower: only Viktor/Kaisa/Khazix/Viego rows inside the
// app's 90-day fresh window are selected. Historical rows are counted and
// reported but not fetched because the list query that feeds the PRO surfaces
// excludes them.
//
// Usage:
//   npx tsx scripts/backfill-skill-orders.mjs --table otp_matches --dry-run
//   npx tsx scripts/backfill-skill-orders.mjs --table pro_matches --dry-run
//   npx tsx scripts/backfill-skill-orders.mjs --table pro_matches
//   npx tsx scripts/backfill-skill-orders.mjs --table pro_matches --limit 3
//   npx tsx scripts/backfill-skill-orders.mjs --table pro_matches --offset 500 --limit 500
import { loadEnvLocal } from "./_env.mjs";

loadEnvLocal();

const { getSql } = await import("../lib/pro/db.ts");
const { buildSkillOrder, kitForChampionIdentity } = await import("../lib/pro/extract.ts");
const { getMatchTimeline, RiotRequestError } = await import("../lib/pro/riot.ts");

const TARGET_CHAMPIONS = new Set([
  "viktor",
  "khazix",
  "udyr",
  "jayce",
  "kaisa",
  "yuumi",
  "aphelios",
  "viego",
]);
const PRO_TARGET_CHAMPIONS = new Set(["viktor", "kaisa", "khazix", "viego"]);
const PRO_FRESH_WINDOW_DAYS = 90;

const MAX_SCRIPT_429_RETRIES = 2;

// Match-v5 prefixes are platform ids, not the regional cluster names used in
// the URL. Keep this mapping local because an otp_matches row stores only the
// match id and puuid, not the account's source-region label.
const REGIONAL_BY_MATCH_PREFIX = new Map([
  ["NA1", "americas"],
  ["BR1", "americas"],
  ["LA1", "americas"],
  ["LA2", "americas"],
  ["OC1", "americas"],
  ["OCE1", "americas"],
  ["EUW1", "europe"],
  ["EUN1", "europe"],
  ["TR1", "europe"],
  ["RU", "europe"],
  ["ME1", "europe"],
  ["KR", "asia"],
  ["JP1", "asia"],
  ["PH2", "sea"],
  ["SG2", "sea"],
  ["TH2", "sea"],
  ["TW2", "sea"],
  ["VN2", "sea"],
]);

function normalizeChampionName(name) {
  return String(name ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function regionalForMatchId(matchId) {
  const prefix = String(matchId ?? "").split("_", 1)[0].toUpperCase();
  return REGIONAL_BY_MATCH_PREFIX.get(prefix) ?? null;
}

function parseStoredOrder(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

function skillCounts(value) {
  const counts = { Q: 0, W: 0, E: 0, R: 0 };
  const order = parseStoredOrder(value);
  if (!order) return counts;
  for (const skill of order) {
    if (Object.prototype.hasOwnProperty.call(counts, skill)) counts[skill] += 1;
  }
  return counts;
}

function violatesOwnCaps(value, row) {
  const counts = skillCounts(value);
  const kit = kitForChampionIdentity(row.champion_id, row.champion_name);
  // Unknown/unresolvable champion identity keeps the old no-guard behavior;
  // silently applying 5/5/5/3 here would make the candidate set less honest.
  if (!kit) return false;
  return Object.entries(kit.maxRanks).some(([skill, cap]) => counts[skill] > cap);
}

function isKnownEvolveChampion(championName, targetChampions = TARGET_CHAMPIONS) {
  return targetChampions.has(normalizeChampionName(championName));
}

function rowKey(row) {
  return `${row.match_id}\u0000${row.puuid}`;
}

function rowsByChampion(rows) {
  const counts = new Map();
  for (const row of rows) counts.set(row.champion_name, (counts.get(row.champion_name) ?? 0) + 1);
  return Object.fromEntries([...counts.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

function countsByChampion(rows, getOrder, targetChampions = TARGET_CHAMPIONS) {
  const counts = new Map();
  for (const row of rows) {
    if (isKnownEvolveChampion(row.champion_name, targetChampions)) {
      counts.set(row.champion_name, counts.get(row.champion_name) ?? 0);
    }
    if (!violatesOwnCaps(getOrder(row), row)) continue;
    counts.set(row.champion_name, (counts.get(row.champion_name) ?? 0) + 1);
  }
  return Object.fromEntries([...counts.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

function rowDateMs(row) {
  const value = new Date(row.game_creation).getTime();
  return Number.isFinite(value) ? value : null;
}

async function loadRows(sql, table) {
  if (table === "otp_matches") {
    return sql`
      SELECT match_id, puuid, champion_id, champion_name, skill_order
      FROM coachbuild.otp_matches
      WHERE skill_order IS NOT NULL
      ORDER BY champion_name ASC, match_id ASC, puuid ASC
    `;
  }

  const championNames = [...PRO_TARGET_CHAMPIONS];
  return sql`
    SELECT match_id, puuid, champion_id, champion_name, skill_order, game_creation
    FROM coachbuild.pro_matches
    WHERE skill_order IS NOT NULL
      AND regexp_replace(lower(champion_name), '[^a-z0-9]', '', 'g') = ANY(${championNames}::text[])
    ORDER BY game_creation ASC, champion_name ASC, match_id ASC, puuid ASC
  `;
}

async function updateSkillOrder(sql, table, row, order) {
  if (table === "otp_matches") {
    if (order === null) {
      await sql`
        UPDATE coachbuild.otp_matches
        SET skill_order = NULL
        WHERE match_id = ${row.match_id} AND puuid = ${row.puuid}
      `;
    } else {
      await sql`
        UPDATE coachbuild.otp_matches
        SET skill_order = ${JSON.stringify(order)}::jsonb
        WHERE match_id = ${row.match_id} AND puuid = ${row.puuid}
      `;
    }
    return;
  }

  if (order === null) {
    await sql`
      UPDATE coachbuild.pro_matches
      SET skill_order = NULL
      WHERE match_id = ${row.match_id} AND puuid = ${row.puuid}
    `;
  } else {
    await sql`
      UPDATE coachbuild.pro_matches
      SET skill_order = ${JSON.stringify(order)}::jsonb
      WHERE match_id = ${row.match_id} AND puuid = ${row.puuid}
    `;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * getMatchTimeline already retries 429s through the shared Riot pacer. This
 * outer bounded retry covers a 429 that remains after that helper's retries,
 * and keeps the retry delay conservative when Riot omitted Retry-After.
 */
async function fetchTimelineWithRetry(regional, matchId, log) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return { kind: "ok", timeline: await getMatchTimeline(regional, matchId) };
    } catch (err) {
      if (err instanceof RiotRequestError && err.status === 404) {
        return { kind: "aged-out" };
      }
      if (!(err instanceof RiotRequestError) || err.status !== 429 || attempt >= MAX_SCRIPT_429_RETRIES) {
        throw err;
      }
      const retryAfterSec =
        typeof err.retryAfterSec === "number" && err.retryAfterSec > 0 ? err.retryAfterSec : 120;
      const backoffMs = retryAfterSec * 1000;
      log(
        `${matchId}: 429 after Riot-client retries; waiting ${retryAfterSec}s before ` +
          `script retry ${attempt + 1}/${MAX_SCRIPT_429_RETRIES}`
      );
      await sleep(backoffMs);
    }
  }
}

function parseArgs(argv) {
  const dryRun = argv.includes("--dry-run");
  const tableArgIndex = argv.indexOf("--table");
  const inlineTableArg = argv.find((arg) => arg.startsWith("--table="));
  const table =
    tableArgIndex >= 0
      ? argv[tableArgIndex + 1]
      : inlineTableArg
        ? inlineTableArg.slice("--table=".length)
        : "otp_matches";
  if (table !== "otp_matches" && table !== "pro_matches") {
    throw new Error("--table must be otp_matches or pro_matches");
  }
  const limitIndex = argv.indexOf("--limit");
  const limit = limitIndex >= 0 ? Number(argv[limitIndex + 1]) : undefined;
  if (limitIndex >= 0 && (!Number.isInteger(limit) || limit <= 0)) {
    throw new Error("--limit must be a positive integer");
  }
  const offsetIndex = argv.indexOf("--offset");
  const offset = offsetIndex >= 0 ? Number(argv[offsetIndex + 1]) : 0;
  if (offsetIndex >= 0 && (!Number.isInteger(offset) || offset < 0)) {
    throw new Error("--offset must be a non-negative integer");
  }
  return { dryRun, limit, offset, table };
}

async function main() {
  const { dryRun, limit, offset, table } = parseArgs(process.argv.slice(2));
  const sql = getSql();
  if (!sql) throw new Error("DATABASE_URL missing");
  if (!process.env.RIOT_API_KEY) throw new Error("RIOT_API_KEY missing");

  const allRows = await loadRows(sql, table);
  const targetChampions = table === "pro_matches" ? PRO_TARGET_CHAMPIONS : TARGET_CHAMPIONS;
  let selected;
  let outOfWindow = [];
  let cutoff = null;
  if (table === "pro_matches") {
    const clockRows = await sql`SELECT now() AS now`;
    const dbNowMs = new Date(clockRows[0].now).getTime();
    cutoff = dbNowMs - PRO_FRESH_WINDOW_DAYS * 86400 * 1000;
    selected = allRows.filter((row) => {
      const isFresh = rowDateMs(row) !== null && rowDateMs(row) > cutoff;
      if (!isFresh) outOfWindow.push(row);
      return isFresh;
    });
  } else {
    selected = allRows.filter(
      (row) => isKnownEvolveChampion(row.champion_name, targetChampions) || violatesOwnCaps(row.skill_order, row)
    );
  }
  const rows = limit ? selected.slice(offset, offset + limit) : selected.slice(offset);
  const projectedOrders = new Map(selected.map((row) => [rowKey(row), row.skill_order]));
  const beforeByChampion = countsByChampion(selected, (row) => row.skill_order, targetChampions);

  console.log(
    `backfill-skill-orders: table=${table}, ${selected.length} candidate row(s)` +
      (limit || offset ? `; processing ${rows.length} (offset=${offset}${limit ? `, limit=${limit}` : ""})` : "") +
      `${dryRun ? " [DRY RUN]" : ""}`
  );
  if (table === "pro_matches") {
    console.log(
      `fresh window: ${PRO_FRESH_WINDOW_DAYS} days; cutoff=${new Date(cutoff).toISOString()}; ` +
        `out-of-window rows skipped=${outOfWindow.length}`
    );
    console.log(`out-of-window rows by champion: ${JSON.stringify(rowsByChampion(outOfWindow))}`);
    console.log(
      `out-of-window over-cap rows: ${JSON.stringify(
        countsByChampion(outOfWindow, (row) => row.skill_order, targetChampions)
      )}`
    );
  }
  console.log(`over-cap rows before: ${JSON.stringify(beforeByChampion)}`);

  let attempted = 0;
  let updated = 0;
  let changed = 0;
  let unchanged = 0;
  let agedOut = 0;
  let skipped = 0;
  const failures = [];

  for (const row of rows) {
    const regional = regionalForMatchId(row.match_id);
    if (!regional) {
      const reason = `unknown match-id routing prefix`;
      console.log(`  ${row.match_id}: ${reason}, skipping`);
      failures.push({ matchId: row.match_id, puuid: row.puuid, reason });
      skipped += 1;
      continue;
    }

    attempted += 1;
    try {
      const result = await fetchTimelineWithRetry(regional, row.match_id, (message) => console.log(`  ${message}`));
      if (result.kind === "aged-out") {
        projectedOrders.set(rowKey(row), null);
        agedOut += 1;
        if (dryRun) {
          console.log(`  ${row.match_id}: timeline 404 (aged out), would set skill_order=NULL`);
        } else {
          await updateSkillOrder(sql, table, row, null);
          updated += 1;
          console.log(`  ${row.match_id}: timeline 404 (aged out), set skill_order=NULL`);
        }
        continue;
      }

      const timelineParticipants = result.timeline?.info?.participants;
      const timelineParticipant = Array.isArray(timelineParticipants)
        ? timelineParticipants.find((participant) => participant?.puuid === row.puuid)
        : null;
      if (typeof timelineParticipant?.participantId !== "number") {
        const reason = "puuid not found in timeline.info.participants";
        console.log(`  ${row.match_id}: ${reason}, skipping`);
        failures.push({ matchId: row.match_id, puuid: row.puuid, reason });
        skipped += 1;
        continue;
      }

      const nextOrder = buildSkillOrder(result.timeline, timelineParticipant.participantId, {
        championId: row.champion_id,
        championName: row.champion_name,
      });
      const wasChanged = JSON.stringify(row.skill_order) !== JSON.stringify(nextOrder);
      projectedOrders.set(rowKey(row), nextOrder);
      if (wasChanged) changed += 1;
      else unchanged += 1;

      if (!dryRun) {
        await updateSkillOrder(sql, table, row, nextOrder);
        updated += 1;
      }
      if (attempted % 100 === 0) {
        console.log(
          `  progress: ${attempted}/${rows.length} fetched; ` +
            `${changed} changed, ${unchanged} unchanged${dryRun ? " (dry-run)" : ""}`
        );
      }
    } catch (err) {
      if (err instanceof RiotRequestError) {
        const reason = `riot ${err.status}`;
        console.log(`  ${row.match_id}: ${reason}, skipping`);
        failures.push({ matchId: row.match_id, puuid: row.puuid, reason: err.message });
        skipped += 1;
        continue;
      }
      throw err;
    }
  }

  const afterByChampion = countsByChampion(
    selected,
    (row) => projectedOrders.get(rowKey(row)),
    targetChampions
  );
  const summary = {
    dryRun,
    table,
    selected: selected.length,
    offset,
    processed: rows.length,
    attempted,
    updated,
    changed,
    unchanged,
    agedOut,
    skipped,
    failures,
    outOfWindowSkipped: outOfWindow.length,
    outOfWindowByChampion: rowsByChampion(outOfWindow),
    outOfWindowOverCap: countsByChampion(outOfWindow, (row) => row.skill_order, targetChampions),
    overCapBefore: beforeByChampion,
    overCapAfter: afterByChampion,
  };
  console.log(JSON.stringify(summary, null, 2));
  if (failures.length > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error("backfill-skill-orders failed:", err.message);
  process.exit(1);
});
