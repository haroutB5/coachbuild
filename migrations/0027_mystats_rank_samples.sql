-- 0027_mystats_rank_samples.sql -- the LP TIME SERIES behind "LP this session"
-- (spec docs/superpowers/specs/2026-08-20-session-record-lp-design.md §3).
--
-- WHY A NEW TABLE AND NOT A COLUMN. coachbuild.my_account (migration 0022)
-- already stores rank_tier / rank_division / rank_lp -- as a SINGLE CURRENT
-- VALUE that is OVERWRITTEN on every refresh. There is no history anywhere, and
-- Riot's match API does not return per-game LP change and never has. So the
-- only way to say what a session cost or earned is to hold two READINGS either
-- side of it and subtract them on an absolute ladder scale (lib/mystats/
-- ladder.ts). That needs a series, and a series needs its own table.
--
-- It also means LP can only ever be EXACT from the day capture ships. Every
-- session before that has no readings and renders a dash -- never a number
-- reconstructed from the win count, which would be invention rather than
-- estimation (spec §6).
--
-- WHY THE READING COMES FROM THE LCU, NOT RIOT. The shared Riot key is this
-- app's scarcest resource and going over its cap suspends every pipeline
-- (CLAUDE.md gotcha (d)); lib/mystats/rank.ts exists almost entirely to
-- conserve it. The League client is on the user's own machine and answers for
-- free, so the companion reads LP locally and POSTs it here. Sampling is dense
-- (app start, champ select, game end) precisely because the existing sources
-- are not: the /api/ingest/mystats cron runs once daily and page loads refresh
-- on a 30-minute TTL, which cannot bracket a two-hour sitting.
--
-- ── RETENTION SHIPS WITH THE TABLE. NOT LATER. ──────────────────────────────
--
-- Four tables reached production with no retention at all and that is a direct
-- contributor to the 2026-08-20 Neon compute-quota exhaustion (da26db9). This
-- table is not allowed to become the fifth, so its policy is stated here and
-- ENFORCED IN THE SAME CHANGE:
--
--   POLICY   a sample is deleted once it is older than RETENTION_DAYS
--            (lib/retention/prune.ts: FRESH_WINDOW_DAYS + RETENTION_GRACE_DAYS
--            = 90 + 7 = 97 days).
--   WHY THAT IS SAFE  the ONLY reader is app/api/mystats/summary/route.ts's
--            sessions block, whose sample query is bounded to
--            FRESH_WINDOW_DAYS. The prune predicate is therefore the strict
--            COMPLEMENT of the read predicate plus seven days of grace, both
--            derived from the same constant -- the identical invariant
--            lib/retention/prune.ts's header sets out, and the reason neither
--            number may be edited alone.
--   WHERE    lib/mystats/rankSample.ts, in the SAME statement that performs the
--            insert. Prune-on-write, not a scheduled task: the incident this
--            guards against was caused by an unattended scheduled task with a
--            bad cadence, and a table that is only written a few dozen times a
--            day can be kept bounded by the writer at no measurable cost. The
--            delete is scoped to the writing puuid, carries an explicit LIMIT,
--            and is served by the primary key below as an index range scan.
--
-- NOT REGISTERED IN lib/retention/prune.ts, deliberately. That module's batched
-- delete is generic over a TEXT/TEXT composite primary key -- it collects keys
-- and re-identifies rows via `unnest($1::text[], $2::text[])`. This table's
-- second key column is a timestamptz, and `timestamptz = text` has no operator
-- in Postgres, so registering it there would fail at runtime on the first prune
-- rather than at review time. Extending that machinery for one table would put
-- three live ingest pipelines at risk to save a four-line statement.
--
-- ── SIZE ────────────────────────────────────────────────────────────────────
--
-- ~60 bytes per row and roughly 20-40 rows a day (three captures per game),
-- i.e. under 1 MB at the 97-day steady state. This table is not a storage
-- concern; it is bounded anyway because "small enough not to matter" is exactly
-- what was assumed about the four tables that were not.

-- One reading of the account's ranked-solo standing at one instant.
--
-- ALL THREE RANK COLUMNS ARE NULLABLE TOGETHER. A successful read of an
-- UNRANKED account is a real observation and is stored with all three null --
-- the same convention migration 0022 uses. lib/mystats/ladder.ts refuses to
-- place such a reading on the ladder, so it is skipped when bracketing a
-- session rather than being scored as zero LP (which would produce a delta of
-- a couple of thousand points that looks like data).
--
-- cumulative_lp is Riot's own absolute ladder integer from the LCU. It is
-- nullable because league-v4 (the cron/page source) does not return it; those
-- rows deliberately fall back to lib/mystats/ladder.ts at read time.
--
-- PRIMARY KEY (puuid, observed_at) IS THE IDEMPOTENCY GUARANTEE AND THE INDEX.
-- The companion captures on app start, champ select and game end, and it
-- retries; POST /api/mystats/rank-sample must never 500 on a duplicate, so the
-- write is an ON CONFLICT DO NOTHING against this key. The spec asks for an
-- index on (puuid, observed_at DESC) -- that index IS this primary key: a btree
-- is scannable in both directions, so the descending read is already served and
-- a second index would only spend storage in the migration whose whole point is
-- not to.
CREATE TABLE IF NOT EXISTS coachbuild.my_rank_samples (
  puuid text NOT NULL,
  observed_at timestamptz NOT NULL,
  tier text,
  division text,
  lp integer,
  cumulative_lp integer,
  -- 'companion' | 'cron' | 'page'. Which capture produced this reading, so a
  -- future question about sampling density has an answer without a join.
  -- Validated as an allowlist at the API boundary (lib/mystats/rankSample.ts):
  -- an unrecognised source is REFUSED rather than stored, because a value
  -- nobody can interpret is worse than a rejected write.
  source text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (puuid, observed_at)
);

-- WHY recorded_at EXISTS ALONGSIDE observed_at, and why they are not redundant:
--   observed_at  -- when the LCU was READ. Supplied by the companion, on the
--                   user's clock. It is the axis every session bracket is
--                   measured on, because it is the only one that can be
--                   compared against a game's start and end.
--   recorded_at  -- when the SERVER stored it. Database clock, never supplied.
-- Splitting them is what makes a clock-skew or delayed-retry investigation
-- possible at all: with one column, a machine whose clock is an hour out is
-- indistinguishable from a sample that took an hour to arrive, and the first
-- silently corrupts every LP figure while the second is harmless. The API
-- refuses observed_at values in the future or absurdly far in the past for the
-- same reason; this column is how that rule can be audited afterwards.
