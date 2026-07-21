import { describe, it, expect } from "vitest";
import { buildPersonalBadgeModel, filterToMyPool } from "../live/personalBadge";

describe("buildPersonalBadgeModel", () => {
  it("null when both personal and personalOverall are empty -- no clutter on a row with nothing to show", () => {
    expect(buildPersonalBadgeModel(null, { games: 0, wins: 0 })).toBeNull();
  });

  it("null when a lane opponent resolved but I've never played that exact matchup, AND I've never played the champ at all", () => {
    expect(buildPersonalBadgeModel({ games: 0, wins: 0 }, { games: 0, wins: 0 })).toBeNull();
  });

  it("both lines populated when both have real data", () => {
    const model = buildPersonalBadgeModel({ games: 11, wins: 8 }, { games: 39, wins: 25 });
    expect(model).toEqual({
      vsLabel: "you: 8-3",
      overallLabel: "you: 25W-14L overall",
      tooltip: "Your Season 2026 record — shown for context, never affects ranking",
    });
  });

  it("vsLabel only, when personal has games but no lane-opp record was ever fetched as overall-less (edge case guarded defensively)", () => {
    const model = buildPersonalBadgeModel({ games: 3, wins: 1 }, { games: 0, wins: 0 });
    expect(model?.vsLabel).toBe("you: 1-2");
    expect(model?.overallLabel).toBeNull();
  });

  it("overallLabel only, when no lane opponent is resolved (personal is null) but I've played the champ overall", () => {
    const model = buildPersonalBadgeModel(null, { games: 25, wins: 20 });
    expect(model?.vsLabel).toBeNull();
    expect(model?.overallLabel).toBe("you: 20W-5L overall");
  });

  it("vsLabel is null (not '0-0') when a lane opponent resolved but I've never faced them, even with a real overall record", () => {
    const model = buildPersonalBadgeModel({ games: 0, wins: 0 }, { games: 10, wins: 6 });
    expect(model?.vsLabel).toBeNull();
    expect(model?.overallLabel).toBe("you: 6W-4L overall");
  });
});

describe("filterToMyPool", () => {
  interface Fixture {
    champId: number;
    score: number;
    personalOverall: { games: number; wins: number };
  }

  const rows: Fixture[] = [
    { champId: 1, score: 0.9, personalOverall: { games: 0, wins: 0 } },
    { champId: 2, score: 0.8, personalOverall: { games: 5, wins: 3 } },
    { champId: 3, score: 0.7, personalOverall: { games: 0, wins: 0 } },
    { champId: 4, score: 0.6, personalOverall: { games: 1, wins: 0 } },
  ];

  it("keeps only champions with personalOverall.games >= 1", () => {
    expect(filterToMyPool(rows).map((r) => r.champId)).toEqual([2, 4]);
  });

  it("preserves the input's relative order -- a FILTER, never a re-sort", () => {
    // rows is already score-DESC; the filtered result must stay score-DESC
    // among survivors, not get re-ordered by games/wins.
    const filtered = filterToMyPool(rows);
    expect(filtered[0].score).toBeGreaterThan(filtered[1].score);
  });

  it("empty input -> empty output", () => {
    expect(filterToMyPool([])).toEqual([]);
  });

  it("no matches -> empty output, not a fallback to the full list", () => {
    const noPersonalData: Fixture[] = [{ champId: 9, score: 0.5, personalOverall: { games: 0, wins: 0 } }];
    expect(filterToMyPool(noPersonalData)).toEqual([]);
  });
});
