-- Per-player team data (full TeamCompPlayer[5] per side — championId, name,
-- items, trinket, role), added alongside migration 0006's champion-id-only
-- ally_champion_ids/enemy_champion_ids for soloq matches. Same all-or-nothing
-- contract: both columns are always written TOGETHER by lib/pro/extract.ts's
-- extractTeamPlayers (see lib/pro/types.ts's TeamCompPlayer doc comment) — a
-- match without a clean 5v5 split stores NULL in both, never a partial side.
-- Nullable — historical rows need scripts/backfill-team-comps.mjs's --players
-- mode to fill this in (WHERE ally_players IS NULL cursor); every NEW ingest
-- (lib/pro/ingestMatches.ts) populates both from here on.
ALTER TABLE coachbuild.pro_matches ADD COLUMN IF NOT EXISTS ally_players jsonb;
ALTER TABLE coachbuild.pro_matches ADD COLUMN IF NOT EXISTS enemy_players jsonb;
