# CoachBuild FEATURED one-trick refresh — Windows Task Scheduler entry point.
#
# NOT REGISTERED YET, ON PURPOSE. Read the timing section before enabling it.
#
# WHY THE DISCOVERY HALF RUNS HERE AND NOT ON VERCEL: discovery drives a real
# Chrome through puppeteer-core because onetricks.gg returns HTTP 429 to plain
# fetches (reproduced repeatedly 2026-07-29) and 200 to a browser. Vercel has no
# browser and puppeteer-core is a devDependency the Next app never imports. Same
# split, same reason, as ingest-otp-scheduled.ps1's op.gg discovery.
#
# ── TIMING: THE THING TO DECIDE BEFORE ENABLING ─────────────────────────────
# This box ALREADY runs two Riot-calling jobs — CoachBuildMatchIngest every 6h
# and CoachBuildOtpIngest every 6h, offset by 3h, the latter capped at 30
# champions (~114 min) precisely because that is what the 3h gap allows.
#
# lib/pro/pacer.ts serialises Riot calls WITHIN a process only. Two Riot-calling
# processes at once double the request rate against ONE key budget, and
# exceeding that cap SUSPENDS the key for every surface in the app (CLAUDE.md
# gotcha (d)). So this job must not overlap either existing slot.
#
# MEASURED 2026-07-29 for this pipeline: ~70s per champion at --matches 40
# (8s page load + ~5s resolve + 40 x 1.3s Riot floor). So 30 champions is
# ~35 min — much cheaper per champion than the consensus walk, because it
# fetches ONE account's games rather than eight accounts' worth.
#
# Two safe ways to enable it, both of which keep total concurrency at one:
#   A. Append it to ingest-otp-scheduled.ps1 so the two run SEQUENTIALLY in one
#      slot, and drop that script's consensus run from 30 champions to ~20 to
#      stay inside the 3h gap (20 x 3.8min + 30 x 70s = ~111 min).
#   B. Give it its own slot in the remaining gap, verified against the other two
#      tasks' actual start times (`schtasks /query /tn CoachBuildOtpIngest /v`).
#
# Do NOT simply register this on a 6h trigger and hope the slots miss each
# other. That is the exact assumption gotcha (d) exists to prevent.
#
# Task name (once decided): CoachBuildOtpFeatured
#   Status:  schtasks /query /tn CoachBuildOtpFeatured
#   Run now: schtasks /run   /tn CoachBuildOtpFeatured
#   Remove:  schtasks /delete /tn CoachBuildOtpFeatured /f
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
$log = Join-Path $logDir 'otp-featured-ingest.log'

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
Add-Content $log "[$stamp] otp featured ingest starting" -Encoding utf8

& npx tsx scripts/ingest-otp-featured.mjs --champions 30 --matches 40 2>&1 | Out-File -FilePath $log -Append -Encoding utf8
$code = $LASTEXITCODE

$stamp = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
Add-Content $log "[$stamp] otp featured ingest finished, exit $code" -Encoding utf8
exit $code
