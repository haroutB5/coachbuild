/**
 * Pure-logic tests for the CoachBuild Score chip + CS/min·KP micro-stats
 * (components/ScoreChip.ts). No JSX rendering (no jsdom/RTL in this repo's
 * harness, see StatBadge.test.ts) — these are plain functions, so they run
 * fine under vitest's node environment. ProGameCard.tsx's <ScoreChip> itself
 * is a one-line `if (!hasScoreData(...)) return null` wrapper around these,
 * so exercising the guard + color-mapping here covers its render-or-not
 * behavior without needing a DOM.
 */
import { describe, it, expect } from "vitest";
import { scoreGradeClasses, hasScoreData, formatCsPerMin, formatKp, SCORE_CHIP_TITLE } from "../ScoreChip";

describe("hasScoreData (chip renders with score+grade / nothing when undefined)", () => {
  it("true for a valid score+grade pair", () => {
    expect(hasScoreData(91, "S")).toBe(true);
  });
  it("true for a 0 score (falsy number, still valid data)", () => {
    expect(hasScoreData(0, "D")).toBe(true);
  });
  it("false when score is undefined", () => {
    expect(hasScoreData(undefined, "S")).toBe(false);
  });
  it("false when score is null", () => {
    expect(hasScoreData(null, "S")).toBe(false);
  });
  it("false when grade is undefined", () => {
    expect(hasScoreData(91, undefined)).toBe(false);
  });
  it("false when grade is null", () => {
    expect(hasScoreData(91, null)).toBe(false);
  });
  it("false when grade is an empty string", () => {
    expect(hasScoreData(91, "")).toBe(false);
  });
  it("false when score is NaN", () => {
    expect(hasScoreData(NaN, "S")).toBe(false);
  });
  it("false when both are missing", () => {
    expect(hasScoreData(undefined, undefined)).toBe(false);
  });
});

describe("scoreGradeClasses (green -> red, matches the reskin's graded scale)", () => {
  it("S is a strong/saturated green, distinct from A's green", () => {
    expect(scoreGradeClasses("S")).toContain("#10b981");
    expect(scoreGradeClasses("S")).not.toContain("good");
  });
  it("A uses the shared --good token", () => {
    expect(scoreGradeClasses("A")).toContain("text-good");
  });
  it("B is neutral (mut), not colored good/bad", () => {
    const classes = scoreGradeClasses("B");
    expect(classes).toContain("mut");
    expect(classes).not.toContain("good");
    expect(classes).not.toContain("bad");
  });
  it("C is amber", () => {
    expect(scoreGradeClasses("C")).toContain("#f59e0b");
  });
  it("D uses the shared --bad token", () => {
    expect(scoreGradeClasses("D")).toContain("text-bad");
  });
  it("never uses the decorative cyan/lavender accent", () => {
    for (const grade of ["S", "A", "B", "C", "D"] as const) {
      const classes = scoreGradeClasses(grade);
      expect(classes).not.toContain("teal");
      expect(classes).not.toContain("lavender");
    }
  });
});

describe("SCORE_CHIP_TITLE", () => {
  it("names the formula inputs", () => {
    expect(SCORE_CHIP_TITLE).toBe(
      "CoachBuild Score — performance grade from KDA, kill participation and CS"
    );
  });
});

describe("formatCsPerMin (null must render nothing, never a dash/zero)", () => {
  it("formats to one decimal place", () => expect(formatCsPerMin(7.3)).toBe("CS/min 7.3"));
  it("pads a whole number to one decimal", () => expect(formatCsPerMin(7)).toBe("CS/min 7.0"));
  it("returns null for null input", () => expect(formatCsPerMin(null)).toBeNull());
});

describe("formatKp (0-1 fraction -> whole-percent; null must render nothing)", () => {
  it("formats a fraction as a rounded percent", () => expect(formatKp(0.62)).toBe("KP 62%"));
  it("rounds to the nearest percent", () => expect(formatKp(0.665)).toBe("KP 67%"));
  it("handles 0 (not the same as null)", () => expect(formatKp(0)).toBe("KP 0%"));
  it("returns null for null input", () => expect(formatKp(null)).toBeNull());
});
