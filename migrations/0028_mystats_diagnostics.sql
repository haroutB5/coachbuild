-- 0028_mystats_diagnostics.sql -- bounded companion diagnostics uploads.
--
-- RETENTION SHIPS WITH THE TABLE. POST /api/mystats/diagnostics inserts the
-- new upload and removes everything beyond the five most recent uploads for
-- that puuid in the SAME data-modifying-CTE statement. Keeping the policy in
-- the writer makes every successful write repair its own account's bound and
-- avoids a second database round trip or an unattended pruning job.
--
-- uploaded_at is assigned by the database, never accepted from the companion.
-- That makes "most recent" a server-controlled ordering rather than something
-- a client clock (or a malformed request) can move indefinitely into the future.
CREATE TABLE IF NOT EXISTS coachbuild.my_diagnostics (
  puuid text NOT NULL,
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  body text NOT NULL,
  -- Closed vocabulary: POST validation accepts only 'companion'.
  source text NOT NULL
);

CREATE INDEX IF NOT EXISTS my_diagnostics_puuid_uploaded_at_idx
  ON coachbuild.my_diagnostics (puuid, uploaded_at DESC);
