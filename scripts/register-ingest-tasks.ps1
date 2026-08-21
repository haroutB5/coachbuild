# CoachBuild SIBLING INGESTS — Task Scheduler registration, idempotent.
#
# THE POINT OF THIS FILE. scripts/register-otp-priority-task.ps1 took ONE task
# out of the GUI and put its cadence in the repo. The other four had no
# registration script at all: their cadence existed only as Task Scheduler
# state on one machine, unreviewable, un-diffable, and unrecoverable after a
# rebuild. That is the precondition the 2026-08-20 Neon outage write-up named,
# and leaving four of five tasks in it would have guaranteed the next drift.
#
# What that gap was already hiding, found while writing this file:
#
#   * CoachBuildMatchIngest, CoachBuildProstageIngest and CoachBuildDraftIngest
#     all carried ExecutionTimeLimit = PT72H. A wedged run could therefore
#     bridge 24 consecutive 3-hourly slots and hold the Neon compute awake for
#     three days, which is the ~100% duty cycle the incident was about,
#     arriving through a setting nobody had ever looked at.
#   * CoachBuildDraftIngest is NOT weekly. Its StartBoundary falls on a Friday,
#     which is what a casual read of the XML suggests, but DaysOfWeek is 18 =
#     Monday|Thursday, so it fires TWICE a week. Confirmed against
#     draft-ingest.log (27 Jul Mon, 30 Jul Thu, 3 Aug Mon, 6 Aug Thu, ...).
#     Any budget that modelled it as weekly understated it by half.
#
# ── THE CADENCE, AND THE ARITHMETIC BEHIND IT ───────────────────────────────
# The Neon Free quota is 100 CU-hours per PROJECT per calendar month, and Neon
# bills compute as wall-clock ACTIVE seconds. These walks issue statements
# continuously, so the compute never reaches the 5-minute autosuspend threshold
# while a job runs: DUTY CYCLE IS THE BILL. Query tuning is worth nothing here;
# the trigger interval is worth everything.
#
# As found (2026-08-21) the five-task fleet projected to ~102 CU-hours against
# that 100. Fixing only the task the incident was blamed on left the other four
# holding ~72 of those CU-hours. Applied here:
#
#   CoachBuildOtpIngest       6h -> 24h   never chosen against a budget; the
#                                         walk is resumable, so a longer
#                                         interval slows how fast coverage
#                                         deepens, it does not lose work.
#   CoachBuildMatchIngest     6h -> 24h   ditto, also resumable.
#   CoachBuildProstageIngest  3h ->  6h   at 6h its :15 slots fall entirely
#                                         INSIDE the priority walk's :10-to-:70
#                                         windows and cost nothing; at 3h the
#                                         four extra slots land in gaps and each
#                                         wakes the compute alone.
#   CoachBuildDraftIngest     unchanged   Mon+Thu, ~2.3 CU-hours. Irrelevant.
#
# The full overlap-aware model, and the tests that hold these numbers to the
# ones below, live in lib/ingestCadence.ts and lib/__tests__/ingestCadence.ts.
# Change an interval here without changing it there and the suite fails, which
# is the entire point: two records of one number silently disagreeing is the
# mechanism that produced the outage.
#
# ── WHY NOT schtasks /create ────────────────────────────────────────────────
# Same four reasons as register-otp-priority-task.ps1, and they all still bite:
# a repetition interval with NO duration (a duration makes the repetition
# expire and the job stops dead with no error anywhere); MultipleInstances =
# IgnoreNew, without which an overrunning run is joined by the next one and two
# walks share one Riot key; ExecutionTimeLimit BELOW the trigger interval, so a
# wedged run can never bridge two slots; and battery settings, which `schtasks
# /create` sets to skip the trigger while unplugged — silently, with Status
# still reading "Ready" and nothing in any log because no process ever started.
#
# ── THIS SCRIPT DOES NOT ENABLE ANYTHING ────────────────────────────────────
# Set-ScheduledTask REPLACES the whole settings object, and Enabled lives in
# that object, so a settings set fresh from New-ScheduledTaskSettingsSet
# carries Enabled = True and re-cadencing a DISABLED task silently starts it.
# Measured on a throwaway task 2026-08-21: Disabled -> Set-ScheduledTask ->
# Ready. All five ingest tasks were disabled on 2026-08-20 to stop the Neon
# burn, and StartWhenAvailable is true, so a re-enabled task with a missed slot
# behind it does not wait for its next tick — it fires within minutes, into
# whatever the shared Riot key is doing at the time. "Fix the cadence" must
# never mean "start the job". The previous state is carried forward and
# enabling stays a separate, deliberate act.
#
# ── NO ELEVATION NEEDED ─────────────────────────────────────────────────────
# All four run as the interactive user at RunLevel Limited. If you see "Access
# is denied", something re-created a task elevated — do not fight it from a
# normal prompt, re-run this in an Administrator terminal. A half-applied
# scheduler change is worse than none.
#
# ── USAGE ───────────────────────────────────────────────────────────────────
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\register-ingest-tasks.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\register-ingest-tasks.ps1 -WhatIf
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\register-ingest-tasks.ps1 -TaskName CoachBuildProstageIngest
#
# Idempotent: creates a task if absent, repairs trigger/action/settings in place
# if present, and never changes its enabled state.

[CmdletBinding(SupportsShouldProcess = $true)]
param(
    # Restrict the run to one task. Default: all four.
    [string]$TaskName,

    # ── THE CADENCE. These four defaults ARE the registered cadence, and
    # lib/__tests__/ingestCadence.test.ts parses them straight out of this file
    # and compares them against lib/ingestCadence.ts. Recompute the fleet total
    # before touching any of them.
    [int]$OtpIngestIntervalHours = 24,
    [int]$MatchIngestIntervalHours = 24,
    [int]$ProstageIntervalHours = 6,
    # 84 = twice a week. Not 168: see the header. Derived from $DraftDays and
    # asserted against it below, so the two cannot drift apart.
    [int]$DraftIntervalHours = 84,

    # Days CoachBuildDraftIngest fires on. Unchanged from what is registered.
    [string[]]$DraftDays = @('Monday', 'Thursday')
)

$ErrorActionPreference = 'Stop'

# Self-locating, like the wrappers it registers: resolve the repo from this
# script's own location rather than a hardcoded user path, so the tasks survive
# a machine or username migration. (Computed here, never in a param default —
# $PSScriptRoot is empty inside a param block under Windows PowerShell 5.1.)
$repo = Split-Path -Parent $PSScriptRoot

if ((168 / $DraftDays.Count) -ne $DraftIntervalHours) {
    throw "-DraftIntervalHours $DraftIntervalHours disagrees with $($DraftDays.Count) day(s) a week (expected $(168 / $DraftDays.Count))"
}

# ── THE TABLE ───────────────────────────────────────────────────────────────
# runMinutes is MEASURED (median of successful August 2026 runs in
# %LOCALAPPDATA%\CoachBuild), not estimated, and exists here only to make the
# refusal guard below computable. The authoritative copy, with the overlap
# model, is lib/ingestCadence.ts.
#
# limitMin (ExecutionTimeLimit) is per-task and deliberately NOT derived from the
# interval: CoachBuildOtpIngest legitimately runs up to ~2h45 (a 120-minute
# consensus budget plus the ~24-minute featured half chained after it), while
# CoachBuildProstageIngest has never exceeded single-digit minutes. What every
# entry must satisfy is limit < interval, so a wedged run can never bridge two
# slots — asserted below.
#
# In MINUTES, not fractional hours, because `New-TimeSpan -Hours` binds to an
# [int]: -Hours 2.75 silently registers PT3H. Observed on the first run of this
# script. A setting that rounds itself is the kind nobody ever re-reads.
$tasks = @(
    @{
        name      = 'CoachBuildOtpIngest'
        wrapper   = 'scripts\ingest-otp-scheduled.ps1'
        interval  = $OtpIngestIntervalHours
        boundary  = '2026-08-22T04:20:00'
        limitMin  = 165   # 120-min consensus budget + the ~24-min featured half + slack
        runMin    = 73
        weekly    = $false
        desc      = 'CoachBuild OTP discovery + match ingest (consensus walk, then the featured half). Cadence is a Neon compute budget - see scripts/register-ingest-tasks.ps1.'
    },
    @{
        name      = 'CoachBuildMatchIngest'
        wrapper   = 'scripts\ingest-matches-scheduled.ps1'
        interval  = $MatchIngestIntervalHours
        boundary  = '2026-08-22T01:20:00'
        limitMin  = 180   # ~3x the 63-min median
        runMin    = 63
        weekly    = $false
        desc      = 'CoachBuild solo-queue match sweep. Cadence is a Neon compute budget - see scripts/register-ingest-tasks.ps1.'
    },
    @{
        name      = 'CoachBuildProstageIngest'
        wrapper   = 'scripts\ingest-prostage-scheduled.ps1'
        interval  = $ProstageIntervalHours
        boundary  = '2026-08-22T00:15:00'
        limitMin  = 120   # median is 5 min; this is a wedge detector, not a budget
        runMin    = 5
        weekly    = $false
        desc      = 'CoachBuild pro-stage live feed + export ingest. Cadence is a Neon compute budget - see scripts/register-ingest-tasks.ps1.'
    },
    @{
        name      = 'CoachBuildDraftIngest'
        wrapper   = 'scripts\ingest-draft-scheduled.ps1'
        interval  = $DraftIntervalHours
        boundary  = '2026-08-24T09:00:00'
        limitMin  = 180   # ~3x the 63-min median
        runMin    = 63
        weekly    = $true
        desc      = "CoachBuild draft/patch ingest, $($DraftDays -join '+') 09:00. Cadence is a Neon compute budget - see scripts/register-ingest-tasks.ps1."
    }
)

# ── THE REFUSAL GUARD ───────────────────────────────────────────────────────
# A COARSE upper bound, on purpose. This sums the four jobs plus the priority
# walk's 30 CU-hours and ignores overlap, so it always overstates the bill —
# which is the right direction for a tripwire that must never wave through a
# cadence that does not fit. The precise, overlap-aware figure and the 2x
# headroom gate live in lib/ingestCadence.ts, because painting a 1440-minute
# day in two languages would be two records of one algorithm, which is the
# problem this whole exercise is about. If this throws, the cadence is wrong by
# any measure; passing it is necessary, not sufficient.
$OTP_PRIORITY_CU_HOURS = 30.0   # 6h x 1h, from register-otp-priority-task.ps1
$FLEET_CU_HOUR_TRIPWIRE = 60.0  # vs a 100 CU-hour quota SHARED with matchday

$fleetCu = $OTP_PRIORITY_CU_HOURS
foreach ($t in $tasks) {
    if ($t.interval -le 0) { throw "$($t.name): interval must be positive" }
    if (($t.limitMin / 60.0) -ge $t.interval) {
        throw ("$($t.name): ExecutionTimeLimit $($t.limitMin)min is not below the $($t.interval)h trigger interval. " +
               'A run that outlives its own slot restores the ~100% duty cycle this file exists to prevent.')
    }
    $minutesPerDay = $t.runMin * (24.0 / $t.interval)
    $fleetCu += ($minutesPerDay / 60.0) * 30 * 0.25
}
$fleetCu = [math]::Round($fleetCu, 1)
if ($fleetCu -gt $FLEET_CU_HOUR_TRIPWIRE) {
    throw ("REFUSING: this cadence projects to ~$fleetCu CU-hours/month (upper bound, overlap ignored) " +
           "against a 100 CU-hour Neon quota shared with matchday. That is the shape that caused the " +
           '2026-08-20 outage. Read HANDOFF-ingest-cadence.md, then pass explicit -*IntervalHours if you really mean it.')
}

$selected = if ($TaskName) { $tasks | Where-Object { $_.name -eq $TaskName } } else { $tasks }
if (-not $selected) { throw "no such task in this file: $TaskName" }

foreach ($t in $selected) {
    $wrapper = Join-Path $repo $t.wrapper
    if (-not (Test-Path $wrapper)) { throw "wrapper not found: $wrapper" }

    # Every wrapper must resolve DATABASE_URL to the rebuilt Neon project
    # before it runs. Until 2026-08-21 none of them did: they inherited
    # .env.local's OLD, matchday-shared, exhausted project through
    # scripts/_env.mjs, so enabling these tasks would have left the rebuilt
    # database empty while re-burning the quota that broke. Refuse to register
    # a wrapper that has not been fixed, rather than register a task whose
    # writes land somewhere nobody intended.
    $wrapperText = Get-Content $wrapper -Raw
    if ($wrapperText -notmatch '_cbnew-db\.ps1' -or $wrapperText -notmatch '\$CbnewDbResolved') {
        throw ("REFUSING: $($t.wrapper) does not dot-source scripts\_cbnew-db.ps1 and check " +
               '$CbnewDbResolved, so it would ingest into whatever .env.local points at.')
    }

    $argument = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden ' + "-File $wrapper"
    $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $argument

    if ($t.weekly) {
        $trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek $DraftDays `
                     -At ([datetime]$t.boundary) -WeeksInterval 1
    } else {
        # -Once + -RepetitionInterval and NO -RepetitionDuration: an unbounded
        # repetition on a TimeTrigger. Do not add a duration "for tidiness" — a
        # repetition that expires stops the job dead with no error, no log line
        # and a Status that still reads "Ready".
        $trigger = New-ScheduledTaskTrigger -Once -At ([datetime]$t.boundary) `
                     -RepetitionInterval (New-TimeSpan -Hours $t.interval)
        # New-ScheduledTaskTrigger writes <StopAtDurationEnd>true</> while
        # writing NO <Duration>. Inert today (no duration means repeat forever,
        # so there is no duration end), but one hand-edit from a repetition
        # that silently expires. Say false and mean it.
        $trigger.Repetition.StopAtDurationEnd = $false
    }

    # A NAIVE, offset-free StartBoundary. New-ScheduledTaskTrigger stamps the
    # CURRENT UTC offset, which pins the schedule to absolute time so every
    # fire slides by an hour at the clock change. CoachBuildOtpIngest was
    # already registered that way (2026-07-28T04:20:00+01:00) and would have
    # drifted its :20 slots onto its siblings'. A naive boundary floats with
    # local time and holds 04:20 all year.
    $trigger.StartBoundary = ([datetime]$t.boundary).ToString('yyyy-MM-ddTHH:mm:ss')

    # Set-ScheduledTask REPLACES the whole settings object, so everything worth
    # keeping is restated here in one call. All five are load-bearing; see the
    # header for what each prevents.
    #
    # StartWhenAvailable is true, and for a DAILY job that is the safer error:
    # its 04:20 slot lands while a laptop is usually asleep, and without this a
    # missed slot is simply skipped — a whole day of ingest lost with nothing
    # written anywhere. The cost is that ENABLING a task with a missed slot
    # behind it fires it within minutes rather than at its next tick. That is
    # why the enable step is ordered, and why it must not be run while a manual
    # ingest is holding the Riot key.
    $settings = New-ScheduledTaskSettingsSet `
                  -AllowStartIfOnBatteries `
                  -DontStopIfGoingOnBatteries `
                  -MultipleInstances IgnoreNew `
                  -StartWhenAvailable `
                  -ExecutionTimeLimit (New-TimeSpan -Minutes $t.limitMin)

    $existing = Get-ScheduledTask -TaskName $t.name -ErrorAction SilentlyContinue

    # RE-CADENCING MUST NOT ALSO RE-ENABLE. See the header — Enabled lives in
    # the settings object that Set-ScheduledTask replaces wholesale.
    if ($existing) { $settings.Enabled = $existing.Settings.Enabled }

    $cadence = if ($t.weekly) { "$($DraftDays -join '+') at $(([datetime]$t.boundary).ToString('HH:mm'))" }
               else { "every $($t.interval)h from $($t.boundary)" }

    if ($PSCmdlet.ShouldProcess($t.name, "register $cadence")) {
        if ($existing) {
            Set-ScheduledTask -TaskName $t.name -Trigger $trigger -Action $action -Settings $settings | Out-Null
            Write-Output "updated: $($t.name) (left $(if ($settings.Enabled) { 'ENABLED' } else { 'DISABLED' }), as found)"
        } else {
            Register-ScheduledTask -TaskName $t.name -Trigger $trigger -Action $action -Settings $settings `
                -Description $t.desc | Out-Null
            Write-Output "created: $($t.name) (DISABLED by default is NOT automatic - verify before walking away)"
        }
    }
    Write-Output "  trigger:  $cadence"
    Write-Output "  limit:    $($t.limitMin) min execution time limit, IgnoreNew, runs on battery"
}

Write-Output ""
Write-Output "fleet upper bound: ~$fleetCu CU-hours/month (incl. CoachBuildOtpPriority's $OTP_PRIORITY_CU_HOURS), quota 100, shared with matchday"
Write-Output "Verify:  Get-ScheduledTask | Where-Object TaskName -like 'CoachBuild*' | Select-Object TaskName, State"
