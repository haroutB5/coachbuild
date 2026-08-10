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

// ── Per-slot rune counts ─────────────────────────────────────────────────────
// The property under test is that each slot gets its OWN denominator. Every
// fixture below therefore has UNEVEN slot coverage on purpose: if the code
// regressed to one page-level figure repeated per slot, the fractions would
// collapse to a single pair and these assertions would fail.

/** A page with independently controllable slots. Anything passed as `null` is
 *  ABSENT from that game — the case a slot denominator must not count. */
function runes(over: {
  primaryTree?: number;
  keystone?: number | null;
  primary?: (number | null)[];
  secondaryTree?: number | null;
  secondary?: number[];
  shards?: (number | null)[];
} = {}) {
  const strip = (xs: (number | null)[]) => xs.filter((x): x is number => x != null);
  return {
    primaryTree: over.primaryTree ?? 8200,
    keystone: over.keystone === undefined ? 8214 : over.keystone,
    primary: strip(over.primary ?? [8226, 8234, 8237]),
    secondaryTree: over.secondaryTree === undefined ? 8000 : over.secondaryTree,
    secondary: over.secondary ?? [9105, 8017],
    shards: strip(over.shards ?? [5008, 5008, 5011]),
  };
}

describe("buildFeaturedModel per-slot rune counts", () => {
  it("gives each slot its own denominator when coverage is uneven", () => {
    // 5 games. Row 1 is missing from one, row 2 from two — so the three primary
    // rows must report three DIFFERENT denominators, none of them 5.
    const m = buildFeaturedModel([
      game({ runes: runes({ primary: [8226, 8234, 8237] }) }),
      game({ runes: runes({ primary: [8226, 8234, 8237] }) }),
      game({ runes: runes({ primary: [8226, 8234, 8232] }) }),
      game({ runes: runes({ primary: [8226, 8210, null] }) }),
      game({ runes: runes({ primary: [8275, null, null] }) }),
    ]);
    const slots = m.runes!.slots;
    expect(m.games).toBe(5);
    expect(slots.primaryTreeGames).toBe(5);
    // Row 0: every game filled it; 4 of the 5 ran the displayed rune.
    expect(slots.primaryRows[0]).toEqual({ runeId: 8226, count: 4, sampleSize: 5 });
    // Row 1: four games filled it, three ran the displayed rune. NOT /5.
    expect(slots.primaryRows[1]).toEqual({ runeId: 8234, count: 3, sampleSize: 4 });
    // Row 2: three games filled it, two ran the displayed rune. NOT /5 either.
    expect(slots.primaryRows[2]).toEqual({ runeId: 8237, count: 2, sampleSize: 3 });
    // Three rows, three denominators, and none of them is the exact-page
    // figure the card used to print under every rune.
    expect(m.runes!.games).toBe(2);
    expect(new Set(slots.primaryRows.map((r) => r!.sampleSize)).size).toBe(3);
  });

  it("leaves a slot no game filled empty instead of defaulting it", () => {
    // No game records a third primary minor or a defense shard. Those slots
    // must come back null — an absent slot is not a zero and not a borrowed
    // page-level count.
    const m = buildFeaturedModel([
      game({ runes: runes({ primary: [8226, 8234, null], shards: [5008, 5008, null] }) }),
      game({ runes: runes({ primary: [8226, 8234, null], shards: [5008, 5008, null] }) }),
    ]);
    const slots = m.runes!.slots;
    expect(slots.primaryRows[2]).toBeNull();
    expect(slots.shards[2]).toBeNull();
    expect(slots.primaryRows[0]).toEqual({ runeId: 8226, count: 2, sampleSize: 2 });
  });

  it("counts a keystone only against games that ran its tree", () => {
    // Two games on Sorcery, two on Domination. The displayed Sorcery keystone
    // must read 2/2, never 2/4 — a Domination game could not have run it.
    const m = buildFeaturedModel([
      game({ runes: runes({ primaryTree: 8200, keystone: 8214 }) }),
      game({ runes: runes({ primaryTree: 8200, keystone: 8214 }) }),
      game({ runes: runes({ primaryTree: 8100, keystone: 8112, primary: [8126, 8139, 8135] }) }),
      game({ runes: runes({ primaryTree: 8100, keystone: 8128, primary: [8126, 8139, 8135] }) }),
    ]);
    const slots = m.runes!.slots;
    expect(m.games).toBe(4);
    expect(slots.primaryTreeGames).toBe(2);
    expect(slots.keystone).toEqual({ runeId: 8214, count: 2, sampleSize: 2 });
    // The off-tree games are excluded from the primary ROWS too, for the same
    // reason: their row-0 rune is a Domination rune and was never a candidate.
    expect(slots.primaryRows[0]).toEqual({ runeId: 8226, count: 2, sampleSize: 2 });
  });

  it("counts a keystone the player also ran under a losing page", () => {
    // The exact page repeats twice; a third game keeps the keystone but swaps a
    // minor. The keystone is 3/3 while the exact page is 2/3 — the whole point
    // of counting slots separately.
    const m = buildFeaturedModel([
      game({ runes: runes({ primary: [8226, 8234, 8237] }) }),
      game({ runes: runes({ primary: [8226, 8234, 8237] }) }),
      game({ runes: runes({ primary: [8226, 8234, 8232] }) }),
    ]);
    expect(m.runes!.games).toBe(2);
    expect(m.runes!.slots.keystone).toEqual({ runeId: 8214, count: 3, sampleSize: 3 });
    expect(m.runes!.slots.primaryRows[2]).toEqual({ runeId: 8237, count: 2, sampleSize: 3 });
  });

  it("places secondary picks by tree row, not by array position", () => {
    // 9105 is a Precision row-1 rune and 8017 a row-2 rune, listed here in one
    // order and reversed in the next game. Both games ran the SAME two runes,
    // so each row must read 2/2 — an array-position mapping would score 0/2.
    const m = buildFeaturedModel([
      game({ runes: runes({ secondary: [9105, 8017] }) }),
      game({ runes: runes({ secondary: [8017, 9105] }) }),
    ]);
    const slots = m.runes!.slots;
    expect(slots.secondaryRows[0]).toBeNull();
    expect(slots.secondaryRows[1]).toEqual({ runeId: 9105, count: 2, sampleSize: 2 });
    expect(slots.secondaryRows[2]).toEqual({ runeId: 8017, count: 2, sampleSize: 2 });
  });

  it("counts secondary rows only over games running that secondary tree", () => {
    const m = buildFeaturedModel([
      game({ runes: runes({ secondaryTree: 8000, secondary: [9105, 8017] }) }),
      game({ runes: runes({ secondaryTree: 8000, secondary: [9105, 8017] }) }),
      game({ runes: runes({ secondaryTree: 8000, secondary: [9105, 8014] }) }),
      game({ runes: runes({ secondaryTree: 8400, secondary: [8429, 8451] }) }),
    ]);
    const slots = m.runes!.slots;
    // The Resolve game ran the same PRIMARY tree, so it counts on that side —
    // but it could not have run a Precision secondary rune, so it is excluded
    // from both secondary rows.
    expect(slots.primaryTreeGames).toBe(4);
    expect(slots.secondaryTreeGames).toBe(3);
    expect(slots.secondaryRows[1]).toEqual({ runeId: 9105, count: 3, sampleSize: 3 });
    expect(slots.secondaryRows[2]).toEqual({ runeId: 8017, count: 2, sampleSize: 3 });
  });

  it("counts shards across every game, tree or not", () => {
    // Shards belong to no tree, so the off-tree game still counts toward them —
    // a denominator of 4 here against a primary-side denominator of 3.
    const m = buildFeaturedModel([
      game({ runes: runes({ primaryTree: 8200, shards: [5008, 5008, 5011] }) }),
      game({ runes: runes({ primaryTree: 8200, shards: [5008, 5008, 5011] }) }),
      game({ runes: runes({ primaryTree: 8200, shards: [5008, 5010, 5011] }) }),
      game({ runes: runes({ primaryTree: 8100, primary: [8126, 8139, 8135], shards: [5005, 5008, 5011] }) }),
    ]);
    const slots = m.runes!.slots;
    expect(slots.primaryTreeGames).toBe(3);
    expect(slots.shards[0]).toEqual({ runeId: 5008, count: 3, sampleSize: 4 });
    expect(slots.shards[1]).toEqual({ runeId: 5008, count: 3, sampleSize: 4 });
    expect(slots.shards[2]).toEqual({ runeId: 5011, count: 4, sampleSize: 4 });
  });

  it("excludes games with no usable rune payload from every denominator", () => {
    // A row that stored nothing had no opinion about any slot. Counting it
    // would understate every rune on the page.
    const m = buildFeaturedModel([
      game({ runes: runes() }),
      game({ runes: runes() }),
      game({ runes: null }),
      game({ runes: { primary: [], secondary: [], shards: [] } }),
    ]);
    const slots = m.runes!.slots;
    expect(m.games).toBe(4);
    expect(slots.primaryTreeGames).toBe(2);
    expect(slots.keystone).toEqual({ runeId: 8214, count: 2, sampleSize: 2 });
  });

  it("never reports a count larger than its own denominator", () => {
    const m = buildFeaturedModel([
      game({ runes: runes({ primary: [8226, 8234, 8237] }) }),
      game({ runes: runes({ primary: [8275, 8210, null] }) }),
      game({ runes: runes({ primaryTree: 8100, primary: [8126, 8139, 8135] }) }),
    ]);
    const slots = m.runes!.slots;
    const every = [slots.keystone, ...slots.primaryRows, ...slots.secondaryRows, ...slots.shards];
    for (const slot of every) {
      if (!slot) continue;
      expect(slot.count).toBeGreaterThanOrEqual(0);
      expect(slot.count).toBeLessThanOrEqual(slot.sampleSize);
      expect(slot.sampleSize).toBeGreaterThan(0);
      expect(slot.sampleSize).toBeLessThanOrEqual(m.games);
    }
  });
});
