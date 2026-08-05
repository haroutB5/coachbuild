import { describe, it, expect } from "vitest";
import { buildFeaturedModel, type FeaturedMatchRow } from "../otp/featured";
import { kitFromMaxRanks } from "../championKit";

const page = (keystone: number, primaryTree = 8200) => ({
  primaryTree,
  keystone,
  primary: [8226, 8234],
  secondaryTree: 8000,
  secondary: [8017, 9105],
  shards: [5005, 5008, 5011],
});

const game = (over: Partial<FeaturedMatchRow> = {}): FeaturedMatchRow => ({
  win: true,
  final_items: [3100, 6653],
  runes: page(8992),
  spells: [4, 6],
  skill_order: null,
  ...over,
});

describe("buildFeaturedModel", () => {
  it("reports build rate as a share of the player's own games", () => {
    const m = buildFeaturedModel([
      game({ final_items: [3100, 6653] }),
      game({ final_items: [3100, 3157] }),
      game({ final_items: [3100, 6653] }),
      game({ final_items: [4645] }),
    ]);
    expect(m.games).toBe(4);
    expect(m.items[0]).toEqual({ itemId: 3100, games: 3, pct: 75 });
    expect(m.items.find((i) => i.itemId === 6653)).toEqual({ itemId: 6653, games: 2, pct: 50 });
    expect(m.items.find((i) => i.itemId === 4645)).toEqual({ itemId: 4645, games: 1, pct: 25 });
  });

  it("counts a duplicated item once per game", () => {
    // One inventory listing the same id twice is one game that built it.
    const m = buildFeaturedModel([game({ final_items: [3100, 3100, 3100] })]);
    expect(m.items[0]).toEqual({ itemId: 3100, games: 1, pct: 100 });
  });

  it("applies the caller's item filter rather than guessing at metadata", () => {
    const m = buildFeaturedModel([game({ final_items: [3100, 1058, 2003] })], (id) => id !== 2003);
    expect(m.items.map((i) => i.itemId).sort()).toEqual([1058, 3100]);
  });

  it("picks the modal rune page, not the first seen", () => {
    const m = buildFeaturedModel([
      game({ runes: page(8112) }),
      game({ runes: page(8992) }),
      game({ runes: page(8992) }),
    ]);
    expect(m.runes?.page.keystone).toBe(8992);
    expect(m.runes?.games).toBe(2);
    expect(m.runes?.pct).toBe(67);
  });

  it("breaks tied rune and spell modals by canonical id order, not first-seen order", () => {
    const m = buildFeaturedModel([
      game({ runes: page(8992), spells: [4, 12] }),
      game({ runes: page(8112), spells: [4, 6] }),
    ]);
    expect(m.runes?.page.keystone).toBe(8112);
    expect(m.spells?.spells).toEqual([4, 6]);
  });

  it("treats pages with neither keystone nor tree as absent", () => {
    // Otherwise empty pages win the modal count by sheer volume and the card
    // claims a rune setup the player never ran.
    const m = buildFeaturedModel([
      game({ runes: { primary: [], secondary: [], shards: [] } }),
      game({ runes: { primary: [], secondary: [], shards: [] } }),
      game({ runes: page(8992) }),
    ]);
    expect(m.runes?.page.keystone).toBe(8992);
    expect(m.runes?.games).toBe(1);
  });

  it("normalises spell pair order so 4,6 and 6,4 are the same choice", () => {
    const m = buildFeaturedModel([
      game({ spells: [4, 6] }),
      game({ spells: [6, 4] }),
      game({ spells: [4, 12] }),
    ]);
    expect(m.spells?.spells).toEqual([4, 6]);
    expect(m.spells?.games).toBe(2);
  });

  it("returns the full modal skill model over timeline-backed games", () => {
    const m = buildFeaturedModel([
      game({ skill_order: ["Q", "W", "E", "Q", "Q", "R"] }),
      game({ skill_order: ["Q", "W", "E", "Q", "Q", "R"] }),
      game({ skill_order: ["W", "Q", "E", "Q", "W", "R"] }),
      game({ skill_order: null }),
      game({ skill_order: [] }),
    ]);
    expect(m.skillOrder).toMatchObject({
      priority: ["Q", "W", "E"],
      order: ["Q", "W", "E", "Q", "Q", "R"],
      observedLevels: 6,
      sampleSize: 3,
      completed: false,
    });
    expect(m.skillOrder?.inferredTail).toBeUndefined();
    expect(m.skillOrder?.completionBasis).toBeUndefined();
    expect(m.skillOrder?.inferredBasis).toBeUndefined();
  });

  it("passes a resolved non-standard kit into recorded aggregation", () => {
    const model = buildFeaturedModel(
      [game({ skill_order: "QWEQQWQWQWQWWEEEEE".split("") })],
      undefined,
      kitFromMaxRanks([6, 6, 6, 1])
    );
    expect(model.skillOrder?.order.join("")).toBe("QWEQQWQWQWQWWEEEEE");
    expect(model.skillOrder?.levels.R).toEqual([]);
    expect(model.skillOrder?.kit?.maxRanks).toEqual({ Q: 6, W: 6, E: 6, R: 1 });
  });

  it("keeps levels reached by fewer games and never treats missing timelines as a sample", () => {
    const m = buildFeaturedModel([
      game({ skill_order: ["Q", "W", "E", "Q"] }),
      game({ skill_order: ["Q", "W"] }),
      game({ skill_order: null }),
    ]);
    expect(m.skillOrder).toMatchObject({
      order: ["Q", "W", "E", "Q"],
      observedLevels: 4,
      sampleSize: 2,
      completed: false,
    });
  });

  it("survives malformed rows without throwing", () => {
    const m = buildFeaturedModel([
      game({ final_items: null, runes: null, spells: null }),
      game({ final_items: "nope" as unknown as number[], runes: 7 as unknown as object }),
      game({ final_items: [0, -1, 3100] }),
    ]);
    expect(m.games).toBe(3);
    expect(m.items).toEqual([{ itemId: 3100, games: 1, pct: 33 }]);
  });

  it("reports zero games without dividing by zero", () => {
    const m = buildFeaturedModel([]);
    expect(m).toEqual({ games: 0, wins: 0, items: [], gameLog: [], runes: null, spells: null, skillOrder: null });
  });

  it("returns the per-game records the build strip needs", () => {
    // `items` above is a per-item aggregate and cannot answer "which items did
    // they finish holding TOGETHER" — see lib/otp/featuredBuild.ts on why a
    // build assembled from rates and one somebody played must not be
    // confusable.
    const m = buildFeaturedModel([
      game({ final_items: [3100, 6653, 3100] }),
      game({ final_items: [4645] }),
      game({ final_items: null }),
    ]);
    // Deduped within a game, one entry per row, and a malformed row keeps its
    // slot with an empty `items` so the log stays index-aligned with the games
    // it describes and `games` stays the denominator.
    expect(m.gameLog.map((g) => g.items)).toEqual([[3100, 6653], [4645], []]);
    expect(m.gameLog).toHaveLength(m.games);
  });

  it("pairs each inventory with the outcome of the SAME game", () => {
    // The card captions a build "a game they won" off this pairing. Two
    // parallel arrays could desynchronise silently and turn that caption into a
    // lie; one array of records cannot. This pins the pairing, including for a
    // malformed row, whose outcome is still a known fact about a real game.
    const m = buildFeaturedModel([
      game({ final_items: [3100, 6653], win: true }),
      game({ final_items: [4645], win: false }),
      game({ final_items: null, win: true }),
    ]);
    expect(m.gameLog).toEqual([
      { items: [3100, 6653], win: true },
      { items: [4645], win: false },
      { items: [], win: true },
    ]);
    expect(m.wins).toBe(2);
  });

  it("applies the caller's item filter to the per-game inventories too", () => {
    const m = buildFeaturedModel([game({ final_items: [3100, 2003] })], (id) => id !== 2003);
    expect(m.gameLog.map((g) => g.items)).toEqual([[3100]]);
  });
});
