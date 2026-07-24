import { describe, it, expect } from "vitest";
import {
  buildPickRows,
  sortPickRows,
  nextPickSortState,
  ariaSortFor,
  pickSortCaption,
  difficultyLabel,
  synergyClass,
  DEFAULT_PICK_SORT,
  isDefaultPickSort,
  type PickRow,
} from "../hextech/draftPicksModel";
import type { DraftPlayResult } from "../live/draftRecommend";
import type { ChampionIconEntry } from "../proAssets";

function play(over: Partial<DraftPlayResult> & { champId: number }): DraftPlayResult {
  return {
    score: 0.5,
    winVsLaneOpp: null,
    winVsLaneOppGames: null,
    confidence: "normal",
    minGames: 1000,
    personal: null,
    personalOverall: { games: 0, wins: 0 },
    synergyDelta: 0,
    synergyBand: "Even",
    ...over,
  };
}

describe("buildPickRows", () => {
  it("assigns rank as input-order index + 1, independent of score", () => {
    const plays = [play({ champId: 1, score: 0.1 }), play({ champId: 2, score: 0.9 })];
    const rows = buildPickRows(plays, new Map());
    expect(rows.map((r) => r.rank)).toEqual([1, 2]);
  });

  it("falls back to a placeholder name/icon when the champion isn't in champIcons", () => {
    const rows = buildPickRows([play({ champId: 99 })], new Map());
    expect(rows[0].name).toBe("Champion #99");
    expect(rows[0].icon).toBe("");
  });

  it("defaults synergyDelta/synergyBand to 0/Even when absent from the wire (older cached response)", () => {
    const rows = buildPickRows([play({ champId: 1 })], new Map());
    expect(rows[0].synergyDelta).toBe(0);
    expect(rows[0].synergyBand).toBe("Even");
  });

  it("passes through real synergy fields when present", () => {
    const p = play({ champId: 1 }) as DraftPlayResult & { synergyDelta: number; synergyBand: "Strong" };
    p.synergyDelta = 0.03;
    p.synergyBand = "Strong";
    const rows = buildPickRows([p], new Map());
    expect(rows[0].synergyDelta).toBe(0.03);
    expect(rows[0].synergyBand).toBe("Strong");
  });

  it("difficulty/difficultyBand degrade to null when absent from champIcons", () => {
    const icons = new Map<number, ChampionIconEntry>([[1, { name: "Ahri", icon: "x" }]]);
    const rows = buildPickRows([play({ champId: 1 })], icons);
    expect(rows[0].difficulty).toBeNull();
    expect(rows[0].difficultyBand).toBeNull();
  });

  it("surfaces real difficulty fields when present on the champIcons entry", () => {
    const icons = new Map<number, ChampionIconEntry & { difficulty: number; difficultyBand: "High" }>([
      [1, { name: "Zed", icon: "x", difficulty: 9, difficultyBand: "High" }],
    ]);
    const rows = buildPickRows([play({ champId: 1 })], icons);
    expect(rows[0].difficulty).toBe(9);
    expect(rows[0].difficultyBand).toBe("High");
  });

  it("minGames prefers winVsLaneOppGames over the candidate's own minGames, mirroring DraftResultRow", () => {
    const rows = buildPickRows([play({ champId: 1, minGames: 5000, winVsLaneOppGames: 1200 })], new Map());
    expect(rows[0].minGames).toBe(1200);
  });

  it("games mirrors minGames's resolution (winVsLaneOppGames over the candidate's own minGames)", () => {
    const rows = buildPickRows([play({ champId: 1, minGames: 5000, winVsLaneOppGames: 1200 })], new Map());
    expect(rows[0].games).toBe(1200);
  });

  it("games falls back to the candidate's own minGames when no lane-matchup sample exists", () => {
    const rows = buildPickRows([play({ champId: 1, minGames: 800, winVsLaneOppGames: null })], new Map());
    expect(rows[0].games).toBe(800);
  });

  it("games is always a number, never null, even when both sources are absent", () => {
    const rows = buildPickRows([play({ champId: 1, minGames: 0, winVsLaneOppGames: null })], new Map());
    expect(rows[0].games).toBe(0);
  });
});

function row(over: Partial<PickRow> & { champId: number; rank: number }): PickRow {
  return {
    name: `C${over.champId}`,
    icon: "",
    score: 0.5,
    winVsLaneOpp: null,
    confidence: "normal",
    minGames: 100,
    games: 100,
    personal: null,
    personalOverall: { games: 0, wins: 0 },
    difficulty: null,
    difficultyBand: null,
    synergyDelta: 0,
    synergyBand: "Even",
    ...over,
  };
}

describe("sortPickRows", () => {
  const rows = [
    row({ champId: 1, rank: 1, score: 0.3, difficulty: 5, synergyDelta: -0.02 }),
    row({ champId: 2, rank: 2, score: 0.9, difficulty: 2, synergyDelta: 0.05 }),
    row({ champId: 3, rank: 3, score: 0.5, difficulty: null, synergyDelta: 0 }),
  ];

  it("rank sort is a no-op (always server order), regardless of dir", () => {
    expect(sortPickRows(rows, { key: "rank", dir: "desc" })).toEqual(rows);
  });

  it("winRate desc sorts highest score first", () => {
    const sorted = sortPickRows(rows, { key: "winRate", dir: "desc" });
    expect(sorted.map((r) => r.champId)).toEqual([2, 3, 1]);
  });

  it("winRate asc sorts lowest score first", () => {
    const sorted = sortPickRows(rows, { key: "winRate", dir: "asc" });
    expect(sorted.map((r) => r.champId)).toEqual([1, 3, 2]);
  });

  it("difficulty sort treats null as lowest, never throws", () => {
    const sorted = sortPickRows(rows, { key: "difficulty", dir: "desc" });
    expect(sorted.map((r) => r.champId)).toEqual([1, 2, 3]);
  });

  it("never mutates the input array", () => {
    const copy = [...rows];
    sortPickRows(rows, { key: "winRate", dir: "desc" });
    expect(rows).toEqual(copy);
  });
});

describe("nextPickSortState", () => {
  it("clicking a fresh numeric column starts DESC", () => {
    expect(nextPickSortState(DEFAULT_PICK_SORT, "winRate")).toEqual({ key: "winRate", dir: "desc" });
  });
  it("clicking the same column again toggles to ASC", () => {
    expect(nextPickSortState({ key: "winRate", dir: "desc" }, "winRate")).toEqual({ key: "winRate", dir: "asc" });
  });
  it("clicking Rank always resets to default", () => {
    expect(nextPickSortState({ key: "synergy", dir: "asc" }, "rank")).toEqual(DEFAULT_PICK_SORT);
  });
});

describe("ariaSortFor", () => {
  it("none for a column that isn't the active sort", () => {
    expect(ariaSortFor("difficulty", DEFAULT_PICK_SORT)).toBe("none");
  });
  it("reflects the active column's direction", () => {
    expect(ariaSortFor("synergy", { key: "synergy", dir: "desc" })).toBe("descending");
    expect(ariaSortFor("synergy", { key: "synergy", dir: "asc" })).toBe("ascending");
  });
});

describe("pickSortCaption / isDefaultPickSort", () => {
  it("null on default sort", () => {
    expect(pickSortCaption(DEFAULT_PICK_SORT)).toBeNull();
    expect(isDefaultPickSort(DEFAULT_PICK_SORT)).toBe(true);
  });
  it("names the column and disclaims ranking ownership on a non-default sort", () => {
    expect(pickSortCaption({ key: "synergy", dir: "desc" })).toBe("Sorted by Matchup Synergy — ranking is CoachBuild's own.");
    expect(isDefaultPickSort({ key: "synergy", dir: "desc" })).toBe(false);
  });
});

describe("difficultyLabel", () => {
  it("em-dash for null", () => {
    expect(difficultyLabel(null)).toBe("—");
  });
  it("passes through a real band", () => {
    expect(difficultyLabel("High")).toBe("High");
  });
});

describe("synergyClass", () => {
  it("Strong -> good, Weak -> bad, Even -> neutral", () => {
    expect(synergyClass("Strong")).toBe("text-good");
    expect(synergyClass("Weak")).toBe("text-bad");
    expect(synergyClass("Even")).toBe("text-mut");
  });
});
