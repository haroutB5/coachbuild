/**
 * Tests for lib/pro/sweepOutcome.ts — the graded exit code for the local
 * solo-queue sweep (2026-07-29).
 *
 * The measured case this exists for: the 12:20 run walked 1,445 accounts,
 * upserted 200 matches and skipped 15 on transient Riot 429s, then reported
 * exit 1 — the same code a dead key produces. Task Scheduler had no way to
 * tell a healthy run from a broken one, so nobody looked, and the 07:10 run
 * had already failed identically.
 */
import { describe, it, expect } from "vitest";
import {
  classifySweep,
  sweepErrorBudget,
  SWEEP_ERROR_FLOOR,
  SWEEP_ERROR_FRACTION,
} from "@/lib/pro/sweepOutcome";

describe("classifySweep", () => {
  it("THE REGRESSION: the real 12:20 run (1445 accounts, 200 matches, 15 transient errors) is exit 0", () => {
    const verdict = classifySweep({
      accountsProcessed: 1445,
      matchesUpserted: 200,
      errorCount: 15,
      rateLimited: false,
    });
    expect(verdict.exitCode).toBe(0);
    expect(verdict.reason).toContain("15 transient error(s) tolerated");
  });

  it("a clean run is exit 0", () => {
    const verdict = classifySweep({
      accountsProcessed: 1445,
      matchesUpserted: 200,
      errorCount: 0,
      rateLimited: false,
    });
    expect(verdict.exitCode).toBe(0);
    expect(verdict.reason).toContain("no errors");
  });

  it("a run that found nothing new is still exit 0 — matches never enter the verdict", () => {
    const verdict = classifySweep({
      accountsProcessed: 1445,
      matchesUpserted: 0,
      errorCount: 0,
      rateLimited: false,
    });
    expect(verdict.exitCode).toBe(0);
  });

  it("a rate-limit abort is exit 1 even with a single error and plenty of work done", () => {
    const verdict = classifySweep({
      accountsProcessed: 900,
      matchesUpserted: 150,
      errorCount: 1,
      rateLimited: true,
    });
    expect(verdict.exitCode).toBe(1);
    expect(verdict.reason).toContain("rate-limiting");
  });

  it("a rate-limit abort outranks everything — it is checked before the error budget", () => {
    const verdict = classifySweep({
      accountsProcessed: 0,
      matchesUpserted: 0,
      errorCount: 1,
      rateLimited: true,
    });
    expect(verdict.exitCode).toBe(1);
    expect(verdict.reason).toContain("rate-limiting");
  });

  it("errors above the budget are exit 1", () => {
    const verdict = classifySweep({
      accountsProcessed: 1445,
      matchesUpserted: 5,
      errorCount: 400,
      rateLimited: false,
    });
    expect(verdict.exitCode).toBe(1);
    expect(verdict.reason).toContain("exceeds the tolerance");
  });

  it("a drained walk that visits nothing is exit 0, not a failure", () => {
    const verdict = classifySweep({
      accountsProcessed: 0,
      matchesUpserted: 0,
      errorCount: 0,
      rateLimited: false,
    });
    expect(verdict.exitCode).toBe(0);
  });

  it("zero accounts WITH errors is exit 1 — nothing got done and something went wrong", () => {
    const verdict = classifySweep({
      accountsProcessed: 0,
      matchesUpserted: 0,
      errorCount: 3,
      rateLimited: false,
    });
    expect(verdict.exitCode).toBe(1);
  });
});

describe("sweepErrorBudget", () => {
  it("uses the FLOOR for a small walk so a 5-account batch is not failed by one blip", () => {
    expect(sweepErrorBudget(5)).toBe(SWEEP_ERROR_FLOOR);
    expect(sweepErrorBudget(100)).toBe(SWEEP_ERROR_FLOOR); // ceil(5) < 25
  });

  it("uses the FRACTION once the walk is large enough for it to bite", () => {
    expect(sweepErrorBudget(1445)).toBe(Math.ceil(1445 * SWEEP_ERROR_FRACTION));
    expect(sweepErrorBudget(1445)).toBe(73);
  });

  it("boundary: exactly at the budget passes, one over fails", () => {
    const budget = sweepErrorBudget(1445);
    expect(
      classifySweep({
        accountsProcessed: 1445,
        matchesUpserted: 1,
        errorCount: budget,
        rateLimited: false,
      }).exitCode
    ).toBe(0);
    expect(
      classifySweep({
        accountsProcessed: 1445,
        matchesUpserted: 1,
        errorCount: budget + 1,
        rateLimited: false,
      }).exitCode
    ).toBe(1);
  });
});
