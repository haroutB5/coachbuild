-- coachbuild pro-match-history schema (Phase 1). Dedicated `coachbuild`
-- schema on a shared Neon instance — never touch `public` or any other schema.

CREATE SCHEMA IF NOT EXISTS coachbuild;

CREATE TABLE IF NOT EXISTS coachbuild.pros (
  id text PRIMARY KEY,                 -- lolpros uuid
  name text NOT NULL,
  slug text NOT NULL,
  team text,
  role smallint,                       -- 0=TOP 1=JUNGLE 2=MID 3=BOT 4=SUPPORT
  country text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS coachbuild.pro_accounts (
  puuid text PRIMARY KEY,
  pro_id text NOT NULL REFERENCES coachbuild.pros(id) ON DELETE CASCADE,
  region text NOT NULL,                -- lolpros server string, e.g. "EUW"
  riot_id text NOT NULL,               -- "gameName#tagLine"
  active boolean NOT NULL DEFAULT true,-- false = puuid unresolved against our Riot key
  last_fetched_at timestamptz,
  last_match_ts bigint,                -- epoch ms of newest ingested match
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pro_accounts_pro_id_idx ON coachbuild.pro_accounts (pro_id);
CREATE INDEX IF NOT EXISTS pro_accounts_last_fetched_idx ON coachbuild.pro_accounts (last_fetched_at ASC NULLS FIRST);

CREATE TABLE IF NOT EXISTS coachbuild.pro_matches (
  match_id text NOT NULL,
  puuid text NOT NULL REFERENCES coachbuild.pro_accounts(puuid) ON DELETE CASCADE,
  pro_id text NOT NULL REFERENCES coachbuild.pros(id) ON DELETE CASCADE,
  champion_id integer NOT NULL,
  champion_name text NOT NULL,
  role smallint NOT NULL,
  patch text NOT NULL,
  win boolean NOT NULL,
  kills integer NOT NULL,
  deaths integer NOT NULL,
  assists integer NOT NULL,
  game_creation timestamptz NOT NULL,
  game_duration_sec integer NOT NULL,
  spells jsonb NOT NULL,
  final_items jsonb NOT NULL,
  trinket integer,
  purchase_order jsonb NOT NULL,
  skill_order jsonb NOT NULL,
  runes jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (match_id, puuid)
);

CREATE INDEX IF NOT EXISTS pro_matches_champ_role_idx
  ON coachbuild.pro_matches (champion_id, role, game_creation DESC);
