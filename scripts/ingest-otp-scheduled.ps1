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
# Scheduled cadence: every 6 hours, 6 champions per run (~170 champions, so a
# full sweep takes ~1 week and then rolls continuously). Deliberately unhurried
# — the pass is bound by lib/pro/pacer.ts's 1.3s Riot floor, which is SHARED
# with the pro-account sweep and My Stats.
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
Set-Location $repo

# -Encoding utf8 on BOTH writers: PS 5.1's bare *>> redirect writes UTF-16LE
# while Add-Content writes ANSI -- a mixed-encoding log that byte-oriented
# tools (tail, grep) render as garbage. One encoding, one log.
$stamp = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
Add-Content $log "[$stamp] otp ingest starting" -Encoding utf8

& npx tsx scripts/ingest-otp.mjs --champions 6 2>&1 | Out-File -FilePath $log -Append -Encoding utf8
$code = $LASTEXITCODE

$stamp = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
Add-Content $log "[$stamp] otp ingest finished, exit $code" -Encoding utf8
exit $code
