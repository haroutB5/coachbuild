-- 0015 — indexes for the live/Leaguepedia supersede rule (v0.55.1).
--
-- WHY. The supersede predicate in app/api/pros used to key on
-- `sup.lolesports_game_id = pm.lolesports_game_id`, but the Leaguepedia ingest
-- (lib/prostage/ingest.ts) never writes that column — only the on-demand
-- timeline route and the backfill script do. So the EXISTS could never match on
-- a freshly-ingested Leaguepedia row (NULL = NULL is never true) and every live
-- row rendered alongside its Leaguepedia twin. A supersede rule keyed on a field
-- the superseding writer never writes is not a rule.
--
-- The predicate now matches on (normalised player, champion, +/-12h), which both
-- writers populate unconditionally. These indexes make that correlated NOT EXISTS
-- cheap; it runs on every prostage read.

-- Still used by the write-path "do I already hold this game" check.
CREATE INDEX IF NOT EXISTS prostage_matches_lolesports_game_id_idx
  ON coachbuild.prostage_matches (lolesports_game_id)
  WHERE lolesports_game_id IS NOT NULL;

-- Drives the supersede EXISTS. Leaguepedia player_links carry real-name
-- disambiguators the live feed never has ("Zeka (Kim Geon-woo)" vs "Zeka"), so
-- the join is on the paren-stripped, lower-cased name — indexed as the same
-- expression the query uses, or the index is not used.
CREATE INDEX IF NOT EXISTS prostage_matches_supersede_idx
  ON coachbuild.prostage_matches (
    lower(btrim(split_part(player_link, ' (', 1))),
    champion_id,
    game_datetime
  );
