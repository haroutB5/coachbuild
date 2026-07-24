import { describe, it, expect } from "vitest";
import { buildBanRows, banPriorityBarPct, banReason, BAN_PRIORITY_BAR_CEILING } from "../hextech/draftBansModel";
import type { DraftBanResult } from "../live/draftRecommend";

describe("buildBanRows", () => {
  it("assigns rank as input-order index + 1", () => {
    const bans: DraftBanResult[] = [
      { champId: 1, score: 0.05, confidence: "normal", minGames: 2000, winVsYou: 0.56 },
      { champId: 2, score: 0.03, confidence: "normal", minGames: 1500, winVsYou: 0.53 },
    ];
    const rows = buildBanRows(bans, new Map());
    expect(rows.map((r) => r.rank)).toEqual([1, 2]);
  });

  it("falls back to a placeholder name/icon when missing from champIcons", () => {
    const rows = buildBanRows([{ champId: 42, score: 0.02, confidence: "low", minGames: null, winVsYou: null }], new Map());
    expect(rows[0].name).toBe("Champion #42");
  });

  it("difficultyBand degrades to null when absent from the champIcons entry", () => {
    const icons = new Map([[1, { name: "Ahri", icon: "x" }]]);
    const rows = buildBanRows([{ champId: 1, score: 0.05, confidence: "normal", minGames: 1000, winVsYou: 0.51 }], icons);
    expect(rows[0].difficultyBand).toBeNull();
  });

  it("carries minGames through as-is, including null (no matchup row)", () => {
    const rows = buildBanRows([{ champId: 1, score: 0.05, confidence: "low", minGames: null, winVsYou: null }], new Map());
    expect(rows[0].minGames).toBeNull();
  });

  it("attaches a reason string derived from winVsYou", () => {
    const rows = buildBanRows([{ champId: 1, score: 0.05, confidence: "normal", minGames: 2000, winVsYou: 0.56 }], new Map());
    expect(rows[0].reason).toBe("lane bully, 56.0%");
  });
});

describe("banReason", () => {
  it("null winVsYou -> honest no-data fallback, never a fabricated per-champion claim", () => {
    expect(banReason(null)).toBe("High ban priority");
  });

  it("winVsYou at/above the lane-bully floor (0.55) -> 'lane bully, N.N%'", () => {
    expect(banReason(0.56)).toBe("lane bully, 56.0%");
    expect(banReason(0.55)).toBe("lane bully, 55.0%");
  });

  it("winVsYou below the lane-bully floor -> 'N.N% into you'", () => {
    expect(banReason(0.524)).toBe("52.4% into you");
  });

  it("formats to exactly one decimal place", () => {
    expect(banReason(0.5)).toBe("50.0% into you");
  });
});

describe("banPriorityBarPct", () => {
  it("0 score -> the visibility floor (2%), never a fully-empty bar", () => {
    expect(banPriorityBarPct(0)).toBe(2);
  });
  it("at the ceiling -> 100%", () => {
    expect(banPriorityBarPct(BAN_PRIORITY_BAR_CEILING)).toBe(100);
  });
  it("clamps above the ceiling to 100%, never overflowing the bar", () => {
    expect(banPriorityBarPct(BAN_PRIORITY_BAR_CEILING * 2)).toBe(100);
  });
  it("mid-range score maps proportionally", () => {
    expect(banPriorityBarPct(BAN_PRIORITY_BAR_CEILING / 2)).toBeCloseTo(50, 5);
  });
});
