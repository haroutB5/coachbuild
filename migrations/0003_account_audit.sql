-- Adds resumability bookkeeping for scripts/audit-accounts.mjs (round 6,
-- 2026-07-10 — Bwipo/Zeus stale-account bug). The audit fleet run is
-- expected to take 30-60 min across ~1-2k accounts; last_audited_at lets a
-- restarted/resumed run skip accounts already checked today instead of
-- re-spending Riot API budget on them, ordered ASC NULLS FIRST same as the
-- existing last_fetched_at index.
ALTER TABLE coachbuild.pro_accounts ADD COLUMN IF NOT EXISTS last_audited_at timestamptz;

CREATE INDEX IF NOT EXISTS pro_accounts_last_audited_idx
  ON coachbuild.pro_accounts (last_audited_at ASC NULLS FIRST);
