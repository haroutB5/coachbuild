/**
 * RC-2 / RC-4 (2026-08-27) — the artifact carries the BUY ORDER, additively.
 *
 * ── The defect ─────────────────────────────────────────────────────────────
 *
 * `ConsensusArtifactSource.i` is sorted share-desc and `buildItemSets` consumed
 * that as the order to buy in. Live, Jinx Bot, patch 16.16: the in-game shop
 * panel told an ADC to buy Infinity Edge FIRST, because 70% of pros ended the
 * game holding it. In those same 51 games it is bought THIRD, behind Hexoptics
 * C44 and Runaan's Hurricane. Frequency and order are different questions, and
 * Infinity Edge is exactly the item where they disagree most.
 *
 * Separately, `b` reads FINAL INVENTORY, and ADCs SELL their boots: 0 of 53
 * Jinx games ended holding any, so the export filled the slot from the
 * situational pool and shipped Plated Steelcaps — a boot 2% of those pros
 * bought, over the Berserker's Greaves 67% of them did.
 *
 * ── Why this is additive, and why that is load-bearing ─────────────────────
 *
 * `p`, `bp` and `pn` are OPTIONAL, so CONSENSUS_ARTIFACT_SCHEMA stays at 1 and
 * the artifact already deployed keeps parsing and keeps working. A schema bump
 * would have made all 865 combos fail the reader's version check the moment the
 * code shipped and before the re-bake landed — which is the full pre-56bbe6a
 * Neon load, in production, for the length of that window. This file's last
 * three tests are what pin that property.
 *
 * A separate file from consensusArtifact.test.ts on purpose: that suite's
 * central claim is that the artifact path and the live path are BYTE-IDENTICAL,
 * and it proves it with a fixture that deliberately carries no purchase
 * timelines. These tests need the opposite fixture.
 */
import { describe, it, expect } from "vitest";
import { aggregateProConsensus } from "../hextech/proConsensus";
import {
  CONSENSUS_ARTIFACT_SCHEMA,
  consensusSourceToInput,
  parseConsensusArtifact,
  reduceConsensusModel,
} from "../hextech/consensusArtifact";
import type { ItemDetail } from "@/components/itemDetail";
import type { ProGame } from "@/components/proGames.types";

// Real 16.16.1 ids and recipe rows.
const HEXOPTICS = 2523;
const RUNAANS = 3085;
const INFINITY_EDGE = 3031;
const BERSERKERS = 3006; // tier-2 boot, from:["1001",...], into:["3172"]
const RAW_BOOTS = 1001; // tier-1 component — never a build-line boot

function meta(id: number, from: string[], into: string[], tags: string[]): [number, ItemDetail] {
  return [
    id,
    { id, name: `Item ${id}`, goldTotal: 3000, descriptionText: "", from, into, tags, purchasable: true },
  ];
}

const CATALOG = new Map<number, ItemDetail>([
  meta(HEXOPTICS, ["1037"], [], []),
  meta(RUNAANS, ["3086"], [], []),
  meta(INFINITY_EDGE, ["1038"], [], []),
  meta(BERSERKERS, ["1001"], ["3172"], ["Boots"]),
  meta(RAW_BOOTS, [], ["3006"], ["Boots"]),
]);

function proGame(id: string, finalItems: number[], purchaseOrder: { itemId: number; ts: number }[]): ProGame {
  return {
    id,
    source: "soloq",
    player: { name: "p", team: null, role: 3, country: null },
    account: { riotId: "p#EUW", region: "euw" },
    championId: 222,
    championName: "Jinx",
    role: 3,
    patch: "16.16",
    win: true,
    kills: 8,
    deaths: 3,
    assists: 6,
    gameCreation: "2026-08-26T12:00:00.000Z",
    gameDurationSec: 1900,
    spells: [4, 7],
    finalItems,
    trinket: null,
    purchaseOrder,
    skillOrder: [],
    runes: { primaryTree: 8000, keystone: 8005, primary: [], secondaryTree: 8200, secondary: [], shards: [] },
  } as unknown as ProGame;
}

/** 12 games in the real Jinx shape: Hexoptics -> Runaan's -> Infinity Edge,
 *  boots bought early and SOLD before the end so the final inventory has none. */
const jinxGames: ProGame[] = Array.from({ length: 12 }, (_, g) =>
  proGame(`jinx-${g}`, [INFINITY_EDGE, HEXOPTICS, RUNAANS], [
    { itemId: RAW_BOOTS, ts: 200 },
    { itemId: HEXOPTICS, ts: 600 },
    { itemId: BERSERKERS, ts: 700 },
    { itemId: RUNAANS, ts: 1100 },
    { itemId: INFINITY_EDGE, ts: 1600 },
  ])
);

describe("reduceConsensusModel carries purchase order alongside frequency", () => {
  it("stores `i` share-desc as before AND `p` in real purchase order", () => {
    const src = reduceConsensusModel("pro", aggregateProConsensus(jinxGames, CATALOG))!;
    // `i` is untouched — count-desc, itemId-asc — so every existing reader is
    // byte-for-byte unaffected.
    expect(src.i.map(([id]) => id)).toEqual([HEXOPTICS, INFINITY_EDGE, RUNAANS]);
    expect(src.p).toEqual([HEXOPTICS, RUNAANS, INFINITY_EDGE]);
  });

  it("stores the boots pros BOUGHT, with their own denominator", () => {
    const src = reduceConsensusModel("pro", aggregateProConsensus(jinxGames, CATALOG))!;
    expect(src.b).toEqual([]); // final inventory: every one of them sold it
    expect(src.bp).toEqual([[BERSERKERS, 12]]);
    expect(src.pn).toBe(12);
  });

  it("omits `p` entirely when the sample has no timelines, rather than faking one", () => {
    // 25 games so the sample clears OTP_CONSENSUS_MIN_GAMES and the reduction
    // returns a real source — the absence below is about ORDER, not about the
    // OTP floor.
    const noTimelines = Array.from({ length: 25 }, (_, g) =>
      proGame(`otp-${g}`, [INFINITY_EDGE, HEXOPTICS, RUNAANS], [])
    );
    const src = reduceConsensusModel("otp", aggregateProConsensus(noTimelines, CATALOG))!;
    expect(src.p).toBeUndefined();
    expect(src.bp).toBeUndefined();
    expect(src.pn).toBeUndefined();
    expect(src.i.length).toBeGreaterThan(0);
  });
});

describe("consensusSourceToInput", () => {
  it("hands the export the items already ordered, and says so", () => {
    const input = consensusSourceToInput({
      n: 12,
      i: [
        [INFINITY_EDGE, 12],
        [HEXOPTICS, 11],
      ],
      b: [],
      p: [HEXOPTICS, INFINITY_EDGE],
      bp: [[BERSERKERS, 9]],
      pn: 12,
    })!;
    expect(input.items.map((e) => e.itemId)).toEqual([HEXOPTICS, INFINITY_EDGE]);
    expect(input.ordered).toBe(true);
    // Order is a PERMUTATION, never a re-weighting: every share still divides
    // by the same denominator it did before.
    expect(input.items[1].share).toBe(1);
    expect(input.boots).toEqual([{ itemId: BERSERKERS, share: 9 / 12 }]);
  });

  it("a source with no `p` keeps today's behaviour exactly, and is NOT ordered", () => {
    const input = consensusSourceToInput({
      n: 10,
      i: [
        [INFINITY_EDGE, 8],
        [HEXOPTICS, 5],
      ],
      b: [[BERSERKERS, 6]],
    })!;
    expect(input.items.map((e) => e.itemId)).toEqual([INFINITY_EDGE, HEXOPTICS]);
    expect(input.boots).toEqual([{ itemId: BERSERKERS, share: 0.6 }]);
    expect(input.ordered).toBeFalsy();
  });

  it("keeps an item `p` never positioned, after every one it did", () => {
    const input = consensusSourceToInput({
      n: 12,
      i: [
        [INFINITY_EDGE, 12],
        [HEXOPTICS, 11],
        [RUNAANS, 4],
      ],
      b: [],
      p: [HEXOPTICS, INFINITY_EDGE],
    })!;
    expect(input.items.map((e) => e.itemId)).toEqual([HEXOPTICS, INFINITY_EDGE, RUNAANS]);
  });

  it("publishes `orderedIds` as `p` ITSELF, never as the reordered item list", () => {
    // RC-5: the other source reads this as a positional prior. `items`
    // additionally carries Runaan's, which these timelines never positioned —
    // handing that over would export a rank the sample never measured, to a
    // block that has no way to tell the difference.
    const input = consensusSourceToInput({
      n: 12,
      i: [
        [INFINITY_EDGE, 12],
        [HEXOPTICS, 11],
        [RUNAANS, 4],
      ],
      b: [],
      p: [HEXOPTICS, INFINITY_EDGE],
    })!;
    expect(input.orderedIds).toEqual([HEXOPTICS, INFINITY_EDGE]);
    expect(input.orderedIds).not.toContain(RUNAANS);
  });

  it("publishes no `orderedIds` when there is no `p`", () => {
    const input = consensusSourceToInput({ n: 10, i: [[INFINITY_EDGE, 8]], b: [] })!;
    expect(input.orderedIds).toBeUndefined();
  });

  it("copies `p` rather than aliasing it, so a consumer cannot mutate the artifact", () => {
    const src = { n: 12, i: [[INFINITY_EDGE, 12], [HEXOPTICS, 11]] as [number, number][], b: [], p: [HEXOPTICS, INFINITY_EDGE] };
    const input = consensusSourceToInput(src)!;
    input.orderedIds!.push(RUNAANS);
    expect(src.p).toEqual([HEXOPTICS, INFINITY_EDGE]);
  });
});

describe("the addition does not break an artifact already in production", () => {
  const base = {
    schema: 1,
    patch: "16.13",
    generatedAt: "2026-08-21T00:00:00.000Z",
    query: { pro: { limit: 200, proMin: 100, source: "all" }, otp: { limit: 200 } },
    coverage: { combos: 1, pro: 1, otp: 0 },
    entries: { "3|2": { pro: { n: 10, i: [[3152, 7]], b: [] }, otp: null } },
  };

  it("the schema does NOT bump, and an artifact with no order still parses", () => {
    expect(CONSENSUS_ARTIFACT_SCHEMA).toBe(1);
    const parsed = parseConsensusArtifact(structuredClone(base))!;
    expect(parsed).not.toBeNull();
    expect(parsed.entries["3|2"].pro!.p).toBeUndefined();
  });

  it("round-trips `p` / `bp` / `pn` through parse", () => {
    const parsed = parseConsensusArtifact({
      ...structuredClone(base),
      entries: {
        "3|2": {
          pro: {
            n: 10,
            i: [
              [3152, 7],
              [4645, 5],
            ],
            b: [],
            p: [4645, 3152],
            bp: [[3006, 6]],
            pn: 9,
          },
          otp: null,
        },
      },
    })!;
    expect(parsed.entries["3|2"].pro).toMatchObject({ p: [4645, 3152], bp: [[3006, 6]], pn: 9 });
  });

  it.each([
    ["a non-array order", { p: 7 }],
    ["a non-numeric id in the order", { p: [3152, "4645"] }],
    ["a malformed purchased-boots entry", { bp: [[3006]] }],
    ["purchased boots with no denominator", { bp: [[3006, 6]], pn: "nine" }],
  ])("fails CLOSED on %s", (_label, extra) => {
    expect(
      parseConsensusArtifact({
        ...structuredClone(base),
        entries: { "3|2": { pro: { n: 10, i: [[3152, 7]], b: [], ...(extra as object) }, otp: null } },
      })
    ).toBeNull();
  });
});
