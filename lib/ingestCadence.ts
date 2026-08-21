// Scheduled-ingest cadence, as a committed budget rather than a Task Scheduler
// state nobody can review.
//
// WHY THIS FILE EXISTS. On 2026-08-20 the shared Neon Free-plan compute quota
// was exhausted at 07:57 UTC and the in-game shop panel silently lost its Pro
// and OTP build blocks for nine hours. The cause was a cadence: a 12-hour walk
// on an HOURLY trigger. The post-incident finding was that the cadence lived
// only in a comment plus a list of GUI steps, which is why it drifted -- there
// was no place in the repo where the fleet-wide number could be read, reviewed
// or asserted, so nobody could see that it did not fit.
//
// scripts/register-otp-priority-task.ps1 fixed that for ONE task. This file
// does it for the fleet, because the quota is per Neon PROJECT and it is the
// SUM of every job that has to fit under it. Fixing the worst offender in
// isolation is exactly how the remaining ~102 CU-hours went unnoticed.
//
// NEON BILLING, which is the whole reason cadence dominates: compute is billed
// as wall-clock ACTIVE seconds, not per query. These walks issue statements
// continuously, so the compute never reaches the Free-plan autosuspend
// threshold (fixed at 5 minutes idle, not configurable) for as long as a job
// runs. Duty cycle IS the bill. Query optimisation is worth almost nothing
// here; the trigger interval is worth everything.

/** Neon Free plan: CU-hours per PROJECT per calendar month. */
export const NEON_FREE_CU_HOUR_QUOTA = 100;

/**
 * Compute size the walks actually run at. Confirmed by the incident numbers
 * (413 active hours billed 103.4 CU-hours = 0.2503 CU), which is the Free-plan
 * floor: these jobs are I/O-bound on the Riot API, so the compute never
 * autoscales above the minimum.
 */
export const CU_SIZE = 0.25;

export type ScheduledIngest = {
  /** Windows Task Scheduler task name. */
  readonly task: string;
  /** Trigger repetition interval, in hours. */
  readonly intervalHours: number;
  /** Minutes past midnight of the first fire, so overlap can be modelled. */
  readonly startOffsetMinutes: number;
  /**
   * Wall-clock minutes one run keeps the Neon compute active. MEASURED from
   * the logs under %LOCALAPPDATA%\CoachBuild (median of successful August 2026
   * runs), not estimated -- an assumed runtime is how a duty cycle drifts.
   */
  readonly runMinutes: number;
  /** Where this cadence is actually registered from. */
  readonly registeredBy: string;
};

/** Tasks whose cadence is reproducible from a committed script. */
export const UNREGISTERED = "(none -- hand-registered, cadence not in the repo)";

/**
 * The cadence as REGISTERED on this machine on 2026-08-21, after 33785c7.
 *
 * All five tasks are currently Disabled. These entries describe the shape they
 * would resume in when enabled, which is the thing worth asserting: enabling is
 * a one-click action and re-registering is not.
 */
export const SCHEDULED_INGESTS: readonly ScheduledIngest[] = [
  {
    task: "CoachBuildOtpPriority",
    intervalHours: 6,
    startOffsetMinutes: 10, // 00:10 / 06:10 / 12:10 / 18:10
    runMinutes: 60, // hard-bounded by -MaxHours 1; the walk exits cleanly
    registeredBy: "scripts/register-otp-priority-task.ps1",
  },
  {
    task: "CoachBuildOtpIngest",
    intervalHours: 6,
    startOffsetMinutes: 4 * 60 + 20,
    runMinutes: 73, // 53 consensus + 20 featured, sequential within one slot
    registeredBy: UNREGISTERED,
  },
  {
    task: "CoachBuildMatchIngest",
    intervalHours: 6,
    startOffsetMinutes: 1 * 60 + 20,
    runMinutes: 63,
    registeredBy: UNREGISTERED,
  },
  {
    task: "CoachBuildProstageIngest",
    intervalHours: 3,
    startOffsetMinutes: 15,
    runMinutes: 5,
    registeredBy: UNREGISTERED,
  },
  {
    task: "CoachBuildDraftIngest",
    intervalHours: 168, // weekly
    startOffsetMinutes: 9 * 60,
    runMinutes: 63,
    registeredBy: UNREGISTERED,
  },
];

/**
 * Active minutes per day, counting OVERLAP ONCE.
 *
 * Summing the jobs overstates the bill: two walks running at the same time keep
 * ONE compute awake and Neon bills that compute once. The slots genuinely do
 * collide (the :10 priority walk runs straight through the :15 prostage slot),
 * so the union is the honest number and the sum is an upper bound.
 */
export function activeMinutesPerDay(
  tasks: readonly ScheduledIngest[] = SCHEDULED_INGESTS,
): number {
  const minute = new Uint8Array(1440);
  let subDaily = 0;

  for (const t of tasks) {
    if (t.intervalHours > 24) {
      // Fires LESS often than daily: amortise rather than paint a day it may
      // not land on. A weekly 63-minute job is 9 minutes of an average day.
      //
      // The boundary is > 24, not >= 24, on purpose. An exactly-daily job fires
      // on every single day at a known offset, so it must be PAINTED like any
      // other -- amortising it would discard its overlap with the walks it
      // collides with and overstate the bill. That distinction is worth ~2.5
      // CU-hours here, which is the difference between clearing a 2x headroom
      // target and missing it.
      subDaily += (t.runMinutes * 24) / t.intervalHours;
      continue;
    }
    const intervalMinutes = t.intervalHours * 60;
    for (
      let start = t.startOffsetMinutes;
      start < t.startOffsetMinutes + 1440;
      start += intervalMinutes
    ) {
      for (let m = start; m < start + t.runMinutes; m++) minute[m % 1440] = 1;
    }
  }

  let painted = 0;
  for (const m of minute) painted += m;
  return painted + subDaily;
}

/** Projected CU-hours for a 30-day month at the given cadence. */
export function projectedCuHours(
  tasks: readonly ScheduledIngest[] = SCHEDULED_INGESTS,
): number {
  return (activeMinutesPerDay(tasks) / 60) * 30 * CU_SIZE;
}

/**
 * Headroom multiple the fleet cadence must clear. 1.0 is not a target: it means
 * a single 31-day month, one retry storm, or the app's own query traffic tips
 * the project over -- and a Neon 402 is indistinguishable from empty data to
 * every caller that does not explicitly check.
 */
export const REQUIRED_HEADROOM = 2;

/**
 * The cadence this file recommends: ~48 CU-hours, 2.1x headroom.
 *
 * The principle is to cut only the numbers nobody ever chose. CoachBuildOtpPriority
 * stays at 6h x 1h because the user picked that deliberately on 2026-08-20
 * (four refreshes a day) against this exact arithmetic. CoachBuildOtpIngest and
 * CoachBuildMatchIngest, by contrast, have never had a cadence chosen against a
 * budget at all -- they were hand-registered at 6-hourly and between them are
 * 68 CU-hours, more than the priority walk the incident was blamed on. Both are
 * resumable, so a longer interval slows how fast coverage deepens rather than
 * losing work.
 *
 * CoachBuildProstageIngest goes 3h -> 6h, and the reason is worth stating
 * because it is invisible without an overlap model. At 6-hourly its :15 slots
 * fall entirely INSIDE the priority walk's :10-to-:70 windows, so all four of
 * them cost nothing at all; at 3-hourly the four extra slots (03:15, 09:15,
 * 15:15, 21:15) land in gaps where nothing else is running and each one wakes
 * the compute on its own. Halving the frequency of this job therefore removes
 * 20 active minutes a day -- 2.5 CU-hours, the margin that takes the fleet from
 * 1.98x to 2.08x -- while halving nothing anyone would notice. A per-job duty
 * cycle table cannot see this: it would have called prostage a rounding error
 * at 2.8% and left it alone.
 */
export const RECOMMENDED_INGESTS: readonly ScheduledIngest[] = SCHEDULED_INGESTS.map(
  (t) => {
    if (t.task === "CoachBuildOtpIngest" || t.task === "CoachBuildMatchIngest") {
      return { ...t, intervalHours: 24 };
    }
    if (t.task === "CoachBuildProstageIngest") return { ...t, intervalHours: 6 };
    return t;
  },
);
