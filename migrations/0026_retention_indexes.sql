-- 0026_retention_indexes.sql — indexes that make lib/retention/prune.ts's
-- batched delete an index range scan instead of a repeated sequential scan.
--
-- WHY THESE ARE WORTH THEIR OWN STORAGE, IN A CHANGE WHOSE ENTIRE PURPOSE IS
-- TO SAVE STORAGE. Not one of the four pruned tables has an index that can
-- serve a bare `<time column> <= $1` predicate:
--
--   pro_matches          (champion_id, role, game_creation DESC)  -- champion-prefixed
--   otp_matches          (champion_id, role, game_creation DESC)  -- champion-prefixed
--   prostage_matches     (champion_id, game_datetime DESC), (pro_id, game_datetime DESC)
--   otp_featured_scanned (puuid)                                  -- no time column indexed
--
-- A leading-column mismatch means the planner cannot use any of them for the
-- prune's selection, so every batch would sequentially scan the whole table.
-- On pro_matches that is ~200k rows over ~400 MB of heap, repeated once per
-- batch, on a 0.25 CU compute — i.e. exactly the profile of unattended,
-- invisible database work that exhausted this project's compute quota on
-- 2026-08-20. Paying ~5 MB of index to permanently remove a recurring
-- full-table scan is the correct trade against 60-90 MB/month of growth
-- prevented, and it is the cheaper of the two resources.
--
-- BTREE, NOT BRIN. BRIN would be the textbook choice for an append-only,
-- time-correlated column and would cost kilobytes instead of megabytes — but
-- these tables are NOT written in game-time order. The pro walk visits
-- accounts by staleness and each account's matches arrive newest-first within
-- its own 90-day window, so physical row order correlates only weakly with
-- game_creation and BRIN's block ranges would be too wide to prune much.
--
-- PLAIN, NOT CONCURRENTLY. scripts/db-migrate.mjs runs each statement outside
-- a transaction, so CREATE INDEX CONCURRENTLY would be syntactically possible
-- here. It is deliberately not used: a CONCURRENTLY build that fails leaves an
-- INVALID index behind, and the `IF NOT EXISTS` guard would then silently skip
-- ever rebuilding it — a failure this migration could not report. At these row
-- counts a plain build holds its lock for a second or two on an app with one
-- user, which is the cheaper failure mode.

CREATE INDEX IF NOT EXISTS pro_matches_retention_idx
  ON coachbuild.pro_matches (game_creation);

-- NOTE THE COLUMN. prostage_matches has NO game_creation column — its time
-- axis is game_datetime (migrations/0002_prostage.sql). A blanket
-- "prune on game_creation" retention rule applied to all four tables would
-- fail here at runtime.
CREATE INDEX IF NOT EXISTS prostage_matches_retention_idx
  ON coachbuild.prostage_matches (game_datetime);

-- otp_featured_scanned is a scan ledger, not a match table: it has no
-- game-time column at all. scanned_at is when the Riot call was made, and it
-- is the correct (and only possible) retention key — see the reasoning in
-- lib/retention/prune.ts's registry entry for why a row scanned more than
-- FRESH_WINDOW_DAYS ago can never save another Riot call.
CREATE INDEX IF NOT EXISTS otp_featured_scanned_retention_idx
  ON coachbuild.otp_featured_scanned (scanned_at);

-- otp_matches is deliberately NOT indexed for retention here. Its prune is
-- implemented but blocked: app/api/otp/featured/route.ts reads that table with
-- no time bound and no LIMIT, and aggregates over every row it returns, so it
-- genuinely serves rows older than the fresh window today. Adding the index
-- before that read path is bounded would spend storage on a prune that must
-- not run. See PRUNE_BLOCKED_REASON.otp_matches in lib/retention/prune.ts.
