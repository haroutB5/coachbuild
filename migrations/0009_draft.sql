-- "Draft" champ-select recommender — champion-level matchup + baseline stats,
-- sourced from u.gg's stats2 CDN (see lib/draft/ugg.ts). Scoped to ONE tier
-- (10 = Emerald+) and world region for v1 (see _research/draft-feature-plan.md
-- §1/§9) — tier/role columns are kept anyway so a future multi-tier ship never
-- needs a migration, just a wider WHERE.
--
-- patch is the DISPLAY label ("16.14"), NOT u.gg's own "16_14" URL segment —
-- see lib/draft/patch.ts for the segment<->label conversion. Retention: only
-- the last 2 distinct patch labels are kept, pruned by lib/draft/ingest.ts on
-- the FINAL cursor of a bootstrap/refresh walk only (never mid-fill, so a
-- partially-ingested new patch never evicts the last fully-populated one).
--
-- role is the APP convention (0=TOP 1=JUNGLE 2=MID 3=BOT 4=SUPPORT) — u.gg's
-- own role ids (top=4 jungle=1 mid=5 adc=3 support=2) are mapped to this at
-- ingest time (lib/draft/ugg.ts), never stored raw.

CREATE TABLE IF NOT EXISTS coachbuild.draft_matchup (
  patch      text NOT NULL,
  tier       smallint NOT NULL,
  role       smallint NOT NULL,
  champ_id   integer NOT NULL,
  opp_id     integer NOT NULL,
  wins       integer NOT NULL,
  games      integer NOT NULL,
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (patch, tier, role, champ_id, opp_id),
  CHECK (wins <= games),
  CHECK (games >= 0)
);

CREATE TABLE IF NOT EXISTS coachbuild.draft_champ_stats (
  patch      text NOT NULL,
  tier       smallint NOT NULL,
  role       smallint NOT NULL,
  champ_id   integer NOT NULL,
  winrate    real,
  pickrate   real,
  banrate    real,
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (patch, tier, role, champ_id)
);
