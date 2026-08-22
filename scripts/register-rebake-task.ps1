# CoachBuild WEEKLY CONSENSUS RE-BAKE — Task Scheduler registration, idempotent.
#
# THE POINT OF THIS FILE, and it is the same point as
# scripts/register-otp-priority-task.ps1's: a cadence that lives only in Task
# Scheduler cannot be reviewed, cannot be restored after a machine rebuild, and
# drifts without leaving a diff. That is not a style opinion - it is the named
# root cause of the 2026-08-20 Neon outage, where an hourly trigger wrapped
# around a twelve-hour walk because the only record of the intended shape was a
# comment. So this task is registered from a committed, re-runnable script, and
# the number it registers is asserted by lib/__tests__/ingestCadence.test.ts.
#
# ── THE SLOT, AND WHY THIS ONE ──────────────────────────────────────────────
# SUNDAY 15:00 LOCAL. Every scheduled writer on this machine, in LOCAL time:
#
#   CoachBuildOtpPriority   every 6h at :10   ~60 min   00:10 06:10 12:10 18:10
#   CoachBuildProstage      every 6h at :15   ~5 min    00:15 06:15 12:15 18:15
#   CoachBuildMatchIngest   daily  01:20      40-110 min (measured range)
#   CoachBuildOtpIngest     daily  04:20      ~73 min
#   CoachBuildDraftIngest   Mon+Thu 09:00     ~63 min
#   Vercel cron /api/ingest/otp  09:00 UTC = 10:00 local, daily
#
# 15:00 Sunday sits in the widest gap in the week: 13:10 (priority walk ends) to
# 18:10 (it starts again), on a day CoachBuildDraftIngest does not run. Three
# hours and ten minutes of clearance in front of the next writer, against a run
# that takes about ten minutes.
#
# THE ARITHMETIC IS IN LOCAL TIME BECAUSE Get-ScheduledTaskInfo REPORTS
# NextRunTime IN LOCAL TIME. Mixing it with a UTC "now" reads an hour of
# clearance that is not there - which tripped an earlier lane on this repo. The
# wrapper's own clearance guard compares local against local for the same reason.
#
# ── WHY THE OVERLAP CHECK BELOW IS CODE AND NOT A COMMENT ───────────────────
# Because the table above will change, and the next person to move a slot will
# not re-derive this one. The check throws if the chosen start collides with a
# known busy window, so moving an ingest into this slot fails loudly at
# registration time instead of quietly at 15:00 on a Sunday. It is the same
# reasoning as the priority script's duty-cycle refusal: make the arithmetic
# enforceable rather than merely documented.
#
# ── COST ────────────────────────────────────────────────────────────────────
# The bake issues ~1,730 requests against production, ~5 min of Neon compute,
# ~0.03 CU-hours - once a week, so ~0.13 CU-hours a month against a 100
# CU-hour quota SHARED with matchday. It is a rounding error, and it is still
# pinned in lib/ingestCadence.ts, because "too small to matter" is how four of
# the five ingest tasks ended up with no reviewable cadence at all.
#
# The far larger cost this replaces is a human doing it by hand: four bakes in
# HANDOFF-otp-artifact.md, each one an evening.
#
# ── NO ELEVATION NEEDED ─────────────────────────────────────────────────────
# Runs as the interactive user at RunLevel Limited, so registering works from an
# ordinary terminal. "Access is denied" here means something else created the
# task elevated - re-run in an Administrator terminal rather than fighting it,
# because a half-applied scheduler change is worse than none.
#
# ── USAGE ───────────────────────────────────────────────────────────────────
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\register-rebake-task.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\register-rebake-task.ps1 -WhatIf
#
# Registering does NOT enable a task that was found disabled - see the note by
# $settings.Enabled below. Enabling stays a separate, deliberate act.

[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$TaskName = 'CoachBuildConsensusRebake',
    # Day and local time of the weekly fire. See the slot arithmetic above.
    [string]$DayOfWeek = 'Sunday',
    [string]$StartBoundary = '2026-08-23T15:00:00',
    # Handed to the wrapper as -DeadlineMinutes: its whole-run ceiling AND the
    # clearance it demands in front of the next scheduled ingest.
    [int]$DeadlineMinutes = 60
)

$ErrorActionPreference = 'Stop'

# Self-locating, so the task survives a machine or username migration.
$repo    = Split-Path -Parent $PSScriptRoot
$wrapper = Join-Path $repo 'scripts\rebake-consensus.ps1'
if (-not (Test-Path $wrapper)) { throw "wrapper not found: $wrapper" }

# Refuse to register a wrapper that cannot prove which database this checkout is
# configured against. Same guard as the two sibling register scripts; the reason
# it is repeated rather than shared is that a guard living in one place is a
# guard somebody's new script quietly does not have.
$wrapperText = Get-Content $wrapper -Raw
if ($wrapperText -notmatch '_cbnew-db\.ps1' -or $wrapperText -notmatch '\$CbnewDbResolved') {
    throw ('REFUSING: scripts\rebake-consensus.ps1 does not dot-source scripts\_cbnew-db.ps1 ' +
           'and check $CbnewDbResolved.')
}
# And that it still refuses on a coverage regression. If that guard is deleted,
# registration fails rather than the next Sunday shipping a thinner corpus.
if ($wrapperText -notmatch 'coverage\.otp REGRESSED') {
    throw 'REFUSING: scripts\rebake-consensus.ps1 has lost its coverage.otp regression refusal.'
}

# ── slot collision guard ────────────────────────────────────────────────────
# Busy windows in LOCAL minutes-past-midnight, mirroring lib/ingestCadence.ts.
# Every-N-hours jobs are expanded across the day; the two day-specific ones are
# tagged so a Sunday slot is not blocked by a Monday job.
$busy = @(
    @{ Task = 'CoachBuildOtpPriority';   Start = 10;        Run = 60; Every = 360; Days = $null },
    @{ Task = 'CoachBuildProstageIngest'; Start = 15;       Run = 5;  Every = 360; Days = $null },
    # MatchIngest is modelled at its MEASURED WORST (110 min), not its median.
    # A collision guard sized on the median is a guard that passes and then the
    # job overruns into it.
    @{ Task = 'CoachBuildMatchIngest';   Start = 80;        Run = 110; Every = 1440; Days = $null },
    @{ Task = 'CoachBuildOtpIngest';     Start = 260;       Run = 73; Every = 1440; Days = $null },
    @{ Task = 'CoachBuildDraftIngest';   Start = 540;       Run = 63; Every = 1440; Days = @('Monday','Thursday') },
    # Vercel cron /api/ingest/otp, 09:00 UTC. Not a local task, but it drives
    # the same Neon compute and the same Riot key.
    @{ Task = 'vercel cron /api/ingest/otp'; Start = 600;   Run = 30; Every = 1440; Days = $null }
)

$startDt = [datetime]$StartBoundary
$slotStart = $startDt.Hour * 60 + $startDt.Minute
$slotEnd = $slotStart + $DeadlineMinutes

foreach ($b in $busy) {
    if ($b.Days -and ($b.Days -notcontains $DayOfWeek)) { continue }
    for ($s = $b.Start; $s -lt 1440; $s += $b.Every) {
        $e = $s + $b.Run
        if ($slotStart -lt $e -and $s -lt $slotEnd) {
            throw ("REFUSING: ${DayOfWeek} $($startDt.ToString('HH:mm')) + ${DeadlineMinutes}min overlaps " +
                   "$($b.Task) ($([timespan]::FromMinutes($s).ToString('hh\:mm'))-" +
                   "$([timespan]::FromMinutes($e).ToString('hh\:mm')) local). Two Riot-calling jobs share " +
                   'ONE key budget and exceeding it SUSPENDS the key for every surface in the app. ' +
                   'Pick another slot, or fix the table in this script if an ingest moved.')
        }
    }
}
Write-Output "slot check: ${DayOfWeek} $($startDt.ToString('HH:mm')) local + ${DeadlineMinutes}min is clear of every known writer"

$argument = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden ' +
            "-File $wrapper -DeadlineMinutes $DeadlineMinutes"

$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $argument

# A plain WEEKLY CalendarTrigger with NO repetition. Deliberate: a
# CalendarTrigger carrying a Repetition block skips slots on this box (measured
# on a sibling project), and a repetition WITH a duration expires and stops the
# job dead with no error in any log. Weekly needs neither.
$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek $DayOfWeek -At $startDt

# New-ScheduledTaskTrigger stamps the StartBoundary with the CURRENT UTC offset
# (…T15:00:00+01:00), pinning the schedule to absolute time - so every fire
# slides by an hour when the clock changes and the 15:00 slot drifts. A naive
# local boundary floats with local time and stays at 15:00 all year. Verified
# against the task XML on the priority task, same correction.
$trigger.StartBoundary = $startDt.ToString('yyyy-MM-ddTHH:mm:ss')

# Set-ScheduledTask REPLACES the whole settings object, so everything worth
# keeping is restated in one call. Each of these is load-bearing:
#
#   IgnoreNew            a run that overruns must not be joined by another.
#   ExecutionTimeLimit   set ABOVE the wrapper's own deadline (it should stop
#                        itself) but well below the gap to the next writer, so a
#                        wedged run can never bridge into 18:10's priority walk.
#   AllowStartIfOnBatteries / DontStopIfGoingOnBatteries
#                        `schtasks /create` sets BOTH to true, and on this laptop
#                        that silently SKIPS the trigger while unplugged:
#                        LastRunTime does not move, Status still reads "Ready",
#                        and nothing is logged because no process ever started.
#                        Observed 2026-07-29, one whole slot lost at 66% battery.
#   StartWhenAvailable   the machine is not on every Sunday at 15:00. Without
#                        this a missed week is simply skipped, and a weekly job
#                        that skips is a job that has silently stopped.
$settings = New-ScheduledTaskSettingsSet `
              -AllowStartIfOnBatteries `
              -DontStopIfGoingOnBatteries `
              -MultipleInstances IgnoreNew `
              -StartWhenAvailable `
              -ExecutionTimeLimit (New-TimeSpan -Minutes ([math]::Max(120, $DeadlineMinutes + 60)))

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue

# RE-REGISTERING MUST NOT ALSO RE-ENABLE. Enabled lives inside the settings
# object that Set-ScheduledTask replaces wholesale, and a fresh settings set
# carries Enabled = True - so re-running this against a task somebody disabled
# on purpose silently turns it back on. Verified 2026-08-21 on a throwaway task.
# Carry the previous state forward; enabling stays a deliberate act.
if ($existing) { $settings.Enabled = $existing.Settings.Enabled }

if ($PSCmdlet.ShouldProcess($TaskName, "register weekly $DayOfWeek $($startDt.ToString('HH:mm')) re-bake")) {
    if ($existing) {
        Set-ScheduledTask -TaskName $TaskName -Trigger $trigger -Action $action -Settings $settings | Out-Null
        Write-Output "updated: $TaskName (left $(if ($settings.Enabled) { 'ENABLED' } else { 'DISABLED' }), as found)"
    } else {
        Register-ScheduledTask -TaskName $TaskName -Trigger $trigger -Action $action -Settings $settings `
            -Description ('CoachBuild weekly consensus artifact re-bake: generate, and if it changed, commit + push + deploy. ' +
                          'Cadence and slot are chosen in scripts/register-rebake-task.ps1 - do not re-cadence in the GUI.') | Out-Null
        Write-Output "created: $TaskName"
    }
}

Write-Output "  trigger:  weekly $DayOfWeek at $($startDt.ToString('HH:mm')) local"
Write-Output "  wrapper:  $wrapper -DeadlineMinutes $DeadlineMinutes"
Write-Output "  limit:    ExecutionTimeLimit $($settings.ExecutionTimeLimit)"
Write-Output ""
Write-Output "Enable:  Enable-ScheduledTask -TaskName $TaskName"
Write-Output "Verify:  schtasks /Query /TN $TaskName /V /FO LIST"
Write-Output "Log:     $env:LOCALAPPDATA\CoachBuild\consensus-rebake.log"
