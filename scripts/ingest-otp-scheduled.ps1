# CoachBuild OTP (one-trick) refresh — Windows Task Scheduler entry point.
#
# WHY THE DISCOVERY HALF RUNS HERE AND NOT ON VERCEL: discovery calls op.gg's
# undocumented MCP endpoint, whose reachability from Vercel egress is
# UNVERIFIED. This repo has already lost weeks of pro-play ingest to exactly
# that assumption — Leaguepedia turned out to be rate-limited/Cloudflare-403'd
# from Vercel's shared datacenter IPs, and the route failed SILENTLY with a
# clean HTTP 200 (see ingest-prostage-scheduled.ps1's header and CLAUDE.md
# gotcha (o)). So the same split applies: the half that is known to work from
# Vercel (Riot match-v5) stays on /api/ingest/otp, and discovery runs from this
# box, where op.gg is confirmed reachable.
#
# Scheduled cadence: every 6 hours, 30 champions per run.
#
# THIS SLOT NOW RUNS TWO JOBS, SEQUENTIALLY: the consensus walk below, then
# ingest-otp-featured-scheduled.ps1 (the onetricks.gg featured one-trick
# refresh, 20 champions, ~24 min). They are chained rather than given separate
# triggers so that total Riot concurrency stays at one BY CONSTRUCTION — see
# that script's header for the measured numbers behind the decision. A
# wall-clock budget below skips the featured half if the consensus walk
# overruns, so a slow run degrades coverage instead of colliding with
# CoachBuildMatchIngest.
#
# MEASURED, not guessed (2026-07-28): a 6-champion run took 22m42s wall clock,
# i.e. ~3.8 min/champion, bound by lib/pro/pacer.ts's 1.3s Riot floor. So:
#   6/run  = 24 champions/day  -> ~7 days for the ~170-champion roster
#   30/run = 120 champions/day -> full coverage in ~1.5 days, then a rolling
#            re-freshness cycle of ~1.5 days (the walk is stalest-first, so once
#            every champion has a cursor row it naturally re-walks oldest-first)
#
# 30 is the ceiling the CONTENTION WINDOW allows, and that is what caps it, not
# ambition: 30 x 3.8 min = ~114 min, against a 3h gap to the neighbouring
# CoachBuildMatchIngest slot. Do not raise this past ~40 (152 min) without
# re-checking that gap — two concurrent Riot-calling jobs double the request
# rate against one key budget, and exceeding the cap SUSPENDS the key for every
# surface in the app (CLAUDE.md gotcha (d)).
#
# DO NOT schedule this to overlap CoachBuildMatchIngest. The pacer only
# serialises calls WITHIN one process, so two concurrent Riot-calling jobs
# double the request rate against one key budget, and exceeding that cap
# SUSPENDS the key for every surface in the app (CLAUDE.md gotcha (d)).
# CoachBuildMatchIngest runs every 6h; offset this one by 3h.
#
# Task name: CoachBuildOtpIngest
#   Status:  schtasks /query /tn CoachBuildOtpIngest
#   Run now: schtasks /run   /tn CoachBuildOtpIngest
#   Remove:  schtasks /delete /tn CoachBuildOtpIngest /f
#
# GOTCHA this file exists to encode (inherited from the sibling scripts): Task
# Scheduler's environment does NOT carry the interactive PATH, and this machine
# has a corporate node shadow ("MDXT Connect" node64) earlier in PATH than the
# real Node.js. Pin the real Node.js dir FIRST or tsx resolves against the
# wrong runtime.

$ErrorActionPreference = 'Continue'
# Self-locating: resolve the repo from this script's own location rather than a
# hardcoded user path, so the job survives a machine/username migration.
$repo = Split-Path -Parent $PSScriptRoot
$logDir = Join-Path $env:LOCALAPPDATA 'CoachBuild'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
$log = Join-Path $logDir 'otp-ingest.log'

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
$slotStart = Get-Date
$stamp = $slotStart.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
Add-Content $log "[$stamp] otp ingest starting" -Encoding utf8

& npx tsx scripts/ingest-otp.mjs --champions 30 2>&1 | Out-File -FilePath $log -Append -Encoding utf8
$code = $LASTEXITCODE

$stamp = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
Add-Content $log "[$stamp] otp ingest finished, exit $code" -Encoding utf8

# ── Chained featured one-trick refresh ──────────────────────────────────────
# Guard, not decoration. TWO ceilings bound this slot, and the tighter one is
# NOT the obvious one:
#   1. CoachBuildMatchIngest opens its slot 180 min after this one.
#   2. This task's own "Stop Task If Runs" limit, which Task Scheduler enforces
#      by KILLING the job. It was 02:00:00 while this slot ran only the
#      consensus walk; raised to 02:45:00 (PT2H45M) on 2026-07-29 when the
#      featured half was chained on, still stopping well before ceiling 1.
# Ceiling 2 binds. At the old 2h limit, a worst-case consensus walk (111 min
# measured) plus the featured half (~24 min) would have been cut off mid-run.
#
# The featured half needs ~24 min at 20 champions, so starting it past the 120
# min mark leaves under ~20 min before the kill. Past that, skipping a refresh
# cycle is strictly cheaper than a half-written run or two concurrent Riot
# processes, which SUSPENDS the key for every surface in the app (CLAUDE.md
# gotcha (d)). Coverage is recoverable; a suspended key is not.
#
# If you change either ceiling, change the other deliberately: this budget, the
# task's ExecutionTimeLimit, and the 3h trigger offset are one interlocking set.
#
# Run as a CHILD PROCESS, not dot-sourced or called with &: that script ends in
# `exit`, which in the same scope would terminate this one too and lose the
# logging below.
$budgetMinutes = 120
$elapsed = [int]((Get-Date) - $slotStart).TotalMinutes
$stamp = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')

if ($elapsed -ge $budgetMinutes) {
    Add-Content $log "[$stamp] featured half SKIPPED: consensus walk took $elapsed min, budget is $budgetMinutes" -Encoding utf8
} else {
    Add-Content $log "[$stamp] featured half starting ($elapsed min elapsed, budget $budgetMinutes)" -Encoding utf8
    $featured = Join-Path $PSScriptRoot 'ingest-otp-featured-scheduled.ps1'
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $featured -Champions 20
    $featuredCode = $LASTEXITCODE
    $stamp = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    Add-Content $log "[$stamp] featured half finished, exit $featuredCode (own log: otp-featured-ingest.log)" -Encoding utf8
}

# Exit with the CONSENSUS code: that is what this task's health has always
# meant, and the featured half logs its own outcome separately.
exit $code
