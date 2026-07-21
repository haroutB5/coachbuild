/**
 * Draft redesign plan §2.1/§6 — band boundaries for lib/draft/difficulty.ts's
 * difficultyBand(). Exhaustive boundary coverage (0/1/3/4/6/7/10/null).
 */
import { describe, it, expect } from "vitest";
import { difficultyBand, DIFFICULTY_LOW_MAX, DIFFICULTY_MEDIUM_MAX } from "../draft/difficulty";

describe("difficultyBand", () => {
  it("constants match the plan's exact banding (1-3 Low, 4-6 Medium, 7-10 High)", () => {
    expect(DIFFICULTY_LOW_MAX).toBe(3);
    expect(DIFFICULTY_MEDIUM_MAX).toBe(6);
  });

  it("0 -> Low (falls at/below the low-max boundary)", () => {
    expect(difficultyBand(0)).toBe("Low");
  });

  it("1 -> Low", () => {
    expect(difficultyBand(1)).toBe("Low");
  });

  it("3 -> Low (top of the Low band)", () => {
    expect(difficultyBand(3)).toBe("Low");
  });

  it("4 -> Medium (bottom of the Medium band)", () => {
    expect(difficultyBand(4)).toBe("Medium");
  });

  it("6 -> Medium (top of the Medium band)", () => {
    expect(difficultyBand(6)).toBe("Medium");
  });

  it("7 -> High (bottom of the High band)", () => {
    expect(difficultyBand(7)).toBe("High");
  });

  it("10 -> High", () => {
    expect(difficultyBand(10)).toBe("High");
  });

  it("null -> null (never a fabricated band)", () => {
    expect(difficultyBand(null)).toBeNull();
  });

  it("NaN/non-finite -> null", () => {
    expect(difficultyBand(NaN)).toBeNull();
    expect(difficultyBand(Infinity)).toBeNull();
  });
});
