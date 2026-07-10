-- Adds the raw stats needed for the CoachBuild Score (lib/pro/score.ts):
-- dpm.lol's signature 0-100 per-game grade, blended from KDA + win + (when
-- available) kill participation and CS/min. Nullable — historical rows
-- ingested before this migration have no match-v5 re-fetch and stay NULL
-- until scripts/backfill-game-stats.mjs walks them (WHERE cs IS NULL
-- cursor); every NEW ingest (lib/pro/ingestMatches.ts) populates all four
-- from here on.
ALTER TABLE coachbuild.pro_matches ADD COLUMN IF NOT EXISTS cs integer;
ALTER TABLE coachbuild.pro_matches ADD COLUMN IF NOT EXISTS damage_champions integer;
ALTER TABLE coachbuild.pro_matches ADD COLUMN IF NOT EXISTS team_kills integer;
ALTER TABLE coachbuild.pro_matches ADD COLUMN IF NOT EXISTS gold integer;
