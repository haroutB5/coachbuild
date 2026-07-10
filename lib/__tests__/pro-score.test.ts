/**
 * Tests for lib/pro/score.ts — the "CoachBuild Score" 0-100 per-game grade.
 * Pure functions, table-driven — see the formula writeup in score.ts's header
 * comment for what each assertion is pinning.
 */
import { describe, it, expect } from "vitest";
import {
  computeCsPerMin,
  computeGameScore,
  computeKillParticipation,
  type GameScoreInput,
} from "../pro/score";

function baseInput(overrides: Partial<GameScoreInput> = {}): GameScoreInput {
  return {
    kills: 5,
    deaths: 2,
    assists: 7,
    win: true,
    gameDurationSec: 1800,
    ...overrides,
  };
}

describe("computeGameScore — degraded (no optional stats)", () => {
  it("solid KDA + win scores in the A/B range", () => {
    const { score, grade } = computeGameScore(baseInput());
    expect(score).toBeGreaterThan(60);
    expect(score).toBeLessThanOrEqual(100);
    expect(["A", "B", "S"]).toContain(grade);
  });

  it("0/0/0 loss scores low but is clamped at 0 minimum, never negative", () => {
    const { score, grade } = computeGameScore(
      baseInput({ kills: 0, deaths: 5, assists: 0, win: false })
    );
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThan(20);
    expect(grade).toBe("D");
  });

  it("0 deaths does not divide by zero and outscores an equivalent 1-death game", () => {
    const flawless = computeGameScore(baseInput({ kills: 5, deaths: 0, assists: 5 }));
    const oneDeath = computeGameScore(baseInput({ kills: 5, deaths: 1, assists: 5 }));
    expect(Number.isFinite(flawless.score)).toBe(true);
    expect(flawless.score).toBeGreaterThan(oneDeath.score);
  });

  it("undefined optional stats behave identically to omitted fields", () => {
    const withUndefined = computeGameScore(
      baseInput({ cs: undefined, damageChampions: undefined, teamKills: undefined })
    );
    const omitted = computeGameScore(baseInput());
    expect(withUndefined).toEqual(omitted);
  });

  it("null optional stats also degrade to the KDA+win-only path", () => {
    const withNull = computeGameScore(baseInput({ cs: null, damageChampions: null, teamKills: null }));
    const omitted = computeGameScore(baseInput());
    expect(withNull).toEqual(omitted);
  });

  it("an extreme KDA/win combination clamps at 100, never overflows", () => {
    const { score } = computeGameScore(baseInput({ kills: 40, deaths: 0, assists: 40, win: true }));
    expect(score).toBe(100);
  });

  it("gameDurationSec = 0 (edge case) does not throw or divide by zero", () => {
    expect(() => computeGameScore(baseInput({ gameDurationSec: 0 }))).not.toThrow();
  });

  it("is deterministic — same input always produces the same output", () => {
    const a = computeGameScore(baseInput());
    const b = computeGameScore(baseInput());
    expect(a).toEqual(b);
  });
});

describe("computeGameScore — blended (cs + teamKills present)", () => {
  it("blends KP% and CS/min into a higher score than the degraded baseline for a strong statline", () => {
    const degraded = computeGameScore(baseInput());
    const blended = computeGameScore(baseInput({ cs: 220, damageChampions: 25000, teamKills: 15 }));
    expect(blended.score).toBeGreaterThan(degraded.score);
  });

  it("teamKills = 0 degrades kill participation to 0 instead of NaN/Infinity", () => {
    const { score } = computeGameScore(baseInput({ cs: 150, damageChampions: 10000, teamKills: 0 }));
    expect(Number.isFinite(score)).toBe(true);
    expect(score).toBeGreaterThanOrEqual(0);
  });

  it("a very short game (<10 min) computes a sane csPerMin rather than an inflated one", () => {
    const shortGame = computeCsPerMin(50, 480); // 8 minutes, 50 cs
    expect(shortGame).toBeCloseTo(6.25, 5);
    const { score } = computeGameScore(
      baseInput({ gameDurationSec: 480, cs: 50, damageChampions: 6000, teamKills: 10 })
    );
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(100);
  });

  it("clamps at 100 even with elite cs/kp/kda/win all maxed", () => {
    const { score } = computeGameScore(
      baseInput({ kills: 15, deaths: 0, assists: 10, cs: 400, damageChampions: 60000, teamKills: 18 })
    );
    expect(score).toBe(100);
  });
});

describe("grade thresholds", () => {
  it("S starts at 90, A at 75, B at 60, C at 40, D below 40 (boundary spot-checks)", () => {
    // kda=Infinity-ish (huge K+A, 0 deaths) + win saturates near 100 -> S
    expect(computeGameScore(baseInput({ kills: 20, deaths: 0, assists: 20, win: true })).grade).toBe("S");
    // Moderate KDA + win lands in A/B territory (see "solid KDA" test above)
    // moderate-low KDA + loss lands lower
    expect(computeGameScore(baseInput({ kills: 1, deaths: 4, assists: 1, win: false })).grade).toMatch(
      /[CD]/
    );
    // 0/8/0 loss is about as bad as it gets -> D
    expect(computeGameScore(baseInput({ kills: 0, deaths: 8, assists: 0, win: false })).grade).toBe("D");
  });
});

describe("computeCsPerMin", () => {
  it("divides cs by minutes played", () => {
    expect(computeCsPerMin(300, 1800)).toBeCloseTo(10, 5); // 30 min game
  });

  it("floors the duration at 1 minute to avoid a div-by-zero blowup", () => {
    expect(computeCsPerMin(5, 0)).toBe(5);
    expect(computeCsPerMin(5, 30)).toBe(5); // 30 sec game -> still floored to 1 min
  });
});

describe("computeKillParticipation", () => {
  it("kills+assists over teamKills, clamped to [0,1]", () => {
    expect(computeKillParticipation(5, 7, 15)).toBeCloseTo(0.8, 5);
  });

  it("teamKills = 0 returns 0 instead of NaN", () => {
    expect(computeKillParticipation(0, 0, 0)).toBe(0);
  });

  it("never exceeds 1 even with pathological input", () => {
    expect(computeKillParticipation(50, 50, 10)).toBe(1);
  });
});
