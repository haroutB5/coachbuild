# CoachBuild Draft data refresh — Windows Task Scheduler entry point.
# Runs the full u.gg matchup/rankings ingest (scripts/ingest-draft.mjs) from
# this machine because Vercel's egress is Cloudflare-blocked at u.gg (see
# HANDOFF: the daily Vercel cron cannot land fresh data; this box's
# curl-transport path is the one that works). Idempotent upserts + cursor
# resume make re-runs safe; polite pacing keeps the walk ~30 min.
#
# Scheduled cadence: Mon + Thu 09:00 (research cadence: patch-change + 2x/week;
# LoL patches usually land Wednesdays, so Thu catches the new patch fast).
# Task name: CoachBuildDraftIngest  (schtasks /query /tn CoachBuildDraftIngest)
#
# GOTCHA this file exists to encode: Task Scheduler's environment does not
# carry the interactive PATH, and this machine has a corporate node shadow
# ("MDXT Connect" node64 earlier in PATH than the real Node.js). Pin the real
# Node.js dir FIRST or tsx resolves against the wrong runtime.

$ErrorActionPreference = 'Continue'
$repo = 'C:\Users\Harout\urgot-travel-bundle-2026-06-18\AI\coachbuild'
$logDir = Join-Path $env:LOCALAPPDATA 'CoachBuild'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
$log = Join-Path $logDir 'draft-ingest.log'

# Keep the log bounded (~1MB): keep the newest half when it grows past that.
if ((Test-Path $log) -and ((Get-Item $log).Length -gt 1MB)) {
    $text = Get-Content $log -Raw
    Set-Content $log $text.Substring([int]($text.Length / 2))
}

$env:Path = 'C:\Program Files\nodejs;' + $env:Path
Set-Location $repo

# -Encoding utf8 on BOTH writers: PS 5.1's bare *>> redirect writes UTF-16LE
# while Add-Content writes ANSI -- a mixed-encoding log that byte-oriented
# tools (tail, grep) render as garbage. One encoding, one log.
$stamp = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
Add-Content $log "[$stamp] draft ingest starting" -Encoding utf8
& npx tsx scripts/ingest-draft.mjs 2>&1 | Out-File -FilePath $log -Append -Encoding utf8
$code = $LASTEXITCODE
$stamp = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
Add-Content $log "[$stamp] draft ingest finished, exit $code" -Encoding utf8
exit $code
