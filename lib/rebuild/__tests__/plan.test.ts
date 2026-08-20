import { describe, it, expect } from "vitest";
import {
  ARTIFACT_CRITICAL_TABLES,
  REBUILD_STAGES,
  buildPlan,
  planCeilingHours,
  resolvePlanOptions,
} from "@/lib/rebuild/plan";

describe("rebuild plan — scope", () => {
  it("phase 1 writes every table /api/pros and /api/otp read", () => {
    // This is THE scope assertion. The artifact is a reduction over those two
    // routes' responses, so a phase-1 plan that misses one of their tables
    // produces an artifact that is silently short.
    const written = new Set(
      REBUILD_STAGES.filter((s) => s.phase === 1).flatMap((s) => s.writes)
    );
    for (const table of ARTIFACT_CRITICAL_TABLES) {
      expect(written.has(table), `phase 1 never writes ${table}`).toBe(true);
    }
  });

  it("keeps prostage_matches in phase 1 — /api/pros defaults to source=all", () => {
    const prostage = REBUILD_STAGES.find((s) => s.id === "prostage");
    expect(prostage?.phase).toBe(1);
    expect(prostage?.usesRiot).toBe(false);
  });

  it("phase 2 holds nothing that can reach the artifact", () => {
    const phase2Only = REBUILD_STAGES.filter((s) => s.phase === 2).flatMap((s) => s.writes);
    const phase1 = new Set(REBUILD_STAGES.filter((s) => s.phase === 1).flatMap((s) => s.writes));
    for (const table of phase2Only) {
      if (phase1.has(table)) continue; // timelines backfill re-touches prostage_matches
      expect(
        (ARTIFACT_CRITICAL_TABLES as readonly string[]).includes(table),
        `${table} is deferred to phase 2 but feeds the artifact`
      ).toBe(false);
    }
  });

  it("puts the artifact-critical stages before the phase-2 tail", () => {
    const plan = buildPlan({ phase: "all" });
    const lastPhase1 = plan.map((u) => u.phase).lastIndexOf(1);
    const firstPhase2 = plan.map((u) => u.phase).indexOf(2);
    expect(firstPhase2).toBeGreaterThan(lastPhase1);
  });

  it("orders OTP discovery before the deep walk that consumes it", () => {
    const plan = buildPlan({ phase: 1 });
    const discovery = plan.findIndex((u) => u.stage === "otp-featured");
    const walk = plan.findIndex((u) => u.stage === "otp-priority");
    expect(discovery).toBeGreaterThanOrEqual(0);
    expect(discovery).toBeLessThan(walk);
  });

  it("orders roster discovery before the pro match walk", () => {
    const plan = buildPlan({ phase: 1 });
    expect(plan.findIndex((u) => u.stage === "roster")).toBeLessThan(
      plan.findIndex((u) => u.stage === "matches")
    );
  });
});

describe("rebuild plan — determinism", () => {
  it("produces identical keys for identical options", () => {
    const a = buildPlan({ phase: 1, otpPrioritySlots: 4 }).map((u) => u.key);
    const b = buildPlan({ phase: 1, otpPrioritySlots: 4 }).map((u) => u.key);
    expect(a).toEqual(b);
  });

  it("never repeats a unit key", () => {
    const keys = buildPlan({ phase: "all" }).map((u) => u.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("keeps earlier keys stable when a later stage's size changes", () => {
    // A resumed run must not invalidate its own checkpoint because the user
    // passed a different --match-slots on the second invocation.
    const before = buildPlan({ phase: 1, matchSlots: 3 }).filter((u) => u.stage !== "matches");
    const after = buildPlan({ phase: 1, matchSlots: 9 }).filter((u) => u.stage !== "matches");
    expect(before.map((u) => u.key)).toEqual(after.map((u) => u.key));
  });
});

describe("rebuild plan — options", () => {
  it("chunks champion discovery so every champion is reachable", () => {
    const plan = buildPlan({ phase: 1, championCount: 173, championChunk: 10 });
    const units = plan.filter((u) => u.stage === "otp-featured");
    expect(units.length).toBe(18);
    expect(units[0].argv).toEqual(["--champions", "10"]);
  });

  it("passes the roster size through to the roster script", () => {
    const [roster] = buildPlan({ phase: 1, rosterSize: 200 }).filter((u) => u.stage === "roster");
    expect(roster.argv).toEqual(["200"]);
  });

  it("caps the OTP walk above the walk's own 1h self-bound, never below", () => {
    const [slot] = buildPlan({ phase: 1 }).filter((u) => u.stage === "otp-priority");
    expect(slot.argv).toEqual(["--max-hours", "1"]);
    expect(slot.maxMs).toBeGreaterThan(3_600_000);
  });

  it("rejects nonsense options rather than planning something impossible", () => {
    expect(() => resolvePlanOptions({ rosterSize: 0 })).toThrow(/rosterSize/);
    expect(() => resolvePlanOptions({ championChunk: 0 })).toThrow(/championChunk/);
    expect(() => resolvePlanOptions({ matchSlotHours: 0 })).toThrow(/matchSlotHours/);
  });

  it("reports a wall-clock ceiling that grows with the match budget", () => {
    const small = planCeilingHours({ phase: 1, matchSlots: 2, matchSlotHours: 4 });
    const large = planCeilingHours({ phase: 1, matchSlots: 6, matchSlotHours: 4 });
    expect(large - small).toBeCloseTo(16, 5);
  });
});

describe("rebuild plan — Riot key safety", () => {
  it("marks exactly the stages that spend the shared Riot key", () => {
    const riot = REBUILD_STAGES.filter((s) => s.usesRiot).map((s) => s.id);
    expect(riot).toContain("roster");
    expect(riot).toContain("otp-priority");
    expect(riot).toContain("matches");
    // Cargo and u.gg cost no Riot budget — this is what makes them safe to
    // move if the schedule ever needs to overlap something.
    expect(riot).not.toContain("prostage");
    expect(riot).not.toContain("draft");
  });

  it("flags the one stage that needs a local Chrome", () => {
    const chrome = REBUILD_STAGES.filter((s) => s.usesChrome).map((s) => s.id);
    expect(chrome).toEqual(["otp-featured"]);
  });
});
