# CoachBuild PRIORITY DEEP WALK — Windows Task Scheduler entry point.
#
# *** NOT REGISTERED. *** Written to be reviewed first (user directive
# 2026-07-29: "I will register it after reviewing the yield logic myself").
# The exact schtasks command is at the bottom of this header.
#
# ── WHAT THIS RUNS ──────────────────────────────────────────────────────────
# scripts/ingest-otp-priority.mjs — a CONTINUOUS walk that deepens the featured
# one-trick fleet, prioritised by the champions the user actually plays. Read
# lib/otp/deepWalk.ts for the ordering and lib/otp/riotYield.ts for the safety
# predicate before changing anything here.
#
# ── TIMING: THE DECISION, AND WHY IT IS DIFFERENT FROM ITS SIBLINGS ─────────
# The sibling jobs (ingest-otp-scheduled.ps1, ingest-matches-scheduled.ps1,
# ingest-otp-featured-scheduled.ps1) are made safe by their SCHEDULE: they are
# given non-overlapping slots, sized against measured worst-case runtimes, and
# ingest-otp-scheduled.ps1's own header is explicit that this arithmetic is
# fragile — "a slot that is free on the median is occupied on the tail".
#
# This job does NOT get a slot, and deliberately so. It is safe by PREDICATE:
# before every unit of work — and again before every match fetch inside a unit —
# it asks the literal question "is a process running one of those scripts right
# now?" (process command lines + Task Scheduler state, either signal saying busy
# means busy, and an enumeration it cannot perform also means busy). When the
# answer is yes it parks at 30s polling and logs the fact; when the answer goes
# back to no it logs how long it was parked and resumes.
#
# So the trigger is chosen for RESTART, not for isolation:
#
#   * hourly, starting 00:10 — off the :20 that both existing Riot jobs fire on,
#     purely so a restart tick does not land in the same second as a slot start;
#   * the walk exits cleanly at --max-hours, and the next hourly tick brings it
#     back. A crash, a reboot or an aborted run therefore self-heals within an
#     hour with no watchdog;
#   * a second copy must never start. TWO layers, because the obvious one is not
#     enough:
#       1. Task Scheduler's multiple-instance policy. schtasks-created tasks are
#          believed to default to IgnoreNew — UNVERIFIED here, since the task is
#          not registered. Do not rely on it alone.
#       2. A lock file (%LOCALAPPDATA%\CoachBuild\otp-priority.lock) holding the
#          running pid, which the walk checks at startup and which is validated
#          against that pid's live command line, not just its existence. THIS is
#          the guarantee. It exists because riotYield.ts's SELF_MARKER makes this
#          walk invisible to itself — without which it would yield to itself
#          forever — so two copies would each classify the other as "self" and
#          run concurrently, doubling the request rate against one key budget.
#          That is the exact failure the yield predicate exists to prevent,
#          arriving through its own escape hatch.
#
# ── WHY NOT JUST A LONGER SLOT ──────────────────────────────────────────────
# Because there is no speed available and therefore no slot big enough. Riot's
# live headers give the ceiling as `x-app-rate-limit: 100:120,20:1` (100 calls
# per 2 minutes) and lib/pro/pacer.ts's 1.3s floor already runs at ~92% of it.
# Bringing the user's 42 played champions to depth is thousands of calls; the
# only way to spend them is across the ~10 hours a day the key is otherwise
# idle, in pieces, around jobs whose runtimes span 23-115 minutes.
#
# ── EXECUTION TIME LIMIT ────────────────────────────────────────────────────
# The walk bounds ITSELF with --max-hours (default 12) and exits cleanly. Task
# Scheduler's own ExecutionTimeLimit is a backstop, not the mechanism — a kill
# is safe here (every match is persisted the moment it is fetched, ON CONFLICT
# DO NOTHING, so a kill loses at most one in-flight match and duplicates
# nothing) but it produces no summary line in the log. Set it above --max-hours.
#
# ── LOGS: TWO FILES, ON PURPOSE ─────────────────────────────────────────────
#   otp-priority.log       — owned and written by the NODE process, UTF-8,
#                            self-bounding at ~1MB. This is the log a human
#                            reads: what it is doing, how far along, when it
#                            last yielded and for how long.
#   otp-priority-host.log  — owned by THIS script: slot start/stop, exit code,
#                            and any raw crash output the runtime emits before
#                            node's own logging is up. Tiny.
#
# The siblings use one file, redirecting the child's stdout into it and trimming
# it once at slot start. That works for a 24-minute job. This one runs for
# hours, so the bounding has to happen from inside the process — and two writers
# on one file would mean two encodings, the exact garbling those scripts'
# headers warn about (PS 5.1's bare *>> writes UTF-16LE while Add-Content writes
# ANSI). One owner per file, one encoding per file.
#
# ── REGISTER IT (after reviewing the yield logic) ───────────────────────────
#
#   schtasks /create /tn CoachBuildOtpPriority /sc HOURLY /mo 1 /st 00:10 /f `
#     /tr "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \"C:\Claude\AI\coachbuild\scripts\ingest-otp-priority.ps1\""
#
#   Status:  schtasks /query  /tn CoachBuildOtpPriority /v /fo list
#   Run now: schtasks /run    /tn CoachBuildOtpPriority
#   Stop:    schtasks /end    /tn CoachBuildOtpPriority
#   Remove:  schtasks /delete /tn CoachBuildOtpPriority /f
#
#   Then confirm the two settings schtasks cannot express on the command line:
#     - Settings > "If the task is already running: Do not start a new instance"
#     - Settings > "Stop the task if it runs longer than" > above -MaxHours
#
# NOTE: CoachBuildOtpPriority is deliberately NOT added to
# riotYield.ts's RIOT_SCHEDULED_TASKS. That list is what this walk yields TO;
# adding itself would make it yield to itself forever.
#
# ── DRY RUN FIRST (safe at any time, makes ZERO Riot calls) ─────────────────
#   powershell -NoProfile -ExecutionPolicy Bypass -File `
#     scripts\ingest-otp-priority.ps1 -DryRun
#
# GOTCHA this file exists to encode (inherited from the sibling scripts): Task
# Scheduler's environment does NOT carry the interactive PATH, and this machine
# has a corporate node shadow ("MDXT Connect" node64) earlier in PATH than the
# real Node.js. Pin the real Node.js dir FIRST or tsx resolves against the wrong
# runtime.

param(
    # Wall-clock ceiling for one run. The hourly trigger brings it back.
    [int]$MaxHours = 12,
    # Plan only: derive and log the priority order, make no Riot calls.
    [switch]$DryRun,
    # Run exactly one unit of work, then exit. For verifying the walk end to end.
    [switch]$Once,
    # Spill into featured champions the user has never played, once the played
    # ones are exhausted. Off by default — the directive is to deepen what they
    # actually play.
    [switch]$Fleet
)

$ErrorActionPreference = 'Continue'
# Self-locating: resolve the repo from this script's own location rather than a
# hardcoded user path, so the job survives a machine/username migration.
$repo = Split-Path -Parent $PSScriptRoot
$logDir = Join-Path $env:LOCALAPPDATA 'CoachBuild'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
# THIS script's log. The node process owns otp-priority.log separately — see the
# header. Do not point both at one file.
$hostLog = Join-Path $logDir 'otp-priority-host.log'

# Keep the host log bounded (~256KB): keep the newest half when it grows past
# that. Smaller than the siblings' 1MB because this file only ever holds slot
# markers and crash output; the operational log is the other one.
if ((Test-Path $hostLog) -and ((Get-Item $hostLog).Length -gt 256KB)) {
    $text = Get-Content $hostLog -Raw
    Set-Content $hostLog $text.Substring([int]($text.Length / 2)) -Encoding utf8
}

$env:Path = 'C:\Program Files\nodejs;' + $env:Path
Set-Location $repo

# NOT `$args`. That is a PowerShell AUTOMATIC variable (a script's own unbound
# arguments), and splatting it with `@args` does not pass a reassigned value —
# it passed NOTHING, so `npx tsx` launched with no script and dropped into an
# interactive Node REPL. The task then sat in state "Running" for its full
# execution limit having done zero work, and the failure is invisible from
# Task Scheduler: no error, no exit code, just a task that looks healthy and
# is not. Caught 2026-07-29 on the first live registration, by reading the host
# log rather than the task state.
#
# The `-join` in the log line above read `$args` correctly, which is what makes
# this worth a comment: the value IS there, it just does not survive splatting.
# Use an ordinary variable.
$walkArgs = @('scripts/ingest-otp-priority.mjs', '--max-hours', $MaxHours)
if ($DryRun) { $walkArgs += '--dry-run' }
if ($Once)   { $walkArgs += '--once' }
if ($Fleet)  { $walkArgs += '--fleet' }

# -Encoding utf8 on BOTH writers: PS 5.1's bare *>> redirect writes UTF-16LE
# while Add-Content writes ANSI -- a mixed-encoding log that byte-oriented
# tools (tail, grep) render as garbage. One encoding, one log.
$slotStart = Get-Date
$stamp = $slotStart.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
Add-Content $hostLog "[$stamp] priority walk starting: $($walkArgs -join ' ')" -Encoding utf8

& npx tsx @walkArgs 2>&1 | Out-File -FilePath $hostLog -Append -Encoding utf8
$code = $LASTEXITCODE

$elapsed = [int]((Get-Date) - $slotStart).TotalMinutes
$stamp = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
Add-Content $hostLog "[$stamp] priority walk finished after $elapsed min, exit $code (operational log: otp-priority.log)" -Encoding utf8
exit $code
