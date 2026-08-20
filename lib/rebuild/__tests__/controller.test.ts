import { describe, it, expect } from "vitest";
import { buildPlan, type PlannedUnit } from "@/lib/rebuild/plan";
import {
  BACKOFF_DEFAULTS,
  GATE_DEFAULTS,
  JOURNAL_VERSION,
  backoffMs,
  classifySignals,
  evaluateArtifactGate,
  parseCoverageLine,
  parseJournal,
  replayJournal,
  runController,
  sleptMs,
  type ControllerDeps,
  type JournalEvent,
  type UnitResult,
} from "@/lib/rebuild/controller";

// ── harness ─────────────────────────────────────────────────────────────────

function unit(over: Partial<PlannedUnit> = {}): PlannedUnit {
  return {
    key: "s#0",
    stage: "s",
    phase: 1,
    index: 0,
    unitsInStage: 1,
    script: "scripts/fake.mjs",
    argv: [],
    maxMs: 60_000,
    drainOnCleanExit: false,
    usesRiot: false,
    usesChrome: false,
    ...over,
  };
}

function ok(over: Partial<UnitResult> = {}): UnitResult {
  return { exitCode: 0, timedOut: false, output: "", awakeMs: 1, sleptMs: 0, ...over };
}

interface Harness {
  deps: ControllerDeps;
  journal: JournalEvent[];
  waits: number[];
  calls: string[];
}

function harness(results: (u: PlannedUnit, call: number) => UnitResult): Harness {
  const journal: JournalEvent[] = [];
  const waits: number[] = [];
  const calls: string[] = [];
  let clock = Date.parse("2026-09-01T00:00:00.000Z");
  const perKey = new Map<string, number>();
  return {
    journal,
    waits,
    calls,
    deps: {
      now: () => (clock += 1000),
      runUnit: async (u) => {
        const n = (perKey.get(u.key) ?? 0) + 1;
        perKey.set(u.key, n);
        calls.push(u.key);
        return results(u, n);
      },
      append: (e) => journal.push(e),
      wait: async (ms) => {
        waits.push(ms);
      },
      log: () => {},
      random: () => 0,
    },
  };
}

const emptyState = () => ({ completed: new Set<string>(), drained: new Set<string>(), attempts: new Map<string, number>(), aborts: [] });

// ── journal ─────────────────────────────────────────────────────────────────

describe("journal", () => {
  const line = (e: object) => JSON.stringify(e);

  it("drops a torn FINAL record without calling the journal corrupt", () => {
    // Power cut mid-append. This is the expected shape of damage and it must
    // not scare a resume off.
    const text =
      line({ v: 1, t: "x", kind: "unit-done", key: "a#0", ms: 1, drained: false }) +
      "\n" +
      '{"v":1,"t":"x","kind":"unit-do';
    const parsed = parseJournal(text);
    expect(parsed.events).toHaveLength(1);
    expect(parsed.dropped).toBe(1);
    expect(parsed.corruptBeforeEnd).toBe(false);
  });

  it("flags damage in the MIDDLE of the file as real corruption", () => {
    const text = ["{oops", line({ v: 1, t: "x", kind: "unit-done", key: "a#0", ms: 1, drained: false })].join("\n");
    const parsed = parseJournal(text);
    expect(parsed.corruptBeforeEnd).toBe(true);
  });

  it("rejects well-formed JSON that is not an event", () => {
    expect(parseJournal("[1,2,3]\n").events).toHaveLength(0);
    expect(parseJournal("null\n").events).toHaveLength(0);
  });

  it("ignores blank lines and trailing newlines", () => {
    const text = `\n${line({ v: 1, t: "x", kind: "abort", reason: "r" })}\n\n`;
    expect(parseJournal(text).events).toHaveLength(1);
    expect(parseJournal(text).dropped).toBe(0);
  });

  it("replays completion, drain and per-unit failure counts", () => {
    const state = replayJournal(
      parseJournal(
        [
          line({ v: 1, t: "x", kind: "unit-failed", key: "a#0", attempt: 1, exitCode: 1, reason: "exit 1" }),
          line({ v: 1, t: "x", kind: "unit-failed", key: "a#0", attempt: 2, exitCode: 1, reason: "exit 1" }),
          line({ v: 1, t: "x", kind: "unit-done", key: "b#0", ms: 5, drained: true }),
          line({ v: 1, t: "x", kind: "stage-drained", stage: "b" }),
        ].join("\n")
      ).events
    );
    expect(state.attempts.get("a#0")).toBe(2);
    expect(state.completed.has("b#0")).toBe(true);
    expect(state.drained.has("b")).toBe(true);
  });

  it("clears the failure count once a unit finally succeeds", () => {
    const state = replayJournal([
      { v: 1, t: "x", kind: "unit-failed", key: "a#0", attempt: 1, exitCode: 1, reason: "r" },
      { v: 1, t: "x", kind: "unit-done", key: "a#0", ms: 1, drained: false },
    ] as JournalEvent[]);
    expect(state.attempts.has("a#0")).toBe(false);
  });

  it("leaves a unit incomplete when the process died between start and done", () => {
    const state = replayJournal([
      { v: 1, t: "x", kind: "unit-start", key: "a#0", attempt: 1 },
    ] as JournalEvent[]);
    expect(state.completed.has("a#0")).toBe(false);
  });

  it("counts a capped unit as progress, not as a failure", () => {
    const state = replayJournal([
      { v: 1, t: "x", kind: "unit-capped", key: "a#0", ms: 10 },
    ] as JournalEvent[]);
    expect(state.completed.has("a#0")).toBe(true);
    expect(state.attempts.has("a#0")).toBe(false);
  });
});

// ── signals ─────────────────────────────────────────────────────────────────

describe("classifySignals", () => {
  it("reads the compute-quota 402 that started all of this", () => {
    const s = classifySignals(
      'FAIL 189ms Server error (HTTP status 402): {"message":"Your account or project has exceeded the compute time quota."}'
    );
    expect(s.quotaExhausted).toBe(true);
  });

  it("reads a Retry-After in any of the shapes a log line carries it", () => {
    expect(classifySignals("Retry-After: 42").retryAfterSec).toBe(42);
    expect(classifySignals('"retry-after"=8').retryAfterSec).toBe(8);
    expect(classifySignals("retry_after 120").retryAfterSec).toBe(120);
    expect(classifySignals("nothing here").retryAfterSec).toBeNull();
  });

  it("separates rate limiting from a server error from a rejected key", () => {
    expect(classifySignals("Riot 429 Too Many Requests").rateLimited).toBe(true);
    expect(classifySignals("/api/pros returned HTTP 500").serverError).toBe(true);
    expect(classifySignals("403 Forbidden — key expired").keyRejected).toBe(true);
    expect(classifySignals("all good, 200 rows upserted").rateLimited).toBe(false);
  });
});

// ── backoff ─────────────────────────────────────────────────────────────────

describe("backoffMs", () => {
  const none = classifySignals("");

  it("obeys Retry-After over its own exponential guess", () => {
    const s = classifySignals("Retry-After: 90");
    expect(backoffMs(1, s, BACKOFF_DEFAULTS, () => 0)).toBe(90_000);
    // …even on a late attempt, where the exponential would be far longer.
    expect(backoffMs(6, s, BACKOFF_DEFAULTS, () => 0)).toBe(90_000);
  });

  it("backs off exponentially when nobody said when to come back", () => {
    expect(backoffMs(1, none, BACKOFF_DEFAULTS, () => 0)).toBe(30_000);
    expect(backoffMs(2, none, BACKOFF_DEFAULTS, () => 0)).toBe(60_000);
    expect(backoffMs(3, none, BACKOFF_DEFAULTS, () => 0)).toBe(120_000);
  });

  it("caps both paths so a stall surfaces to a human instead of eating the night", () => {
    expect(backoffMs(20, none, BACKOFF_DEFAULTS, () => 0)).toBe(BACKOFF_DEFAULTS.maxMs);
    const huge = classifySignals("retry-after: 86400");
    expect(backoffMs(1, huge, BACKOFF_DEFAULTS, () => 0)).toBe(BACKOFF_DEFAULTS.maxMs);
  });

  it("jitters downward within the configured fraction, never negative", () => {
    const full = backoffMs(2, none, BACKOFF_DEFAULTS, () => 1);
    expect(full).toBe(Math.round(60_000 * (1 - BACKOFF_DEFAULTS.jitter)));
    expect(backoffMs(1, none, { baseMs: 10, maxMs: 100, jitter: 1 }, () => 1)).toBe(0);
  });
});

// ── sleep ───────────────────────────────────────────────────────────────────

describe("sleptMs", () => {
  it("ignores ordinary scheduler jitter", () => {
    expect(sleptMs(30_000, 30_400)).toBe(0);
    expect(sleptMs(30_000, 89_000)).toBe(0);
  });

  it("charges a real suspend to sleep rather than to the running child", () => {
    const eightHours = 8 * 3_600_000;
    expect(sleptMs(30_000, 30_000 + eightHours)).toBe(eightHours);
  });

  it("never returns negative time when the clock steps backwards", () => {
    expect(sleptMs(30_000, 10)).toBe(0);
  });
});

// ── the artifact gate ───────────────────────────────────────────────────────

describe("evaluateArtifactGate", () => {
  it("REFUSES an empty corpus that resolved 100% of its requests", () => {
    // The whole reason this gate exists. Against an empty database every
    // champion-role answers successfully with `null`, so the generator's own
    // --min-coverage reads 100% while the artifact contains nothing — and a
    // stored null tells the shop export "this champion genuinely has no pro
    // data" for a whole patch.
    const verdict = evaluateArtifactGate({ combos: 865, resolved: 1, pro: 0, otp: 0 });
    expect(verdict.ok).toBe(false);
    expect(verdict.reasons.join(" ")).toMatch(/pro coverage 0/);
    expect(verdict.reasons.join(" ")).toMatch(/otp coverage 0/);
  });

  it("passes a realistic corpus", () => {
    expect(evaluateArtifactGate({ combos: 865, resolved: 0.99, pro: 455, otp: 133 }).ok).toBe(true);
  });

  it("refuses a thin OTP half even when the pro half is complete", () => {
    const verdict = evaluateArtifactGate({ combos: 865, resolved: 1, pro: 600, otp: 12 });
    expect(verdict.ok).toBe(false);
    expect(verdict.reasons).toHaveLength(1);
  });

  it("re-asserts the generator's own request-success floor", () => {
    const verdict = evaluateArtifactGate({ combos: 865, resolved: 0.5, pro: 400, otp: 100 });
    expect(verdict.ok).toBe(false);
    expect(verdict.reasons.join(" ")).toMatch(/resolved 50\.0%/);
  });

  it("honours caller thresholds", () => {
    expect(evaluateArtifactGate({ combos: 10, resolved: 1, pro: 5, otp: 5 }, { minPro: 5, minOtp: 5, minResolved: 1 }).ok).toBe(true);
  });

  it("keeps defaults below the measured realistic corpus so a partial rebuild can ship", () => {
    expect(GATE_DEFAULTS.minPro).toBeLessThan(455);
    expect(GATE_DEFAULTS.minOtp).toBeLessThan(133);
    expect(GATE_DEFAULTS.minPro).toBeGreaterThan(0);
  });
});

describe("parseCoverageLine", () => {
  it("reads the generator CLI's real summary line", () => {
    const out = "[consensus] patch=16.13 resolved 860/865 (99.4%) — pro 455, otp 133";
    expect(parseCoverageLine(out)).toEqual({ combos: 865, resolved: 860 / 865, pro: 455, otp: 133 });
  });

  it("returns null rather than guessing when the line is absent", () => {
    expect(parseCoverageLine("[consensus] FAILED: coverage 0.10 below --min-coverage 0.95")).toBeNull();
    expect(parseCoverageLine("")).toBeNull();
  });
});

// ── the loop ────────────────────────────────────────────────────────────────

describe("runController", () => {
  const plan3 = [unit({ key: "a#0", stage: "a" }), unit({ key: "a#1", stage: "a" }), unit({ key: "b#0", stage: "b" })];

  it("runs every unit in plan order", async () => {
    const h = harness(() => ok());
    const r = await runController(plan3, emptyState(), h.deps, { runId: "r" });
    expect(r.status).toBe("complete");
    expect(h.calls).toEqual(["a#0", "a#1", "b#0"]);
  });

  it("resumes: units the journal already records are never re-run", async () => {
    const h = harness(() => ok());
    const state = { ...emptyState(), completed: new Set(["a#0", "a#1"]) };
    const r = await runController(plan3, state, h.deps, { runId: "r" });
    expect(h.calls).toEqual(["b#0"]);
    expect(r.skipped).toEqual(["a#0", "a#1"]);
  });

  it("skips the rest of a stage that drained on a clean exit", async () => {
    const drainy = [
      unit({ key: "m#0", stage: "m", drainOnCleanExit: true }),
      unit({ key: "m#1", stage: "m", drainOnCleanExit: true }),
      unit({ key: "m#2", stage: "m", drainOnCleanExit: true }),
    ];
    const h = harness(() => ok());
    await runController(drainy, emptyState(), h.deps, { runId: "r" });
    expect(h.calls).toEqual(["m#0"]);
    expect(h.journal.some((e) => e.kind === "stage-drained")).toBe(true);
  });

  it("honours a drain recorded by a PREVIOUS process", async () => {
    const drainy = [unit({ key: "m#0", stage: "m", drainOnCleanExit: true }), unit({ key: "m#1", stage: "m", drainOnCleanExit: true })];
    const h = harness(() => ok());
    await runController(drainy, { ...emptyState(), drained: new Set(["m"]) }, h.deps, { runId: "r" });
    expect(h.calls).toEqual([]);
  });

  it("treats a time-capped unit as progress and moves on without retrying", async () => {
    const h = harness(() => ok({ timedOut: true, exitCode: null, awakeMs: 60_000 }));
    const r = await runController([unit({ key: "w#0", stage: "w" })], emptyState(), h.deps, { runId: "r" });
    expect(r.status).toBe("complete");
    expect(h.calls).toEqual(["w#0"]);
    expect(h.journal.some((e) => e.kind === "unit-capped")).toBe(true);
    expect(h.journal.some((e) => e.kind === "unit-failed")).toBe(false);
  });

  it("retries a transient failure and records the backoff it waited", async () => {
    const h = harness((_u, n) => (n < 3 ? ok({ exitCode: 1, output: "Riot 429 Too Many Requests\nRetry-After: 12" }) : ok()));
    const r = await runController([unit({ key: "a#0", stage: "a" })], emptyState(), h.deps, { runId: "r" });
    expect(r.status).toBe("complete");
    expect(h.calls).toEqual(["a#0", "a#0", "a#0"]);
    expect(h.waits).toEqual([12_000, 12_000]);
  });

  it("STOPS DEAD on a compute-quota 402 instead of retrying into the next outage", async () => {
    const h = harness(() => ok({ exitCode: 1, output: "Server error (HTTP status 402): exceeded the compute time quota" }));
    const r = await runController(plan3, emptyState(), h.deps, { runId: "r" });
    expect(r.status).toBe("aborted");
    expect(r.reason).toMatch(/402/);
    expect(h.calls).toEqual(["a#0"]);
    expect(h.waits).toEqual([]);
  });

  it("stops on a rejected credential — a 24h Riot key cannot be renewed by backing off", async () => {
    const h = harness(() => ok({ exitCode: 1, output: "riot: 403 Forbidden" }));
    const r = await runController(plan3, emptyState(), h.deps, { runId: "r" });
    expect(r.status).toBe("aborted");
    expect(r.reason).toMatch(/401\/403/);
  });

  it("does not mistake a 403 mentioned by a SUCCESSFUL unit for a dead key", async () => {
    const h = harness(() => ok({ exitCode: 0, output: "skipped 2 accounts on 403" }));
    const r = await runController([unit()], emptyState(), h.deps, { runId: "r" });
    expect(r.status).toBe("complete");
  });

  it("gives up after maxAttempts on a hard failure", async () => {
    const h = harness(() => ok({ exitCode: 1, output: "TypeError: boom" }));
    const r = await runController([unit({ key: "a#0", stage: "a" })], emptyState(), h.deps, {
      runId: "r",
      maxAttempts: 3,
    });
    expect(r.status).toBe("aborted");
    expect(h.calls).toHaveLength(3);
    expect(r.failedKey).toBe("a#0");
  });

  it("gives a rate-limited unit a much longer leash than a broken one", async () => {
    const h = harness((_u, n) => (n < 8 ? ok({ exitCode: 1, output: "429 rate limited" }) : ok()));
    const r = await runController([unit({ key: "a#0", stage: "a" })], emptyState(), h.deps, {
      runId: "r",
      maxAttempts: 3,
      maxRateLimitAttempts: 20,
    });
    expect(r.status).toBe("complete");
    expect(h.calls).toHaveLength(8);
  });

  it("carries failed attempts across a restart so a crash loop cannot reset the budget", async () => {
    const h = harness(() => ok({ exitCode: 1, output: "TypeError: boom" }));
    const state = { ...emptyState(), attempts: new Map([["a#0", 2]]) };
    const r = await runController([unit({ key: "a#0", stage: "a" })], state, h.deps, {
      runId: "r",
      maxAttempts: 3,
    });
    expect(r.status).toBe("aborted");
    expect(h.calls).toHaveLength(1); // attempt 3 of 3, not a fresh 3
  });

  it("stops after phase 1 when asked, leaving the tail for later", async () => {
    const mixed = [unit({ key: "a#0", stage: "a", phase: 1 }), unit({ key: "z#0", stage: "z", phase: 2 })];
    const h = harness(() => ok());
    const r = await runController(mixed, emptyState(), h.deps, { runId: "r", stopAfterPhase: 1 });
    expect(h.calls).toEqual(["a#0"]);
    expect(r.skipped).toEqual(["z#0"]);
  });

  it("records a sleep so a resumed operator can see the machine suspended", async () => {
    const h = harness(() => ok({ sleptMs: 8 * 3_600_000 }));
    await runController([unit()], emptyState(), h.deps, { runId: "r" });
    const sleep = h.journal.find((e) => e.kind === "sleep");
    expect(sleep).toBeTruthy();
  });

  it("stamps every record with the journal version and an ISO timestamp", async () => {
    const h = harness(() => ok());
    await runController([unit()], emptyState(), h.deps, { runId: "r" });
    for (const e of h.journal) {
      expect(e.v).toBe(JOURNAL_VERSION);
      expect(Number.isNaN(Date.parse(e.t))).toBe(false);
    }
  });

  it("writes the checkpoint BEFORE the next unit starts", async () => {
    // The ordering is the crash-safety property: if the process dies during
    // a#1, the record for a#0 is already on disk.
    const h = harness(() => ok());
    await runController(plan3, emptyState(), h.deps, { runId: "r" });
    const kinds = h.journal.map((e) => `${e.kind}:${"key" in e ? e.key : ""}`);
    expect(kinds.indexOf("unit-done:a#0")).toBeLessThan(kinds.indexOf("unit-start:a#1"));
  });

  it("drives the real phase-1 plan end to end", async () => {
    const plan = buildPlan({ phase: 1, otpPrioritySlots: 2, matchSlots: 2, championChunk: 90, championCount: 173 });
    const h = harness(() => ok());
    const r = await runController(plan, emptyState(), h.deps, { runId: "r", stopAfterPhase: 1 });
    expect(r.status).toBe("complete");
    expect(h.calls).toContain("otp-priority#0");
    expect(h.calls).toContain("otp-priority#1");
    // roster, prostage and matches all drain on a clean exit
    expect(h.calls.filter((k) => k.startsWith("matches#"))).toEqual(["matches#0"]);
  });
});
