-- Lazily-computed in-game item build order for pro-stage (on-stage) games,
-- reconstructed from the free lolesports livestats feed (see
-- lib/prostage/timeline.ts + resolveGame.ts). ONE livestats walk yields all 10
-- players' timelines, so a single resolve persists purchase_order for every row
-- of that game_id at once — GET /api/prostage/timeline computes on first request
-- for a game, then serves every subsequent request from these columns.
--
-- All nullable / backfilled: rows ingested before this migration (and every
-- future ingest) start with timeline_status NULL = "never attempted". A prior
-- attempt that hit a TRANSIENT feed/API failure ALSO leaves NULL (never written
-- as 'unavailable') so it re-attempts on the next request — same
-- distrust-a-failure discipline as lib/prostage/cargo.ts's header and matchday's
-- livestats contract.

-- ProGamePurchase[] (lib/pro/types.ts) for THIS player_link: {itemId, ts} where
-- ts is SECONDS into the game (appear-only first-appearance timeline). Same
-- shape as soloq pro_matches.purchase_order so the frontend renders both
-- identically.
ALTER TABLE coachbuild.prostage_matches ADD COLUMN IF NOT EXISTS purchase_order jsonb;

-- The resolved numeric lolesports esports game id the timeline was walked from
-- (shared across all 10 rows of the game). Kept for debuggability / re-walks;
-- NULL until the game is resolved.
ALTER TABLE coachbuild.prostage_matches ADD COLUMN IF NOT EXISTS lolesports_game_id text;

-- 'ok'          = purchase_order populated from a clean walk.
-- 'unavailable' = permanently unresolvable (game maps to no lolesports id, or the
--                 livestats feed genuinely has no data for it) — served as a
--                 terminal "unavailable" without re-walking.
-- NULL          = never attempted, OR a prior attempt hit a transient failure
--                 (5xx / network / tainted walk). Both re-attempt next request.
ALTER TABLE coachbuild.prostage_matches ADD COLUMN IF NOT EXISTS timeline_status text;
