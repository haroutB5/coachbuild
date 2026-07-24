-- "My Stats" v0.51 additions: per-match KDA/build fidelity + split tagging.
-- See lib/mystats/extract.ts (KDA/items/keystone extraction), lib/mystats/
-- adherence.ts (the pure on-build check), lib/mystats/ingest.ts (recommend-
-- pipeline resolution + cache), lib/mystats/season.ts (SPLIT_BOUNDARIES).

ALTER TABLE coachbuild.my_matches
  ADD COLUMN IF NOT EXISTS kills smallint,
  ADD COLUMN IF NOT EXISTS deaths smallint,
  ADD COLUMN IF NOT EXISTS assists smallint,
  -- Final item slots 0-5 (the 6 build slots; trinket/item6 excluded -- never
  -- a build-path signal). Empty slots come through as Riot's own `0` sentinel,
  -- never stripped -- computeAdherence's membership check never matches 0
  -- against a real recommended item id, so no filtering is needed here.
  ADD COLUMN IF NOT EXISTS item_ids integer[],
  -- Primary-tree keystone rune id (perks.styles[primaryStyle].selections[0]),
  -- null when perks are missing/malformed (defensive -- shouldn't happen on a
  -- real match-v5 response).
  ADD COLUMN IF NOT EXISTS primary_keystone integer,
  -- true/false = a real WPA-build comparison was made (lib/mystats/
  -- adherence.ts's computeAdherence); NULL = no recommendation was available
  -- to compare against (unresolved role, champ/role/patch combo with no
  -- coachless data, or -- see ingest.ts's header -- the match's own patch
  -- isn't today's live patch, since the recommend engine has no
  -- historical-patch override). DISPLAY ONLY: never feeds any score/ranking
  -- (same hard rule as every other My Stats field -- see lib/draft/
  -- recommend.ts's PersonalPlayResult doc comment).
  ADD COLUMN IF NOT EXISTS on_wpa_build boolean,
  -- 1-indexed within-season split number (Riot's own "Season 1/2/3" naming
  -- within an annual cycle -- see lib/mystats/season.ts's SPLIT_BOUNDARIES
  -- header for the sourced boundary dates). Used so a purge run can retire
  -- data older than the PRIOR split while always keeping prior+current.
  ADD COLUMN IF NOT EXISTS split smallint;

CREATE INDEX IF NOT EXISTS my_matches_split_idx ON coachbuild.my_matches (split);

-- Backfill `split` for every existing row. Unlike kills/deaths/assists/
-- item_ids/primary_keystone/on_wpa_build (which need a fresh Riot match-v5
-- fetch or a coachless recommend lookup -- deliberately NOT backfilled, see
-- lib/mystats/ingest.ts's header), `split` is a pure function of a column
-- this table ALREADY has (game_creation) -- free to backfill with plain SQL,
-- no external I/O, so there's no reason to leave old rows without it (that
-- would silently exclude every pre-migration row from the new
-- current-split-filtered displays). Mirrors lib/mystats/season.ts's
-- SPLIT_BOUNDARIES exactly -- keep these two in sync if a boundary ever moves.
UPDATE coachbuild.my_matches SET split = CASE
  WHEN game_creation >= '2026-08-26T00:00:00Z' THEN 3  -- patch 16.17 ("26.17")
  WHEN game_creation >= '2026-04-29T00:00:00Z' THEN 2  -- patch 16.9  ("26.9"), "Pandemonium"
  ELSE 1                                                -- patch 16.1  ("26.1"), "For Demacia"
END
WHERE split IS NULL;
