#!/usr/bin/env node
// Repairs prostage_matches ids written while ddragon's duplicate display-name
// entries were resolved by last-write-wins. The correction map comes from the
// fixed lib/prostage/ddragon.ts maps themselves: every collided id is mapped
// to the lowest numeric id for that normalized display name. Never infer a
// correction from an id's decimal shape (for example, by stripping 60000 or
// a leading 7) because those are observations, not identity rules.
//
// Usage:
//   npx tsx scripts/backfill-prostage-ids.mjs --dry-run
//   npx tsx scripts/backfill-prostage-ids.mjs
//   npx tsx scripts/backfill-prostage-ids.mjs --limit 100
//
// --limit bounds the number of candidate rows selected by the UPDATE. The
// default is unbounded because this is a local, single-statement database
// correction with no Riot/API pacing. Dry-run is deliberately separate from
// apply so the first production command can be inspected before any write.
import { loadEnvLocal } from "./_env.mjs";

loadEnvLocal();

const { getSql } = await import("../lib/pro/db.ts");
const { getDdragonMaps } = await import("../lib/prostage/ddragon.ts");

function parseArgs(args) {
  let dryRun = false;
  let limit = null;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--limit") {
      const value = args[++i];
      if (value === undefined) throw new Error("--limit requires a positive integer");
      limit = parseLimit(value);
      continue;
    }
    if (arg.startsWith("--limit=")) {
      limit = parseLimit(arg.slice("--limit=".length));
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }

  return { dryRun, limit };
}

function parseLimit(value) {
  if (!/^\d+$/.test(value)) throw new Error(`invalid --limit: ${value}`);
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error(`invalid --limit: ${value}`);
  return limit;
}

function mappingRows(map) {
  return [...map.entries()]
    .sort(([badA], [badB]) => badA - badB)
    .map(([bad, good]) => ({ bad, good }));
}

function mappingJson(rows) {
  return JSON.stringify(rows);
}

function effectiveLimit(limit) {
  // PostgreSQL's integer LIMIT is enough for an intentionally unbounded
  // correction; the value is not user-controlled when the default is used.
  return limit ?? 2_147_483_647;
}

async function readBeforeCounts(sql, championRows, spellRows, limit) {
  const championMap = mappingJson(championRows);
  const spellMap = mappingJson(spellRows);
  const rowLimit = effectiveLimit(limit);

  const championCounts = await sql`
    WITH champion_map AS (
      SELECT (entry->>'bad')::integer AS bad_id, (entry->>'good')::integer AS good_id
      FROM jsonb_array_elements(${championMap}::jsonb) AS entry
    ),
    spell_map AS (
      SELECT (entry->>'bad')::integer AS bad_id, (entry->>'good')::integer AS good_id
      FROM jsonb_array_elements(${spellMap}::jsonb) AS entry
    ),
    candidates AS (
      SELECT pm.champion_id
      FROM coachbuild.prostage_matches pm
      WHERE EXISTS (SELECT 1 FROM champion_map cm WHERE cm.bad_id = pm.champion_id)
         OR EXISTS (
           SELECT 1
           FROM jsonb_array_elements_text(
             CASE WHEN jsonb_typeof(pm.spells) = 'array' THEN pm.spells ELSE '[]'::jsonb END
           ) AS spell(value)
           JOIN spell_map sm ON spell.value = sm.bad_id::text
         )
      ORDER BY pm.game_datetime DESC, pm.game_id, pm.player_link
      LIMIT ${rowLimit}
    )
    SELECT champion_id, count(*)::int AS n
    FROM candidates
    WHERE EXISTS (SELECT 1 FROM champion_map cm WHERE cm.bad_id = candidates.champion_id)
    GROUP BY champion_id
    ORDER BY champion_id
  `;

  const spellCounts = await sql`
    WITH champion_map AS (
      SELECT (entry->>'bad')::integer AS bad_id, (entry->>'good')::integer AS good_id
      FROM jsonb_array_elements(${championMap}::jsonb) AS entry
    ),
    spell_map AS (
      SELECT (entry->>'bad')::integer AS bad_id, (entry->>'good')::integer AS good_id
      FROM jsonb_array_elements(${spellMap}::jsonb) AS entry
    ),
    candidates AS (
      SELECT pm.spells
      FROM coachbuild.prostage_matches pm
      WHERE EXISTS (SELECT 1 FROM champion_map cm WHERE cm.bad_id = pm.champion_id)
         OR EXISTS (
           SELECT 1
           FROM jsonb_array_elements_text(
             CASE WHEN jsonb_typeof(pm.spells) = 'array' THEN pm.spells ELSE '[]'::jsonb END
           ) AS spell(value)
           JOIN spell_map sm ON spell.value = sm.bad_id::text
         )
      ORDER BY pm.game_datetime DESC
      LIMIT ${rowLimit}
    )
    SELECT sm.bad_id AS spell_id, count(*)::int AS n
    FROM candidates
    CROSS JOIN LATERAL jsonb_array_elements_text(
      CASE WHEN jsonb_typeof(candidates.spells) = 'array' THEN candidates.spells ELSE '[]'::jsonb END
    ) AS spell(value)
    JOIN spell_map sm ON spell.value = sm.bad_id::text
    GROUP BY sm.bad_id
    ORDER BY sm.bad_id
  `;

  const championCountById = new Map(championCounts.map((row) => [Number(row.champion_id), Number(row.n)]));
  const spellCountById = new Map(spellCounts.map((row) => [Number(row.spell_id), Number(row.n)]));
  const championTotal = [...championCountById.values()].reduce((sum, n) => sum + n, 0);

  return { championCountById, spellCountById, championTotal };
}

async function readAfterCounts(sql) {
  const [championRows, spellRows, spellCounts] = await Promise.all([
    sql`
      SELECT count(*)::int AS n
      FROM coachbuild.prostage_matches
      WHERE champion_id > 60000
    `,
    sql`
      SELECT count(*)::int AS n
      FROM coachbuild.prostage_matches pm
      CROSS JOIN LATERAL jsonb_array_elements_text(
        CASE WHEN jsonb_typeof(pm.spells) = 'array' THEN pm.spells ELSE '[]'::jsonb END
      ) AS spell(value)
      WHERE spell.value ~ '^7[0-9]'
    `,
    sql`
      SELECT spell.value AS spell_id, count(*)::int AS n
      FROM coachbuild.prostage_matches pm
      CROSS JOIN LATERAL jsonb_array_elements_text(
        CASE WHEN jsonb_typeof(pm.spells) = 'array' THEN pm.spells ELSE '[]'::jsonb END
      ) AS spell(value)
      WHERE spell.value ~ '^7[0-9]'
      GROUP BY spell.value
      ORDER BY spell.value
    `,
  ]);

  return {
    championAbove60000: Number(championRows[0]?.n ?? 0),
    sevenPrefixedSpells: Number(spellRows[0]?.n ?? 0),
    sevenPrefixedSpellCounts: spellCounts.map((row) => ({
      spellId: row.spell_id,
      count: Number(row.n),
    })),
  };
}

async function applyCorrections(sql, championRows, spellRows, limit) {
  const championMap = mappingJson(championRows);
  const spellMap = mappingJson(spellRows);
  const rowLimit = effectiveLimit(limit);

  const updated = await sql`
    WITH champion_map AS (
      SELECT (entry->>'bad')::integer AS bad_id, (entry->>'good')::integer AS good_id
      FROM jsonb_array_elements(${championMap}::jsonb) AS entry
    ),
    spell_map AS (
      SELECT (entry->>'bad')::integer AS bad_id, (entry->>'good')::integer AS good_id
      FROM jsonb_array_elements(${spellMap}::jsonb) AS entry
    ),
    candidates AS (
      SELECT pm.game_id, pm.player_link
      FROM coachbuild.prostage_matches pm
      WHERE EXISTS (SELECT 1 FROM champion_map cm WHERE cm.bad_id = pm.champion_id)
         OR EXISTS (
           SELECT 1
           FROM jsonb_array_elements_text(
             CASE WHEN jsonb_typeof(pm.spells) = 'array' THEN pm.spells ELSE '[]'::jsonb END
           ) AS spell(value)
           JOIN spell_map sm ON spell.value = sm.bad_id::text
         )
      ORDER BY pm.game_datetime DESC, pm.game_id, pm.player_link
      LIMIT ${rowLimit}
    )
    UPDATE coachbuild.prostage_matches pm
    SET champion_id = COALESCE(
          (SELECT cm.good_id FROM champion_map cm WHERE cm.bad_id = pm.champion_id),
          pm.champion_id
        ),
        spells = CASE
          WHEN jsonb_typeof(pm.spells) = 'array' THEN COALESCE((
            SELECT jsonb_agg(
                COALESCE(to_jsonb(sm.good_id), element.value)
                ORDER BY element.ordinality
              )
              FROM jsonb_array_elements(pm.spells) WITH ORDINALITY AS element(value, ordinality)
              LEFT JOIN spell_map sm ON element.value #>> '{}' = sm.bad_id::text
            ), '[]'::jsonb)
          ELSE pm.spells
        END
    FROM candidates
    WHERE pm.game_id = candidates.game_id AND pm.player_link = candidates.player_link
    RETURNING pm.game_id, pm.player_link
  `;

  return updated.length;
}

async function main() {
  const { dryRun, limit } = parseArgs(process.argv.slice(2));
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL missing");

  const sql = getSql();
  if (!sql) throw new Error("DATABASE_URL missing");

  const dbInfo = await sql`SELECT current_database() AS database_name`;
  console.log(`database target: ${dbInfo[0]?.database_name ?? "unknown"}`);

  const maps = await getDdragonMaps();
  const collisionFixes = maps.collisionFixes;
  if (!collisionFixes) {
    throw new Error("ddragon maps did not expose collisionFixes; refusing to guess id arithmetic");
  }

  const championRows = mappingRows(collisionFixes.champion);
  const spellRows = mappingRows(collisionFixes.summoner);
  console.log(`ddragon version: ${maps.version}`);
  console.log(`collision mappings: ${championRows.length} champion, ${spellRows.length} summoner spell`);
  for (const { bad, good } of championRows) {
    console.log(`  champion ${bad} -> ${good} (${maps.championNameById.get(good) ?? "unknown"})`);
  }
  for (const { bad, good } of spellRows) console.log(`  spell ${bad} -> ${good}`);

  const before = await readBeforeCounts(sql, championRows, spellRows, limit);
  console.log(`before champion collision rows: ${before.championTotal}`);
  for (const { bad, good } of championRows) {
    console.log(
      `  champion ${maps.championNameById.get(good) ?? good} (${bad} -> ${good}): ` +
        `${before.championCountById.get(bad) ?? 0} row(s)`
    );
  }
  console.log("before collided spell occurrences:");
  for (const { bad, good } of spellRows) {
    console.log(`  spell ${bad} -> ${good}: ${before.spellCountById.get(bad) ?? 0} occurrence(s)`);
  }
  if (limit === null && before.championTotal !== 309) {
    console.warn(
      `WARNING: audit baseline was 309 bad champion rows, but this run sees ${before.championTotal}; ` +
        "inspect concurrent ingest/new rows before treating the drift as unexpected"
    );
  }

  if (dryRun) {
    console.log("dry-run: no rows changed");
    return;
  }

  const updated = await applyCorrections(sql, championRows, spellRows, limit);
  console.log(`applied corrections to ${updated} candidate row(s)`);

  const after = await readAfterCounts(sql);
  console.log(`after champion_id > 60000 rows: ${after.championAbove60000}`);
  console.log(`after 7-prefixed spell occurrences: ${after.sevenPrefixedSpells}`);
  for (const row of after.sevenPrefixedSpellCounts) {
    console.log(`  remaining spell ${row.spellId}: ${row.count} occurrence(s)`);
  }
  if (after.championAbove60000 !== 0 || after.sevenPrefixedSpells !== 0) {
    process.exitCode = 1;
    console.error("backfill incomplete: contaminated ids remain");
  }
}

main().catch((err) => {
  console.error("backfill-prostage-ids failed:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
