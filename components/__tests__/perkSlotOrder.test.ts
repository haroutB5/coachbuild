// Rune DISPLAY order (components/hextech/perkSlots.ts's sort helpers).
//
// The bug being pinned is a real user report on the Pro page, 2026-07-29:
// "Ultimate Hunter shows 2nd but it is the LAST row of Domination." The card
// rendered ProConsensusModel.primaryMinors, which is a flat frequency
// aggregate, so the fixtures below use FREQUENCY-ORDERED input — the order the
// card actually receives — rather than input that is already correct.

import { describe, it, expect } from "vitest";
import {
  PERK_TREES,
  perkSlotPosition,
  perkSortRank,
  comparePerksByRow,
  sortPerkIdsByRow,
  sortPerksByRow,
} from "../hextech/perkSlots";

const DOMINATION = 8100;
const SORCERY = 8200;

// Domination, verbatim from PERK_TREES[8100].
const ELECTROCUTE = 8112; // keystone
const CHEAP_SHOT = 8126; // minor row 1, col 0
const TASTE_OF_BLOOD = 8139; // minor row 1, col 1
const SUDDEN_IMPACT = 8143; // minor row 1, col 2
const SIXTH_SENSE = 8137; // minor row 2, col 0
const GRISLY_MEMENTOS = 8140; // minor row 2, col 1
const TREASURE_HUNTER = 8135; // minor row 3, col 0
const RELENTLESS_HUNTER = 8105; // minor row 3, col 1
const ULTIMATE_HUNTER = 8106; // minor row 3, col 2 — the reported bug

describe("perkSlotPosition", () => {
  it("puts Ultimate Hunter in the LAST minor row of Domination", () => {
    expect(perkSlotPosition(DOMINATION, ULTIMATE_HUNTER)).toEqual({ row: 3, col: 2 });
    // ...and confirms it against the map itself, so this test fails loudly if a
    // future perkstyles refresh moves the rune rather than silently passing.
    expect(PERK_TREES[DOMINATION].minorRows[2]).toContain(ULTIMATE_HUNTER);
  });

  it("gives the keystone row 0, above every minor", () => {
    expect(perkSlotPosition(DOMINATION, ELECTROCUTE)).toEqual({ row: 0, col: 0 });
    expect(perkSortRank(DOMINATION, ELECTROCUTE)).toBeLessThan(perkSortRank(DOMINATION, CHEAP_SHOT));
  });

  it("returns null for a rune of a different tree, an unknown id, or no tree", () => {
    expect(perkSlotPosition(SORCERY, ULTIMATE_HUNTER)).toBeNull();
    expect(perkSlotPosition(DOMINATION, 999999)).toBeNull();
    expect(perkSlotPosition(null, ULTIMATE_HUNTER)).toBeNull();
    expect(perkSlotPosition(12345, ULTIMATE_HUNTER)).toBeNull();
  });
});

describe("sortPerkIdsByRow", () => {
  it("fixes the reported order: Ultimate Hunter goes last, not second", () => {
    // Frequency order, which is what the flat aggregate hands the card: Ultimate
    // Hunter is the second-most-picked Domination minor, and that is exactly why
    // it rendered second.
    const byPickRate = [TASTE_OF_BLOOD, ULTIMATE_HUNTER, GRISLY_MEMENTOS];
    expect(sortPerkIdsByRow(DOMINATION, byPickRate)).toEqual([
      TASTE_OF_BLOOD, // row 1
      GRISLY_MEMENTOS, // row 2
      ULTIMATE_HUNTER, // row 3
    ]);
  });

  it("orders left-to-right within a row, as the in-game page lays it out", () => {
    expect(sortPerkIdsByRow(DOMINATION, [SUDDEN_IMPACT, CHEAP_SHOT, TASTE_OF_BLOOD])).toEqual([
      CHEAP_SHOT,
      TASTE_OF_BLOOD,
      SUDDEN_IMPACT,
    ]);
  });

  it("puts the keystone first when one is in the list", () => {
    expect(sortPerkIdsByRow(DOMINATION, [ULTIMATE_HUNTER, ELECTROCUTE, CHEAP_SHOT])).toEqual([
      ELECTROCUTE,
      CHEAP_SHOT,
      ULTIMATE_HUNTER,
    ]);
  });

  it("does not mutate the caller's array", () => {
    const input = [ULTIMATE_HUNTER, TASTE_OF_BLOOD];
    const out = sortPerkIdsByRow(DOMINATION, input);
    expect(input).toEqual([ULTIMATE_HUNTER, TASTE_OF_BLOOD]);
    expect(out).not.toBe(input);
  });
});

describe("sortPerkIdsByRow — unknown ids degrade deterministically", () => {
  it("sorts an unknown perk id to the end, after every known row", () => {
    const NEW_RUNE = 8999; // a rune this CDragon snapshot has not caught up to
    expect(sortPerkIdsByRow(DOMINATION, [NEW_RUNE, ULTIMATE_HUNTER, CHEAP_SHOT])).toEqual([
      CHEAP_SHOT,
      ULTIMATE_HUNTER,
      NEW_RUNE,
    ]);
  });

  it("orders several unknowns by id, identically whatever order they arrive in", () => {
    // "Deterministic" means the SAME answer, not merely a stable one — so the
    // same set is sorted from two different input orders and compared.
    const a = sortPerkIdsByRow(DOMINATION, [9002, 9001, CHEAP_SHOT, 9003]);
    const b = sortPerkIdsByRow(DOMINATION, [9003, CHEAP_SHOT, 9001, 9002]);
    expect(a).toEqual([CHEAP_SHOT, 9001, 9002, 9003]);
    expect(a).toEqual(b);
  });

  it("falls back to id order — never an arbitrary one — when the tree is unknown", () => {
    // Every id is unknown without a tree, so the total comparator's tie-break
    // is all that is left: plain id ascending, 8106 < 8112 < 8126.
    expect(sortPerkIdsByRow(null, [ULTIMATE_HUNTER, CHEAP_SHOT, ELECTROCUTE])).toEqual([
      ULTIMATE_HUNTER,
      ELECTROCUTE,
      CHEAP_SHOT,
    ]);
    expect(sortPerkIdsByRow(undefined, [SUDDEN_IMPACT, CHEAP_SHOT])).toEqual([CHEAP_SHOT, SUDDEN_IMPACT]);
  });

  it("never throws on junk input", () => {
    expect(() => sortPerkIdsByRow(DOMINATION, [0, -1, Number.NaN])).not.toThrow();
    expect(sortPerkIdsByRow(DOMINATION, [])).toEqual([]);
  });
});

describe("sortPerksByRow — the shape the card actually holds", () => {
  it("reorders ProConsensus-style entries without losing their counts", () => {
    // ProConsensusModel.primaryMinors.entries, count desc — Ultimate Hunter
    // second by pick rate, third by row.
    const entries = [
      { runeId: TASTE_OF_BLOOD, count: 41, share: 0.62 },
      { runeId: ULTIMATE_HUNTER, count: 33, share: 0.5 },
      { runeId: GRISLY_MEMENTOS, count: 12, share: 0.18 },
    ];
    const sorted = sortPerksByRow(DOMINATION, entries, (e) => e.runeId);
    expect(sorted.map((e) => e.runeId)).toEqual([TASTE_OF_BLOOD, GRISLY_MEMENTOS, ULTIMATE_HUNTER]);
    expect(sorted.map((e) => e.count)).toEqual([41, 12, 33]);
    expect(entries[0].runeId).toBe(TASTE_OF_BLOOD); // caller's array untouched
  });

  it("orders a full stored rune page as the in-game page reads", () => {
    // The featured card's runes.page.primary, which arrives in Riot selection
    // order for soloq but is not guaranteed to across sources.
    const page = [TREASURE_HUNTER, CHEAP_SHOT, SIXTH_SENSE];
    expect(sortPerkIdsByRow(DOMINATION, page)).toEqual([CHEAP_SHOT, SIXTH_SENSE, TREASURE_HUNTER]);
  });
});

describe("comparePerksByRow", () => {
  it("is total — never 0 for two different ids", () => {
    const cmp = comparePerksByRow(DOMINATION);
    expect(cmp(CHEAP_SHOT, TASTE_OF_BLOOD)).toBeLessThan(0);
    expect(cmp(9001, 9002)).toBeLessThan(0); // both unknown, tie broken by id
    expect(cmp(CHEAP_SHOT, CHEAP_SHOT)).toBe(0);
  });
});
