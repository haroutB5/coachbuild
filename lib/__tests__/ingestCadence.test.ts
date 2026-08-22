import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  AS_FOUND_INGESTS,
  CU_SIZE,
  POST_AUDIT_ADDITIONS,
  NEON_FREE_CU_HOUR_QUOTA,
  REQUIRED_HEADROOM,
  SCHEDULED_INGESTS,
  UNREGISTERED,
  activeMinutesPerDay,
  projectedCuHours,
  type ScheduledIngest,
} from "@/lib/ingestCadence";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const REGISTER_SCRIPT = path.join(REPO_ROOT, "scripts", "register-otp-priority-task.ps1");
const SIBLING_SCRIPT = path.join(REPO_ROOT, "scripts", "register-ingest-tasks.ps1");
const REBAKE_SCRIPT = path.join(REPO_ROOT, "scripts", "register-rebake-task.ps1");

/** Every wrapper Task Scheduler launches, plus the one chained from otp. */
const WRAPPERS = [
  "ingest-otp-priority.ps1",
  // Not an ingest, but it is launched by Task Scheduler and it must prove which
  // database this checkout is configured against before it bakes a snapshot of
  // that corpus into a file the export believes without fallback.
  "rebake-consensus.ps1",
  "ingest-otp-scheduled.ps1",
  "ingest-otp-featured-scheduled.ps1",
  "ingest-matches-scheduled.ps1",
  "ingest-prostage-scheduled.ps1",
  "ingest-draft-scheduled.ps1",
];

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

describe("the registered cadence matches the scripts that register it", () => {
  // The drift gate. The register-*.ps1 scripts are the only supported way to
  // (re-)cadence these tasks, so their param defaults ARE the cadence. If
  // someone changes them without updating this table -- or updates this table
  // without changing them -- the two records of the same number have silently
  // diverged, which is precisely the condition that produced the 2026-08-20
  // outage.
  const priorityScript = readFileSync(REGISTER_SCRIPT, "utf8");
  const siblingScript = readFileSync(SIBLING_SCRIPT, "utf8");

  const psDefault = (script: string, param: string, where: string): number => {
    const m = new RegExp(String.raw`\[int\]\$${param}\s*=\s*(\d+)`).exec(script);
    if (!m) throw new Error(`could not read [int]$${param} default from ${where}`);
    return Number(m[1]);
  };

  it("uses the priority script's -IntervalHours default", () => {
    expect(task("CoachBuildOtpPriority").intervalHours).toBe(
      psDefault(priorityScript, "IntervalHours", REGISTER_SCRIPT),
    );
  });

  it("uses the priority script's -MaxHours default as the run duration", () => {
    // The walk bounds ITSELF at -MaxHours and exits cleanly, so -MaxHours is
    // the wall-clock ceiling, not an estimate.
    expect(task("CoachBuildOtpPriority").runMinutes).toBe(
      psDefault(priorityScript, "MaxHours", REGISTER_SCRIPT) * 60,
    );
  });

  it.each([
    ["CoachBuildOtpIngest", "OtpIngestIntervalHours"],
    ["CoachBuildMatchIngest", "MatchIngestIntervalHours"],
    ["CoachBuildProstageIngest", "ProstageIntervalHours"],
    ["CoachBuildDraftIngest", "DraftIntervalHours"],
  ])("uses the sibling script's default for %s", (taskName, param) => {
    expect(task(taskName).intervalHours).toBe(psDefault(siblingScript, param, SIBLING_SCRIPT));
  });

  it("stays inside the priority script's own refusal threshold", () => {
    const m = /-gt\s+(0\.\d+)\)\s*\{/.exec(priorityScript);
    expect(m, "register-otp-priority-task.ps1 lost its duty-cycle refusal guard").not.toBeNull();
    const threshold = Number(m![1]);
    const entry = task("CoachBuildOtpPriority");
    const duty = entry.runMinutes / 60 / entry.intervalHours;
    expect(duty).toBeLessThanOrEqual(threshold);
  });

  it("uses the rebake script's own slot as the re-bake cadence entry", () => {
    // Same drift gate as the two above, for the one job whose cadence is a SLOT
    // rather than an interval. The register script refuses to install a
    // colliding slot, so its StartBoundary is the authoritative time -- and if
    // it moves without this table moving, the fleet overlap model is modelling
    // a job that no longer runs when it says it does.
    const rebake = readFileSync(REBAKE_SCRIPT, "utf8");
    const boundary = /\[string\]\$StartBoundary\s*=\s*'(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/.exec(rebake);
    expect(boundary, "register-rebake-task.ps1 lost its $StartBoundary default").not.toBeNull();
    const offset = Number(boundary![2]) * 60 + Number(boundary![3]);
    expect(task("CoachBuildConsensusRebake").startOffsetMinutes).toBe(offset);

    // Daily, and daily WITHOUT a repetition block: a CalendarTrigger carrying
    // a Repetition skips slots on this machine, and a repetition with a
    // duration expires and stops the job dead with no error in any log. That is
    // the shape that wrapped an hourly trigger around a twelve-hour walk on
    // 2026-08-20, so "daily" must mean -Daily and never a 24h repetition.
    expect(rebake).toMatch(/New-ScheduledTaskTrigger -Daily -At \$startDt/);
    expect(rebake).not.toMatch(/-Weekly/);
    expect(rebake).not.toMatch(/RepetitionInterval/);
    expect(task("CoachBuildConsensusRebake").intervalHours).toBe(24);

    // THE DAY FILTER MUST STAY GONE. While this job was weekly, the collision
    // check skipped any busy window whose Days did not include its single fire
    // day -- which let a Sunday slot ignore CoachBuildDraftIngest (Mon+Thu)
    // entirely. A daily job fires on those days too, so that filter is a hole
    // in the guard, not a refinement. If someone reinstates a `$b.Days`
    // skip while the task is still daily, the slot stops being checked against
    // the only day-specific writer on the machine.
    expect(rebake).not.toMatch(/\$b\.Days\s+-notcontains/);
    expect(rebake).not.toMatch(/\[string\]\$DayOfWeek/);
  });

  it("keeps the re-bake slot clear of every writer on EVERY day, not just one", () => {
    // The arithmetic the register script throws on, re-derived here against the
    // cadence table rather than the script's own copy of it -- so the two
    // cannot drift into agreeing with each other and disagreeing with reality.
    //
    // A daily job has no day to hide behind: it must clear CoachBuildDraftIngest
    // (Mon+Thu 09:00, 63 min) exactly as it clears the every-6h walks.
    const rebakeTask = task("CoachBuildConsensusRebake");
    const slotStart = rebakeTask.startOffsetMinutes;
    // The ceiling the wrapper is actually given, not its measured runtime: a
    // slot is only clear if the WHOLE permitted window is clear.
    const deadline = /\[int\]\$DeadlineMinutes\s*=\s*(\d+)/.exec(
      readFileSync(REBAKE_SCRIPT, "utf8"),
    );
    expect(deadline, "register-rebake-task.ps1 lost its $DeadlineMinutes default").not.toBeNull();
    const slotEnd = slotStart + Number(deadline![1]);

    for (const other of SCHEDULED_INGESTS) {
      if (other.task === "CoachBuildConsensusRebake") continue;
      // Expand every-N-hours jobs across the day. Day-specific jobs are NOT
      // skipped -- that is the whole point of this test.
      const interval = Math.min(other.intervalHours, 24) * 60;
      for (let s = other.startOffsetMinutes; s < other.startOffsetMinutes + 1440; s += interval) {
        const start = s % 1440;
        const end = start + other.runMinutes;
        const overlaps = slotStart < end && start < slotEnd;
        expect(
          overlaps,
          `re-bake slot ${slotStart}-${slotEnd} overlaps ${other.task} at ${start}-${end}`,
        ).toBe(false);
      }
    }
  });

  it("keeps the sibling script's fleet tripwire, and stays under it", () => {
    // Same shape of guard as the priority script's duty-cycle throw: if the
    // refusal is deleted, the suite says so rather than the next cadence
    // change sailing through.
    const m = /\$FLEET_CU_HOUR_TRIPWIRE\s*=\s*([\d.]+)/.exec(siblingScript);
    expect(m, "register-ingest-tasks.ps1 lost its fleet CU-hour tripwire").not.toBeNull();
    const tripwire = Number(m![1]);
    expect(tripwire).toBeLessThan(NEON_FREE_CU_HOUR_QUOTA);
    expect(projectedCuHours(SCHEDULED_INGESTS)).toBeLessThan(tripwire);
  });
});

describe("every scheduled wrapper resolves the database explicitly", () => {
  // THE FAILURE THIS GATE EXISTS FOR. scripts/_env.mjs assigns only keys that
  // are still `undefined`, so a wrapper that does not set DATABASE_URL does
  // not fail -- it silently inherits .env.local, which until the cutover is
  // the OLD Neon project that matchday shares and whose quota died on
  // 2026-08-20. Enabling the tasks in that state would have left the rebuilt
  // database empty while re-burning another app's quota, with every run
  // reporting success. A missing line here is not a style problem.
  it.each(WRAPPERS)("%s dot-sources _cbnew-db.ps1 and honours its refusal", (wrapper) => {
    const text = readFileSync(path.join(REPO_ROOT, "scripts", wrapper), "utf8");
    expect(text).toContain("_cbnew-db.ps1");
    // The sentinel check is the load-bearing half. An `exit` inside a function
    // in a DOT-SOURCED script unwinds only that file (measured 2026-08-21: the
    // caller carried straight on past the refusal), so the guard only works if
    // the CALLER tests $CbnewDbResolved.
    expect(text).toMatch(/if \(-not \$CbnewDbResolved\) \{ exit 78 \}/);
    // And it has to happen before the ingest is launched, not after.
    expect(text.indexOf("$CbnewDbResolved")).toBeLessThan(text.indexOf("npx tsx"));
  });

  it("the resolver refuses rather than falling back", () => {
    const resolver = readFileSync(path.join(REPO_ROOT, "scripts", "_cbnew-db.ps1"), "utf8");
    expect(resolver).toContain("CBNEW_DATABASE_URL");
    expect(resolver).toMatch(/-pooler/); // pooled endpoint only
    expect(resolver).toContain("ep-shy-bread"); // old project refused by name
  });
});

describe("fleet budget against the Neon Free quota", () => {
  it("the cadence as found did NOT fit, which is why it was changed", () => {
    // The "before" half of the claim. Without it the assertion below is just a
    // number with nothing to compare against: any cadence looks fine if you
    // never measured the one it replaced.
    const projected = projectedCuHours(AS_FOUND_INGESTS);
    expect(projected).toBeGreaterThan(NEON_FREE_CU_HOUR_QUOTA);
    expect(projected).toBeLessThan(115); // pins the figure; catches model drift
  });

  it("the registered cadence clears the quota with the required headroom", () => {
    expect(projectedCuHours(SCHEDULED_INGESTS)).toBeLessThanOrEqual(
      NEON_FREE_CU_HOUR_QUOTA / REQUIRED_HEADROOM,
    );
  });

  it("the change only slowed jobs down, never sped them up", () => {
    for (const now of SCHEDULED_INGESTS) {
      const before = AS_FOUND_INGESTS.find((t) => t.task === now.task);
      if (!before) {
        // A task registered after the audit has no baseline to be slower than.
        // It has to say so out loud: without this the way to bypass the fleet's
        // only cadence-regression check would be to misspell a task name.
        expect(
          POST_AUDIT_ADDITIONS,
          `${now.task} has no as-found entry and is not declared in POST_AUDIT_ADDITIONS`,
        ).toContain(now.task);
        continue;
      }
      expect(now.intervalHours).toBeGreaterThanOrEqual(before.intervalHours);
      expect(now.runMinutes).toBeLessThanOrEqual(before.runMinutes);
    }
  });

  it("every post-audit addition is actually in the fleet, and is a net ADDITION", () => {
    // The other half of the exemption: a name may sit in POST_AUDIT_ADDITIONS
    // only while it names a real scheduled task that genuinely predates no
    // baseline. Otherwise the list becomes a place to park exemptions.
    for (const name of POST_AUDIT_ADDITIONS) {
      expect(SCHEDULED_INGESTS.some((t) => t.task === name)).toBe(true);
      expect(AS_FOUND_INGESTS.some((t) => t.task === name)).toBe(false);
    }
    // And an addition must not have quietly eaten the headroom the audit won.
    expect(projectedCuHours(SCHEDULED_INGESTS)).toBeLessThanOrEqual(
      NEON_FREE_CU_HOUR_QUOTA / REQUIRED_HEADROOM,
    );
  });
});

describe("cadence provenance", () => {
  it("leaves no task whose cadence lives only in Task Scheduler", () => {
    // Not a style point. A cadence that exists only in Task Scheduler cannot
    // be reviewed, cannot be restored after a machine rebuild, and drifts
    // without leaving a diff -- the exact mechanism named in the incident
    // write-up. Four of the five tasks were in that state until 2026-08-21.
    const unregistered = SCHEDULED_INGESTS.filter((t) => t.registeredBy === UNREGISTERED).map(
      (t) => t.task,
    );
    expect(unregistered).toEqual([]);
  });

  it("every task points at a registration script that exists", () => {
    for (const entry of SCHEDULED_INGESTS) {
      expect(() => readFileSync(path.join(REPO_ROOT, entry.registeredBy), "utf8")).not.toThrow();
    }
  });
});
