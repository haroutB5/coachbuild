# CoachBuild solo-queue (Riot match-v5) sweep — Windows Task Scheduler entry point.
#
# WHY THIS EXISTS — measured live 2026-07-25:
#   coachbuild.pro_accounts holds 2801 accounts.
#     2440 had NEVER been fetched.
#        1 had been fetched in the previous 2 days.
#   The Vercel path walks `batch = 5` accounts per invocation and returns a
#   cursor for an external pinger to drain — but nothing pings it, and the Hobby
#   cron fires once every 2 days. 5 accounts / 2 days against 2801 accounts is a
#   ~3-YEAR full cycle. That is why users saw "Bwipo's soloQ isn't up to date"
#   and "no games for TheShy": their turn had not come up, and never would.
#
# Unlike pro-stage (Leaguepedia, Cloudflare-blocked from Vercel — see
# ingest-prostage-scheduled.ps1), Riot's API is reachable from Vercel. The
# blocker here is THROUGHPUT, not access: a 60s serverless budget and a daily
# Hobby cron cannot drain thousands of accounts. Running locally removes both
# limits — the script walks its own cursor to completion, paced by the Riot key.
#
# The on-demand path (/api/pros/refresh, wired into the Pro Players screen)
# covers "the pro I am looking at RIGHT NOW". This sweep covers everyone else,
# so the app is broadly warm rather than cold for 87% of the roster.
#
# Scheduled cadence: every 6 hours.
# Task name: CoachBuildMatchIngest
#   Status:  schtasks /query /tn CoachBuildMatchIngest
#   Run now: schtasks /run   /tn CoachBuildMatchIngest
#   Remove:  schtasks /delete /tn CoachBuildMatchIngest /f
#
# GOTCHA (shared with the other two scheduled scripts): Task Scheduler does not
# inherit the interactive PATH, and this machine has a corporate node64 shadow
# ahead of real Node. Pin C:\Program Files\nodejs FIRST or tsx picks the wrong
# runtime.

$ErrorActionPreference = 'Continue'
$repo = Split-Path -Parent $PSScriptRoot
$logDir = Join-Path $env:LOCALAPPDATA 'CoachBuild'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
$log = Join-Path $logDir 'match-ingest.log'

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

$stamp = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
Add-Content $log "[$stamp] soloq sweep starting" -Encoding utf8
& npx tsx scripts/ingest-matches.mjs 2>&1 | Out-File -FilePath $log -Append -Encoding utf8
$code = $LASTEXITCODE
$stamp = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
Add-Content $log "[$stamp] soloq sweep finished, exit $code" -Encoding utf8
exit $code
