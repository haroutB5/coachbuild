-- Per-game ALLY + ENEMY team compositions (dpm.lol-style champ icon rows) for
-- soloq matches. Nullable — historical rows ingested before this migration
-- have no comps until scripts/backfill-team-comps.mjs walks them (WHERE
-- ally_champion_ids IS NULL cursor); every NEW ingest (lib/pro/ingestMatches.ts)
-- populates both from here on. Both columns are always written TOGETHER (see
-- lib/pro/extract.ts's extractTeamComps) — a match without a clean 5v5 split
-- (should not happen for queue=420 ranked solo/duo, but defensive) stores
-- NULL in both rather than a partial side.
ALTER TABLE coachbuild.pro_matches ADD COLUMN IF NOT EXISTS ally_champion_ids jsonb;
ALTER TABLE coachbuild.pro_matches ADD COLUMN IF NOT EXISTS enemy_champion_ids jsonb;
