-- "My Stats" ranked tier / LP per linked account (2026-07-30).
--
-- Source: league-v4 `/lol/league/entries/by-puuid/{puuid}` on the PLATFORM host
-- (euw1 etc, not the regional cluster). Probed live 2026-07-30 against both
-- linked accounts, HTTP 200 both times. SOLO QUEUE ONLY is stored here --
-- K1ayer#swift's real response carries a RANKED_FLEX_SR entry alongside the
-- solo one, and blending or silently preferring either would put a flex rank on
-- a badge the design labels as rank. If flex is ever wanted it gets its own
-- flex_* columns, never these.
--
-- WHY THIS IS PERSISTED AND NOT AN IN-PROCESS CACHE. The Riot key is shared with
-- every other pipeline in this app and going over the cap suspends it app-wide
-- (CLAUDE.md gotcha (d)). An in-memory TTL on Vercel is per-lambda-instance, so
-- N cold instances means N calls for the same fact. Persisting makes the TTL
-- GLOBAL: one call per account per RANK_TTL_MS for the whole deployment, and
-- zero calls when nothing is stale.
--
-- THE TWO TIMESTAMPS ARE NOT REDUNDANT.
--   rank_checked_at   -- last SUCCESSFUL read. Drives the API's `rankCheckedAt`
--                        and, by being NULL, drives `rankUnknown`.
--   rank_attempted_at -- last attempt, success OR failure. Drives the TTL gate.
-- Splitting them is what lets a FAILED refresh keep serving the last real
-- reading (with an honestly old rank_checked_at) instead of blanking a badge
-- that was correct a minute ago, while still backing off the failing call. One
-- shared column would force a choice between hammering Riot and discarding good
-- data.
--
-- ALL SIX VALUE COLUMNS ARE NULL TOGETHER OR SET TOGETHER. A successful read of
-- an UNRANKED account writes all six as NULL and stamps rank_checked_at -- that
-- is the "genuinely unranked" state, and it is distinguishable from "never
-- looked" purely by rank_checked_at being non-NULL. Never write a partial row.
ALTER TABLE coachbuild.my_account
  -- "IRON".."CHALLENGER", uppercase, exactly as Riot spells it. NULL = unranked
  -- (when rank_checked_at is set) or unknown (when it is not).
  ADD COLUMN IF NOT EXISTS rank_tier text,
  -- "I".."IV". Riot sends "I" for MASTER/GRANDMASTER/CHALLENGER, where it is
  -- meaningless -- stored verbatim, and the UI is told not to render it for
  -- those tiers rather than this column lying about what Riot said.
  ADD COLUMN IF NOT EXISTS rank_division text,
  ADD COLUMN IF NOT EXISTS rank_lp integer,
  ADD COLUMN IF NOT EXISTS rank_wins integer,
  ADD COLUMN IF NOT EXISTS rank_losses integer,
  ADD COLUMN IF NOT EXISTS rank_checked_at timestamptz,
  ADD COLUMN IF NOT EXISTS rank_attempted_at timestamptz;
