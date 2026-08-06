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
import type { FeaturedGame } from "../otp/featured";

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

  it("backfills a sparse floored list to five full items without changing boot choices", () => {
    // Only the first three completed items clear 60%; the next two are still
    // real completed items and make this a usable five-item OTP build.
    const view = buildFeaturedView(
      RATES,
      Array.from({ length: SAMPLE_GAMES }, () => ({
        items: [ROCKETBELT, RABADONS, SHADOWFLAME, ZHONYAS, VOID_STAFF],
        win: true,
      })),
      SAMPLE_GAMES,
      META,
      { minDisplayPct: 60 }
    );
    expect(view.items.map((i) => i.itemId)).toEqual([
      ROCKETBELT,
      RABADONS,
      SHADOWFLAME,
      ZHONYAS,
      VOID_STAFF,
    ]);
    expect(view.items.slice(3).every((i) => i.pct < 60)).toBe(true);
    expect(view.boots.map((i) => i.itemId)).toEqual([SORCS, SWIFTMARCH, IONIANS]);
    expect(
      view.slots
        .flatMap((slot) => [slot.primary, ...slot.alternatives])
        .map((item) => item.itemId)
        .sort((a, b) => a - b)
    ).toEqual([ROCKETBELT, RABADONS, SHADOWFLAME, ZHONYAS, VOID_STAFF].sort((a, b) => a - b));
  });

  it("keeps support-quest finals out of items and slots for a non-support lane", () => {
    // A handful of mis-roled stored games put Bloodsong into a top-laner's
    // sample (measured live: Jax TOP, 3 of 38 games), and the sparse-build
    // backfill surfaced it — into the rendered build AND the exported in-game
    // item set. `excludeSupportFinalItems` is the guard; the WPA path has its
    // own (lib/supportFinalGroup.ts collapseSupportFinalPools).
    const BLOODSONG = 3877;
    const metaWithBloodsong = new Map([
      ...META,
      [BLOODSONG, meta({ id: BLOODSONG, name: "Bloodsong" })],
    ]);
    // 20/37 = 54%: below the 60% floor but ABOVE Void Staff (49%), so without
    // the guard the backfill would prefer it — the exact failure shape.
    const rates = [...RATES, rate(BLOODSONG, 20)];
    const gameLog = Array.from({ length: SAMPLE_GAMES }, () => ({
      items: [ROCKETBELT, RABADONS, SHADOWFLAME, ZHONYAS, VOID_STAFF, BLOODSONG],
      win: true,
    }));

    const guarded = buildFeaturedView(rates, gameLog, SAMPLE_GAMES, metaWithBloodsong, {
      minDisplayPct: 60,
      excludeSupportFinalItems: true,
    });
    expect(guarded.items.map((i) => i.itemId)).toEqual([
      ROCKETBELT,
      RABADONS,
      SHADOWFLAME,
      ZHONYAS,
      VOID_STAFF,
    ]);
    const slotIds = guarded.slots.flatMap((s) => [s.primary, ...s.alternatives]).map((i) => i.itemId);
    expect(slotIds).not.toContain(BLOODSONG);

    // Control: without the guard the backfill picks it — proving the fixture
    // exercises the boundary rather than clearing it by a mile.
    const unguarded = buildFeaturedView(rates, gameLog, SAMPLE_GAMES, metaWithBloodsong, {
      minDisplayPct: 60,
    });
    expect(unguarded.items.map((i) => i.itemId)).toContain(BLOODSONG);
  });

  it("admits every floor-clearing completed id to slots, not just the displayed six", () => {
    // Regression: restricting the slots include-set to the DISPLAYED items
    // re-priced contested pairs — a pair used to cost one slot but no item
    // budget, so a deep-sampled champion's sixth item vanished (measured live:
    // Viktor lost Rabadon's, Teemo lost Zhonya's). Banshee's clears the 15%
    // floor (6/37 = 16%) but is seventh by rate, so it is NOT in the displayed
    // six — yet it must still be able to appear as a contested alternative.
    const gameLog = Array.from({ length: SAMPLE_GAMES }, (_, i) => ({
      items: [
        ROCKETBELT,
        ...(i < 30 ? [RABADONS] : []),
        ...(i < 26 ? [SHADOWFLAME] : []),
        ...(i < 21 ? [ZHONYAS] : []),
        ...(i < 19 ? [VOID_STAFF] : []),
        ...(i < 12 ? [CRYPTBLOOM] : []),
        ...(i >= 21 && i < 27 ? [BANSHEES] : []),
      ],
      win: true,
    }));
    const view = buildFeaturedView(RATES, gameLog, SAMPLE_GAMES, META, { minDisplayPct: 15 });
    // The displayed list is unchanged — Banshee's is a slots concern only.
    expect(view.items.map((i) => i.itemId)).toEqual([
      ROCKETBELT,
      RABADONS,
      SHADOWFLAME,
      ZHONYAS,
      VOID_STAFF,
      CRYPTBLOOM,
    ]);
    const slotIds = view.slots.flatMap((s) => [s.primary, ...s.alternatives]).map((i) => i.itemId);
    expect(slotIds).toContain(BANSHEES);
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

// ── The example build ───────────────────────────────────────────────────────
// Two branches: a repeated FULL BUILD (five finished non-boots items PLUS
// boots, user directive 2026-07-29), or one real game drawn from a LOWER floor
// so a shallow sample still shows something real. There is no
// assembled/synthesised branch — see featuredBuild.ts's header.
//
// `won` defaults to true in this helper so a test that says nothing about
// outcomes is not silently exercising the loss path.
const won = (items: number[], win: boolean | null = true): FeaturedGame => ({ items, win });

// A helper that repeats one exact inventory n times inside a realistic tail of
// varied games, so the modal set has to WIN a vote rather than be the only
// candidate. EXACT is a full build: five non-boots plus SORCS.
const EXACT = [ROCKETBELT, SORCS, RABADONS, SHADOWFLAME, ZHONYAS, VOID_STAFF];
function sampleWithExactRepeats(n: number): FeaturedGame[] {
  const games: FeaturedGame[] = [];
  for (let i = 0; i < n; i++) games.push(won([...EXACT]));
  // Varied real games: each a legal 5-6 slot inventory, all distinct, so none
  // of them can out-vote the repeated set.
  games.push(won([ROCKETBELT, SORCS, RABADONS, SHADOWFLAME, BANSHEES, VOID_STAFF]));
  games.push(won([ROCKETBELT, SWIFTMARCH, RABADONS, ZHONYAS, CRYPTBLOOM]));
  games.push(won([ROCKETBELT, SORCS, RABADONS, SHADOWFLAME, CRYPTBLOOM, BANSHEES]));
  games.push(won([ROCKETBELT, IONIANS, RABADONS, VOID_STAFF, ZHONYAS, CRYPTBLOOM]));
  return games;
}

describe("resolveFullBuild — the full-build bar (5 non-boots + boots)", () => {
  // The directive, 2026-07-29: a complete build is five finished NON-BOOTS
  // items plus boots. Every assertion below is about that bar specifically, not
  // about the vote it feeds.

  it("qualifies at EXACTLY five non-boots plus boots — the boundary, not one past it", () => {
    const fivePlusBoots = [ROCKETBELT, RABADONS, SHADOWFLAME, ZHONYAS, VOID_STAFF, SORCS];
    const build = resolveFullBuild(
      RATES,
      [won([...fivePlusBoots]), won([...fivePlusBoots])],
      SAMPLE_GAMES,
      classOf
    );
    expect(build!.method).toBe("most-played-exact");
    expect(build!.games).toBe(2);
    expect(build!.items).toHaveLength(6);
  });

  it("does NOT qualify as a FULL build at four non-boots plus boots, however often it repeats", () => {
    // The bar this change raised. Four legendaries plus boots was a complete
    // build until 2026-07-29 and is not one now, so it can never win the full
    // tier however many times it repeats.
    //
    // UPDATED later the same day: it no longer falls all the way to one real
    // game either. Repeating five times is a fact worth showing, so it lands on
    // the MIDDLE tier — which is a different claim, carrying its own item count
    // so no caption can call it complete. The assertion that matters here is
    // that it is not `most-played-exact`; where it lands instead belongs to the
    // middle-tier suite below.
    const fourPlusBoots = [ROCKETBELT, RABADONS, SHADOWFLAME, ZHONYAS, SORCS];
    const build = resolveFullBuild(
      RATES,
      Array.from({ length: 5 }, () => won([...fourPlusBoots])),
      SAMPLE_GAMES,
      classOf
    );
    expect(build!.method).not.toBe("most-played-exact");
    expect(build!.method).toBe("most-played-partial");
    expect((build as { nonBootsItems: number }).nonBootsItems).toBe(4);
    // Still a REAL set of games, not nothing.
    expect(build!.items.map((i) => i.itemId).sort((a, b) => a - b)).toEqual(
      [...fourPlusBoots].sort((a, b) => a - b)
    );
  });

  it("does NOT qualify at six non-boots and no boots", () => {
    // "5 + boots" and ">= 6 finished items" are different claims, and this is
    // the case that separates them. Measured live: two of the 232 stored Ahri
    // games end this way. They are real games and they are not full builds.
    const sixNoBoots = [ROCKETBELT, RABADONS, SHADOWFLAME, ZHONYAS, VOID_STAFF, CRYPTBLOOM];
    const build = resolveFullBuild(
      RATES,
      [won([...sixNoBoots]), won([...sixNoBoots]), won([...sixNoBoots])],
      SAMPLE_GAMES,
      classOf
    );
    expect(build!.method).toBe("single-game");
  });

  it("drops a malformed seven-finished-item row rather than trimming it", () => {
    const seven = [ROCKETBELT, RABADONS, SHADOWFLAME, ZHONYAS, VOID_STAFF, CRYPTBLOOM, SORCS];
    const build = resolveFullBuild(RATES, [won([...seven]), won([...seven])], SAMPLE_GAMES, classOf);
    // Nothing else in the sample, so there is nothing honest left to show.
    expect(build).toBeNull();
  });
});

describe("resolveFullBuild — the full build that repeats", () => {
  it("reports the repeated set with its TRUE count and the card's own denominator", () => {
    const build = resolveFullBuild(RATES, sampleWithExactRepeats(3), SAMPLE_GAMES, classOf);
    expect(build).not.toBeNull();
    expect(build!.method).toBe("most-played-exact");
    expect(build!.games).toBe(3);
    // 37, the games we HOLD — not the number that happened to qualify as a
    // build. A second denominator on one card is the v0.73.1 bug.
    expect(build!.sampleGames).toBe(SAMPLE_GAMES);
    expect(build!.items.map((i) => i.itemId).sort((a, b) => a - b)).toEqual(
      [...EXACT].sort((a, b) => a - b)
    );
  });

  it("still prefers a set that repeated only TWICE — the threshold boundary", () => {
    // The threshold moved from 3 to 2 when the fallback stopped being a
    // whole-sample synthesis and became a single game. "2 of 37 games ended
    // with exactly this" is strictly more evidence than "here is 1 game", so
    // there is nothing left for a higher threshold to buy.
    const build = resolveFullBuild(RATES, sampleWithExactRepeats(2), SAMPLE_GAMES, classOf);
    expect(build!.method).toBe("most-played-exact");
    expect(build!.games).toBe(2);
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
      ...Array.from({ length: 5 }, () => won([ROCKETBELT, SORCS])),
    ];
    const build = resolveFullBuild(RATES, games, SAMPLE_GAMES, classOf);
    expect(build!.method).toBe("most-played-exact");
    expect(build!.items).toHaveLength(6);
  });

  it("groups on FINISHED items, so a leftover component cannot split one build in two", () => {
    // The mistake this rule exists for: compare raw inventories and a game that
    // ended with a Needlessly Large Rod still in the bag looks like a different
    // build from the identical game that sold it. Three games, one build.
    const build = resolveFullBuild(
      RATES,
      [
        won([...EXACT]),
        won([ROCKETBELT, SORCS, RABADONS, SHADOWFLAME, ZHONYAS, VOID_STAFF, NEEDLESSLY_LARGE_ROD]),
        won([...EXACT, HEALTH_POTION]),
      ],
      SAMPLE_GAMES,
      classOf
    );
    expect(build!.method).toBe("most-played-exact");
    expect(build!.games).toBe(3);
    expect(build!.items.map((i) => i.itemId)).not.toContain(NEEDLESSLY_LARGE_ROD);
  });

  it("counts a set as the same build whatever inventory order it was stored in", () => {
    const shuffled = [
      won([...EXACT]),
      won([...EXACT].reverse()),
      won([EXACT[2], EXACT[0], EXACT[5], EXACT[1], EXACT[4], EXACT[3]]),
    ];
    const build = resolveFullBuild(RATES, shuffled, SAMPLE_GAMES, classOf);
    expect(build!.method).toBe("most-played-exact");
    expect(build!.games).toBe(3);
  });

});

// ── Snowball stacks: IN the record, OUT of the recommendation ───────────────
// User decision, 2026-07-29, reversing the previous behaviour on this one
// surface. `resolveFullBuild` reports what the player ended a game HOLDING, so
// a Mejai's they really had stays in; `buildFeaturedView`'s `items`/`slots` are
// a recommendation and still exclude it. See lib/snowballStacks.ts's "Two
// surfaces, two jobs".
//
// The shape below is the live one: the featured Ahri one-trick's ONLY repeating
// full build across 232 stored games contains Mejai's, and excluding it drops
// the qualifying games 16 -> 3 with zero repeats.
describe("snowball stacks in the played build", () => {
  const WITH_STACK = [ROCKETBELT, MEJAIS, RABADONS, ZHONYAS, VOID_STAFF, SORCS];

  it("counts Mejai's as one of the five non-boots items, so the build qualifies", () => {
    // Without this, WITH_STACK is four non-boots plus boots and falls short of
    // the bar — which is exactly the 16 -> 3 collapse measured live.
    const build = resolveFullBuild(
      RATES,
      [won([...WITH_STACK]), won([...WITH_STACK])],
      SAMPLE_GAMES,
      classOf
    );
    expect(build!.method).toBe("most-played-exact");
    expect(build!.games).toBe(2);
    expect(build!.items.map((i) => i.itemId)).toContain(MEJAIS);
    expect(build!.items).toHaveLength(6);
  });

  it("flags the stack so the card can mark it, and marks nothing else", () => {
    const build = resolveFullBuild(RATES, [won([...WITH_STACK]), won([...WITH_STACK])], SAMPLE_GAMES, classOf);
    const flagged = build!.items.filter((i) => i.isSnowball).map((i) => i.itemId);
    expect(flagged).toEqual([MEJAIS]);
    expect(build!.items.find((i) => i.itemId === SORCS)!.isBoots).toBe(true);
    expect(build!.items.find((i) => i.itemId === SORCS)!.isSnowball).toBe(false);
  });

  it("orders the stack LAST, whatever its build rate", () => {
    // One of three carriers keeping the record from reading as advice. Mejai's
    // sits at 15 games in RATES, above Cryptbloom (12) and below the rest — a
    // plain build-rate sort would put it fifth of six. It must be sixth.
    const build = resolveFullBuild(RATES, [won([...WITH_STACK]), won([...WITH_STACK])], SAMPLE_GAMES, classOf);
    const ids = build!.items.map((i) => i.itemId);
    expect(ids[ids.length - 1]).toBe(MEJAIS);
    // And the rest are still most-built first, so the exception is exactly one
    // slot deep rather than a different sort.
    const rest = build!.items.slice(0, -1).map((i) => i.games);
    expect(rest).toEqual([...rest].sort((a, b) => b - a));
  });

  it("still keeps Mejai's out of the slot list and the rates list on the same card", () => {
    // The split, asserted on ONE view so the two surfaces are compared against
    // the same input rather than in separate tests that could drift.
    const view = buildFeaturedView(
      RATES,
      [won([...WITH_STACK]), won([...WITH_STACK])],
      SAMPLE_GAMES,
      META
    );
    expect(view.fullBuild!.items.map((i) => i.itemId)).toContain(MEJAIS);
    expect(view.items.map((i) => i.itemId)).not.toContain(MEJAIS);
    expect(view.slots.map((s) => s.primary.itemId)).not.toContain(MEJAIS);
    expect(view.slots.flatMap((s) => s.alternatives.map((a) => a.itemId))).not.toContain(MEJAIS);
  });

  it("does not let Dark Seal into a build slot — it is a starter first", () => {
    // 1082 is in the snowball family too, and this change must not promote it.
    // `classifyFeaturedItem` puts starter ahead of snowball, so a game that
    // ends holding Dark Seal is four non-boots plus boots: not a full build.
    //
    // Since the middle tier landed (2026-07-29) this repeats onto that tier
    // rather than to one real game — which is the correct read of "they played
    // this twice, and it is four items". The point of THIS test is unchanged
    // and is the second assertion: Dark Seal is absent from the build whichever
    // tier prints it.
    const withSeal = [ROCKETBELT, DARK_SEAL, RABADONS, ZHONYAS, VOID_STAFF, SORCS];
    const build = resolveFullBuild(RATES, [won([...withSeal]), won([...withSeal])], SAMPLE_GAMES, classOf);
    expect(build!.method).not.toBe("most-played-exact");
    expect(build!.items.map((i) => i.itemId)).not.toContain(DARK_SEAL);
  });
});

describe("resolveFullBuild — one real game, when nothing repeats", () => {
  /** Every game distinct, so the exact branch cannot fire. Deliberately built
   *  so the three selection keys are each decisive for a DIFFERENT game — a
   *  fixture where one game wins on every key would test nothing. */
  const NO_REPEATS: FeaturedGame[] = [
    // index 0 — newest, a LOSS with the most items. Loses on key 1.
    won([ROCKETBELT, SORCS, RABADONS, SHADOWFLAME, ZHONYAS, VOID_STAFF], false),
    // index 1 — a win with FIVE finished items. Should be the pick.
    won([ROCKETBELT, SORCS, RABADONS, SHADOWFLAME, CRYPTBLOOM], true),
    // index 2 — a win with four. Loses on key 2.
    won([ROCKETBELT, SWIFTMARCH, RABADONS, BANSHEES], true),
    // index 3 — an older win, also five. Loses on key 3 (recency).
    won([ROCKETBELT, IONIANS, RABADONS, ZHONYAS, VOID_STAFF], true),
  ];

  it("shows ONE game, labelled as one game, with no frequency claimed", () => {
    const build = resolveFullBuild(RATES, NO_REPEATS, SAMPLE_GAMES, classOf);
    expect(build!.method).toBe("single-game");
    expect(build!.games).toBe(1);
    expect(build!.sampleGames).toBe(SAMPLE_GAMES);
  });

  it("prefers a WIN, then the most finished items, then the most recent", () => {
    const build = resolveFullBuild(RATES, NO_REPEATS, SAMPLE_GAMES, classOf);
    if (!build || build.method !== "single-game") throw new Error("expected the single-game branch");
    expect(build.won).toBe(true);
    expect(build.items.map((i) => i.itemId).sort((a, b) => a - b)).toEqual(
      [ROCKETBELT, SORCS, RABADONS, SHADOWFLAME, CRYPTBLOOM].sort((a, b) => a - b)
    );
  });

  it("is deterministic — the same input always yields the same game", () => {
    // Not a tautology about pure functions: the comparator's last key is the
    // game INDEX, which is unique, so it can never fall through to an
    // unspecified order. A comparator that stopped at "most items" would let
    // two equally-good games swap on any re-sort.
    const a = resolveFullBuild(RATES, NO_REPEATS, SAMPLE_GAMES, classOf);
    const b = resolveFullBuild(RATES, [...NO_REPEATS], SAMPLE_GAMES, classOf);
    expect(a).toEqual(b);
    // Two wins, five finished items each, differing ONLY in recency: the newer
    // one must win, every time.
    const tied: FeaturedGame[] = [
      won([ROCKETBELT, SORCS, RABADONS, SHADOWFLAME, CRYPTBLOOM], true),
      won([ROCKETBELT, SORCS, RABADONS, SHADOWFLAME, BANSHEES], true),
    ];
    for (let i = 0; i < 5; i++) {
      const build = resolveFullBuild(RATES, tied, SAMPLE_GAMES, classOf);
      expect(build!.items.map((i2) => i2.itemId)).toContain(CRYPTBLOOM);
      expect(build!.items.map((i2) => i2.itemId)).not.toContain(BANSHEES);
    }
  });

  it("reports a LOSS honestly when every qualifying game was lost", () => {
    const allLost = NO_REPEATS.map((g) => ({ ...g, win: false }));
    const build = resolveFullBuild(RATES, allLost, SAMPLE_GAMES, classOf);
    if (!build || build.method !== "single-game") throw new Error("expected the single-game branch");
    expect(build.won).toBe(false);
  });

  it("carries a NULL outcome through rather than defaulting it to a loss", () => {
    // A legacy response body has inventories but no outcomes. `null` makes the
    // card drop the outcome clause; `false` would caption a real build "a game
    // they lost", which is an invented fact (HARD RULE 4).
    const noOutcome = NO_REPEATS.map((g) => ({ ...g, win: null }));
    const build = resolveFullBuild(RATES, noOutcome, SAMPLE_GAMES, classOf);
    if (!build || build.method !== "single-game") throw new Error("expected the single-game branch");
    expect(build.won).toBeNull();
  });

  it("ranks an unknown outcome WITH the losses, never above them", () => {
    const build = resolveFullBuild(
      RATES,
      [
        won([ROCKETBELT, SORCS, RABADONS, SHADOWFLAME, CRYPTBLOOM], null),
        won([ROCKETBELT, SWIFTMARCH, RABADONS, BANSHEES], true),
      ],
      SAMPLE_GAMES,
      classOf
    );
    if (!build || build.method !== "single-game") throw new Error("expected the single-game branch");
    expect(build.won).toBe(true);
    expect(build.items.map((i) => i.itemId)).toContain(BANSHEES);
  });
});

describe("resolveFullBuild — nothing to show", () => {
  it("renders NOTHING rather than a partial build when no game ever finished one", () => {
    // Every game ended with at most three finished items. There is no honest
    // build here, and padding one out of per-item rates is exactly the
    // synthesis this module stopped doing.
    const early: FeaturedGame[] = [
      won([ROCKETBELT, SORCS, NEEDLESSLY_LARGE_ROD]),
      won([ROCKETBELT, SORCS, HEALTH_POTION]),
      won([RABADONS, DORANS_RING, HEALTH_POTION]),
      won([ROCKETBELT, DARK_SEAL, MEJAIS]),
    ];
    expect(resolveFullBuild(RATES, early, SAMPLE_GAMES, classOf)).toBeNull();
  });

  it("returns null when nothing in the sample is a build item", () => {
    const junk: FeaturedItemRate[] = [rate(HEALTH_POTION, 30), rate(NEEDLESSLY_LARGE_ROD, 8)];
    expect(resolveFullBuild(junk, [won([HEALTH_POTION])], SAMPLE_GAMES, classOf)).toBeNull();
  });

  it("survives an empty sample without throwing", () => {
    expect(resolveFullBuild([], [], 0, classOf)).toBeNull();
  });
});

describe("buildFeaturedView — the thin-sample floor", () => {
  const games = sampleWithExactRepeats(3);

  it("carries no percentages and no example build below the floor", () => {
    // 11 stored games is "71%" over seven, which reads as a settled preference
    // and is five games. The card has always branched on this; the model now
    // enforces it too, so a JSX reshuffle cannot leak the numbers back out.
    const view = buildFeaturedView(RATES, games, 11, META, { minSampleGames: 12 });
    expect(view.items).toEqual([]);
    expect(view.boots).toEqual([]);
    expect(view.starters).toEqual([]);
    expect(view.slots).toEqual([]);
    expect(view.fullBuild).toBeNull();
  });

  it("carries them at exactly the floor — the boundary, not one past it", () => {
    const view = buildFeaturedView(RATES, games, 12, META, { minSampleGames: 12 });
    expect(view.items.length).toBeGreaterThan(0);
    expect(view.fullBuild).not.toBeNull();
  });

  it("has no floor unless a caller asks for one", () => {
    const view = buildFeaturedView(RATES, games, 3, META);
    expect(view.fullBuild).not.toBeNull();
  });
});

// ── The middle tier ─────────────────────────────────────────────────────────
// A build that REPEATED but is a slot short of the directive's full build.
// Added 2026-07-29 after raising the bar to five non-boots items measured its
// own cost: across all 172 featured accounts the repeated-build branch fell
// from 139 champions to 18, pushing 144 onto the one-real-game fallback. The
// cause is sample DEPTH, not the rule, so the ladder degrades through this tier
// rather than straight past it.

/** Four finished non-boots items plus boots — one short of a full build. */
const PARTIAL = [ROCKETBELT, RABADONS, SHADOWFLAME, ZHONYAS, SORCS];

/** `n` repeats of PARTIAL among distinct games, with NO full build repeating. */
function sampleWithPartialRepeats(n: number): FeaturedGame[] {
  const games: FeaturedGame[] = [];
  for (let i = 0; i < n; i++) games.push(won([...PARTIAL]));
  // Full builds present but all DISTINCT, so none of them repeats and the full
  // tier cannot fire. This is the real shape of a shallow sample.
  games.push(won([ROCKETBELT, SORCS, RABADONS, SHADOWFLAME, BANSHEES, VOID_STAFF]));
  games.push(won([ROCKETBELT, SWIFTMARCH, RABADONS, ZHONYAS, CRYPTBLOOM, VOID_STAFF]));
  return games;
}

describe("resolveFullBuild — the middle tier", () => {
  it("reports a repeated 4+boots set with its count AND its item size", () => {
    const build = resolveFullBuild(RATES, sampleWithPartialRepeats(3), SAMPLE_GAMES, classOf);
    expect(build!.method).toBe("most-played-partial");
    expect(build!.games).toBe(3);
    // The size is on the branch because the tier's whole risk is being read as
    // a full build. A caption that cannot state "4 items plus boots" is the bug.
    expect((build as { nonBootsItems: number }).nonBootsItems).toBe(4);
    // Same denominator as every other number on the card.
    expect(build!.sampleGames).toBe(SAMPLE_GAMES);
    expect(build!.items).toHaveLength(5);
  });

  it("NEVER outranks a full build that also repeats — the ladder degrades, it does not choose", () => {
    // Both tiers available: a full build twice, a partial build three times.
    // The partial is MORE frequent and must still lose.
    const games: FeaturedGame[] = [
      won([...EXACT]),
      won([...EXACT]),
      won([...PARTIAL]),
      won([...PARTIAL]),
      won([...PARTIAL]),
    ];
    const build = resolveFullBuild(RATES, games, SAMPLE_GAMES, classOf);
    expect(build!.method).toBe("most-played-exact");
    expect(build!.games).toBe(2);
  });

  it("falls through to one real game when the shorter build does not repeat either", () => {
    const games: FeaturedGame[] = [
      won([ROCKETBELT, RABADONS, SHADOWFLAME, ZHONYAS, SORCS]),
      won([ROCKETBELT, RABADONS, SHADOWFLAME, BANSHEES, SORCS]),
      won([ROCKETBELT, RABADONS, CRYPTBLOOM, ZHONYAS, SWIFTMARCH]),
    ];
    const build = resolveFullBuild(RATES, games, SAMPLE_GAMES, classOf);
    expect(build!.method).toBe("single-game");
    expect(build!.games).toBe(1);
  });

  it("does not fire on a THREE-item set however often it repeats", () => {
    // Measured floor: at three finished non-boots items the modal set is a boot
    // and two items — a game that ended early, not a build. Four is the floor
    // and there is deliberately no third rung.
    //
    // A sample of nothing BUT three-item games returns null outright: three
    // items is under SHOWABLE_MIN_ITEMS, so such a game is not even eligible as
    // the one-real-game fallback. Null is the honest answer — an empty build
    // section rather than a "build" that is a boot and two items.
    const three = [ROCKETBELT, RABADONS, SORCS];
    const games: FeaturedGame[] = [won([...three]), won([...three]), won([...three]), won([...three])];
    expect(resolveFullBuild(RATES, games, SAMPLE_GAMES, classOf)).toBeNull();

    // And when such a set repeats ALONGSIDE eligible games, it still cannot win
    // the middle tier — the four-item floor is on the tier, not just on
    // eligibility.
    const mixed: FeaturedGame[] = [
      ...games,
      won([ROCKETBELT, RABADONS, SHADOWFLAME, ZHONYAS, SORCS]),
      won([ROCKETBELT, RABADONS, CRYPTBLOOM, BANSHEES, SWIFTMARCH]),
    ];
    const build = resolveFullBuild(RATES, mixed, SAMPLE_GAMES, classOf);
    expect(build!.items.map((i) => i.itemId).sort((a, b) => a - b)).not.toEqual(
      [...three].sort((a, b) => a - b)
    );
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
