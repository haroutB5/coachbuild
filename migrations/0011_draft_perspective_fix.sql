-- P0 DATA FIX (2026-07-21, user-caught with external + internal evidence):
-- u.gg's matchup row `[oppId, wins, matches]` -- `wins` in champion X's OWN
-- matchups file is the OPPONENT's wins in that pairing, NOT X's. Every row
-- ingested so far (migrations 0009/0010's bootstrap + this morning's
-- scheduled full refresh -- all one "16.13" snapshot) was stored mirror-
-- flipped. Proof: Mel mid's derived baseline landed at 54.6% against a real
-- ~44.8%; Ashe support at 55.2% against a real ~43.7% (near-exact
-- complements); a live Viktor mid "counters" list surfaced off-meta
-- marksmen "beating" him at 58-64%, which is actually Viktor crushing them,
-- read backwards. See lib/draft/ugg.ts's decodeMatchupsJson doc comment for
-- the full story and the decoder fix for all FUTURE ingests (this migration
-- only corrects data already in the table).
--
-- NO RE-FETCH NEEDED: the fix is a pure data transform. Two sequential
-- atomic UPDATE statements (each a single Postgres statement, inherently
-- atomic on its own) -- NOT wrapped in an explicit BEGIN/COMMIT block,
-- because this project's migration runner (scripts/db-migrate.mjs) executes
-- each split statement as its own independent fetch-transport call with no
-- cross-statement session/transaction affinity (see that script's own doc
-- comment); a literal BEGIN/COMMIT here would be decorative, not real
-- atomicity, so it's omitted rather than left as a false promise. The
-- practical risk window (a concurrent read landing between statement 1 and
-- 2) is the same class of risk every other multi-statement migration in
-- this project already accepts (e.g. 0010's total_games backfill + cursor
-- table creation) -- acceptable for a one-time, sub-second data correction.
--
-- Statement 1: flip every stored matchup row to the file-owner's own wins.
-- (games - wins) is safe for every existing row -- the ingest-time CHECK
-- constraint (wins<=games, games>=0) already guarantees 0 <= games-wins <= games.
UPDATE coachbuild.draft_matchup SET wins = games - wins;

-- Statement 2: re-derive draft_champ_stats.winrate from the NOW-CORRECTED
-- matchup rows, using the SAME games-weighted derivation lib/draft/ingest.ts
-- uses at ingest time (sum(wins)/sum(games) per patch+tier+role+champ) --
-- deliberately NOT a blind `1 - old_winrate`, since that would silently
-- inherit any rounding/weighting drift from the original (wrong-perspective)
-- aggregation instead of recomputing cleanly from the corrected source rows.
-- total_games is untouched (the `games` column was never wrong -- only
-- `wins` was -- so the P1-1 pool floor stays valid with no changes needed).
UPDATE coachbuild.draft_champ_stats cs
SET winrate = sub.winrate
FROM (
  SELECT patch, tier, role, champ_id,
         SUM(wins)::float8 / NULLIF(SUM(games), 0) AS winrate
  FROM coachbuild.draft_matchup
  GROUP BY patch, tier, role, champ_id
) sub
WHERE cs.patch = sub.patch AND cs.tier = sub.tier AND cs.role = sub.role AND cs.champ_id = sub.champ_id;
