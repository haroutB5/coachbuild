-- 0019_otp_featured_deep.sql — state for the CONTINUOUS priority-driven deep
-- walk of featured one-tricks (scripts/ingest-otp-priority.mjs, 2026-07-29).
--
-- WHY ANY NEW STATE AT ALL. The obvious design is stateless: re-fetch the
-- account's in-window id list every pass, diff it against otp_matches, fetch
-- only the missing ones. That is idempotent and resumable for free — but it
-- re-fetches every REJECTED match forever. The featured Ahri one-trick has 348
-- ranked games in the 90-day window and 232 of them on Ahri; the other 116 are
-- their off-champion games, they are not stored anywhere, and a stateless diff
-- pays a Riot call for each of them on EVERY pass. Across 42 champions that is
-- thousands of calls per sweep spent re-learning the same "not this champion".
--
-- So the walk records what it has LOOKED AT, not only what it kept.
--
-- IDEMPOTENCE + RESUMABILITY are what these two tables buy, and they buy it
-- from the DB rather than from a local file, so killing the process mid-run
-- loses at most the matches of one in-flight unit (<= 6) and duplicates
-- nothing: every insert is ON CONFLICT DO NOTHING and the cursor is persisted
-- after each unit.

-- ── What we have already asked Riot about ───────────────────────────────────
-- One row per (account, match) EXAMINED — stored or not. `stored` records the
-- outcome so a human can tell "we fetched 348 and kept 232" from the table
-- alone, without inferring it from a join that would silently change meaning
-- if otp_matches were ever pruned.
--
-- Keyed on (puuid, match_id) and NOT on champion: a match is a fact about an
-- ACCOUNT, and the same account can legitimately be the featured one-trick for
-- more than one champion. Keying on champion would make the same match get
-- re-fetched once per champion that account is featured for.
CREATE TABLE IF NOT EXISTS coachbuild.otp_featured_scanned (
  puuid      text NOT NULL,
  match_id   text NOT NULL,
  -- The champion whose walk paid for this call. Provenance only; the dedup key
  -- deliberately excludes it (see above).
  worked_for_champion_id int,
  -- The champion the match turned out to be on, once known. NULL when the
  -- match could not be extracted at all.
  match_champion_id      int,
  stored     boolean NOT NULL DEFAULT false,
  scanned_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (puuid, match_id)
);

-- The only read shape: "of these N ids for this account, which have I seen?"
CREATE INDEX IF NOT EXISTS otp_featured_scanned_puuid_idx
  ON coachbuild.otp_featured_scanned (puuid);

-- Everything already in otp_matches was, by definition, examined and kept.
-- Without this backfill the first pass would re-fetch all 13,105 existing rows
-- (~4.7 hours of paced Riot time) to learn nothing.
--
-- THIS BACKFILL IS A SNAPSHOT, AND A SNAPSHOT IS NOT ENOUGH ON ITS OWN.
-- CoachBuildOtpIngest and the featured refresh keep writing otp_matches after
-- this runs, and every row they add is a match we hold but have no scanned row
-- for — i.e. one wasted Riot call the next time the walk sees that id.
-- Measured immediately after this migration applied (2026-07-29): otp_matches
-- had already moved to 14,189 against the 13,105 captured here, a 1,084-row gap
-- opened by the ingest run that was live at the time.
-- scripts/ingest-otp-priority.mjs therefore repeats this same INSERT, scoped to
-- the id page it is about to consider, on every page read. Do not delete that
-- as redundant with this — the other jobs never stop writing.
INSERT INTO coachbuild.otp_featured_scanned (puuid, match_id, match_champion_id, stored, scanned_at)
SELECT puuid, match_id, min(champion_id), true, min(ingested_at)
FROM coachbuild.otp_matches
GROUP BY puuid, match_id
ON CONFLICT (puuid, match_id) DO NOTHING;

-- ── How far through an account's history we have walked ─────────────────────
-- Riot's id endpoint pages with start/count over a NEWEST-FIRST list, so the
-- walk is a single offset. Persisted per champion because the priority order
-- re-derives every pass and can move on to a different champion at any unit
-- boundary; the offset has to survive that.
CREATE TABLE IF NOT EXISTS coachbuild.otp_featured_deep_cursor (
  champion_id      int PRIMARY KEY,
  -- WHICH ACCOUNT this progress describes. The featured refresh can replace
  -- the one-trick for a champion (onetricks.gg's ranking churns), and an
  -- offset into a DIFFERENT account's history is not a smaller offset — it is
  -- a meaningless one. A puuid mismatch resets the walk rather than resuming
  -- into the wrong history.
  puuid            text NOT NULL,
  ids_offset       int  NOT NULL DEFAULT 0,
  -- True once a short id page proved the 90-day window is exhausted for this
  -- account. Cleared when the walk wraps to look for newly played games.
  window_exhausted boolean NOT NULL DEFAULT false,
  last_exhausted_at timestamptz,
  last_worked_at    timestamptz,
  scanned_total     int NOT NULL DEFAULT 0,
  stored_total      int NOT NULL DEFAULT 0
);
