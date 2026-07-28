-- OTP (one-trick) builds — the "what do the people who SPAM this champion
-- build" section on the Builds page (user request, 2026-07-28).
--
-- WHY A SEPARATE IDENTITY MODEL, not more rows in coachbuild.pro_accounts:
-- pro_accounts is FK'd to coachbuild.pros (a roster of tracked professional
-- players, discovered from lolpros.gg and keyed by person). An OTP is not a
-- person we track — it is "whoever currently sits in op.gg's top-10 for this
-- champion in this region," a champion-scoped, churning list. Folding them
-- into pro_accounts would (a) corrupt every existing "pro" surface with
-- non-pros and (b) make CLAUDE.md's pro/soloq/prostage source contract a lie.
-- Same reasoning migration 0012 used to keep my_account out of pro_accounts.
--
-- PRIVACY POSTURE matches the rest of the app: these are public ladder
-- identities (op.gg publishes the leaderboard), and we store the riot id
-- because account-v1 needs it to re-resolve a puuid. Nothing is stored about
-- the other 9 players in any match — see otp_matches' column list.

-- One row per (champion, account). The SAME account legitimately appears
-- once per champion they one-trick, which is why champion_id is in the key:
-- their Viktor games and their Ahri games are different evidence and must
-- not overwrite each other's leaderboard standing.
CREATE TABLE IF NOT EXISTS coachbuild.otp_accounts (
  champion_id      int  NOT NULL,
  puuid            text NOT NULL,           -- REAL Riot puuid, re-resolved via account-v1
  region           text NOT NULL,           -- regionMap server string, e.g. "EUW" / "KR"
  game_name        text NOT NULL,
  tag_line         text NOT NULL,
  leaderboard_rank int,                     -- op.gg position at discovery time, 1-based
  champ_play       int  NOT NULL DEFAULT 0, -- op.gg's own games-on-this-champion count
  champ_win        int  NOT NULL DEFAULT 0,
  tier             text,                    -- e.g. "CHALLENGER"; null when op.gg didn't say
  active           boolean NOT NULL DEFAULT true,
  discovered_at    timestamptz NOT NULL DEFAULT now(),
  last_fetched_at  timestamptz,             -- last match-ingest pass, NULL = never fetched
  PRIMARY KEY (champion_id, puuid)
);

-- Match-ingest ordering: never-fetched accounts first, then stalest. Mirrors
-- lib/pro/ingestMatches.ts's `last_fetched_at ASC NULLS FIRST` walk.
CREATE INDEX IF NOT EXISTS otp_accounts_fetch_order_idx
  ON coachbuild.otp_accounts (champion_id, last_fetched_at ASC NULLS FIRST)
  WHERE active;

-- One row per (match, account). Column set is deliberately the subset of
-- coachbuild.pro_matches that a match-v5 MATCH response alone can fill:
-- purchase_order/skill_order are NOT here because they require a second
-- match-v5 TIMELINE call per game, which would double an already
-- rate-limit-bound ingest (lib/pro/pacer.ts serialises every Riot call in
-- the process at 1.3s). The consensus aggregation this table feeds
-- (components/hextech/proConsensus.ts) reads final_items/runes/spells and
-- derives starting items from an allowlist — it never touches purchase_order
-- — so the timeline would buy nothing this feature renders. The API layer
-- emits [] for both fields, exactly as prostage rows already do.
CREATE TABLE IF NOT EXISTS coachbuild.otp_matches (
  match_id      text NOT NULL,
  puuid         text NOT NULL,
  champion_id   int  NOT NULL,
  champion_name text NOT NULL,
  role          int  NOT NULL,   -- DisplayRoleId: 0=TOP 1=JGL 2=MID 3=BOT 4=SUP
  patch         text NOT NULL,
  win           boolean NOT NULL,
  kills         int  NOT NULL DEFAULT 0,
  deaths        int  NOT NULL DEFAULT 0,
  assists       int  NOT NULL DEFAULT 0,
  game_creation timestamptz NOT NULL,
  game_duration_sec int NOT NULL DEFAULT 0,
  spells        jsonb,
  final_items   jsonb,
  trinket       int,
  runes         jsonb,
  ingested_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (match_id, puuid)
);

-- The read path is always (champion, role, newest first) within the fresh
-- window — see app/api/otp/route.ts.
CREATE INDEX IF NOT EXISTS otp_matches_champ_role_recent_idx
  ON coachbuild.otp_matches (champion_id, role, game_creation DESC);

-- Per-champion discovery bookkeeping. Discovery (the op.gg leaderboard call)
-- and match ingest advance independently: the roster of one-tricks churns
-- slowly, their games do not.
CREATE TABLE IF NOT EXISTS coachbuild.otp_champion_cursor (
  champion_id        int PRIMARY KEY,
  last_discovered_at timestamptz,
  -- Advances on EVERY attempt, not only on a successful write — the same P2
  -- lesson lib/prostage/tournaments.ts's orderByStaleness documents: a
  -- staleness stamp that only moves on success pins a finished/failing
  -- champion at "stalest" forever and starves every other champion behind it.
  last_attempted_at  timestamptz
);
