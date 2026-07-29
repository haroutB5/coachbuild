// Tests for the featured one-trick's item model (lib/otp/featuredBuild.ts) and
// the snowball-stack family (lib/snowballStacks.ts).
//
// The fixtures below are a real 37-game Viktor-shaped sample: build rates in the
// 40-90% range, a split boots preference, an opener, and Mejai's at a rate high
// enough to have genuinely occupied a top-6 slot. Numbers are chosen so the
// exact-set threshold is EXERCISED in both directions rather than cleared by a
// mile — a fixture that never reaches a boundary tests nothing about it.

import { describe, it, expect } from "vitest";
import type { ItemDetail } from "@/components/itemDetail";
import { isSnowballStackItem, SNOWBALL_STACK_ITEM_IDS } from "@/lib/snowballStacks";
import { STARTING_ITEM_ALLOWLIST } from "@/lib/startingItems";
import {
  buildFeaturedView,
  classifyFeaturedItem,
  resolveFullBuild,
  type FeaturedItemRate,
} from "../otp/featuredBuild";

// ── Item ids + metadata, shaped like live 16.13.1 ddragon ───────────────────
const MEJAIS = 3041;
const DARK_SEAL = 1082;
const DORANS_RING = 1056;
const ROCKETBELT = 3152;
const RABADONS = 3089;
const ZHONYAS = 3157;
const SHADOWFLAME = 4645;
const VOID_STAFF = 3135;
const BANSHEES = 3102;
const CRYPTBLOOM = 3011; // the "seventh item" that must backfill Mejai's slot
const NEEDLESSLY_LARGE_ROD = 1058; // component — never a build slot
const SORCS = 3020; // tier-2 boots: Boots-tagged WITH a live `into` enchant
const SWIFTMARCH = 3009;
const IONIANS = 3158;
const HEALTH_POTION = 2003;

function meta(over: Partial<ItemDetail> & { id: number }): ItemDetail {
  return {
    name: `Item ${over.id}`,
    goldTotal: 3000,
    descriptionText: "",
    into: [],
    from: ["1058"],
    tags: [],
    purchasable: true,
    ...over,
  };
}

const META: ReadonlyMap<number, ItemDetail> = new Map(
  [
    meta({ id: MEJAIS, name: "Mejai's Soulstealer", goldTotal: 1600, from: ["1082"] }),
    meta({ id: DARK_SEAL, name: "Dark Seal", goldTotal: 350, from: [], into: ["3041"], tags: ["Lane"] }),
    meta({ id: DORANS_RING, name: "Doran's Ring", goldTotal: 400, from: [], tags: ["Lane"] }),
    meta({ id: ROCKETBELT, name: "Hextech Rocketbelt" }),
    meta({ id: RABADONS, name: "Rabadon's Deathcap" }),
    meta({ id: ZHONYAS, name: "Zhonya's Hourglass" }),
    meta({ id: SHADOWFLAME, name: "Shadowflame" }),
    meta({ id: VOID_STAFF, name: "Void Staff" }),
    meta({ id: BANSHEES, name: "Banshee's Veil" }),
    meta({ id: CRYPTBLOOM, name: "Cryptbloom" }),
    // A real component: purchasable, but `into` is populated.
    meta({ id: NEEDLESSLY_LARGE_ROD, name: "Needlessly Large Rod", from: [], into: ["3089", "3152"] }),
    // Tier-2 boots keep a live `into` (the 2026 tier-3 enchant rework) — the
    // case a plain empty-into rule gets wrong.
    meta({ id: SORCS, name: "Sorcerer's Shoes", goldTotal: 1100, tags: ["Boots"], into: ["3013"] }),
    meta({ id: SWIFTMARCH, name: "Swiftmarch", goldTotal: 1250, tags: ["Boots"] }),
    meta({ id: IONIANS, name: "Ionian Boots of Lucidity", goldTotal: 1100, tags: ["Boots"], into: ["3014"] }),
    meta({ id: HEALTH_POTION, name: "Health Potion", goldTotal: 50, from: [], tags: ["Consumable"] }),
  ].map((m) => [m.id, m])
);

const SAMPLE_GAMES = 37;
const rate = (itemId: number, games: number): FeaturedItemRate => ({
  itemId,
  games,
  pct: Math.round((games / SAMPLE_GAMES) * 100),
});

/** Seven completed items compete for six slots, and Mejai's outranks the
 *  seventh — so dropping it must promote Cryptbloom, not shorten the list. */
const RATES: FeaturedItemRate[] = [
  rate(ROCKETBELT, 33),
  rate(RABADONS, 30),
  rate(SHADOWFLAME, 26),
  rate(ZHONYAS, 21),
  rate(VOID_STAFF, 18),
  rate(MEJAIS, 15),
  rate(CRYPTBLOOM, 12),
  rate(BANSHEES, 6),
  rate(SORCS, 22),
  rate(SWIFTMARCH, 11),
  rate(IONIANS, 3),
  rate(DORANS_RING, 20),
  rate(DARK_SEAL, 14),
  rate(NEEDLESSLY_LARGE_ROD, 4),
  rate(HEALTH_POTION, 31),
];

const classOf = (id: number) => classifyFeaturedItem(id, META.get(id));

describe("snowball stacks", () => {
  it("names Mejai's and Dark Seal, and nothing else", () => {
    expect(isSnowballStackItem(MEJAIS)).toBe(true);
    expect(isSnowballStackItem(DARK_SEAL)).toBe(true);
    expect(isSnowballStackItem(RABADONS)).toBe(false);
    expect(Array.from(SNOWBALL_STACK_ITEM_IDS).sort((a, b) => a - b)).toEqual([DARK_SEAL, MEJAIS]);
  });

  it("does not remove Dark Seal from the starter allowlist", () => {
    // Double-handling guard. The two lists overlap ON PURPOSE and must stay
    // independent: the snowball rule governs completed-item lists, the
    // allowlist governs the opener slot. If a future edit "simplifies" one by
    // deleting 1082 from the other, the Pro card's Starting slot loses a real
    // build choice — a silent regression with no error anywhere.
    expect(STARTING_ITEM_ALLOWLIST.has(DARK_SEAL)).toBe(true);
  });
});

describe("classifyFeaturedItem", () => {
  it("puts each id in exactly one slot", () => {
    expect(classOf(ROCKETBELT)).toBe("completed");
    expect(classOf(SORCS)).toBe("boots"); // Boots-tagged despite a live `into`
    expect(classOf(DORANS_RING)).toBe("starter");
    expect(classOf(MEJAIS)).toBe("snowball");
    expect(classOf(NEEDLESSLY_LARGE_ROD)).toBe("excluded");
    expect(classOf(HEALTH_POTION)).toBe("excluded");
  });

  it("classifies Dark Seal as a STARTER, not a snowball stack", () => {
    // Precedence regression, caught on review 2026-07-29. Dark Seal is in both
    // families; the snowball rule governs BUILD SLOTS, and an opener is not a
    // build slot. Classifying it `snowball` contradicted snowballStacks.ts's
    // own contract and made this card disagree with the Pro card's Starting
    // slot about the same item. Mejai's is the id the directive named, and it
    // is not allowlisted, so it is unaffected by this ordering.
    expect(classOf(DARK_SEAL)).toBe("starter");
    expect(isSnowballStackItem(DARK_SEAL)).toBe(true); // still in the family
    expect(classOf(MEJAIS)).toBe("snowball");
  });

  it("excludes an id with no metadata rather than assuming it is finished", () => {
    expect(classifyFeaturedItem(99999, undefined)).toBe("excluded");
  });

  it("excludes raw tier-1 Boots — Boots-tagged, but a component", () => {
    // 1001 is built from nothing and upgrades into every tier-2 boot. Tagging
    // alone would make it a boots PICK and let it take a slot in a full build.
    const rawBoots = meta({
      id: 1001,
      name: "Boots",
      goldTotal: 300,
      from: [],
      into: ["3020", "3009", "3158"],
      tags: ["Boots"],
    });
    expect(classifyFeaturedItem(1001, rawBoots)).toBe("excluded");
  });

  it("still classifies a snowball stack with no metadata", () => {
    // The exclusion must not depend on a CDN fetch having succeeded.
    expect(classifyFeaturedItem(MEJAIS, undefined)).toBe("snowball");
  });
});

describe("buildFeaturedView — items", () => {
  const view = buildFeaturedView(RATES, [], SAMPLE_GAMES, META);

  it("drops Mejai's AND backfills the freed slot", () => {
    // The whole point of the fix: six items, Mejai's gone, and the item that
    // ranked seventh has moved up rather than the list having shortened.
    expect(view.items).toHaveLength(6);
    expect(view.items.map((i) => i.itemId)).toEqual([
      ROCKETBELT,
      RABADONS,
      SHADOWFLAME,
      ZHONYAS,
      VOID_STAFF,
      CRYPTBLOOM,
    ]);
    expect(view.items.map((i) => i.itemId)).not.toContain(MEJAIS);
  });

  it("would have shown Mejai's in a slot Cryptbloom now holds", () => {
    // Pins the premise of the test above: Mejai's out-ranks Cryptbloom, so this
    // is a real promotion and not a list that happened to be six long anyway.
    const mejais = RATES.find((r) => r.itemId === MEJAIS)!;
    const crypt = RATES.find((r) => r.itemId === CRYPTBLOOM)!;
    expect(mejais.games).toBeGreaterThan(crypt.games);
  });

  it("keeps components, consumables, boots and starters out of the item list", () => {
    const ids = view.items.map((i) => i.itemId);
    expect(ids).not.toContain(NEEDLESSLY_LARGE_ROD);
    expect(ids).not.toContain(HEALTH_POTION);
    expect(ids).not.toContain(SORCS);
    expect(ids).not.toContain(DORANS_RING);
  });

  it("applies a display floor, which bites below the six-slot cap", () => {
    // Cryptbloom (12/37 = 32%) drops out at a 35% floor and nothing backfills
    // it, because there is nothing above the floor left — a SHORT list here is
    // correct, unlike the Mejai's case where a qualifying item was waiting.
    const floored = buildFeaturedView(RATES, [], SAMPLE_GAMES, META, { minDisplayPct: 35 });
    expect(floored.items.every((i) => i.pct >= 35)).toBe(true);
    expect(floored.items.map((i) => i.itemId)).toEqual([
      ROCKETBELT,
      RABADONS,
      SHADOWFLAME,
      ZHONYAS,
      VOID_STAFF,
    ]);
  });
});

describe("buildFeaturedView — boots as their own slot", () => {
  it("returns the top three boots with games and pct over the card's denominator", () => {
    const view = buildFeaturedView(RATES, [], SAMPLE_GAMES, META);
    expect(view.boots).toEqual([
      { itemId: SORCS, games: 22, pct: 59 },
      { itemId: SWIFTMARCH, games: 11, pct: 30 },
      { itemId: IONIANS, games: 3, pct: 8 },
    ]);
    // Same denominator as everything else on the card — 22/37, not 22/(22+11+3).
    expect(view.boots[0].pct).toBe(Math.round((22 / SAMPLE_GAMES) * 100));
  });

  it("keeps the third boot when the item grid's display floor is in force", () => {
    // Regression: a single shared floor cut Ionian Boots (3/37 = 8%) and the
    // card showed two boots, not the three the directive asked for. The floors
    // are separate for exactly this reason.
    const view = buildFeaturedView(RATES, [], SAMPLE_GAMES, META, { minDisplayPct: 15 });
    expect(view.boots.map((b) => b.itemId)).toEqual([SORCS, SWIFTMARCH, IONIANS]);
    expect(view.items.every((i) => i.pct >= 15)).toBe(true);
  });

  it("still honours an explicit boots floor when a caller asks for one", () => {
    const view = buildFeaturedView(RATES, [], SAMPLE_GAMES, META, { bootsMinDisplayPct: 15 });
    expect(view.boots.map((b) => b.itemId)).toEqual([SORCS, SWIFTMARCH]);
  });

  it("returns fewer than three when they have not built three, never padded", () => {
    const thin = RATES.filter((r) => r.itemId !== IONIANS && r.itemId !== SWIFTMARCH);
    const view = buildFeaturedView(thin, [], SAMPLE_GAMES, META);
    expect(view.boots.map((b) => b.itemId)).toEqual([SORCS]);
  });

  it("returns no boots at all when the player never finished with any", () => {
    const none = RATES.filter((r) => classOf(r.itemId) !== "boots");
    expect(buildFeaturedView(none, [], SAMPLE_GAMES, META).boots).toEqual([]);
  });
});

describe("buildFeaturedView — starters", () => {
  it("shows the Dark Seal opener, most-built first", () => {
    // "Opens Dark Seal in nearly 6 games of 10" is the read this row exists to
    // give. Losing it was the regression the precedence swap fixed.
    const view = buildFeaturedView(RATES, [], SAMPLE_GAMES, META);
    expect(view.starters.map((s) => s.itemId)).toEqual([DORANS_RING, DARK_SEAL]);
  });

  it("never lets a starter reach a build slot", () => {
    // The opener stays an opener. HARD RULE 2, and the reason the snowball
    // precedence swap is safe: `items` and `fullBuild` both draw from
    // `completed`/`boots` only, so neither Dark Seal nor Doran's Ring can
    // appear as a build item however they classify.
    const view = buildFeaturedView(RATES, sampleWithExactRepeats(3), SAMPLE_GAMES, META);
    expect(view.items.map((i) => i.itemId)).not.toContain(DARK_SEAL);
    expect(view.fullBuild!.items.map((i) => i.itemId)).not.toContain(DARK_SEAL);
    expect(view.boots.map((i) => i.itemId)).not.toContain(DARK_SEAL);
  });
});

// ── The full build ──────────────────────────────────────────────────────────
// A helper that repeats one exact inventory n times inside a realistic tail of
// varied games, so the modal set has to WIN a vote rather than be the only
// candidate.
const EXACT = [ROCKETBELT, SORCS, RABADONS, SHADOWFLAME, ZHONYAS, VOID_STAFF];
function sampleWithExactRepeats(n: number): number[][] {
  const games: number[][] = [];
  for (let i = 0; i < n; i++) games.push([...EXACT]);
  // Varied real games: each a legal 5-6 slot inventory, all distinct, so none
  // of them can out-vote the repeated set.
  games.push([ROCKETBELT, SORCS, RABADONS, SHADOWFLAME, BANSHEES, VOID_STAFF]);
  games.push([ROCKETBELT, SWIFTMARCH, RABADONS, ZHONYAS, CRYPTBLOOM]);
  games.push([ROCKETBELT, SORCS, RABADONS, SHADOWFLAME, CRYPTBLOOM, BANSHEES]);
  games.push([ROCKETBELT, IONIANS, RABADONS, VOID_STAFF, ZHONYAS, CRYPTBLOOM]);
  return games;
}

describe("resolveFullBuild", () => {
  it("uses the exact repeated set once it repeats three times", () => {
    const build = resolveFullBuild(RATES, sampleWithExactRepeats(3), SAMPLE_GAMES, classOf);
    expect(build).not.toBeNull();
    expect(build!.method).toBe("most-played-exact");
    expect(build!.games).toBe(3);
    expect(build!.sampleGames).toBe(SAMPLE_GAMES);
    expect(build!.items.map((i) => i.itemId).sort((a, b) => a - b)).toEqual(
      [...EXACT].sort((a, b) => a - b)
    );
  });

  it("falls back to a LABELLED synthesis at two repeats — the threshold boundary", () => {
    // n=2 is the case the boundary exists for: an exact set that happened
    // twice is not "the build they build most", and the card must not imply a
    // game count for what replaces it.
    const build = resolveFullBuild(RATES, sampleWithExactRepeats(2), SAMPLE_GAMES, classOf);
    expect(build!.method).toBe("assembled-from-rates");
    expect(build!.games).toBeNull();
    expect(build!.sampleGames).toBe(SAMPLE_GAMES);
  });

  it("assembles six legal slots with exactly one pair of boots", () => {
    const build = resolveFullBuild(RATES, sampleWithExactRepeats(0), SAMPLE_GAMES, classOf);
    expect(build!.method).toBe("assembled-from-rates");
    expect(build!.items).toHaveLength(6);
    expect(build!.items.filter((i) => i.isBoots)).toHaveLength(1);
    expect(build!.items.filter((i) => i.isBoots)[0].itemId).toBe(SORCS);
    // No snowball stack, no starter, no component sneaks into a "full build".
    const ids = build!.items.map((i) => i.itemId);
    expect(ids).not.toContain(MEJAIS);
    expect(ids).not.toContain(DORANS_RING);
    expect(ids).not.toContain(NEEDLESSLY_LARGE_ROD);
  });

  it("orders by the player's own build rate, and says nothing about purchase order", () => {
    const build = resolveFullBuild(RATES, sampleWithExactRepeats(3), SAMPLE_GAMES, classOf);
    const games = build!.items.map((i) => i.games);
    expect(games).toEqual([...games].sort((a, b) => b - a));
    // Every slot carries the player's OVERALL rate, not 100%.
    expect(build!.items.find((i) => i.itemId === ROCKETBELT)!.games).toBe(33);
  });

  it("ignores surrendered games when voting for the exact set", () => {
    // Five two-item games are the most common "exact set" in this sample by
    // count. If they were eligible they would win outright and the card would
    // call two items a full build.
    const games = [
      ...sampleWithExactRepeats(3),
      [ROCKETBELT, SORCS],
      [ROCKETBELT, SORCS],
      [ROCKETBELT, SORCS],
      [ROCKETBELT, SORCS],
      [ROCKETBELT, SORCS],
    ];
    const build = resolveFullBuild(RATES, games, SAMPLE_GAMES, classOf);
    expect(build!.method).toBe("most-played-exact");
    expect(build!.items).toHaveLength(6);
  });

  it("counts a set as the same build whatever inventory order it was stored in", () => {
    const shuffled = [[...EXACT], [...EXACT].reverse(), [EXACT[2], EXACT[0], EXACT[5], EXACT[1], EXACT[4], EXACT[3]]];
    const build = resolveFullBuild(RATES, shuffled, SAMPLE_GAMES, classOf);
    expect(build!.method).toBe("most-played-exact");
    expect(build!.games).toBe(3);
  });

  it("strips Mejai's out of a game before that game votes", () => {
    // A player who buys Mejai's in three otherwise-identical games must not get
    // a seven-slot set thrown out, nor a build with Mejai's in it: the stack is
    // removed, the remaining six are the set, and it votes normally.
    const withStack = [
      [...EXACT, MEJAIS],
      [...EXACT, MEJAIS],
      [...EXACT, MEJAIS],
    ];
    const build = resolveFullBuild(RATES, withStack, SAMPLE_GAMES, classOf);
    expect(build!.method).toBe("most-played-exact");
    expect(build!.games).toBe(3);
    expect(build!.items.map((i) => i.itemId)).not.toContain(MEJAIS);
  });

  it("returns null when nothing in the sample is a build item", () => {
    const junk: FeaturedItemRate[] = [rate(HEALTH_POTION, 30), rate(NEEDLESSLY_LARGE_ROD, 8)];
    expect(resolveFullBuild(junk, [[HEALTH_POTION]], SAMPLE_GAMES, classOf)).toBeNull();
  });

  it("survives an empty sample without throwing", () => {
    expect(resolveFullBuild([], [], 0, classOf)).toBeNull();
  });
});

describe("buildFeaturedView — degradation", () => {
  it("returns an empty card rather than a card full of components when metadata is missing", () => {
    const view = buildFeaturedView(RATES, sampleWithExactRepeats(3), SAMPLE_GAMES, new Map());
    expect(view.items).toEqual([]);
    expect(view.boots).toEqual([]);
    expect(view.fullBuild).toBeNull();
    // Starters are id-based and still classify without any metadata, so the
    // opener row survives a failed CDN fetch. The point is that nothing
    // UNKNOWN is promoted into a build slot.
    expect(view.starters.map((s) => s.itemId)).toEqual([DORANS_RING, DARK_SEAL]);
  });
});
