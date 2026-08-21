import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CU_SIZE,
  NEON_FREE_CU_HOUR_QUOTA,
  RECOMMENDED_INGESTS,
  REQUIRED_HEADROOM,
  SCHEDULED_INGESTS,
  UNREGISTERED,
  activeMinutesPerDay,
  projectedCuHours,
  type ScheduledIngest,
} from "@/lib/ingestCadence";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const REGISTER_SCRIPT = path.join(REPO_ROOT, "scripts", "register-otp-priority-task.ps1");

const task = (name: string): ScheduledIngest => {
  const found = SCHEDULED_INGESTS.find((t) => t.task === name);
  if (!found) throw new Error(`no cadence entry for ${name}`);
  return found;
};

describe("activeMinutesPerDay", () => {
  it("counts a non-overlapping job as frequency x duration", () => {
    const minutes = activeMinutesPerDay([
      { task: "a", intervalHours: 6, startOffsetMinutes: 0, runMinutes: 60, registeredBy: "x" },
    ]);
    expect(minutes).toBe(4 * 60);
  });

  it("counts fully overlapping jobs ONCE, because they share one compute", () => {
    // The failure mode this guards: summing per-job duty cycles double-counts
    // wall-clock seconds Neon only bills once, which makes a cadence look worse
    // than it is -- and the opposite error (assuming jobs never collide) makes
    // it look better. Both matter when the answer sits within 2% of the quota.
    const both = activeMinutesPerDay([
      { task: "a", intervalHours: 24, startOffsetMinutes: 0, runMinutes: 60, registeredBy: "x" },
      { task: "b", intervalHours: 24, startOffsetMinutes: 0, runMinutes: 60, registeredBy: "x" },
    ]);
    expect(both).toBe(60); // one hour of wall clock, billed once
  });

  it("paints an exactly-daily job rather than amortising it", () => {
    // Guards the > 24 vs >= 24 boundary. If a 24h job took the amortised path
    // its overlap with everything else would be discarded and the fleet
    // projection would come out ~2.5 CU-hours too high.
    const alone = activeMinutesPerDay([
      { task: "a", intervalHours: 24, startOffsetMinutes: 600, runMinutes: 60, registeredBy: "x" },
    ]);
    expect(alone).toBe(60);
    const hidden = activeMinutesPerDay([
      { task: "a", intervalHours: 24, startOffsetMinutes: 600, runMinutes: 60, registeredBy: "x" },
      { task: "b", intervalHours: 12, startOffsetMinutes: 600, runMinutes: 60, registeredBy: "x" },
    ]);
    expect(hidden).toBe(120); // the daily job hides inside one of b's two slots
  });

  it("paints partial overlap as a union, not a sum", () => {
    const minutes = activeMinutesPerDay([
      { task: "a", intervalHours: 12, startOffsetMinutes: 0, runMinutes: 60, registeredBy: "x" },
      { task: "b", intervalHours: 12, startOffsetMinutes: 30, runMinutes: 60, registeredBy: "x" },
    ]);
    // Each pair spans 00:00-01:30, twice a day. Sum would say 240.
    expect(minutes).toBe(180);
  });

  it("amortises a weekly job rather than painting a whole day", () => {
    const minutes = activeMinutesPerDay([
      { task: "w", intervalHours: 168, startOffsetMinutes: 0, runMinutes: 70, registeredBy: "x" },
    ]);
    expect(minutes).toBeCloseTo(10, 5); // 70 min / 7 days
  });
});

describe("projectedCuHours", () => {
  it("reproduces the incident's own arithmetic", () => {
    // 2026-08-20: 413 active hours billed 103.4 CU-hours over a 19-day period.
    // Same model, run forward over a 30-day month at that duty cycle.
    const activeHoursPerDay = 413 / 19;
    expect((activeHoursPerDay * 30 * CU_SIZE)).toBeCloseTo(163, 0);
  });

  it("is linear in CU size and duration", () => {
    const one: ScheduledIngest[] = [
      { task: "a", intervalHours: 24, startOffsetMinutes: 0, runMinutes: 60, registeredBy: "x" },
    ];
    expect(projectedCuHours(one)).toBeCloseTo(1 * 30 * CU_SIZE, 5);
  });
});

describe("the registered cadence matches the script that registers it", () => {
  // The drift gate. scripts/register-otp-priority-task.ps1 is the only
  // supported way to (re-)cadence CoachBuildOtpPriority, so its param defaults
  // ARE the cadence. If someone changes them without updating this table -- or
  // updates this table without changing them -- the two records of the same
  // number have silently diverged, which is precisely the condition that
  // produced the 2026-08-20 outage.
  const script = readFileSync(REGISTER_SCRIPT, "utf8");

  const psDefault = (param: string): number => {
    const m = new RegExp(String.raw`\[int\]\$${param}\s*=\s*(\d+)`).exec(script);
    if (!m) throw new Error(`could not read [int]$${param} default from ${REGISTER_SCRIPT}`);
    return Number(m[1]);
  };

  it("uses the script's -IntervalHours default", () => {
    expect(task("CoachBuildOtpPriority").intervalHours).toBe(psDefault("IntervalHours"));
  });

  it("uses the script's -MaxHours default as the run duration", () => {
    // The walk bounds ITSELF at -MaxHours and exits cleanly, so -MaxHours is
    // the wall-clock ceiling, not an estimate.
    expect(task("CoachBuildOtpPriority").runMinutes).toBe(psDefault("MaxHours") * 60);
  });

  it("stays inside the script's own refusal threshold", () => {
    const m = /-gt\s+(0\.\d+)\)\s*\{/.exec(script);
    expect(m, "register-otp-priority-task.ps1 lost its duty-cycle refusal guard").not.toBeNull();
    const threshold = Number(m![1]);
    const entry = task("CoachBuildOtpPriority");
    const duty = entry.runMinutes / 60 / entry.intervalHours;
    expect(duty).toBeLessThanOrEqual(threshold);
  });
});

describe("fleet budget against the Neon Free quota", () => {
  it("KNOWN OVER QUOTA: the currently registered fleet cadence does not fit", () => {
    // Deliberately asserting a known-bad fact rather than leaving it unmeasured.
    //
    // 33785c7 fixed CoachBuildOtpPriority (an ~89% duty cycle, ~160 CU-hours)
    // down to ~17% / ~30 CU-hours. But the quota is per PROJECT, and the four
    // sibling ingests were never in scope: together the fleet still projects to
    // ~102 CU-hours against a 100 CU-hour quota. Enabling all five tasks as
    // registered re-runs the outage on a longer fuse.
    //
    // WHEN THE CADENCE IS RE-REGISTERED: update SCHEDULED_INGESTS to the new
    // shape and replace this test with the headroom assertion below. This test
    // failing means the fleet now fits, which is good news that must be
    // recorded here rather than silently swallowed.
    const projected = projectedCuHours(SCHEDULED_INGESTS);
    expect(projected).toBeGreaterThan(NEON_FREE_CU_HOUR_QUOTA);
    expect(projected).toBeLessThan(110); // pins the figure; catches model drift
  });

  it("the recommended cadence clears the quota with the required headroom", () => {
    const projected = projectedCuHours(RECOMMENDED_INGESTS);
    expect(projected).toBeLessThanOrEqual(NEON_FREE_CU_HOUR_QUOTA / REQUIRED_HEADROOM);
  });

  it("the recommendation only slows jobs down, never speeds them up", () => {
    for (const rec of RECOMMENDED_INGESTS) {
      const current = task(rec.task);
      expect(rec.intervalHours).toBeGreaterThanOrEqual(current.intervalHours);
      expect(rec.runMinutes).toBeLessThanOrEqual(current.runMinutes);
    }
  });
});

describe("cadence provenance", () => {
  it("records which tasks still have no committed registration script", () => {
    // Not a style point. A cadence that exists only in Task Scheduler cannot be
    // reviewed, cannot be restored after a machine rebuild, and drifts without
    // leaving a diff -- the exact mechanism named in the incident write-up.
    const unregistered = SCHEDULED_INGESTS.filter((t) => t.registeredBy === UNREGISTERED).map(
      (t) => t.task,
    );
    expect(unregistered).toEqual([
      "CoachBuildOtpIngest",
      "CoachBuildMatchIngest",
      "CoachBuildProstageIngest",
      "CoachBuildDraftIngest",
    ]);
  });

  it("CoachBuildOtpPriority points at a registration script that exists", () => {
    const entry = task("CoachBuildOtpPriority");
    expect(entry.registeredBy).not.toBe(UNREGISTERED);
    expect(() => readFileSync(path.join(REPO_ROOT, entry.registeredBy), "utf8")).not.toThrow();
  });
});
