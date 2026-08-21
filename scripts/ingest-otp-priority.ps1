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
#   * every 6 hours, starting 00:10 — so 00:10 / 06:10 / 12:10 / 18:10, off the
#     :20 that both existing Riot jobs fire on, purely so a restart tick does
#     not land in the same second as a slot start;
#   * the walk exits cleanly at --max-hours, and the next 6-hourly tick brings
#     it back. A crash, a reboot or an aborted run therefore self-heals within
#     six hours with no watchdog;
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
# ── DUTY CYCLE IS A NEON BILL. DO NOT RAISE IT WITHOUT DOING THE ARITHMETIC ─
# Corrected 2026-08-20 after this job exhausted the shared Neon Free-plan
# compute quota and took the shop panel's Pro and OTP blocks down with it.
#
# Neon bills COMPUTE AS WALL-CLOCK ACTIVE SECONDS, not per query. This walk
# issues ~45-75 statements a minute continuously, so for as long as it runs the
# compute never gets to autosuspend (which on Free is fixed at 5 min idle and
# cannot be changed). Duty cycle IS the bill. Query optimisation is worth
# almost nothing here; the trigger interval is worth everything.
#
#   trigger x --max-hours   duty      CU-hours/month @0.25 CU   verdict
#   1h  x 12h               ~89%      ~160                      BLEW the 100 quota
#                                                               on 2026-08-20 at
#                                                               07:57 UTC, 19 days
#                                                               into the period
#   6h  x  1h               ~17%      ~30                       CURRENT. Chosen by
#                                                               the user: four
#                                                               refreshes a day,
#                                                               3.3x headroom
#   24h x  1h                ~4%      ~7                        maximum headroom,
#                                                               slowest coverage
#
# The quota is 100 CU-hours per Neon PROJECT per month and this project is
# SHARED with matchday. The walk is resumable by design, so a shorter budget
# does not lose work — it only slows how fast coverage deepens.
#
# Before changing either number, read HANDOFF-marco-neon-usage.md, then
# recompute: (24 / trigger_hours) * max_hours * 30 * 0.25 must stay well under
# 100. Anything at or above a ~30% duty cycle will exhaust the quota again.
#
# ── EXECUTION TIME LIMIT ────────────────────────────────────────────────────
# The walk bounds ITSELF with --max-hours (default 1) and exits cleanly. Task
# Scheduler's own ExecutionTimeLimit is a backstop, not the mechanism — a kill
# is safe here (every match is persisted the moment it is fetched, ON CONFLICT
# DO NOTHING, so a kill loses at most one in-flight match and duplicates
# nothing) but it produces no summary line in the log. Set it above --max-hours
# but WELL below the trigger interval, so a wedged run can never bridge two
# slots and quietly restore the old ~100% duty cycle. Currently PT2H against a
# 6-hour trigger and a 1-hour walk.
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
# ── REGISTER IT ─────────────────────────────────────────────────────────────
#
# Use the script. It is the ONLY supported way to create or re-cadence this
# task, and it exists because every settings-level guarantee below (interval,
# instance policy, execution limit, battery) is one a raw `schtasks /create`
# either cannot express or gets wrong by default:
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File `
#     scripts\register-otp-priority-task.ps1
#
# It is idempotent, needs no elevation (the task runs as the interactive user,
# RunLevel Limited), and re-running it repairs a hand-edited task.
#
#   Status:  schtasks /query  /tn CoachBuildOtpPriority /v /fo list
#   Run now: schtasks /run    /tn CoachBuildOtpPriority
#   Stop:    schtasks /end    /tn CoachBuildOtpPriority
#   Remove:  schtasks /delete /tn CoachBuildOtpPriority /f
#
# DO NOT re-register with the old one-liner, which is kept here only so the
# thing you must not paste is recognisable. `/sc HOURLY` plus this script's
# former 12-hour default is the ~89% duty cycle that exhausted the Neon quota:
#
#   # WRONG — this is the 2026-08-20 outage, verbatim:
#   # schtasks /create /tn CoachBuildOtpPriority /sc HOURLY /mo 1 /st 00:10 /f ...
#
# ── THE BATTERY DEFAULT, WHICH COSTS A WHOLE SLOT AND LEAVES NO TRACE ───────
# `schtasks /create` sets DisallowStartIfOnBatteries=True and
# StopIfGoingOnBatteries=True. This is a LAPTOP. The consequences:
#
#   * an unplugged machine SKIPS the trigger outright. LastRunTime does not
#     move, NextRunTime jumps to the following hour, NumberOfMissedRuns goes up
#     by one, and Status still reads "Ready". Nothing is written to either log,
#     because no process ever started. It is indistinguishable from a task that
#     simply has not been triggered yet;
#   * unplugging mid-walk KILLS it, and LastTaskResult becomes 267014
#     (0x41306, SCHED_S_TASK_TERMINATED) — byte-identical to a `schtasks /end`,
#     so the log looks like somebody stopped it on purpose.
#
# Observed 2026-07-29: the 18:10 slot was lost this way at 66% battery. Fix it
# from PowerShell — Set-ScheduledTask REPLACES the whole settings object, so
# every setting you want to keep must be restated in the same call:
#
#   $s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries `
#          -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew `
#          -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 13)
#   Set-ScheduledTask -TaskName CoachBuildOtpPriority -Settings $s
#
# Whenever this job "did not run" and left nothing behind, check
# (Get-CimInstance -Namespace root\wmi BatteryStatus).PowerOnline BEFORE
# reading any application log. The sibling CoachBuildMatchIngest,
# CoachBuildDraftIngest and CoachBuildProstageIngest tasks still carry the
# default and will skip the same way; CoachBuildOtpIngest was already corrected.
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
    # Wall-clock ceiling for one run. The 6-hourly trigger brings it back.
    #
    # 1, not 12. This default is a COST control, not a tuning knob — see the
    # "DUTY CYCLE IS A NEON BILL" section in this file's header before raising
    # it. The registered task passes `-MaxHours 1` explicitly as well, so both
    # the scheduled path and a bare hand-run land on the same budget.
    [int]$MaxHours = 1,
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

# Point every ingest below at the REBUILT Neon project, or stop here. These
# scripts reach the database through scripts/_env.mjs, which fills only keys
# that are still undefined -- so with DATABASE_URL unset this wrapper silently
# inherited .env.local's OLD, matchday-shared, quota-exhausted project. That is
# a refusal, not a warning: see scripts/_cbnew-db.ps1.
. (Join-Path $PSScriptRoot '_cbnew-db.ps1') -Root $repo -LogPath $hostLog
if (-not $CbnewDbResolved) { exit 78 }

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
