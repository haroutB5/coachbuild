# CoachBuild FEATURED one-trick refresh — Windows Task Scheduler entry point.
#
# NOT A STANDALONE SCHEDULED TASK, ON PURPOSE. ingest-otp-scheduled.ps1 invokes
# this script sequentially at the end of its own slot. Read the timing section.
#
# WHY THE DISCOVERY HALF RUNS HERE AND NOT ON VERCEL: discovery drives a real
# Chrome through puppeteer-core because onetricks.gg returns HTTP 429 to plain
# fetches (reproduced repeatedly 2026-07-29) and 200 to a browser. Vercel has no
# browser and puppeteer-core is a devDependency the Next app never imports. Same
# split, same reason, as ingest-otp-scheduled.ps1's op.gg discovery.
#
# ── TIMING: DECIDED 2026-07-29, AND WHY ─────────────────────────────────────
# This box ALREADY runs two Riot-calling jobs — CoachBuildMatchIngest every 6h
# (01:20 local) and CoachBuildOtpIngest every 6h (04:20 local), offset by 3h.
#
# lib/pro/pacer.ts serialises Riot calls WITHIN a process only. Two Riot-calling
# processes at once double the request rate against ONE key budget, and
# exceeding that cap SUSPENDS the key for every surface in the app (CLAUDE.md
# gotcha (d)). So this job must not overlap either existing slot.
#
# MEASURED RUNTIMES from the two jobs' own logs, 2026-07-27..29 — not estimates:
#   CoachBuildMatchIngest: 40, 52, 68, 84, 85, 115 min   (worst 115)
#   CoachBuildOtpIngest:   23, 42, 111 min               (worst 111)
# Against a 180 min gap, the worst case leaves only ~65-69 min free. A third
# trigger dropped into that residue would be safe only while both neighbours
# behave — i.e. its safety would rest on arithmetic that nothing enforces.
#
# MEASURED for this pipeline, 2026-07-29 (live 80-champion backfill): ~72s per
# champion at --matches 40 (8s page load + ~5s resolve + 40 x 1.3s Riot floor).
# Much cheaper per champion than the consensus walk, because it fetches ONE
# account's games rather than eight accounts' worth.
#
# CHOSEN: option A, chained — ingest-otp-scheduled.ps1 runs its consensus walk,
# then invokes this script sequentially in the SAME slot. Concurrency stays at
# one BY CONSTRUCTION rather than by timing arithmetic, and there is no third
# trigger that can drift into a neighbour.
#
# Sized against the MEASURED worst case, not the estimate:
#   consensus 30 champions (worst 111 min) + featured 20 champions (~24 min)
#   = ~135 min worst case, inside the 180 min gap with ~45 min of margin.
#
# THE 180 MIN GAP IS NOT THE BINDING CONSTRAINT — CoachBuildOtpIngest also
# carries a Task Scheduler "Stop Task If Runs" limit, which was 02:00:00 and
# would have KILLED that 135 min slot mid-run. Raised to 02:45:00 on 2026-07-29
# for exactly this reason, still stopping before the neighbouring slot opens.
# The consensus walk is NOT reduced to pay for this; the earlier sketch in this
# header proposed dropping it to 20, and the measured numbers make that
# unnecessary.
#
# The parent ALSO enforces a wall-clock budget before starting this half, so a
# pathological consensus run skips the featured half instead of colliding with
# CoachBuildMatchIngest. The arithmetic above is the design intent; that check
# is what actually holds the invariant.
#
# Coverage at 20/run x 4 runs/day = 80 champions/day against a ~170 roster, so
# every featured one-trick refreshes about every two days. The walk is
# stalest-first, so it self-balances.
#
# Run it by hand (safe ONLY when neither scheduled job is mid-slot):
#   powershell -NoProfile -ExecutionPolicy Bypass -File `
#     scripts\ingest-otp-featured-scheduled.ps1 -Champions 20
#
# GOTCHA this file exists to encode (inherited from the sibling scripts): Task
# Scheduler's environment does NOT carry the interactive PATH, and this machine
# has a corporate node shadow ("MDXT Connect" node64) earlier in PATH than the
# real Node.js. Pin the real Node.js dir FIRST or tsx resolves against the
# wrong runtime.

# Champion count is a parameter because the chained caller and a hand-run want
# different sizes: the caller passes the budget-sized 20, a manual catch-up run
# can ask for more when no scheduled slot is active.
param([int]$Champions = 20)

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
Add-Content $log "[$stamp] otp featured ingest starting ($Champions champions)" -Encoding utf8

& npx tsx scripts/ingest-otp-featured.mjs --champions $Champions --matches 40 2>&1 | Out-File -FilePath $log -Append -Encoding utf8
$code = $LASTEXITCODE

$stamp = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
Add-Content $log "[$stamp] otp featured ingest finished, exit $code" -Encoding utf8
exit $code
