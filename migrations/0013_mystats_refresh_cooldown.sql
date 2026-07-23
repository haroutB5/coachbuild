-- On-demand incremental refresh (v0.49.3, GET /mystats page-view trigger via
-- POST /api/mystats/refresh) needs a server-side cooldown so the endpoint is
-- safe to call on every page view without ever spamming the shared Riot key
-- (CLAUDE.md gotcha (d)) -- worst case is one incremental run per cooldown
-- window, REGARDLESS of how many times the endpoint is hit. Piggybacks on
-- coachbuild.my_ingest_cursor (migration 0012) rather than a new table:
-- there's already exactly one row (id=1) for this single-account feature,
-- and the cooldown timestamp is conceptually "when did incremental mode last
-- run," which is cursor-shaped state even though incremental mode itself
-- doesn't use next_start/backfill_done (see lib/mystats/ingest.ts's header).
ALTER TABLE coachbuild.my_ingest_cursor
  ADD COLUMN IF NOT EXISTS last_incremental_at timestamptz;
