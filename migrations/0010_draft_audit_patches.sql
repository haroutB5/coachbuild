-- Audit patch round (2026-07-21, ship-after-patch verdict on the "Draft"
-- recommender): two additive changes.
--
-- P1-1 (default-screen garbage): pickrate is always null right now (see
-- lib/draft/ugg.ts's decodeRankingsJson stub), so the pool had NO working
-- cutoff at all -- a champion could reach the top-10 off a 128-game
-- off-role sample. `total_games` (summed across every opponent row for a
-- champ+role -- the same aggregate lib/draft/ingest.ts already computes to
-- derive `winrate`) backs a playrate-PROXY floor in lib/draft/score.ts's
-- filterPoolByTotalGames. Backfilled here from the already-ingested
-- draft_matchup data (one-time); every ingest going forward writes it
-- directly alongside winrate.
--
-- P1-2 (cron never progresses): the ingest cron previously always started
-- at cursor=0 with no persisted state, so a bounded per-invocation walk
-- (see app/api/ingest/draft/route.ts) could never advance past its first
-- ~40-champion slice across daily runs. This one-row table is the cron's
-- persisted "where did I leave off" pointer -- read/advanced by the route
-- when no explicit ?cursor= is passed; an explicit cursor still overrides
-- for manual/debug driving without touching this stored state.

ALTER TABLE coachbuild.draft_champ_stats ADD COLUMN IF NOT EXISTS total_games integer;

UPDATE coachbuild.draft_champ_stats cs
SET total_games = sub.total_games
FROM (
  SELECT patch, tier, role, champ_id, SUM(games) AS total_games
  FROM coachbuild.draft_matchup
  GROUP BY patch, tier, role, champ_id
) sub
WHERE cs.patch = sub.patch AND cs.tier = sub.tier AND cs.role = sub.role AND cs.champ_id = sub.champ_id
  AND cs.total_games IS NULL;

CREATE TABLE IF NOT EXISTS coachbuild.draft_ingest_cursor (
  id smallint PRIMARY KEY DEFAULT 1,
  cursor integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (id = 1)
);

INSERT INTO coachbuild.draft_ingest_cursor (id, cursor) VALUES (1, 0)
ON CONFLICT (id) DO NOTHING;
