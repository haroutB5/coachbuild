/**
 * positionalPriors — the SECOND and THIRD positional signals.
 *
 * `lib/purchasePositions.ts` measures the first one: median purchase position
 * from a champion-role's OWN timelines. It answers `null` a lot — 236 of 442
 * pro entries and ALL 297 OTP entries in the patch-16.16 artifact — and until
 * now `null` meant the block fell back to FREQUENCY order, i.e. to how often an
 * item ended the game in the inventory, presented left-to-right in a shop panel
 * as if it were a buy order.
 *
 * The user's 2026-08-28 verdict on that fallback, by value:
 *
 *   Viktor Mid, "OTP most built":
 *     Blackfire -> Spellslinger's -> Liandry's -> Zhonya's -> ROCKETBELT -> Rabadon's
 *     "Rocketbelt is always bought in the first two items, never later."
 *   Urgot Top, "Pro most built":
 *     STERAK'S -> Steelcaps -> Black Cleaver -> ...
 *     "Black Cleaver is always first."
 *
 * Directive: frequency order is not an acceptable fallback anywhere a block
 * reads as a build. This module supplies the two replacements, both of which
 * are real positional evidence rather than a popularity ranking.
 */
import { describe, it, expect } from "vitest";
import {
  MIN_PRIOR_POSITIONED,
  applyPositionRanks,
  orderedIdRanks,
  wpaSlotRanks,
} from "@/lib/positionalPriors";

const BLACKFIRE = 2503;
const ROCKETBELT = 3152;
const LIANDRYS = 6653;
const ZHONYAS = 3157;
const RABADONS = 3089;
const ROD_OF_AGES = 6657;
const SORCERERS = 3020;
const BOTRK = 3153;

function pick(id: number, occurrence: number) {
  return { id, name: `Item ${id}`, icon: `i${id}`, wpa: 0, winrate: 50, occurrence };
}

/** Viktor Mid's REAL per-slot pools, /api/build patch 16.16, 2026-08-28. */
function viktorItems() {
  return {
    starter: pick(1056, 37521),
    boots: pick(SORCERERS, 17398),
    first: pick(BLACKFIRE, 30942),
    second: pick(3100, 7505),
    third: pick(4645, 3276),
    fourthPlus: [pick(RABADONS, 2862), pick(ZHONYAS, 2102)],
    alts: {
      boots: [pick(3047, 1529), pick(3009, 2867), pick(3158, 9623)],
      first: [pick(ROD_OF_AGES, 1200), pick(6655, 4726)],
      second: [pick(4629, 651), pick(LIANDRYS, 5145), pick(ROCKETBELT, 12335)],
      third: [pick(3137, 575), pick(LIANDRYS, 865), pick(3135, 1152)],
    },
  };
}

describe("orderedIdRanks — the CROSS-SOURCE prior", () => {
  it("ranks by index, so the other source's measured order becomes this one's", () => {
    // Viktor Mid's pro entry `p`, from the committed artifact.
    const ranks = orderedIdRanks([BLACKFIRE, ROCKETBELT, LIANDRYS, RABADONS, ZHONYAS, 4645]);
    expect(ranks!.get(BLACKFIRE)).toBe(0);
    expect(ranks!.get(ROCKETBELT)).toBe(1);
    expect(ranks!.get(LIANDRYS)).toBe(2);
    expect(ranks!.get(ROD_OF_AGES)).toBeUndefined();
  });

  it("refuses an absent or empty list rather than returning an empty ranking", () => {
    // An empty Map and `null` behave differently at the call site: the Map
    // would be a prior that fired and positioned nothing, `null` is "this
    // signal does not exist, try the next one".
    expect(orderedIdRanks(undefined)).toBeNull();
    expect(orderedIdRanks(null)).toBeNull();
    expect(orderedIdRanks([])).toBeNull();
  });

  it("keeps the FIRST index when an id repeats, never the last", () => {
    expect(orderedIdRanks([7, 8, 7])!.get(7)).toBe(0);
  });
});

describe("wpaSlotRanks — the WPA per-slot prior", () => {
  it("places an item at the slot pool it occurs in most", () => {
    const ranks = wpaSlotRanks(viktorItems())!;
    expect(ranks.get(BLACKFIRE)).toBe(1); // slot-1 pool, 30,942
    expect(ranks.get(ROCKETBELT)).toBe(2); // slot-2 pool, 12,335
    expect(ranks.get(RABADONS)).toBe(4); // fourthPlus
    expect(ranks.get(ZHONYAS)).toBe(4);
  });

  it("resolves an item that appears in TWO pools to the larger occurrence", () => {
    // Liandry's Torment is in Viktor's slot-2 pool (5,145) AND his slot-3 pool
    // (865). It is a second item. Taking the first pool an id is seen in, or
    // the last, would both be wrong here.
    expect(wpaSlotRanks(viktorItems())!.get(LIANDRYS)).toBe(2);
  });

  it("takes the LARGEST pool, not the EARLIEST one the item appears in", () => {
    // Jax Top, /api/build patch 16.16, live: Blade of The Ruined King occurs
    // 892 times in the slot-1 pool and 1,838 times in the slot-2 pool. It is a
    // second item. 91 of the 323 exportable champion-roles carry at least one
    // item whose modal slot is not the earliest slot it appears in — Infinity
    // Edge on Miss Fortune Bot (1,912 at slot 2, 7,366 at slot 3) and
    // Malignance on Teemo Top (1,914 / 3,346) are two more — so "first pool
    // wins" is not a near-equivalent shortcut, it is wrong 91 times.
    const ranks = wpaSlotRanks({
      starter: pick(1055, 30000),
      boots: pick(3158, 12000),
      first: pick(6610, 9812),
      second: pick(6631, 4200),
      third: pick(3157, 1100),
      fourthPlus: [pick(3053, 900)],
      alts: {
        first: [pick(BOTRK, 892)],
        second: [pick(BOTRK, 1838)],
      },
    })!;
    expect(ranks.get(BOTRK)).toBe(2);
  });

  it("does NOT rank boots — the boots slot is decided by BOOTS_LINE_INDEX", () => {
    const ranks = wpaSlotRanks(viktorItems())!;
    expect(ranks.get(SORCERERS)).toBeUndefined();
    expect(ranks.get(3158)).toBeUndefined();
  });

  it("ignores a zero-occurrence pick — no games is not a position", () => {
    // recommend.ts emits an EMPTY_PICK (occurrence 0) when a slot has no
    // candidate at all. Reading it as evidence would put a phantom item first.
    const ranks = wpaSlotRanks({
      starter: pick(1, 10),
      boots: pick(2, 10),
      first: pick(0, 0),
      second: pick(ROCKETBELT, 500),
      third: pick(ZHONYAS, 400),
      fourthPlus: [],
    })!;
    expect(ranks.has(0)).toBe(false);
    expect(ranks.get(ROCKETBELT)).toBe(2);
  });

  it("returns null when no slot pool carries a positive occurrence", () => {
    expect(
      wpaSlotRanks({
        starter: pick(1, 0),
        boots: pick(2, 0),
        first: pick(3, 0),
        second: pick(4, 0),
        third: pick(5, 0),
        fourthPlus: [],
      })
    ).toBeNull();
  });

  it("breaks an exact occurrence tie toward the EARLIER slot", () => {
    const ranks = wpaSlotRanks({
      starter: pick(1, 10),
      boots: pick(2, 10),
      first: pick(ROCKETBELT, 500),
      second: pick(9, 10),
      third: pick(ROCKETBELT, 500),
      fourthPlus: [],
    })!;
    expect(ranks.get(ROCKETBELT)).toBe(1);
  });
});

describe("applyPositionRanks", () => {
  const entries = [
    { itemId: BLACKFIRE, share: 0.81 },
    { itemId: LIANDRYS, share: 0.33 },
    { itemId: ZHONYAS, share: 0.23 },
    { itemId: ROCKETBELT, share: 0.17 },
    { itemId: RABADONS, share: 0.13 },
    { itemId: ROD_OF_AGES, share: 0.13 },
  ];

  it("reorders Viktor's OTP block into the pro corpus's measured order", () => {
    const ranks = orderedIdRanks([BLACKFIRE, ROCKETBELT, LIANDRYS, RABADONS, ZHONYAS, 4645])!;
    const out = applyPositionRanks(entries, ranks)!;
    expect(out.entries.map((e) => e.itemId)).toEqual([
      BLACKFIRE,
      ROCKETBELT,
      LIANDRYS,
      RABADONS,
      ZHONYAS,
      ROD_OF_AGES,
    ]);
    expect(out.positioned).toBe(5);
  });

  it("leaves an UNRANKED item behind every ranked one, in its own share order", () => {
    // Not an accident and not laziness: an unranked id has NO position
    // evidence, and interleaving it by a guess is how the frequency ordering
    // this module replaces got in. Rod of Ages is the live case — a genuine
    // Viktor first item that the pro sample never positioned, whose promotion
    // to slot 1 would push a measured item out of the six-slot block.
    const ranks = new Map([
      [ZHONYAS, 3],
      [RABADONS, 4],
    ]);
    const out = applyPositionRanks(entries, ranks)!;
    expect(out.entries.map((e) => e.itemId)).toEqual([
      ZHONYAS,
      RABADONS,
      BLACKFIRE,
      LIANDRYS,
      ROCKETBELT,
      ROD_OF_AGES,
    ]);
  });

  it("keeps `front` ids at the head and does not count them as evidence", () => {
    // Boots. buildLine lifts them out and reinserts them at BOOTS_LINE_INDEX,
    // so their place in this list is not a claim — but a boot that fell into
    // the unranked tail would be indistinguishable from a real demotion when
    // reading the pool, and a boot must never be the reason a block claims to
    // know an order.
    const withBoots = [{ itemId: SORCERERS, share: 0.34 }, ...entries];
    const ranks = new Map([[ZHONYAS, 3]]);
    expect(applyPositionRanks(withBoots, ranks, { front: new Set([SORCERERS]) })).toBeNull();

    const ok = applyPositionRanks(withBoots, new Map([[ZHONYAS, 3], [RABADONS, 4]]), {
      front: new Set([SORCERERS]),
    })!;
    expect(ok.entries[0].itemId).toBe(SORCERERS);
    expect(ok.positioned).toBe(2);
  });

  it("refuses when fewer than MIN_PRIOR_POSITIONED items carry a rank", () => {
    // An order is a relation between at least two things. One positioned item
    // among six is a fact about that item, not an ordering of the block.
    expect(MIN_PRIOR_POSITIONED).toBe(2);
    expect(applyPositionRanks(entries, new Map([[ZHONYAS, 3]]))).toBeNull();
    expect(applyPositionRanks(entries, new Map())).toBeNull();
  });

  it("breaks a rank tie by the incoming order, which is share-desc", () => {
    const ranks = new Map([
      [BLACKFIRE, 2],
      [LIANDRYS, 2],
      [ROCKETBELT, 2],
    ]);
    const out = applyPositionRanks(entries, ranks)!;
    expect(out.entries.slice(0, 3).map((e) => e.itemId)).toEqual([BLACKFIRE, LIANDRYS, ROCKETBELT]);
  });

  it("is a PERMUTATION — never drops or invents an entry", () => {
    const out = applyPositionRanks(entries, new Map([[ZHONYAS, 1], [RABADONS, 2]]))!;
    expect(out.entries).toHaveLength(entries.length);
    expect([...out.entries].sort((a, b) => a.itemId - b.itemId)).toEqual(
      [...entries].sort((a, b) => a.itemId - b.itemId)
    );
  });
});
