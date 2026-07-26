-- 0016 — cooldown/lease columns for the prostage timeline compute path
-- (2026-07-26 audit fix, P1-3 security: "/api/prostage/timeline is the worst
-- unauthenticated cost amplifier").
--
-- WHY. GET /api/prostage/timeline has no auth, no cooldown, no rate limit. On
-- `timeline_status IS NULL` it synchronously resolves + walks the lolesports
-- livestats feed (~750 outbound requests across the resolve + details walk +
-- ddragon, see lib/prostage/timeline.ts / resolveGame.ts). Worse, a
-- `transient` outcome persists NOTHING (correct taint discipline — see
-- migration 0005's header) so the very next identical request re-walks
-- everything from scratch, and a burst of CONCURRENT requests for the same
-- unresolved game each independently launch their own ~750-request walk.
--
-- `timeline_next_attempt_at` is a single mechanism covering both problems:
--   - In-flight de-dup: the route atomically claims a game by advancing this
--     column to `now() + a short lease` BEFORE starting the walk (an
--     UPDATE ... WHERE timeline_status IS NULL AND (timeline_next_attempt_at
--     IS NULL OR timeline_next_attempt_at <= now()) ... RETURNING). A
--     concurrent request loses the race (0 rows returned, thanks to Postgres
--     row-level locking re-evaluating the WHERE clause after the winner
--     commits) and bounces immediately WITHOUT touching the network.
--   - Cooldown: on a `transient` result the SAME column is set further out
--     (exponential backoff, see app/api/prostage/timeline/route.ts), so a
--     repeat request before that time also fails the claim and bounces.
--   - Self-healing: if the walk crashes or the function is killed mid-walk,
--     the lease simply expires and the row becomes claimable again — no
--     separate cleanup/unlock step needed.
--
-- CRITICAL: this does NOT touch the transient-vs-terminal taint discipline —
-- `timeline_status` stays NULL on a transient result exactly as before (the
-- audit's own "do not touch" list). `timeline_next_attempt_at` only ever
-- gates WHEN a NULL-status row may be re-attempted, never whether it's
-- allowed to be re-attempted at all.

ALTER TABLE coachbuild.prostage_matches
  ADD COLUMN IF NOT EXISTS timeline_next_attempt_at timestamptz;

-- Purely observational (exponential-backoff input + debuggability); not read
-- by any gating logic itself.
ALTER TABLE coachbuild.prostage_matches
  ADD COLUMN IF NOT EXISTS timeline_attempt_count integer NOT NULL DEFAULT 0;
