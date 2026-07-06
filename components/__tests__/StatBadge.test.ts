/**
 * Pure-logic tests for the shared stat-formatting helpers in StatBadge.tsx.
 * No JSX rendering (no jsdom/RTL in this repo's harness) — these are plain
 * functions, so they run fine under vitest's node environment.
 */
import { describe, it, expect } from "vitest";
import { wpaClass, wpaText, fmtSample, isNegativeHeadlineWpa } from "../StatBadge";

describe("wpaClass", () => {
  it("is good above +0.02", () => expect(wpaClass(0.03)).toBe("text-good"));
  it("is bad below -0.02", () => expect(wpaClass(-0.03)).toBe("text-bad"));
  it("is neutral within +/-0.02", () => {
    expect(wpaClass(0.0)).toBe("text-[#9aa7b6]");
    expect(wpaClass(0.02)).toBe("text-[#9aa7b6]");
    expect(wpaClass(-0.02)).toBe("text-[#9aa7b6]");
  });
});

describe("wpaText", () => {
  it("prefixes positive values with +", () => expect(wpaText(0.04)).toBe("+0.04"));
  it("leaves negative values alone", () => expect(wpaText(-0.1)).toBe("-0.10"));
  it("does not prefix exactly zero", () => expect(wpaText(0)).toBe("0.00"));
});

describe("fmtSample", () => {
  it("formats millions", () => expect(fmtSample(295_000)).toBe("295K"));
  it("formats millions with one decimal", () => expect(fmtSample(1_500_000)).toBe("1.5M"));
  it("leaves small counts as-is", () => expect(fmtSample(138)).toBe("138"));
});

describe("isNegativeHeadlineWpa (Fix 3: 'Most played' condition)", () => {
  it("flags a negative headline WPA (Jhin Fleet Footwork, -0.10/295K)", () => {
    expect(isNegativeHeadlineWpa(-0.1)).toBe(true);
  });
  it("does not flag a positive headline WPA", () => {
    expect(isNegativeHeadlineWpa(0.04)).toBe(false);
  });
  it("does not flag exactly zero", () => {
    expect(isNegativeHeadlineWpa(0)).toBe(false);
  });

  // Reviewer P3 (2026-07-06): threshold aligned to wpaClass's own red cutoff
  // so "Most played" never shows next to a neutral-gray number.
  describe("aligned with wpaClass's red threshold (wpa < -0.02)", () => {
    it("does NOT flag -0.01 (renders neutral gray in wpaClass, nothing to explain)", () => {
      expect(isNegativeHeadlineWpa(-0.01)).toBe(false);
    });
    it("does NOT flag exactly -0.02 (wpaClass boundary is still neutral there)", () => {
      expect(isNegativeHeadlineWpa(-0.02)).toBe(false);
    });
    it("flags -0.021, just past the boundary where wpaClass turns red", () => {
      expect(isNegativeHeadlineWpa(-0.021)).toBe(true);
    });
    it("wpaClass and isNegativeHeadlineWpa agree at every sampled point", () => {
      const samples = [-0.5, -0.03, -0.021, -0.02, -0.019, -0.01, 0, 0.01, 0.5];
      for (const wpa of samples) {
        const isRed = wpaClass(wpa) === "text-bad";
        expect(isNegativeHeadlineWpa(wpa)).toBe(isRed);
      }
    });
  });
});
