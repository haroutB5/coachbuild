-- 0018_otp_featured.sql — the ONE one-trick we feature per champion.
--
-- The OTP section used to average eight accounts per champion into a consensus.
-- User directive 2026-07-29: show a single named player instead, the best-ranked
-- genuine one-trick, with their real build combinations and how often they build
-- each item. An average of eight players is a build nobody actually plays; one
-- player's own spread is something you can copy.
--
-- Selection lives in lib/otp/onetricks.ts (LP order among accounts the source
-- flags as one-tricks, minimum 150 games). This table stores the ANSWER plus the
-- evidence for it, so the UI can show WHY this account and not another.
--
-- `puuid` is Riot's, resolved through account-v1 from game_name + tag_line. The
-- id in onetricks.gg's own URLs is site-scoped and returns
-- "Bad Request - Exception decrypting" from Riot, exactly like op.gg's.
--
-- `match_routing` is stored because it is NOT derivable from the server label:
-- Phanta #107 resolves as a NA account but plays on EU, so a lookup that assumed
-- americas found zero matches and looked like an empty history. Probe once, then
-- remember.

CREATE TABLE IF NOT EXISTS coachbuild.otp_featured (
  champion_id          integer PRIMARY KEY,
  puuid                text        NOT NULL,
  game_name            text        NOT NULL,
  tag_line             text        NOT NULL,
  -- Platform label as the source shows it (EUW1, NA1, KR).
  server               text,
  -- Riot regional routing where this account's matches actually live.
  match_routing        text,
  tier                 text,
  lp                   integer,
  -- Share of the account's games that are on this champion, 0-100.
  champion_share_pct   integer,
  -- Games on the champion, per the source. Not the count we have stored.
  source_games         integer,
  winrate_pct          integer,
  kda                  numeric(5,2),
  -- Position in the source's list, kept so a surprising pick can be traced.
  source_rank          integer,
  refreshed_at         timestamptz NOT NULL DEFAULT now()
);

-- The featured account's own games are stored in the existing otp_matches table
-- (keyed match_id + puuid), so nothing new is needed for them. This index makes
-- "every stored game for this account on this champion" a single scan, which is
-- the only read the build-rate aggregation performs.
CREATE INDEX IF NOT EXISTS otp_matches_puuid_champion_idx
  ON coachbuild.otp_matches (puuid, champion_id);
