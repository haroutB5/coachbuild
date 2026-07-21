-- "My Stats" — personal match tracker backend for ONE fixed personal account
-- (design: Riot match-v5 history BACKFILL, not live recording). Deliberately
-- a SEPARATE identity model from coachbuild.pro_accounts (that table is FK'd
-- to coachbuild.pros — a roster of tracked pros; this is a single fixed
-- account with no roster concept, resolved once via account-v1 by-riot-id
-- and cached here so the ingest never re-resolves it on every run). See
-- lib/mystats/** for the pipeline, CLAUDE.md's "My Stats" section for the
-- feature story.

CREATE TABLE IF NOT EXISTS coachbuild.my_account (
  id smallint PRIMARY KEY DEFAULT 1,
  riot_id text NOT NULL,           -- "gameName#tagLine", e.g. "MunsterHunter#EUW"
  puuid text NOT NULL,
  region text NOT NULL,            -- lolpros/regionMap server string, e.g. "EUW"
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (id = 1)                   -- single-row table -- exactly one personal account
);

-- One row per personal match. Privacy posture (deliberate, matches
-- CLAUDE.md's compliance note): stores ONLY champion ids + win/role for both
-- sides -- never the enemy participant's name/puuid, even though the raw
-- Riot response has it. queue_id is stored for EVERY match regardless of
-- queue (420/440/400/430 ranked+normal are the primary target, but ARAM/etc.
-- are kept too, not dropped -- see lib/mystats/ingest.ts's header comment for
-- why the ids fetch is queue-unfiltered) so callers can filter by queue
-- themselves. role follows the DisplayRoleId convention (lib/pro/types.ts):
-- 0=TOP 1=JUNGLE 2=MIDDLE 3=BOTTOM 4=UTILITY, -1=unresolved (ARAM, remakes,
-- or any teamPosition Riot leaves blank) -- rows are NEVER dropped for an
-- unresolved role, only opp_champion_id degrades to null.
CREATE TABLE IF NOT EXISTS coachbuild.my_matches (
  match_id text PRIMARY KEY,
  queue_id smallint NOT NULL,
  game_creation timestamptz NOT NULL,
  patch text NOT NULL,
  champion_id integer NOT NULL,
  role smallint NOT NULL,          -- 0-4 app lane convention, -1 = unknown/unresolved
  opp_champion_id integer,         -- lane opponent (same teamPosition, other team); null when role unresolved or no clean 1:1 opponent
  win boolean NOT NULL,
  ingested_at timestamptz NOT NULL DEFAULT now()
);

-- Backs GET /api/mystats/summary and the /api/draft/recommend personal-record
-- extension (lib/draft/recommend.ts) -- both filter on exactly this triple.
CREATE INDEX IF NOT EXISTS my_matches_champ_role_opp_idx
  ON coachbuild.my_matches (champion_id, role, opp_champion_id);
CREATE INDEX IF NOT EXISTS my_matches_game_creation_idx
  ON coachbuild.my_matches (game_creation DESC);

-- One-row persisted cursor for the BACKFILL walk only (mirrors
-- coachbuild.draft_ingest_cursor's pattern, migration 0010) -- the daily
-- incremental cron always re-checks from the front of match history instead
-- (see lib/mystats/ingest.ts) and never reads/writes this table. Lets a
-- crashed/interrupted backfill run (scripts/ingest-mystats.mjs) resume
-- without re-fetching pages already processed.
CREATE TABLE IF NOT EXISTS coachbuild.my_ingest_cursor (
  id smallint PRIMARY KEY DEFAULT 1,
  next_start integer NOT NULL DEFAULT 0,
  backfill_done boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (id = 1)
);

INSERT INTO coachbuild.my_ingest_cursor (id, next_start, backfill_done)
VALUES (1, 0, false)
ON CONFLICT (id) DO NOTHING;
