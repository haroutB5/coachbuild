/**
 * Tests for lib/purchasePositions.ts — WHEN an item was bought.
 *
 * ── The bar ────────────────────────────────────────────────────────────────
 *
 * Every fixture below is real: real 16.16.1 catalog rows (ids, `from`, `into`,
 * `tags`, `purchasable` copied verbatim from the live coachless mirror) and
 * purchase sequences taken from real prod timelines captured 2026-08-27. The
 * assertions are the MEASURED answers from HANDOFF-core-build-order-2.md, not
 * invented ones — so a test failing here means the code disagrees with what
 * 424 real games did, which is the only kind of failure worth having.
 *
 * The predicates are the app's OWN `isBuildItem`, imported rather than
 * re-implemented: the anchor rule's whole safety property is that it rejects
 * recipe components, and proving that against a hand-rolled stand-in would
 * prove nothing about production.
 */
import { describe, it, expect } from "vitest";
import { isBuildItem } from "@/components/hextech/proConsensus";
import type { ItemDetail } from "@/components/itemDetail";
import {
  MIN_POSITION_GAMES,
  MIN_POSITION_OBSERVATIONS,
  aggregatePurchasePositions,
  purchaseOrderedIds,
  resolveFinalItemPositions,
  type PurchaseSampleGame,
} from "@/lib/purchasePositions";

// ── Real 16.16.1 rows ──────────────────────────────────────────────────────
const BOOTS_T1 = 1001;
const IONIAN = 3158;
const CRIMSON_LUCIDITY = 3171; // tier-3 enchant, from: [3158], never purchased
const BERSERKERS = 3006;
const PLATED = 3047;
const KINDLEGEM = 3067; // component: `into` non-empty -> never a legal anchor
const LOCKET = 3190; // from: [3067, ...]
const KNIGHTS_VOW = 3109; // from: [3067, ...] — the SAME component as Locket
const BOUNTY_OF_WORLDS = 3867; // purchasable: false, fires no purchase event
const SOLSTICE_SLEIGH = 3876; // from: [3867]
const HEXOPTICS = 2523;
const YUN_TAL = 3032;
const RUNAANS = 3085;
const INFINITY_EDGE = 3031;

function detail(
  id: number,
  name: string,
  fields: Partial<Pick<ItemDetail, "into" | "from" | "tags" | "purchasable" | "goldTotal">>
): [number, ItemDetail] {
  return [
    id,
    {
      id,
      name,
      goldTotal: fields.goldTotal ?? 2500,
      descriptionText: "",
      into: fields.into ?? [],
      from: fields.from ?? [],
      tags: fields.tags ?? [],
      purchasable: fields.purchasable ?? true,
    },
  ];
}

const CATALOG: ReadonlyMap<number, ItemDetail> = new Map<number, ItemDetail>([
  detail(BOOTS_T1, "Boots", { goldTotal: 300, into: ["3006", "3047", "3158"], tags: ["Boots"] }),
  detail(IONIAN, "Ionian Boots of Lucidity", {
    goldTotal: 900,
    from: ["1001", "2022"],
    into: ["3171"],
    tags: ["Boots", "CooldownReduction"],
  }),
  detail(CRIMSON_LUCIDITY, "Crimson Lucidity", {
    goldTotal: 900,
    from: ["3158"],
    tags: ["CooldownReduction", "Boots"],
  }),
  detail(BERSERKERS, "Berserker's Greaves", {
    goldTotal: 1100,
    from: ["1001", "1042", "1042"],
    into: ["3172"],
    tags: ["AttackSpeed", "Boots"],
  }),
  detail(PLATED, "Plated Steelcaps", {
    goldTotal: 1200,
    from: ["1001", "1029"],
    into: ["3174"],
    tags: ["Armor", "Boots"],
  }),
  detail(KINDLEGEM, "Kindlegem", { goldTotal: 800, from: ["1028", "2022"], into: ["3190", "3109"] }),
  detail(LOCKET, "Locket of the Iron Solari", { goldTotal: 2200, from: ["3067", "1029", "1033"] }),
  detail(KNIGHTS_VOW, "Knight's Vow", { goldTotal: 2300, from: ["3067", "1031", "1006"] }),
  detail(BOUNTY_OF_WORLDS, "Bounty of Worlds", {
    goldTotal: 400,
    into: ["3869", "3870", "3871", "3876", "3877"],
    purchasable: false,
  }),
  detail(SOLSTICE_SLEIGH, "Solstice Sleigh", { goldTotal: 400, from: ["3867"] }),
  detail(HEXOPTICS, "Hexoptics C44", { goldTotal: 2800, from: ["1037", "6670", "1036"] }),
  detail(YUN_TAL, "Yun Tal Wildarrows", { goldTotal: 3000, from: ["1038", "3144", "1036"] }),
  detail(RUNAANS, "Runaan's Hurricane", { goldTotal: 2650, from: ["3086", "3144"] }),
  detail(INFINITY_EDGE, "Infinity Edge", { goldTotal: 3500, from: ["1038", "1037", "1018"] }),
]);

const OPTS = {
  catalog: CATALOG,
  isSlotItem: (id: number) => isBuildItem(id, CATALOG.get(id), CATALOG),
  isAnchorItem: (id: number) => isBuildItem(id, CATALOG.get(id), CATALOG),
};

const buy = (itemId: number, ts: number) => ({ itemId, ts });

describe("resolveFinalItemPositions", () => {
  it("orders a game's completed items by the moment they were bought", () => {
    const resolved = resolveFinalItemPositions(
      [INFINITY_EDGE, HEXOPTICS, RUNAANS],
      [buy(HEXOPTICS, 500), buy(RUNAANS, 900), buy(INFINITY_EDGE, 1400)],
      OPTS
    );
    expect(resolved.map((r) => r.itemId)).toEqual([HEXOPTICS, RUNAANS, INFINITY_EDGE]);
    expect(resolved.every((r) => r.via === "direct")).toBe(true);
  });

  it("places a tier-3 boot enchant at the tier-2 boot's purchase, not nowhere", () => {
    // Real Ahri Mid shape: 85 of 127 timelines end holding Crimson Lucidity and
    // ZERO of them ever purchased it. Today's `finalIds.has(id)` filter deletes
    // it outright, which is why the card's "most built path" has no boots.
    const resolved = resolveFinalItemPositions(
      [CRIMSON_LUCIDITY, LOCKET],
      [buy(BOOTS_T1, 185), buy(IONIAN, 447), buy(KINDLEGEM, 620), buy(LOCKET, 900)],
      OPTS
    );
    expect(resolved.map((r) => r.itemId)).toEqual([CRIMSON_LUCIDITY, LOCKET]);
    const enchant = resolved.find((r) => r.itemId === CRIMSON_LUCIDITY)!;
    expect(enchant).toMatchObject({ ts: 447, via: "upgrade", anchorId: IONIAN });
  });

  it("never anchors a completed item to a shared recipe COMPONENT", () => {
    // Kindlegem builds into BOTH Locket and Knight's Vow and a support buys
    // several. If a component could anchor, the first Kindlegem purchase would
    // drag a 15-minute item to minute 8. Locket IS purchased here, so it must
    // take its own event; Knight's Vow is not in the inventory at all.
    const resolved = resolveFinalItemPositions(
      [LOCKET],
      [buy(KINDLEGEM, 480), buy(KINDLEGEM, 640), buy(LOCKET, 914)],
      OPTS
    );
    expect(resolved).toEqual([{ itemId: LOCKET, ts: 914, via: "direct", anchorId: LOCKET }]);
  });

  it("leaves a completed item unresolved when only a component was bought", () => {
    const resolved = resolveFinalItemPositions([KNIGHTS_VOW], [buy(KINDLEGEM, 480)], OPTS);
    expect(resolved).toEqual([]);
  });

  it("does NOT put a support-quest final at position 1", () => {
    // MEASURED 2026-08-27: across 145 Thresh Support timelines, World Atlas,
    // Runic Compass and Bounty of Worlds fire ZERO purchase events between
    // them. The chain is invisible, so there is nothing to anchor to — and
    // Bounty of Worlds is `purchasable: false` and fails the anchor test even
    // if a future patch started emitting one.
    const resolved = resolveFinalItemPositions(
      [SOLSTICE_SLEIGH, LOCKET, KNIGHTS_VOW],
      [buy(IONIAN, 300), buy(LOCKET, 870), buy(KNIGHTS_VOW, 1320)],
      OPTS
    );
    expect(resolved.map((r) => r.itemId)).toEqual([LOCKET, KNIGHTS_VOW]);
    expect(resolved[0].itemId).not.toBe(SOLSTICE_SLEIGH);
  });

  it("still refuses the quest final if Bounty of Worlds ever DID fire an event", () => {
    const resolved = resolveFinalItemPositions(
      [SOLSTICE_SLEIGH, LOCKET],
      [buy(BOUNTY_OF_WORLDS, 5), buy(LOCKET, 870)],
      OPTS
    );
    expect(resolved.map((r) => r.itemId)).toEqual([LOCKET]);
  });

  it("takes the quest final's own event when the game DOES buy it", () => {
    // 11 real games across Thresh/Nautilus/Lulu do exactly this, at ts 744-894.
    const resolved = resolveFinalItemPositions(
      [SOLSTICE_SLEIGH, LOCKET],
      [buy(IONIAN, 266), buy(LOCKET, 870), buy(SOLSTICE_SLEIGH, 872)],
      OPTS
    );
    expect(resolved.map((r) => r.itemId)).toEqual([LOCKET, SOLSTICE_SLEIGH]);
  });

  it("returns nothing for a game with no timeline rather than guessing", () => {
    expect(resolveFinalItemPositions([LOCKET, KNIGHTS_VOW], [], OPTS)).toEqual([]);
  });
});

describe("aggregatePurchasePositions — boots", () => {
  const adcGame = (bootId: number): PurchaseSampleGame => ({
    // ADCs SELL their boots for a sixth item: the final inventory holds none.
    finalItems: [HEXOPTICS, RUNAANS, INFINITY_EDGE],
    purchaseOrder: [buy(BOOTS_T1, 200), buy(bootId, 500), buy(HEXOPTICS, 800), buy(INFINITY_EDGE, 1500)],
  });

  it("reads boots off the timeline, so an ADC who sold them still has a boot", () => {
    const model = aggregatePurchasePositions(
      [adcGame(BERSERKERS), adcGame(BERSERKERS), adcGame(PLATED)],
      OPTS
    );
    expect(model.bootsSampleSize).toBe(3);
    expect(model.boots).toEqual([
      { itemId: BERSERKERS, count: 2 },
      { itemId: PLATED, count: 1 },
    ]);
  });

  it("ignores the tier-1 Boots component — it is not a build-line boot", () => {
    const model = aggregatePurchasePositions(
      [{ finalItems: [INFINITY_EDGE], purchaseOrder: [buy(BOOTS_T1, 200), buy(INFINITY_EDGE, 900)] }],
      OPTS
    );
    expect(model.boots).toEqual([]);
    expect(model.bootsSampleSize).toBe(0);
  });
});

describe("purchaseOrderedIds", () => {
  /** The real Jinx Bot disagreement: Infinity Edge is the MOST built item and
   *  the THIRD bought one. 12 games so the sample floor is cleared. */
  const jinxGames: PurchaseSampleGame[] = Array.from({ length: 12 }, () => ({
    finalItems: [INFINITY_EDGE, HEXOPTICS, RUNAANS, YUN_TAL],
    purchaseOrder: [
      buy(HEXOPTICS, 600),
      buy(YUN_TAL, 610),
      buy(RUNAANS, 1100),
      buy(INFINITY_EDGE, 1600),
    ],
  }));

  it("re-orders a frequency-sorted block into real purchase order", () => {
    const model = aggregatePurchasePositions(jinxGames, OPTS);
    // The frequency order the export ships today, IE first:
    const byFrequency = [INFINITY_EDGE, HEXOPTICS, RUNAANS, YUN_TAL];
    expect(purchaseOrderedIds(byFrequency, model)).toEqual([
      HEXOPTICS,
      YUN_TAL,
      RUNAANS,
      INFINITY_EDGE,
    ]);
  });

  it("refuses to claim an order below the sample floor", () => {
    const thin = aggregatePurchasePositions(jinxGames.slice(0, MIN_POSITION_GAMES - 1), OPTS);
    expect(thin.sampleSize).toBe(MIN_POSITION_GAMES - 1);
    expect(purchaseOrderedIds([INFINITY_EDGE, HEXOPTICS], thin)).toBeNull();
  });

  it("refuses when fewer than two items have a position at all", () => {
    const model = aggregatePurchasePositions(
      Array.from({ length: 12 }, () => ({
        finalItems: [INFINITY_EDGE],
        purchaseOrder: [buy(INFINITY_EDGE, 900)],
      })),
      OPTS
    );
    expect(purchaseOrderedIds([INFINITY_EDGE, HEXOPTICS], model)).toBeNull();
  });

  it("keeps a thinly-observed item after every positioned one, in share order", () => {
    const games: PurchaseSampleGame[] = [
      ...jinxGames,
      // Two games — one under MIN_POSITION_OBSERVATIONS — buying Locket first.
      ...Array.from({ length: MIN_POSITION_OBSERVATIONS - 1 }, () => ({
        finalItems: [LOCKET, INFINITY_EDGE],
        purchaseOrder: [buy(LOCKET, 100), buy(INFINITY_EDGE, 1600)],
      })),
    ];
    const model = aggregatePurchasePositions(games, OPTS);
    expect(model.positions.get(LOCKET)!.observations).toBe(MIN_POSITION_OBSERVATIONS - 1);
    const ordered = purchaseOrderedIds([INFINITY_EDGE, HEXOPTICS, RUNAANS, YUN_TAL, LOCKET], model)!;
    expect(ordered[ordered.length - 1]).toBe(LOCKET);
  });

  it("breaks a median tie towards the better-observed item", () => {
    // 12 games put HEXOPTICS at #1; 3 of those also hold a quest final that
    // fired its own event at #1. Both medians are 1; the 12-game item wins.
    const games: PurchaseSampleGame[] = [
      ...Array.from({ length: 9 }, () => ({
        finalItems: [HEXOPTICS, INFINITY_EDGE],
        purchaseOrder: [buy(HEXOPTICS, 600), buy(INFINITY_EDGE, 1600)],
      })),
      ...Array.from({ length: 3 }, () => ({
        finalItems: [HEXOPTICS, SOLSTICE_SLEIGH, INFINITY_EDGE],
        purchaseOrder: [buy(SOLSTICE_SLEIGH, 500), buy(HEXOPTICS, 600), buy(INFINITY_EDGE, 1600)],
      })),
    ];
    const model = aggregatePurchasePositions(games, OPTS);
    expect(model.positions.get(SOLSTICE_SLEIGH)!.median).toBe(1);
    expect(model.positions.get(HEXOPTICS)!.median).toBe(1);
    expect(purchaseOrderedIds([HEXOPTICS, SOLSTICE_SLEIGH, INFINITY_EDGE], model)).toEqual([
      HEXOPTICS,
      SOLSTICE_SLEIGH,
      INFINITY_EDGE,
    ]);
  });
});
