import { describe, it, expect } from "vitest";
import {
  isContested,
  slotFromFrequencies,
  slotSegments,
  type SlotView,
} from "@/components/hextech/buildSlotView";

/** The measured Ahri case this whole shape exists for: Malignance 71%,
 *  Blackfire Torch 23%, over 111 stored games, co-occurring in ZERO of them. */
const AHRI_SLOT: SlotView = {
  primary: { itemId: 323001, games: 79, pct: 71 },
  alternatives: [{ itemId: 4646, games: 26, pct: 23 }],
  sampleGames: 111,
};

const SETTLED: SlotView = {
  primary: { itemId: 3157, games: 92, pct: 83 },
  alternatives: [],
  sampleGames: 111,
};

describe("isContested", () => {
  it("is false for a settled slot — the common case, which must render plain", () => {
    expect(isContested(SETTLED)).toBe(false);
  });

  it("is true as soon as one alternative exists", () => {
    expect(isContested(AHRI_SLOT)).toBe(true);
  });
});

describe("slotSegments", () => {
  it("gives a settled slot exactly one segment, at rank 0", () => {
    const segs = slotSegments(SETTLED);
    expect(segs).toEqual([{ itemId: 3157, rank: 0, width: 83 }]);
  });

  it("divides ONE track between the competing options, go-to first", () => {
    const segs = slotSegments(AHRI_SLOT);
    expect(segs.map((s) => [s.itemId, s.rank, s.width])).toEqual([
      [323001, 0, 71],
      [4646, 1, 23],
    ]);
    // The remainder is real — 6% of games held neither — and is deliberately
    // left unfilled rather than padded out to a full track.
    expect(segs.reduce((n, s) => n + s.width, 0)).toBeLessThan(100);
  });

  it("ranks alternatives in the order given, not by percentage", () => {
    // The engine decides which option is the go-to; this module never re-ranks.
    const slot: SlotView = {
      primary: { itemId: 1, games: 20, pct: 30 },
      alternatives: [
        { itemId: 2, games: 25, pct: 38 },
        { itemId: 3, games: 10, pct: 15 },
      ],
      sampleGames: 66,
    };
    expect(slotSegments(slot).map((s) => s.itemId)).toEqual([1, 2, 3]);
  });

  it("floors a tiny-but-real option to a visible sliver", () => {
    const slot: SlotView = {
      primary: { itemId: 1, games: 60, pct: 80 },
      alternatives: [{ itemId: 2, games: 1, pct: 1 }],
      sampleGames: 75,
    };
    const alt = slotSegments(slot).find((s) => s.itemId === 2);
    expect(alt?.width).toBe(2);
  });

  it("drops a never-built option entirely rather than flooring it", () => {
    // A visible mark for a 0% option would assert it was built. It wasn't.
    const slot: SlotView = {
      primary: { itemId: 1, games: 60, pct: 80 },
      alternatives: [{ itemId: 2, games: 0, pct: 0 }],
      sampleGames: 75,
    };
    expect(slotSegments(slot).map((s) => s.itemId)).toEqual([1]);
  });

  it("never overflows the track, even on overlapping input", () => {
    // Options that genuinely co-occur would sum past 100. The bar scales rather
    // than spilling — a slot filled past full is a lie in the other direction.
    const slot: SlotView = {
      primary: { itemId: 1, games: 70, pct: 70 },
      alternatives: [
        { itemId: 2, games: 60, pct: 60 },
        { itemId: 3, games: 40, pct: 40 },
      ],
      sampleGames: 100,
    };
    const segs = slotSegments(slot);
    const total = segs.reduce((n, s) => n + s.width, 0);
    expect(total).toBeCloseTo(100, 6);
    // Proportions survive the scaling — the go-to still owns the largest share.
    expect(segs[0].width).toBeGreaterThan(segs[1].width);
    expect(segs[1].width).toBeGreaterThan(segs[2].width);
  });
});

describe("slotFromFrequencies", () => {
  it("returns null for an empty group — absent, not an empty slot", () => {
    expect(slotFromFrequencies([], 95)).toBeNull();
  });

  it("makes the first entry the go-to and the rest its alternatives", () => {
    // The Pro card's own boots case: two boots choices, one slot.
    const slot = slotFromFrequencies(
      [
        { itemId: 3158, count: 33, share: 33 / 95 },
        { itemId: 3020, count: 26, share: 26 / 95 },
      ],
      95
    );
    expect(slot).toEqual({
      primary: { itemId: 3158, games: 33, pct: 35 },
      alternatives: [{ itemId: 3020, games: 26, pct: 27 }],
      sampleGames: 95,
    });
  });

  it("keeps each option's own percentage — never a merged family stat", () => {
    // The five support-quest finals are mutually exclusive, so a combined
    // percentage would describe a choice nobody made.
    const slot = slotFromFrequencies(
      [
        { itemId: 3870, count: 8, share: 0.8 },
        { itemId: 3871, count: 2, share: 0.2 },
      ],
      10
    );
    expect(slot!.primary.pct).toBe(80);
    expect(slot!.alternatives[0].pct).toBe(20);
  });

  it("rounds the same way formatSharePct does, so one item never shows two numbers", () => {
    const slot = slotFromFrequencies([{ itemId: 1, count: 1, share: 1 / 3 }], 3);
    expect(slot!.primary.pct).toBe(33);
  });

  it("a single-entry group is a settled slot", () => {
    const slot = slotFromFrequencies([{ itemId: 3157, count: 92, share: 0.83 }], 111);
    expect(isContested(slot!)).toBe(false);
  });
});
