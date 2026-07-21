import { describe, it, expect } from "vitest";
import {
  findLaneOpponentAnalysis,
  winRateVsYouLine,
  hasAnyMatchupSignal,
  type EnemyAnalysis,
} from "../hextech/matchupAnalysis";

function entry(over: Partial<EnemyAnalysis> & { champId: number }): EnemyAnalysis {
  return {
    isLaneOpponent: false,
    winRateVsYou: null,
    winRateVsYouGames: null,
    laneThreatBand: null,
    suggestedDefense: null,
    ...over,
  };
}

describe("findLaneOpponentAnalysis", () => {
  it("null when no lane opponent is resolved", () => {
    expect(findLaneOpponentAnalysis([entry({ champId: 1 })], null)).toBeNull();
  });
  it("null when enemyAnalysis is absent (older cached response)", () => {
    expect(findLaneOpponentAnalysis(undefined, 1)).toBeNull();
  });
  it("finds the entry matching the resolved lane opponent's champId", () => {
    const list = [entry({ champId: 1 }), entry({ champId: 2, isLaneOpponent: true })];
    expect(findLaneOpponentAnalysis(list, 2)?.champId).toBe(2);
  });
  it("null when the array simply doesn't contain that champId", () => {
    expect(findLaneOpponentAnalysis([entry({ champId: 1 })], 5)).toBeNull();
  });
});

describe("winRateVsYouLine", () => {
  it("null when there's no hover-derived record at all", () => {
    expect(winRateVsYouLine(entry({ champId: 1 }))).toBeNull();
  });
  it("null when games is exactly 0 (never a fabricated 0.0%)", () => {
    expect(winRateVsYouLine(entry({ champId: 1, winRateVsYou: 0.5, winRateVsYouGames: 0 }))).toBeNull();
  });
  it("formats a real record as percent + n=", () => {
    expect(winRateVsYouLine(entry({ champId: 1, winRateVsYou: 0.62, winRateVsYouGames: 340 }))).toBe("62.0% (n=340)");
  });
});

describe("hasAnyMatchupSignal", () => {
  it("false when every line is null", () => {
    expect(hasAnyMatchupSignal(entry({ champId: 1 }))).toBe(false);
  });
  it("true when at least the lane threat band resolved", () => {
    expect(hasAnyMatchupSignal(entry({ champId: 1, laneThreatBand: "High" }))).toBe(true);
  });
  it("true when at least suggestedDefense resolved", () => {
    expect(
      hasAnyMatchupSignal(entry({ champId: 1, suggestedDefense: { label: "Armor", reason: "physical" } }))
    ).toBe(true);
  });
});
