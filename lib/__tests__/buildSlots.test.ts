// Tests for lib/buildSlots.ts — grouping a build ranking into competing slots.
//
// Fixtures are shaped from the LIVE measurement that set the threshold
// (scripts/_tmp-cooccur.mts against coachbuild.otp_matches, 2026-07-29), not
// from round numbers: the competing case is Morgana's Blackfire Torch 46% vs
// Luden's Echo 17% at zero co-occurrence, and the companion case is
// Heimerdinger's Shadowflame + Blackfire at 33 observed against 27 expected.
// A fixture that never approaches the threshold would test nothing about it.

import { describe, it, expect } from "vitest";
import { resolveBuildSlots, type BuildSlot } from "../buildSlots";
import type { SlotView } from "@/components/hextech/buildSlotView";

const BLACKFIRE = 4646;
const LUDENS = 6655;
const SHADOWFLAME = 4645;
const RABADONS = 3089;
const ZHONYAS = 3157;
const ROCKETBELT = 3152;
const RYLAIS = 3116;

/** Build `n` games, placing each item id in the game indices given. Lets a test
 *  state co-occurrence exactly rather than hoping a random fixture lands on it. */
function makeGames(n: number, spec: Record<number, number[]>): number[][] {
  const games: number[][] = Array.from({ length: n }, () => [] as number[]);
  for (const [id, idxs] of Object.entries(spec)) {
    for (const i of idxs) games[i].push(Number(id));
  }
  return games;
}
const range = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => from + i);

describe("resolveBuildSlots — competition detection", () => {
  it("groups two items that are never built together into one slot", () => {
    // Morgana, measured: Blackfire 46% and Luden's 17%, expected overlap 13.7
    // games, observed 0. Rabadon's is in every game as an uncontested anchor.
    const games = makeGames(100, {
      [RABADONS]: range(0, 100),
      [BLACKFIRE]: range(0, 46),
      [LUDENS]: range(46, 63),
    });
    const slots = resolveBuildSlots(games, 100);

    expect(slots.map((s) => s.primary.itemId)).toEqual([RABADONS, BLACKFIRE]);
    expect(slots[0].alternatives).toEqual([]); // settled
    expect(slots[1].alternatives).toEqual([{ itemId: LUDENS, games: 17, pct: 17 }]);
    expect(slots[1].primary).toEqual({ itemId: BLACKFIRE, games: 46, pct: 46 });
  });

  it("leaves genuine companions in separate settled slots", () => {
    // Heimerdinger, measured: Shadowflame 56% + Blackfire 49%, 33 together
    // against 27.4 expected — lift 1.2. Nothing here competes.
    const games = makeGames(100, {
      [SHADOWFLAME]: range(0, 56),
      [BLACKFIRE]: [...range(0, 33), ...range(56, 72)],
    });
    const slots = resolveBuildSlots(games, 100);
    expect(slots).toHaveLength(2);
    expect(slots.every((s) => s.alternatives.length === 0)).toBe(true);
  });

  it("returns every slot settled for a champion with no competing pair at all", () => {
    // The Heimerdinger case in full: a settled build must produce zero contested
    // slots, which is what the render draws as ordinary rows.
    const games = makeGames(100, {
      [RABADONS]: range(0, 69),
      [SHADOWFLAME]: range(0, 56),
      [BLACKFIRE]: range(0, 49),
      [ZHONYAS]: range(0, 38),
    });
    const slots = resolveBuildSlots(games, 100);
    expect(slots).toHaveLength(4);
    expect(slots.flatMap((s) => s.alternatives)).toEqual([]);
  });
});

describe("resolveBuildSlots — the case the user actually named", () => {
  // "items like ludens, blackfire and malignance are never built at the same
  // time in one set... put a percentage for each one in the same slot and show
  // which one is the go-to" (2026-07-29).
  //
  // Ahri Mid, measured LIVE through this exact function (n=102 stored games):
  //   [Malignance 70% | Blackfire Torch 25%]  Zhonya's 34%
  //   [Lich Bane 29% | Cosmic Drive 26%]      Shadowflame 26%
  // The fixture reproduces that shape, INCLUDING the two companion pairs that
  // must stay apart — Malignance+Zhonya's and Blackfire+Shadowflame both sit at
  // ~33% joint rate in the real data, which is the closest any real companion
  // pair comes to the threshold. Without them the test would only prove the
  // easy half.
  const MALIGNANCE = 3118;
  const COSMIC_DRIVE = 4629;
  const LICH_BANE = 3100;

  it("groups the either/or and leaves the companions alone, on one champion's games", () => {
    const games = makeGames(102, {
      // 71 Malignance / 26 Blackfire, disjoint — the pair he named.
      [MALIGNANCE]: range(0, 71),
      [BLACKFIRE]: range(71, 97),
      // Zhonya's rides along with Malignance about a third of the time.
      [ZHONYAS]: range(0, 35),
      // Shadowflame rides along with Blackfire about a third of the time, and
      // spreads across the Malignance games too.
      [SHADOWFLAME]: [...range(71, 80), ...range(20, 38)],
      // A second, independent either/or inside the same champion.
      [LICH_BANE]: range(0, 30),
      [COSMIC_DRIVE]: range(30, 57),
    });
    const slots = resolveBuildSlots(games, 102);

    const slotOf = (id: number) =>
      slots.find((s) => s.primary.itemId === id || s.alternatives.some((a) => a.itemId === id))!;

    // The pair he named shares ONE slot, Malignance leading as the go-to.
    const malSlot = slotOf(MALIGNANCE);
    expect(malSlot.primary.itemId).toBe(MALIGNANCE);
    expect(malSlot.alternatives.map((a) => a.itemId)).toContain(BLACKFIRE);

    // The companions are NOT swept in with them.
    expect(malSlot.alternatives.map((a) => a.itemId)).not.toContain(ZHONYAS);
    expect(slotOf(ZHONYAS).primary.itemId).toBe(ZHONYAS);
    expect(slotOf(SHADOWFLAME).alternatives).toEqual([]);

    // ...and the second either/or is found independently of the first.
    const lichSlot = slotOf(LICH_BANE);
    expect(lichSlot.primary.itemId).toBe(LICH_BANE);
    expect(lichSlot.alternatives.map((a) => a.itemId)).toEqual([COSMIC_DRIVE]);

    // Every percentage carries the denominator it was computed over.
    expect(slots.every((s) => s.sampleGames === 102)).toBe(true);
    expect(malSlot.primary.pct).toBe(70);
  });
});

describe("resolveBuildSlots — the noise guard", () => {
  it("does NOT claim competition when the sample could not have shown otherwise", () => {
    // Two 15% items over 40 games expect 0.9 games of overlap. Observing zero is
    // the SINGLE MOST LIKELY outcome under pure independence, so calling it "they
    // never build these together" reads structure out of noise. This is the guard
    // that matters more than the lift threshold.
    const games = makeGames(40, {
      [RABADONS]: range(0, 40),
      [ROCKETBELT]: range(0, 6),
      [RYLAIS]: range(6, 12),
    });
    const slots = resolveBuildSlots(games, 40);
    const contested = slots.filter((s) => s.alternatives.length > 0);
    expect(contested).toEqual([]);
  });

  it("refuses to group AT ALL below the sample floor, however clean the split looks", () => {
    // 12 item-bearing games, two items each in half of them, never together.
    // The pair guard alone would let this through — expected overlap is exactly
    // 3.0 — and the two are forced by pigeonhole to be near-disjoint at those
    // rates anyway, so the "finding" would be arithmetic rather than behaviour.
    // MIN_SAMPLE_GAMES (20) is what refuses it. 12 games is a couple of evenings
    // on one champion, not an opinion about their build.
    const games = makeGames(12, {
      [RABADONS]: range(0, 12),
      [BLACKFIRE]: range(0, 6),
      [LUDENS]: range(6, 12),
    });
    const slots = resolveBuildSlots(games, 12);
    expect(slots.flatMap((s) => s.alternatives)).toEqual([]);
    // Every item still shows up — the refusal is to GROUP, not to report.
    expect(slots.map((s) => s.primary.itemId).sort()).toEqual([RABADONS, BLACKFIRE, LUDENS].sort());
  });

  it("does claim it once the same pair is observable at a real sample size", () => {
    // Identical rates (21%/22%), four times the games — expected overlap is now
    // 9.2, so zero together IS evidence. Morgana's measured Rocketbelt/Rylai's.
    const games = makeGames(160, {
      [RABADONS]: range(0, 160),
      [ROCKETBELT]: range(0, 35),
      [RYLAIS]: range(35, 69),
    });
    const slots = resolveBuildSlots(games, 160);
    const contested = slots.filter((s) => s.alternatives.length > 0);
    expect(contested).toHaveLength(1);
    expect(contested[0].primary.itemId).toBe(ROCKETBELT);
    expect(contested[0].alternatives.map((a) => a.itemId)).toEqual([RYLAIS]);
  });
});

describe("resolveBuildSlots — the lift threshold boundary", () => {
  // A in 50 games, B in 20, over 100 -> expected overlap exactly 10, so the
  // observed count IS the lift in tenths. This pins 0.35 from both sides.
  //
  // RABADONS is in every game and is load-bearing, not decoration: co-occurrence
  // is computed over games that CARRIED items, so without an anchor the trailing
  // empty games would drop out, the population would be 66 rather than 100, and
  // the expected overlap would silently be 15.2 instead of 10. The first draft of
  // this test omitted it and "passed" the 0.30 case for the wrong reason.
  const atOverlap = (overlap: number) =>
    resolveBuildSlots(
      makeGames(100, {
        [RABADONS]: range(0, 100),
        [BLACKFIRE]: range(0, 50),
        [LUDENS]: range(50 - overlap, 70 - overlap),
      }),
      100
    );

  it("treats lift 0.30 as competing", () => {
    const slots = atOverlap(3);
    const contested = slots.filter((s) => s.alternatives.length > 0);
    expect(contested).toHaveLength(1);
    expect(contested[0].primary.itemId).toBe(BLACKFIRE);
    expect(contested[0].alternatives.map((a) => a.itemId)).toEqual([LUDENS]);
  });

  it("treats lift 0.40 as NOT competing", () => {
    const slots = atOverlap(4);
    expect(slots.flatMap((s) => s.alternatives)).toEqual([]);
    expect(slots.map((s) => s.primary.itemId)).toEqual([RABADONS, BLACKFIRE, LUDENS]);
  });
});

describe("resolveBuildSlots — grouping rules", () => {
  it("attaches a contested item to the MORE-BUILT go-to when it competes with two", () => {
    // C never appears with A (50%) or B (30%). Greedy takes the bigger claim.
    const games = makeGames(100, {
      [RABADONS]: range(0, 100),
      [BLACKFIRE]: range(0, 50),
      [SHADOWFLAME]: range(50, 80),
      [LUDENS]: range(80, 100),
    });
    const slots = resolveBuildSlots(games, 100);
    const owner = slots.find((s) => s.alternatives.some((a) => a.itemId === LUDENS));
    expect(owner!.primary.itemId).toBe(BLACKFIRE);
    // ...and it is claimed once, never listed under two slots.
    expect(slots.flatMap((s) => s.alternatives).filter((a) => a.itemId === LUDENS)).toHaveLength(1);
  });

  it("caps alternatives and drops the weakest, never the go-to", () => {
    const games = makeGames(200, {
      [BLACKFIRE]: range(0, 80),
      [LUDENS]: range(80, 130),
      [ROCKETBELT]: range(130, 170),
      [RYLAIS]: range(170, 200),
    });
    const slots = resolveBuildSlots(games, 200, { maxAlternatives: 2 });
    expect(slots[0].primary.itemId).toBe(BLACKFIRE);
    expect(slots[0].alternatives.map((a) => a.itemId)).toEqual([LUDENS, ROCKETBELT]);
  });

  it("respects the include predicate, so a caller can slot one class of item", () => {
    const games = makeGames(100, { [RABADONS]: range(0, 100), [BLACKFIRE]: range(0, 46) });
    const slots = resolveBuildSlots(games, 100, { include: (id) => id !== RABADONS });
    expect(slots.map((s) => s.primary.itemId)).toEqual([BLACKFIRE]);
  });

  it("never seats a snowball stack, even when the caller's predicate would allow it", () => {
    // Mejai's is not a build item (hard user directive, 2026-07-29) and the raw
    // `final_items` arrays callers pass in carry it. The exclusion is ANDed with
    // the caller's `include` rather than delegated to it, so the DEFAULT
    // (`() => true`) is safe rather than merely unused by today's three callers.
    const MEJAIS = 3041;
    const games = makeGames(100, {
      [RABADONS]: range(0, 100),
      [MEJAIS]: range(0, 60),
      [BLACKFIRE]: range(0, 46),
    });
    const slots = resolveBuildSlots(games, 100, { include: () => true });
    expect(slots.flatMap((s) => [s.primary.itemId, ...s.alternatives.map((a) => a.itemId)])).not.toContain(MEJAIS);
    expect(slots.map((s) => s.primary.itemId)).toEqual([RABADONS, BLACKFIRE]);
  });

  it("drops items below the display floor before slotting", () => {
    const games = makeGames(100, { [RABADONS]: range(0, 100), [BLACKFIRE]: range(0, 5) });
    expect(resolveBuildSlots(games, 100).map((s) => s.primary.itemId)).toEqual([RABADONS]);
  });

  it("caps the number of slots at an inventory", () => {
    const spec: Record<number, number[]> = {};
    for (let i = 0; i < 9; i++) spec[7000 + i] = range(0, 100 - i);
    const slots = resolveBuildSlots(makeGames(100, spec), 100);
    expect(slots).toHaveLength(6);
  });
});

describe("resolveBuildSlots — denominators and determinism", () => {
  it("quotes pct against the CALLER's denominator, not the games it was handed", () => {
    // 20 of the player's 40 stored games carry item data. An item in all 20 is
    // 50% of their games, not 100% — quoting it against the item-bearing subset
    // would make one card show two different denominators.
    const games = makeGames(20, { [RABADONS]: range(0, 20) });
    const slots = resolveBuildSlots(games, 40);
    expect(slots[0].primary).toEqual({ itemId: RABADONS, games: 20, pct: 50 });
    expect(slots[0].sampleGames).toBe(40);
  });

  it("counts a duplicated id once per game, in singles AND in pairs", () => {
    const games = [
      [RABADONS, RABADONS, BLACKFIRE],
      [RABADONS, BLACKFIRE, BLACKFIRE],
    ];
    const slots = resolveBuildSlots(games, 2, { minPct: 0 });
    expect(slots.find((s) => s.primary.itemId === RABADONS)!.primary.games).toBe(2);
  });

  it("gives the same slots whatever order the games arrive in", () => {
    const spec = { [RABADONS]: range(0, 100), [BLACKFIRE]: range(0, 46), [LUDENS]: range(46, 63) };
    const a = resolveBuildSlots(makeGames(100, spec), 100);
    const b = resolveBuildSlots([...makeGames(100, spec)].reverse(), 100);
    expect(a).toEqual(b);
  });

  it("returns [] rather than throwing on empty or degenerate input", () => {
    expect(resolveBuildSlots([], 37)).toEqual([]);
    expect(resolveBuildSlots([[]], 37)).toEqual([]);
    expect(resolveBuildSlots([[3089]], 0)).toEqual([]);
    expect(() => resolveBuildSlots([[0, -1, NaN]], 10)).not.toThrow();
  });
});

describe("BuildSlot is structurally the render half's SlotView", () => {
  it("assigns to SlotView with no adapter", () => {
    // Compile-time contract between lib/buildSlots.ts and
    // components/hextech/buildSlotView.ts. If either side adds a required field
    // this stops compiling, which is the point — the two are kept in step by
    // the type checker rather than by a comment.
    const slot: BuildSlot = {
      primary: { itemId: BLACKFIRE, games: 46, pct: 46 },
      alternatives: [{ itemId: LUDENS, games: 17, pct: 17 }],
      sampleGames: 100,
    };
    const view: SlotView = slot;
    expect(view.primary.itemId).toBe(BLACKFIRE);
  });
});
