-- Tracks the last time each prostage tournament was ATTEMPTED (a Cargo pass
-- was run for it), separate from "last successfully wrote a row"
-- (coachbuild.prostage_matches.ingested_at). lib/prostage/tournaments.ts's
-- orderByStaleness previously proxied staleness off max(ingested_at), which
-- never advances on a zero-new-rows pass (a finished tournament with nothing
-- new to ingest, or a ratelimited/errored Cargo call) — that left the same
-- tournament pinned "stalest" forever, winning the cursorless cron's
-- cursor=0 every single day and starving every other tournament in the
-- rotation. lib/prostage/ingest.ts now upserts a row here at the START of
-- every tournament pass (before the Cargo call), so the stamp advances
-- regardless of whether the pass finds new rows — see runProstageIngest.
CREATE TABLE IF NOT EXISTS coachbuild.prostage_ingest_attempts (
  overview_page text PRIMARY KEY,
  attempted_at timestamptz NOT NULL
);
