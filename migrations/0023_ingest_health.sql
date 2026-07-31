-- Last-run status for the ingest pipelines that run OUTSIDE Vercel and have
-- shipped silent failures before (CLAUDE.md gotchas (o)/(u): prostage's
-- Leaguepedia CargoExport leg and draft's u.gg walk are both Cloudflare-
-- blocked from Vercel's egress and run from Scheduled Tasks on this machine
-- instead — see scripts/ingest-prostage-scheduled.ps1 / ingest-draft-
-- scheduled.ps1). Both scripts already compute a per-run `errors` array and
-- set a non-zero exit code on failure, but until now that lived ONLY in a
-- rotating local log file nobody reads proactively — a run can fail for
-- days before anyone notices (this exact failure class cost weeks once, per
-- gotcha (o)). This table is the durable, queryable "did the last run
-- succeed" fact, one row per named ingest pipeline.
--
-- ok=false + last_error is a run that completed (possibly partially) but
-- reported at least one error/guard failure -- see lib/ingestHealth.ts's
-- recordIngestRun for exactly what each script counts as failure.
CREATE TABLE IF NOT EXISTS coachbuild.ingest_health (
  ingest text PRIMARY KEY,
  last_run_at timestamptz NOT NULL,
  last_success_at timestamptz,
  ok boolean NOT NULL,
  last_error text,
  last_error_at timestamptz
);
