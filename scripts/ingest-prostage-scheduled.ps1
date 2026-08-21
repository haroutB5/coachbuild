# CoachBuild pro-play (ScoreboardPlayers) refresh — Windows Task Scheduler entry point.
#
# WHY THIS RUNS HERE AND NOT ON VERCEL — live-verified 2026-07-25, both
# transports probed against production:
#   api.php               -> "You've exceeded your rate limit" on the FIRST call
#                            of a run (Vercel's shared datacenter IP pool).
#   Special:CargoExport   -> HTTP 403 (Cloudflare bot challenge — a TLS/JA3
#                            fingerprint block that headers cannot fix).
# So /api/ingest/prostage physically cannot land data from Vercel. Worse, until
# v0.52.0 it failed SILENTLY: an empty resolved-tournament list made the route
# answer HTTP 200 {rowsSeen:0, errors:[]}, indistinguishable from a healthy
# no-op. Pro-play data went stale for weeks (user report 2026-07-25: Caps's LEC
# Summer games missing; the split had started 07-24). This box is not blocked —
# same reasoning as CoachBuildDraftIngest / ingest-draft-scheduled.ps1.
#
# Scheduled cadence: every 3 hours. Pro games land throughout the day across
# LEC/LCK/LPL/LCS, and the run is cheap — CargoExport is paced 5s apart and the
# list is capped at MAX_TOURNAMENTS=7, so ~7 requests per run.
# Task name: CoachBuildProstageIngest
#   Status:  schtasks /query /tn CoachBuildProstageIngest
#   Run now: schtasks /run   /tn CoachBuildProstageIngest
#   Remove:  schtasks /delete /tn CoachBuildProstageIngest /f
#
# GOTCHA this file exists to encode (inherited from ingest-draft-scheduled.ps1):
# Task Scheduler's environment does NOT carry the interactive PATH, and this
# machine has a corporate node shadow ("MDXT Connect" node64) earlier in PATH
# than the real Node.js. Pin the real Node.js dir FIRST or tsx resolves against
# the wrong runtime.

$ErrorActionPreference = 'Continue'
# Self-locating: resolve the repo from this script's own location rather than a
# hardcoded user path, so the job survives a machine/username migration.
$repo = Split-Path -Parent $PSScriptRoot
$logDir = Join-Path $env:LOCALAPPDATA 'CoachBuild'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
$log = Join-Path $logDir 'prostage-ingest.log'

# Keep the log bounded (~1MB): keep the newest half when it grows past that.
if ((Test-Path $log) -and ((Get-Item $log).Length -gt 1MB)) {
    $text = Get-Content $log -Raw
    Set-Content $log $text.Substring([int]($text.Length / 2))
}

$env:Path = 'C:\Program Files\nodejs;' + $env:Path

# Point every ingest below at the REBUILT Neon project, or stop here. These
# scripts reach the database through scripts/_env.mjs, which fills only keys
# that are still undefined -- so with DATABASE_URL unset this wrapper silently
# inherited .env.local's OLD, matchday-shared, quota-exhausted project. That is
# a refusal, not a warning: see scripts/_cbnew-db.ps1.
. (Join-Path $PSScriptRoot '_cbnew-db.ps1') -Root $repo -LogPath $log
if (-not $CbnewDbResolved) { exit 78 }

Set-Location $repo

# -Encoding utf8 on BOTH writers: PS 5.1's bare *>> redirect writes UTF-16LE
# while Add-Content writes ANSI -- a mixed-encoding log that byte-oriented
# tools (tail, grep) render as garbage. One encoding, one log.
$stamp = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
Add-Content $log "[$stamp] prostage ingest starting" -Encoding utf8

# 1) LIVE lolesports feed FIRST — this is what makes "always up to date" true.
# Leaguepedia lags days-to-weeks (LPL Split 3 started 07-22 and still had zero
# rows on 07-25), so a Leaguepedia-only pipeline can never show today's games.
& npx tsx scripts/ingest-prostage-live.mjs 3 60 2>&1 | Out-File -FilePath $log -Append -Encoding utf8
Add-Content $log "live feed exit $LASTEXITCODE" -Encoding utf8

# 2) THEN Leaguepedia, which later supersedes each live row with a richer one
# (items/runes). The read path hides the live row once its richer twin exists —
# see lib/prostage/liveIngest.ts's reconciliation note.
#
# --via-export is REQUIRED, not optional: it selects Special:CargoExport (light
# rate limit) AND the curl-subprocess transport, which is the only combination
# that gets past Cloudflare from any environment we have. The default api.php
# path would just re-hit the rate limit that broke the cron.
& npx tsx scripts/ingest-prostage.mjs --via-export 2>&1 | Out-File -FilePath $log -Append -Encoding utf8
$code = $LASTEXITCODE

$stamp = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
Add-Content $log "[$stamp] prostage ingest finished, exit $code" -Encoding utf8
exit $code
