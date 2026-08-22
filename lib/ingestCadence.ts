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

/** Placeholder for a task whose cadence is not reproducible from the repo. */
export const UNREGISTERED = "(none -- hand-registered, cadence not in the repo)";

/**
 * The fleet cadence AS FOUND on 2026-08-21, before it was re-registered.
 *
 * Kept because a budget with no "before" is unfalsifiable: this is the shape
 * that projected OVER the quota, and the tests below assert both that it did
 * and that the applied cadence below is strictly slower. Delete it and the
 * only evidence the change did anything is a sentence in a handoff.
 *
 * Note CoachBuildDraftIngest is 84, not 168, even here. Its StartBoundary
 * falls on a Friday, which reads as weekly, but its DaysOfWeek bitmask is
 * 18 = Monday|Thursday and draft-ingest.log confirms it: 27 Jul (Mon), 30 Jul
 * (Thu), 3 Aug (Mon), 6 Aug (Thu). Modelling it as weekly halved it.
 */
export const AS_FOUND_INGESTS: readonly ScheduledIngest[] = [
  {
    task: "CoachBuildOtpPriority",
    intervalHours: 6,
    startOffsetMinutes: 10,
    runMinutes: 60,
    registeredBy: "scripts/register-otp-priority-task.ps1",
  },
  {
    task: "CoachBuildOtpIngest",
    intervalHours: 6,
    startOffsetMinutes: 4 * 60 + 20,
    runMinutes: 73,
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
    intervalHours: 84,
    startOffsetMinutes: 9 * 60,
    runMinutes: 63,
    registeredBy: UNREGISTERED,
  },
];

/**
 * The cadence as REGISTERED on this machine on 2026-08-21, and the budget the
 * fleet is now held to. ~49 CU-hours, comfortably past the 2x headroom target.
 *
 * The principle was to cut only the numbers nobody ever chose.
 * CoachBuildOtpPriority stays at 6h x 1h because the user picked that
 * deliberately on 2026-08-20 (four refreshes a day) against this exact
 * arithmetic. CoachBuildOtpIngest and CoachBuildMatchIngest, by contrast, had
 * never had a cadence chosen against a budget at all -- they were
 * hand-registered at 6-hourly and between them were 68 CU-hours, more than the
 * priority walk the incident was blamed on. Both are resumable, so a longer
 * interval slows how fast coverage deepens rather than losing work.
 *
 * CoachBuildProstageIngest goes 3h -> 6h, and the reason is worth stating
 * because it is invisible without an overlap model. At 6-hourly its :15 slots
 * fall entirely INSIDE the priority walk's :10-to-:70 windows, so all four of
 * them cost nothing at all; at 3-hourly the four extra slots (03:15, 09:15,
 * 15:15, 21:15) land in gaps where nothing else is running and each one wakes
 * the compute on its own. Halving the frequency of this job therefore removes
 * 20 active minutes a day while halving nothing anyone would notice. A per-job
 * duty-cycle table cannot see this: it would have called prostage a rounding
 * error at 2.8% and left it alone.
 *
 * All five tasks are Disabled as of 2026-08-21. These entries describe the
 * shape they resume in when enabled, which is the thing worth asserting:
 * enabling is a one-click action and re-registering is not.
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
    intervalHours: 24,
    startOffsetMinutes: 4 * 60 + 20,
    runMinutes: 73, // 53 consensus + 20 featured, sequential within one slot
    registeredBy: "scripts/register-ingest-tasks.ps1",
  },
  {
    task: "CoachBuildMatchIngest",
    intervalHours: 24,
    startOffsetMinutes: 1 * 60 + 20,
    runMinutes: 63,
    registeredBy: "scripts/register-ingest-tasks.ps1",
  },
  {
    task: "CoachBuildProstageIngest",
    intervalHours: 6,
    startOffsetMinutes: 15,
    runMinutes: 5,
    registeredBy: "scripts/register-ingest-tasks.ps1",
  },
  {
    task: "CoachBuildDraftIngest",
    intervalHours: 84, // Monday + Thursday, NOT weekly -- see AS_FOUND_INGESTS
    startOffsetMinutes: 9 * 60,
    runMinutes: 63,
    registeredBy: "scripts/register-ingest-tasks.ps1",
  },
  {
    // Registered 2026-08-22, AFTER the audit above -- see POST_AUDIT_ADDITIONS.
    //
    // Not an ingest: it regenerates public/consensus/item-set-consensus.json
    // and, only if that file actually changed, commits, pushes and deploys it.
    // It is in this table anyway because it spends the same Neon compute (the
    // generator draws ~1,730 samples through the production API) and because
    // the whole point of this file is that NO scheduled job's cadence lives
    // only in Task Scheduler.
    //
    // Sunday 15:00 local, in the week's widest gap: 13:10 (the priority walk
    // ends) to 18:10 (it starts again), on a day CoachBuildDraftIngest does not
    // run. scripts/register-rebake-task.ps1 refuses to register a colliding
    // slot rather than documenting the requirement.
    task: "CoachBuildConsensusRebake",
    intervalHours: 168,
    startOffsetMinutes: 15 * 60,
    // ~5 min of generation plus commit/push/deploy. Only the generation half
    // touches Neon, so this OVERSTATES the bill, which is the safe direction.
    runMinutes: 10,
    registeredBy: "scripts/register-rebake-task.ps1",
  },
];

/**
 * Tasks registered AFTER the 2026-08-21 cadence audit, so they have no entry in
 * AS_FOUND_INGESTS and cannot be compared against one.
 *
 * This list exists so that "no as-found entry" has to be an explicit, reviewed
 * claim. The alternative -- letting the never-sped-up test skip anything it
 * cannot find a baseline for -- would mean the way to bypass the fleet's only
 * regression check is to misspell a task name.
 */
export const POST_AUDIT_ADDITIONS: readonly string[] = ["CoachBuildConsensusRebake"];

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
