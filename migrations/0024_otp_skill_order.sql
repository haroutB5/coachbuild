-- OTP timeline-backed skill order (nullable by design).
-- Existing rows remain NULL: they were ingested without a timeline and must
-- render as not recorded until the capped featured backfill reaches them.
ALTER TABLE coachbuild.otp_matches
  ADD COLUMN IF NOT EXISTS skill_order jsonb;
