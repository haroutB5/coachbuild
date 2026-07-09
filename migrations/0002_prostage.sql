-- coachbuild pro-stage (official esports) match-history schema (Phase 2).
-- Separate identity model from coachbuild.pro_matches: no puuid — keyed by
-- (game_id, player_link) since Leaguepedia's Cargo API has no Riot account
-- concept. Same `coachbuild` schema, never `public`.

CREATE TABLE IF NOT EXISTS coachbuild.prostage_matches (
  game_id text NOT NULL,
  player_link text NOT NULL,
  overview_page text NOT NULL,          -- Leaguepedia tournament wiki page, e.g. "LEC 2026 Summer"
  tournament_display text NOT NULL,     -- short display form of overview_page
  team text,
  champion_id integer NOT NULL,
  champion_name text NOT NULL,
  role smallint,                        -- 0=TOP 1=JUNGLE 2=MID 3=BOT 4=SUPPORT, nullable (Cargo Role can be blank)
  win boolean NOT NULL,
  kills integer NOT NULL,
  deaths integer NOT NULL,
  assists integer NOT NULL,
  game_datetime timestamptz NOT NULL,
  patch text,                           -- always NULL: confirmed absent from ScoreboardPlayers'
                                         -- real Cargo schema (live-verified 2026-07-09); kept
                                         -- nullable in case a future schema adds patch tracking
  spells jsonb NOT NULL,
  final_items jsonb NOT NULL,
  trinket integer,
  runes jsonb NOT NULL,                 -- same ProGameRunes shape as pro_matches.runes; empty arrays where unknown
  -- pro_id references coachbuild.pros(id), which is `text` (a lolpros uuid
  -- string, not a real Postgres uuid) — deviates from the brief's "uuid"
  -- wording to match the actual FK type already in migrations/0001_init.sql.
  pro_id text REFERENCES coachbuild.pros(id) ON DELETE SET NULL,
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (game_id, player_link)
);

CREATE INDEX IF NOT EXISTS prostage_matches_champ_idx
  ON coachbuild.prostage_matches (champion_id, game_datetime DESC);

CREATE INDEX IF NOT EXISTS prostage_matches_pro_idx
  ON coachbuild.prostage_matches (pro_id, game_datetime DESC);
