-- "My Stats" CS per minute (2026-07-30, TrackDIFF-style /mystats rebuild).
--
-- WHY TWO RAW COLUMNS AND NOT ONE `cs_per_min numeric`. A stored RATE cannot be
-- re-aggregated. Averaging the per-game rates of a 40-minute game and a
-- 20-minute game weights the short game exactly as heavily as the long one,
-- which is not what "my CS per minute" means and is off by several tenths in
-- practice. The honest aggregate is sum(cs) / (sum(game_duration_sec) / 60),
-- which needs both raw numerators and both raw denominators to survive into the
-- table. The per-game rate the UI shows is then derived from this row's own two
-- values at read time (lib/mystats/cs.ts), never stored.
--
-- Both columns are NULLABLE and stay NULL on every row ingested before this
-- migration. That is the same posture migration 0014 took for kills/deaths/
-- assists: NULL means "not measured", never 0, and lib/mystats/cs.ts excludes
-- such a row from every figure rather than counting it as a zero-CS game. Run
-- scripts/backfill-mystats-cs.mjs to fill them (one Riot match-v5 call per row).
ALTER TABLE coachbuild.my_matches
  -- Lane minions + neutral monsters, end of game, for the tracked player only.
  -- Single source of the formula: lib/pro/extract.ts's creepScore().
  ADD COLUMN IF NOT EXISTS cs integer,
  -- match-v5 info.gameDuration, SECONDS. The denominator. Stored even for
  -- remakes and 3-minute games -- the row is never dropped; short games are
  -- excluded at AGGREGATION time only (lib/mystats/cs.ts's CS_MIN_GAME_SEC),
  -- so moving that threshold later needs no re-ingest.
  ADD COLUMN IF NOT EXISTS game_duration_sec integer;
