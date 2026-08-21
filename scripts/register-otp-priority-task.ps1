# CoachBuild PRIORITY DEEP WALK — Task Scheduler registration, idempotent.
#
# THE POINT OF THIS FILE. Until 2026-08-20 the only record of how this task
# should be registered was a `schtasks /create` one-liner in a comment at the
# top of ingest-otp-priority.ps1, plus a prose list of four settings you were
# supposed to go and tick by hand in the Task Scheduler GUI afterwards. That
# arrangement produced the outage: `/sc HOURLY` wrapped around a walk whose
# default was 12 hours is a ~89% duty cycle, Neon bills compute as wall-clock
# ACTIVE seconds, and the shared Free-plan 100 CU-hour quota died at
# 2026-08-20 07:57 UTC — 19 days into the billing period — taking the shop
# panel's Pro and OTP blocks down with it, silently.
#
# So the cadence now lives in a file that is committed, reviewable and
# re-runnable, and a reinstall cannot resurrect the hourly/12-hour shape by
# copying a comment.
#
# ── THE CADENCE, AND THE ARITHMETIC BEHIND IT ───────────────────────────────
# Chosen by the user 2026-08-20: FOUR REFRESHES A DAY, ONE HOUR EACH.
#
#   trigger every 6h x --max-hours 1  ->  ~17% duty  ->  ~30 CU-hours/month
#   at Neon's 0.25 CU floor, against a 100 CU-hour quota. 3.3x headroom.
#
# Recompute before touching either number:
#
#   (24 / IntervalHours) * MaxHours * 30 * 0.25  must stay well under 100
#
# The quota is per Neon PROJECT per month, and this project is SHARED with
# matchday. The walk is resumable by design (see ingest-otp-priority.ps1's
# header), so a smaller budget does not lose work — it only slows how fast
# coverage deepens. Full diagnosis: HANDOFF-marco-neon-usage.md.
#
# ── WHY NOT schtasks /create ────────────────────────────────────────────────
# Because every guarantee that keeps the duty cycle where it is turns out to be
# one `schtasks` cannot express on the command line, gets wrong by default, or
# both:
#
#   * a repetition INTERVAL other than the /sc presets, with NO repetition
#     duration (a duration would make the repetition expire and the job simply
#     stop running one day, with no error anywhere);
#   * MultipleInstancesPolicy = IgnoreNew. Without it a run that overruns its
#     slot is joined by the next one and two walks share one Riot key budget —
#     the exact failure ingest-otp-priority.ps1's yield predicate exists to
#     prevent, arriving through its own escape hatch;
#   * ExecutionTimeLimit set BELOW the trigger interval (PT2H against PT6H), so
#     a wedged run can never bridge two slots and quietly restore the ~100%
#     duty cycle this whole file exists to prevent;
#   * DisallowStartIfOnBatteries / StopIfGoingOnBatteries = false. `schtasks
#     /create` sets BOTH to true, and on this laptop that silently SKIPS the
#     trigger while unplugged: LastRunTime does not move, Status still reads
#     "Ready", and nothing is written to either log because no process ever
#     started. Observed 2026-07-29, one whole slot lost at 66% battery.
#
# ── NO ELEVATION NEEDED ─────────────────────────────────────────────────────
# The task runs as the interactive user at RunLevel Limited, so registering and
# re-cadencing it work from an ordinary terminal. If you ever see "Access is
# denied" here, the task was created elevated by something else — do not fight
# it from a normal prompt, re-run this in an Administrator terminal instead. A
# half-applied scheduler change is worse than none.
#
# ── USAGE ───────────────────────────────────────────────────────────────────
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\register-otp-priority-task.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\register-otp-priority-task.ps1 -WhatIf
#
# Idempotent: creates the task if absent, and repairs trigger/action/settings
# in place if present, without disturbing the registration date or principal.

[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$TaskName = 'CoachBuildOtpPriority',
    # Trigger interval, in hours. See the arithmetic above before changing.
    [int]$IntervalHours = 6,
    # Wall-clock ceiling handed to the walk as -MaxHours. Ditto.
    [int]$MaxHours = 1,
    # First fire of the day. :10 deliberately, off the :20 that the sibling
    # Riot jobs use, so a restart tick never lands in the same second as a
    # sibling's slot start.
    [string]$StartBoundary = '2026-07-29T00:10:00'
)

$ErrorActionPreference = 'Stop'

# Self-locating, like the wrapper it registers: resolve the repo from this
# script's own location rather than a hardcoded user path, so the task survives
# a machine or username migration.
$repo    = Split-Path -Parent $PSScriptRoot
$wrapper = Join-Path $repo 'scripts\ingest-otp-priority.ps1'
if (-not (Test-Path $wrapper)) { throw "wrapper not found: $wrapper" }

# The guard that makes the arithmetic in the header enforceable rather than
# merely documented. Duty cycle = MaxHours / IntervalHours; at Neon's 0.25 CU
# floor a 30% duty cycle is ~54 CU-hours a month and climbing toward a quota
# that is shared with another app. Refuse rather than register a shape that
# will exhaust it.
#
# Clamped at 1.0 for reporting: when MaxHours exceeds the interval the walk
# overruns its own slot and IgnoreNew simply drops the extra ticks, so the
# machine cannot actually spend more than 100% — the raw ratio would overstate
# it. The guard still tests the raw ratio, because anything above 1.0 means a
# walk permanently in flight, which is the worst case, not a smaller one.
$duty = [math]::Min($MaxHours / [double]$IntervalHours, 1.0)
$cuHoursPerMonth = [math]::Round($duty * 24 * 30 * 0.25, 1)
if (($MaxHours / [double]$IntervalHours) -gt 0.30) {
    throw ("REFUSING: -MaxHours $MaxHours every $IntervalHours h is a {0:P0} duty cycle " -f $duty) +
          "(~$cuHoursPerMonth CU-hours/month against a shared 100 CU-hour Neon quota). " +
          "This is the shape that caused the 2026-08-20 outage. Read HANDOFF-marco-neon-usage.md, " +
          "then pass explicit -IntervalHours/-MaxHours if you really mean it."
}

$argument = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden ' +
            "-File $wrapper -MaxHours $MaxHours"

$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $argument

# -Once + -RepetitionInterval and NO -RepetitionDuration: an unbounded
# repetition on a TimeTrigger. Do not add a duration "for tidiness" — a
# repetition that expires stops the job dead with no error and no log line.
$trigger = New-ScheduledTaskTrigger -Once -At ([datetime]$StartBoundary) `
             -RepetitionInterval (New-TimeSpan -Hours $IntervalHours)

# Two corrections to what New-ScheduledTaskTrigger emits, both verified against
# the task XML (Export-ScheduledTask), because neither is expressible as a
# parameter:
#
#   1. It writes <StopAtDurationEnd>true</StopAtDurationEnd> while writing NO
#      <Duration>. That pairing is inert today — an absent duration means
#      "repeat indefinitely", so there is no duration end to stop at — but it
#      is one hand-edit away from a repetition that silently expires and stops
#      the job forever with no error in any log. Say false and mean it.
#   2. It stamps the StartBoundary with the CURRENT UTC offset
#      (2026-07-29T00:10:00+01:00), pinning the schedule to absolute time, so
#      every fire slides by an hour when the clock changes and the :10 slots
#      drift onto the sibling Riot jobs' :20. A naive local boundary floats
#      with local time and keeps 00:10 / 06:10 / 12:10 / 18:10 all year.
$trigger.Repetition.StopAtDurationEnd = $false
$trigger.StartBoundary = ([datetime]$StartBoundary).ToString('yyyy-MM-ddTHH:mm:ss')

# Set-ScheduledTask REPLACES the whole settings object, so every setting worth
# keeping has to be restated here in one call. All four of these are load-
# bearing; see the header for what each one prevents.
$settings = New-ScheduledTaskSettingsSet `
              -AllowStartIfOnBatteries `
              -DontStopIfGoingOnBatteries `
              -MultipleInstances IgnoreNew `
              -StartWhenAvailable `
              -ExecutionTimeLimit (New-TimeSpan -Hours ([math]::Max(2, $MaxHours + 1)))

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue

# RE-CADENCING MUST NOT ALSO RE-ENABLE. Set-ScheduledTask REPLACES the settings
# object wholesale, and Enabled lives in that object: a settings set fresh from
# New-ScheduledTaskSettingsSet carries Enabled = True, so running this script
# against a DISABLED task silently turns it back on. Verified 2026-08-21 on a
# throwaway task: Disabled -> Set-ScheduledTask -> Ready.
#
# That is a live hazard, not a theoretical one. The five CoachBuild ingest tasks
# were disabled on 2026-08-20 to stop the Neon burn, and StartWhenAvailable is
# true, so a re-enabled task with a missed slot behind it does not wait for the
# next 6-hourly tick -- it fires almost immediately, against whatever the shared
# Riot key is doing at the time. "Fix the cadence" must never mean "start the
# job". Carry the previous state forward and let enabling stay a separate,
# deliberate act.
if ($existing) { $settings.Enabled = $existing.Settings.Enabled }

if ($PSCmdlet.ShouldProcess($TaskName, "register every ${IntervalHours}h x ${MaxHours}h walk (~$cuHoursPerMonth CU-hours/mo)")) {
    if ($existing) {
        Set-ScheduledTask -TaskName $TaskName -Trigger $trigger -Action $action -Settings $settings | Out-Null
        Write-Output "updated: $TaskName (left $(if ($settings.Enabled) { 'ENABLED' } else { 'DISABLED' }), as found)"
    } else {
        Register-ScheduledTask -TaskName $TaskName -Trigger $trigger -Action $action -Settings $settings `
            -Description 'CoachBuild OTP priority deep walk. Cadence is a Neon compute budget - see scripts/register-otp-priority-task.ps1.' | Out-Null
        Write-Output "created: $TaskName"
    }
}

Write-Output "  trigger:  every $IntervalHours h from $StartBoundary"
Write-Output "  walk:     -MaxHours $MaxHours"
Write-Output "  duty:     $([math]::Round($duty * 100, 1))%  (~$cuHoursPerMonth CU-hours/month at 0.25 CU, quota 100, shared with matchday)"
Write-Output ""
Write-Output "Verify:  schtasks /Query /TN $TaskName /V /FO LIST"
