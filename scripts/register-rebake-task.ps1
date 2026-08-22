# CoachBuild DAILY CONSENSUS RE-BAKE — Task Scheduler registration, idempotent.
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
# ── WHY DAILY, NOT WEEKLY (changed 2026-08-22) ──────────────────────────────
# This started weekly. Its FIRST run was predicted to be a no-op and instead
# found SEVEN champion-roles that had crossed the 21-game floor in the twelve
# hours since the previous hand bake, and shipped them. That is ~14 a day.
#
# A stored `null` is believed with no live fallback, so every champion-role that
# crosses the floor serves NO OTP BLOCK AT ALL until the next bake. At ~14/day a
# weekly cadence leaves ~100 champion-roles dark by the end of each cycle. The
# run measures ~2 minutes and no-ops cleanly when nothing changed, so the cost
# of closing that window from 7 days to 1 is a rounding error. See the COST
# section below for the arithmetic, which is NOT a rounding error in the
# fleet CU model and had to be paid for with a measured runMinutes.
#
# ── THE SLOT, AND WHY THIS ONE ──────────────────────────────────────────────
# 15:00 LOCAL, EVERY DAY. Every scheduled writer on this machine, in LOCAL time:
#
#   CoachBuildOtpPriority   every 6h at :10   ~60 min   00:10 06:10 12:10 18:10
#   CoachBuildProstage      every 6h at :15   ~5 min    00:15 06:15 12:15 18:15
#   CoachBuildMatchIngest   daily  01:20      40-110 min (measured range)
#   CoachBuildOtpIngest     daily  04:20      ~73 min
#   CoachBuildDraftIngest   Mon+Thu 09:00     ~63 min
#   Vercel cron /api/ingest/otp  09:00 UTC = 10:00 local, daily
#
# 15:00 is the widest gap that exists on EVERY day of the week: 13:10 (the
# priority walk ends) to 18:10 (it starts again). That is 190 minutes of
# clearance in front of the next writer, against a run that measures ~2 min and
# is given a 60-minute ceiling. It is also the slot the weekly version already
# used, so the cadence change moves no times - only the frequency.
#
# GOING DAILY MADE THE Mon/Thu WINDOW LOAD-BEARING. A weekly Sunday job could
# ignore CoachBuildDraftIngest because Sunday is not one of its days. A daily job
# runs on Monday and Thursday too, so the collision check below no longer skips
# day-specific windows - it demands the slot be clear on every day it can fire.
# 15:00 clears 09:00-10:03 by five hours, but the check is what proves it.
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
# registration time instead of quietly at 15:00 tomorrow. It is the same
# reasoning as the priority script's duty-cycle refusal: make the arithmetic
# enforceable rather than merely documented.
#
# ── COST, AND THE PART THAT WAS NOT FREE ────────────────────────────────────
# The bake issues ~1,730 requests against production. MEASURED generation time
# across the three real runs on 2026-08-22 (the only Neon-touching half):
#
#   13:09:22 -> 13:11:19   117 s
#   13:13:26 -> 13:14:23    57 s
#   13:16:09 -> 13:18:03   114 s
#
# so ~2 minutes at the measured WORST, not the "~5 min" this header used to
# estimate. Whole-run wall clock including commit/push/deploy/verify: 113 s and
# 132 s.
#
# THAT NUMBER SUDDENLY MATTERED. lib/ingestCadence.ts amortises anything slower
# than daily but PAINTS anything daily-or-faster onto the minute map, so going
# weekly -> daily moved this job from 1.4 min/day of amortised cost to a real
# painted block. At the old placeholder runMinutes: 10 the fleet projection went
# 49.43 -> 50.50 CU-hours and BROKE the 2x-headroom gate (cap 50). The gate was
# right to fire: daily genuinely costs more.
#
# It was fixed by correcting the INPUT, not the gate. runMinutes is now 5: the
# measured worst whole run (2.2 min) doubled and rounded up. That is still an
# overstatement, but a calibrated one instead of a round guess - and it is not
# tuned to fit, since 6 also passes. Projection lands at 49.875. The 10 was only
# ever safe because weekly amortisation made overstating free.
#
# ~0.04 CU-hours per run, ~1.1 CU-hours a month, against a 100 CU-hour quota
# SHARED with matchday. Pinned in lib/ingestCadence.ts, because "too small to
# matter" is how four of the five ingest tasks ended up with no reviewable
# cadence at all.
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
    # Local time of the DAILY fire. See the slot arithmetic above. There is no
    # -DayOfWeek any more: the job fires every day, which is precisely why the
    # collision check below stopped filtering by day.
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
# registration fails rather than tomorrow's run shipping a thinner corpus.
if ($wrapperText -notmatch 'coverage\.otp REGRESSED') {
    throw 'REFUSING: scripts\rebake-consensus.ps1 has lost its coverage.otp regression refusal.'
}

# ── slot collision guard ────────────────────────────────────────────────────
# Busy windows in LOCAL minutes-past-midnight, mirroring lib/ingestCadence.ts.
# Every-N-hours jobs are expanded across the day; the two day-specific ones are
# tagged for the refusal message only - see the NO DAY FILTER note below.
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

# NO DAY FILTER. The weekly version skipped any busy window whose Days did not
# include its single fire day, which let a Sunday slot ignore CoachBuildDraftIngest
# entirely. A DAILY job fires on Monday and Thursday as well, so every window in
# the table applies and the filter would be a hole in the guard rather than a
# refinement of it. $b.Days now only decorates the refusal message.
foreach ($b in $busy) {
    for ($s = $b.Start; $s -lt 1440; $s += $b.Every) {
        $e = $s + $b.Run
        if ($slotStart -lt $e -and $s -lt $slotEnd) {
            $when = if ($b.Days) { "on $($b.Days -join '/')" } else { 'every day' }
            throw ("REFUSING: daily $($startDt.ToString('HH:mm')) + ${DeadlineMinutes}min overlaps " +
                   "$($b.Task) ($([timespan]::FromMinutes($s).ToString('hh\:mm'))-" +
                   "$([timespan]::FromMinutes($e).ToString('hh\:mm')) local, $when). Two Riot-calling jobs share " +
                   'ONE key budget and exceeding it SUSPENDS the key for every surface in the app. ' +
                   'Pick another slot, or fix the table in this script if an ingest moved.')
        }
    }
}
Write-Output "slot check: daily $($startDt.ToString('HH:mm')) local + ${DeadlineMinutes}min is clear of every known writer, on every day of the week"

$argument = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden ' +
            "-File $wrapper -DeadlineMinutes $DeadlineMinutes"

$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $argument

# A plain DAILY CalendarTrigger with NO repetition. Deliberate, and it is the
# reason this is -Daily rather than a 24-hour repetition hung off a one-shot
# trigger: a CalendarTrigger carrying a Repetition block skips slots on this box
# (measured on a sibling project), and a repetition WITH a duration expires and
# stops the job dead with no error in any log. That is exactly the shape that
# wrapped an hourly trigger around a twelve-hour walk on 2026-08-20. A daily
# calendar trigger needs neither, so it gets neither - and the drift test greps
# this file for the repetition property by name, so do not name it here.
$trigger = New-ScheduledTaskTrigger -Daily -At $startDt

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
#   StartWhenAvailable   the machine is not on every day at 15:00. Without this
#                        a missed day is simply skipped. This matters LESS than
#                        it did weekly (tomorrow's run catches up) but it is not
#                        free: the artifact is what the app serves, so a skipped
#                        day is a day of newly-qualified champion-roles serving
#                        no OTP block at all.
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

# THE DESCRIPTION IS PART OF THE CADENCE RECORD, so it is set on BOTH paths.
# Found the hard way on 2026-08-22: Set-ScheduledTask does not touch Description
# unless you pass one, so flipping this task weekly -> daily left the Task
# Scheduler GUI still reading "CoachBuild weekly consensus artifact re-bake"
# against a trigger that now fires every day. A stale description is worse than
# none - it is a confident wrong answer sitting in the exact place this script
# tells people not to re-cadence from.
$description = ("CoachBuild daily consensus artifact re-bake ($($startDt.ToString('HH:mm')) local): " +
                'generate, and if it changed, commit + push + deploy. ' +
                'Cadence and slot are chosen in scripts/register-rebake-task.ps1 - do not re-cadence in the GUI.')

if ($PSCmdlet.ShouldProcess($TaskName, "register daily $($startDt.ToString('HH:mm')) re-bake")) {
    if ($existing) {
        # Set-ScheduledTask has NO -Description parameter (it lives on
        # RegistrationInfo, not Settings), so the update path has to go through
        # the task object. Passing -Description to the -TaskName form fails with
        # "A parameter cannot be found" - and note that the slot check has
        # already printed "clear" by then, so the run LOOKS like it worked.
        # Verify a description change by reading it back, never by exit output.
        $existing.Description = $description
        $existing.Triggers    = $trigger
        $existing.Actions     = $action
        $existing.Settings    = $settings
        Set-ScheduledTask -InputObject $existing | Out-Null
        Write-Output "updated: $TaskName (left $(if ($settings.Enabled) { 'ENABLED' } else { 'DISABLED' }), as found)"
    } else {
        Register-ScheduledTask -TaskName $TaskName -Trigger $trigger -Action $action -Settings $settings `
            -Description $description | Out-Null
        Write-Output "created: $TaskName"
    }
}

Write-Output "  trigger:  daily at $($startDt.ToString('HH:mm')) local"
Write-Output "  wrapper:  $wrapper -DeadlineMinutes $DeadlineMinutes"
Write-Output "  limit:    ExecutionTimeLimit $($settings.ExecutionTimeLimit)"
Write-Output ""
Write-Output "Enable:  Enable-ScheduledTask -TaskName $TaskName"
Write-Output "Verify:  schtasks /Query /TN $TaskName /V /FO LIST"
Write-Output "Log:     $env:LOCALAPPDATA\CoachBuild\consensus-rebake.log"
