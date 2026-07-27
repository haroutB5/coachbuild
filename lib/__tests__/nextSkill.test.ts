// ─────────────────────────────────────────────────────────────────────────────
// nextSkill.test.ts
//
// WHAT THIS SUITE DOES AND DOES NOT PROVE.
//
// It proves the PURE resolver: given a recommended order + a level + a set of
// ability ranks, does it pick the right ability, and does it refuse in every
// case it is supposed to refuse. That is a closed arithmetic problem and it is
// tested exhaustively (including a full 1..18 walk over three real champions).
//
// It proves NOTHING about the live path. There is no League client in this
// environment, so `https://127.0.0.1:2999/liveclientdata/activeplayer` has
// never been called and no real response has ever been seen. Every `level` and
// `abilities` value below is CONSTRUCTED BY HAND from Riot's published schema.
//
// Therefore this file deliberately contains NO mock of the Live Client Data
// API and NO test of "the companion parses a live response correctly." Such a
// test would assert only that the fixture matches the fixture, while reading —
// in a coverage report, in a handoff, in six months — as proof that the wire
// format was verified. It was not. `parseLiveSkillState` is tested only as
// what it actually is: a narrowing guard that must reject anything it does not
// recognise, INCLUDING shapes we have guessed wrong.
//
// The real wire format is validated by a human running the curl commands in
// HANDOFF-engy.md against a live game. Until that happens it is assumed.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import {
  resolveNextSkill,
  parseLiveSkillState,
  pointsSpent,
  isLiveSkillError,
  RANKABLE,
  type AbilityRanks,
  type NextSkillResult,
} from "@/lib/nextSkill";
import { buildSkillOrderModel, countRanks, MAX_RANKS } from "@/lib/skillOrderModel";
import { kitFromMaxRanks } from "@/lib/championKit";
import type { Ability, ChampionKit, SkillOrderModel } from "@/lib/types";

const A = (s: string): Ability[] => s.split("") as Ability[];

/** Ahri mid, verbatim from op.gg (2026-07-27) — the same fixture
 *  skillOrderModel.test.ts uses. Completes cleanly to 18. */
const AHRI_15 = A("WQEQQRQWQWRWWEE");
/** SYNTHETIC, and labelled as such. Shaped after the SEVEN champions whose
 *  published order ranks R at level *12* (JINX, ZED, KASSADIN, SIVIR, CORKI,
 *  ZERI, QIYANA — see skillOrderModel.ts's sweep): R at slots 5 and 11, and
 *  otherwise standard counts (Q5 W5 E3 R2), so the model still completes to 18.
 *  Their real op.gg strings were not to hand in this environment, and inventing
 *  one and calling it "Jinx, verbatim" would be exactly the kind of fake
 *  provenance this repo forbids — so this fixture claims only its SHAPE. */
const MODAL_R12_15 = A("QWEQQRQQWWWRWEE");
/** Udyr jungle, verbatim — six ranks on Q and E, "R" at level 2. */
const UDYR_15 = A("QRWEQQQEQEQEEEW");

/** Build a real SkillOrderModel through the production assembler, so these
 *  tests exercise the same `completed` flag the API actually serves. */
function model(order: Ability[], play = 1000, win = 550): SkillOrderModel {
  const m = buildSkillOrderModel({ order, play, win, pickRate: 0.4 });
  if (!m) throw new Error("fixture produced no model");
  return m;
}

const ranks = (Q: number, W: number, E: number, R: number): AbilityRanks => ({ Q, W, E, R });
const ZERO = ranks(0, 0, 0, 0);

/** Every refusal asserted the same way, so a `recommend` leaking through a
 *  refusal test can never pass by structural accident. */
function expectNone(res: NextSkillResult, because: string) {
  expect(res.kind).toBe("none");
  expect(res.kind === "none" ? res.because : null).toBe(because);
}

describe("pointsSpent — the derivation the whole feature rests on", () => {
  it("sums exactly the four rankable slots", () => {
    expect(pointsSpent(ZERO)).toBe(0);
    expect(pointsSpent(ranks(5, 5, 5, 3))).toBe(18);
    expect(pointsSpent(ranks(3, 1, 1, 1))).toBe(6);
  });

  it("cannot include a passive — RANKABLE is the closed set of rankable slots", () => {
    expect([...RANKABLE]).toEqual(["Q", "W", "E", "R"]);
    // A payload carrying a Passive entry contributes nothing: the sum reads
    // only the four named keys, so a passive cannot inflate spent-points and
    // fabricate a missing unspent point.
    const withPassive = { ...ranks(2, 1, 1, 1), Passive: 7 } as unknown as AbilityRanks;
    expect(pointsSpent(withPassive)).toBe(5);
  });
});

describe("resolveNextSkill — the happy path", () => {
  const ahri = model(AHRI_15);

  it("level 1, nothing spent -> the first ability in the order", () => {
    const res = resolveNextSkill({ model: ahri, level: 1, ranks: ZERO });
    expect(res).toEqual({ kind: "recommend", ability: "W", fromRank: 0, toRank: 1, atLevel: 1, unspent: 1 });
  });

  it("reports the rank TRANSITION, not just the ability", () => {
    // Ahri at level 5 having followed W,Q,E,Q: order[4] is 'Q', Q is on 2.
    const res = resolveNextSkill({ model: ahri, level: 5, ranks: ranks(2, 1, 1, 0) });
    expect(res).toEqual({ kind: "recommend", ability: "Q", fromRank: 2, toRank: 3, atLevel: 5, unspent: 1 });
  });

  it("recommends the ultimate at level 6", () => {
    const res = resolveNextSkill({ model: ahri, level: 6, ranks: ranks(3, 1, 1, 0) });
    expect(res).toEqual({ kind: "recommend", ability: "R", fromRank: 0, toRank: 1, atLevel: 6, unspent: 1 });
  });

  it("uses the DERIVED tail (16-18) when the model completed", () => {
    expect(ahri.completed).toBe(true);
    // Ahri's derived tail is R,E,E at 16,17,18.
    expect(resolveNextSkill({ model: ahri, level: 16, ranks: ranks(5, 5, 3, 2) })).toMatchObject({
      ability: "R",
      toRank: 3,
      atLevel: 16,
    });
    expect(resolveNextSkill({ model: ahri, level: 17, ranks: ranks(5, 5, 3, 3) })).toMatchObject({
      ability: "E",
      fromRank: 3,
      toRank: 4,
      atLevel: 17,
    });
    expect(resolveNextSkill({ model: ahri, level: 18, ranks: ranks(5, 5, 4, 3) })).toMatchObject({
      ability: "E",
      fromRank: 4,
      toRank: 5,
      atLevel: 18,
    });
  });

  it("walks all 18 levels of a compliant player and reproduces the order exactly", () => {
    const live: AbilityRanks = { ...ZERO };
    const walked: Ability[] = [];
    for (let level = 1; level <= 18; level += 1) {
      const res = resolveNextSkill({ model: ahri, level, ranks: { ...live } });
      expect(res.kind).toBe("recommend");
      if (res.kind !== "recommend") return;
      expect(res.atLevel).toBe(level);
      expect(res.unspent).toBe(1);
      expect(res.fromRank).toBe(live[res.ability]);
      expect(res.toRank).toBe(live[res.ability] + 1);
      live[res.ability] += 1;
      walked.push(res.ability);
    }
    expect(walked.join("")).toBe(ahri.order.join(""));
    expect(countRanks(walked)).toEqual({ Q: 5, W: 5, E: 5, R: 3 });
  });
});

describe("resolveNextSkill — banked points index by POINTS SPENT, not by level", () => {
  const ahri = model(AHRI_15);

  it("a player holding one point back gets the recommendation for their NEXT point", () => {
    // Level 9, only 7 points spent (W,Q,E,Q,Q,R,Q = order[0..6]). The 8th point
    // is order[7] = 'W'. Indexing by LEVEL would give order[8] = 'Q' and skip
    // the W rank permanently.
    const res = resolveNextSkill({ model: ahri, level: 9, ranks: ranks(4, 1, 1, 1) });
    expect(res).toEqual({ kind: "recommend", ability: "W", fromRank: 1, toRank: 2, atLevel: 8, unspent: 2 });
  });

  it("reports every banked point in `unspent`", () => {
    const res = resolveNextSkill({ model: ahri, level: 10, ranks: ranks(2, 1, 1, 0) });
    expect(res.kind === "recommend" ? res.unspent : null).toBe(6);
    expect(res.kind === "recommend" ? res.atLevel : null).toBe(5);
  });
});

describe("resolveNextSkill — refuses rather than guessing", () => {
  const ahri = model(AHRI_15);

  it("no model at all (Kha'Zix, unsupported role) -> no-model", () => {
    expectNone(resolveNextSkill({ model: null, level: 5, ranks: ranks(2, 1, 1, 0) }), "no-model");
  });

  it("no unspent point -> no-unspent (the ordinary in-game state)", () => {
    expectNone(resolveNextSkill({ model: ahri, level: 6, ranks: ranks(3, 1, 1, 1) }), "no-unspent");
    expectNone(resolveNextSkill({ model: ahri, level: 18, ranks: ranks(5, 5, 5, 3) }), "no-unspent");
  });

  it("more points spent than levels earned -> over-spent, never a recommendation", () => {
    // The shape a split read straddling a level-up would produce.
    expectNone(resolveNextSkill({ model: ahri, level: 5, ranks: ranks(3, 2, 1, 0) }), "over-spent");
  });

  it("rejects a level outside 1..18", () => {
    for (const level of [0, -1, 19, 100, 1.5, NaN, Infinity]) {
      expectNone(resolveNextSkill({ model: ahri, level, ranks: ZERO }), "bad-level");
    }
  });

  it("rejects non-integer / negative / missing ranks", () => {
    expectNone(resolveNextSkill({ model: ahri, level: 5, ranks: ranks(-1, 0, 0, 0) }), "bad-ranks");
    expectNone(resolveNextSkill({ model: ahri, level: 5, ranks: ranks(1.5, 0, 0, 0) }), "bad-ranks");
    expectNone(
      resolveNextSkill({ model: ahri, level: 5, ranks: { Q: 1, W: 0, E: 0 } as unknown as AbilityRanks }),
      "bad-ranks"
    );
    expectNone(
      resolveNextSkill({ model: ahri, level: 5, ranks: null as unknown as AbilityRanks }),
      "bad-ranks"
    );
    expectNone(
      resolveNextSkill({ model: ahri, level: 5, ranks: { Q: "3", W: 0, E: 0, R: 0 } as unknown as AbilityRanks }),
      "bad-ranks"
    );
  });

  it("rejects a rank set that could not fit in 18 points", () => {
    // Caught as bad-ranks BEFORE the standard-model check, because a sum > 18
    // is not a kit shape at all, it is a broken payload.
    expectNone(resolveNextSkill({ model: ahri, level: 18, ranks: ranks(19, 0, 0, 0) }), "bad-ranks");
  });

  it("rejects an order carrying a non-Q/W/E/R token", () => {
    // Kha'Zix's "R-Q"/"R-W" evolution tokens are rejected upstream in
    // lib/opgg.ts, but a reshaped feed reaching this far must still not be
    // indexed into blindly.
    const poisoned = { ...ahri, order: A("WQE").concat(["R-Q" as Ability]) };
    expectNone(resolveNextSkill({ model: poisoned, level: 5, ranks: ranks(1, 1, 1, 0) }), "bad-order");
  });
});

describe("resolveNextSkill — the STANDARD-kit fallback still refuses off-model ranks", () => {
  // ── WHY THESE TWO TESTS CHANGED ─────────────────────────────────────────
  // They used to be titled as Udyr's production behaviour and asserted that
  // he is refused. That is no longer true of Udyr: with his real ddragon kit
  // (6/6/6/6, R ungated) both readings below are perfectly legal and now get
  // a recommendation — see the per-champion block at the end of this file,
  // which asserts exactly that.
  //
  // What these cases still legitimately prove is the FALLBACK: a model that
  // carries NO kit is interpreted under the standard 5/5/5/3 model, which is
  // what every consumer did before per-champion caps existed and what still
  // happens when ddragon cannot be reached for an unremarkable champion. So
  // they are kept, re-titled, and their fixture is now named for what it is.
  const noKit = model(UDYR_15);

  it("a sixth rank on a basic -> non-standard-kit when no kit is supplied", () => {
    expect(noKit.kit).toBeUndefined();
    expect(noKit.completed).toBe(false);
    expect(noKit.order).toHaveLength(15);
    expectNone(resolveNextSkill({ model: noKit, level: 14, ranks: ranks(6, 1, 4, 1) }), "non-standard-kit");
  });

  it("an R ranked at level 2 -> ultimate-illegal when no kit is supplied", () => {
    // Under the standard model an ultimate's first rank needs level 6. Without
    // a kit telling us this champion's R is really a fourth basic, refusing is
    // still the right trade: the alternative is a rule that would approve an
    // illegal ultimate rank for every other champion in the game.
    expectNone(resolveNextSkill({ model: noKit, level: 2, ranks: ranks(1, 0, 0, 0) }), "ultimate-illegal");
  });

  it("every rank over the standard cap is caught, on every slot", () => {
    const ahri = model(AHRI_15);
    for (const a of RANKABLE) {
      const over = { ...ZERO, [a]: MAX_RANKS[a] + 1 } as AbilityRanks;
      expectNone(resolveNextSkill({ model: ahri, level: 18, ranks: over }), "non-standard-kit");
    }
  });
});

describe("resolveNextSkill — levels 16-18 on an INCOMPLETE model", () => {
  // The rule the brief is most explicit about: when skillOrderModel.ts refused
  // to derive the tail, past level 15 we say nothing.
  const incomplete = model(UDYR_15);

  it("the fixture really is incomplete (guards against the test asserting nothing)", () => {
    expect(incomplete.completed).toBe(false);
    expect(incomplete.order).toHaveLength(15);
  });

  it("refuses with model-incomplete once the 16th point is due", () => {
    // 15 points spent, level 16 -> the 16th point. Ranks kept inside the
    // standard caps so `non-standard-kit` cannot pre-empt the refusal we are
    // actually testing.
    expectNone(resolveNextSkill({ model: incomplete, level: 16, ranks: ranks(5, 4, 5, 1) }), "model-incomplete");
    expectNone(resolveNextSkill({ model: incomplete, level: 18, ranks: ranks(5, 4, 5, 1) }), "model-incomplete");
  });

  it("still advises INSIDE the 15 levels the source actually published", () => {
    const res = resolveNextSkill({ model: incomplete, level: 1, ranks: ZERO });
    expect(res).toMatchObject({ kind: "recommend", ability: "Q", atLevel: 1 });
  });

  it("a COMPLETED model is advised through level 18", () => {
    const ahri = model(AHRI_15);
    expect(resolveNextSkill({ model: ahri, level: 18, ranks: ranks(5, 5, 4, 3) }).kind).toBe("recommend");
  });

  it("order-exhausted is genuinely unreachable through the public contract", () => {
    // Requires an 19th point, which bad-level (level > 18) and the
    // spent > 18 guard both exclude. Asserted by construction rather than
    // trusted: a hand-built 3-long COMPLETE order is the only way to reach it.
    const stub: SkillOrderModel = {
      priority: A("QWE"),
      levels: { Q: [1], W: [2], E: [3], R: [] },
      order: A("QWE"),
      completed: true,
      sampleSize: 10,
      winRate: 0.5,
      share: 0.1,
    };
    expectNone(resolveNextSkill({ model: stub, level: 5, ranks: ranks(1, 1, 1, 0) }), "order-exhausted");
  });
});

describe("resolveNextSkill — the ultimate-legality guard is NOT dead code", () => {
  it("a published R at the level-12 slot is refused once the player's R is on 2", () => {
    const m = model(MODAL_R12_15);
    // Fixture sanity — these assertions are what make the test mean anything.
    expect(m.order).toHaveLength(18);
    expect(m.completed).toBe(true);
    expect(m.order[11]).toBe("R"); // the level-12 slot, an ILLEGAL ultimate level
    expect(countRanks(MODAL_R12_15)).toEqual({ Q: 5, W: 5, E: 3, R: 2 });

    // The real-play case. The published order is a per-level MODAL AGGREGATE,
    // not one player's path: an actual player takes R at 6 and 11 (both legal),
    // so at level 12 they hold R:2 with 11 points spent. order[11] then says
    // "R" — but R3 needs level 16. Say nothing rather than send them to press R.
    expectNone(resolveNextSkill({ model: m, level: 12, ranks: ranks(5, 3, 1, 2) }), "ultimate-illegal");

    // And the same order IS followable by someone who genuinely delayed R2 to
    // 12 — that is legal (R2 only requires level >= 11), so it must not refuse.
    expect(resolveNextSkill({ model: m, level: 12, ranks: ranks(5, 4, 1, 1) })).toMatchObject({
      kind: "recommend",
      ability: "R",
      fromRank: 1,
      toRank: 2,
    });
  });

  it("R2 before level 11 and R3 before level 16 are both refused", () => {
    const rEarly: SkillOrderModel = {
      priority: A("QWE"),
      levels: { Q: [], W: [], E: [], R: [] },
      order: A("RRRRRRRRRRRRRRRRRR"),
      completed: true,
      sampleSize: 10,
      winRate: 0.5,
      share: 0.1,
    };
    expectNone(resolveNextSkill({ model: rEarly, level: 8, ranks: ranks(0, 0, 0, 1) }), "ultimate-illegal");
    expectNone(resolveNextSkill({ model: rEarly, level: 13, ranks: ranks(0, 0, 0, 2) }), "ultimate-illegal");
    // ...and R1 at 6, R2 at 11, R3 at 16 are all fine.
    expect(resolveNextSkill({ model: rEarly, level: 6, ranks: ranks(0, 0, 0, 0) }).kind).toBe("recommend");
    expect(resolveNextSkill({ model: rEarly, level: 11, ranks: ranks(0, 0, 0, 1) }).kind).toBe("recommend");
    expect(resolveNextSkill({ model: rEarly, level: 16, ranks: ranks(0, 0, 0, 2) }).kind).toBe("recommend");
    // A 4th ultimate rank is capped out before legality is ever consulted.
    expectNone(resolveNextSkill({ model: rEarly, level: 18, ranks: ranks(0, 0, 0, 3) }), "capped-ability");
  });
});

describe("resolveNextSkill — the player deviated from the recommendation", () => {
  it("an already-maxed ability -> capped-ability, not a fabricated 6th rank", () => {
    const ahri = model(AHRI_15);
    // 8 points spent -> order[8], which is 'Q'. This player rushed Q to 5 by
    // level 8 instead of following the published path, so the order's next
    // instruction is un-followable.
    expect(ahri.order[8]).toBe("Q");
    expectNone(resolveNextSkill({ model: ahri, level: 10, ranks: ranks(5, 1, 1, 1) }), "capped-ability");
  });

  it("never emits a toRank above the ability's cap, across an exhaustive sweep", () => {
    const ahri = model(AHRI_15);
    let recommended = 0;
    for (let level = 1; level <= 18; level += 1) {
      for (let q = 0; q <= 5; q += 1)
        for (let w = 0; w <= 5; w += 1)
          for (let e = 0; e <= 5; e += 1)
            for (let r = 0; r <= 3; r += 1) {
              const res = resolveNextSkill({ model: ahri, level, ranks: ranks(q, w, e, r) });
              if (res.kind !== "recommend") continue;
              recommended += 1;
              expect(res.toRank).toBeLessThanOrEqual(MAX_RANKS[res.ability]);
              expect(res.toRank).toBe(res.fromRank + 1);
              expect(res.unspent).toBeGreaterThanOrEqual(1);
              // The invariant that makes indexing-by-points-spent correct.
              expect(res.atLevel).toBeLessThanOrEqual(level);
              if (res.ability === "R") {
                expect(level).toBeGreaterThanOrEqual([6, 11, 16][res.toRank - 1]);
              }
            }
    }
    // Guards against the sweep silently asserting nothing.
    expect(recommended).toBeGreaterThan(100);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PER-CHAMPION KITS — the seven champions the hardcoded 5/5/5/3 model got
// wrong, four of them catastrophically.
//
// Every `order` below is the REAL op.gg published 15, probed live 2026-07-27.
// Every kit is ddragon 16.14.1's real `spells[i].maxrank`. The `ranks` inputs
// are still hand-built from Riot's published Live Client Data schema — that
// half remains unobserved (see this file's header) and these tests claim
// nothing about it.
//
// MEASURED BASELINE, so these tests are anchored to a real defect rather than
// a hypothesis. Replaying the OLD engine against a player who follows each
// published order exactly, across levels 1-15:
//
//     Ahri     15/15 recommendations   (unaffected)
//     Jayce     0/15                   permanently blank  ← the user's report
//     Karma     0/15                   permanently blank
//     Elise     0/15                   permanently blank
//     Nidalee   0/15                   permanently blank
//     Udyr      9/15                   blank at both ends
//     Yuumi    11/15                   goes dark from level 12
//
// The dominant cause for the four zeroes was NOT `non-standard-kit` — it was
// `no-unspent`, every single level. Their R rank is GRANTED at level 1, and
// counting a granted rank as spent hides exactly one point forever. Fixing
// only the caps would have left all four still blank, which is why
// `freeRanks` exists and why these walks assert a recommendation at EVERY
// level rather than merely "no refusal".
// ─────────────────────────────────────────────────────────────────────────────
describe("resolveNextSkill — per-champion kits", () => {
  const KIT = {
    ahri: kitFromMaxRanks([5, 5, 5, 3])!,
    jayce: kitFromMaxRanks([6, 6, 6, 1])!,
    karma: kitFromMaxRanks([5, 5, 5, 4])!,
    elise: kitFromMaxRanks([5, 5, 5, 4])!,
    nidalee: kitFromMaxRanks([5, 5, 5, 4])!,
    udyr: kitFromMaxRanks([6, 6, 6, 6])!,
    yuumi: kitFromMaxRanks([6, 5, 5, 3])!,
    aphelios: kitFromMaxRanks([6, 6, 6, 3])!,
  };

  /** A model carrying a specific champion's kit. */
  const kitModel = (order: Ability[], kit: ChampionKit): SkillOrderModel => {
    const m = buildSkillOrderModel({ order, play: 1000, win: 550, pickRate: 0.4 }, kit);
    if (!m) throw new Error("fixture produced no model");
    return m;
  };

  /**
   * Walk a full game for a player who follows the published order exactly,
   * starting from whatever ranks the game GRANTS at level 1. Asserts a real
   * recommendation at every level and returns the abilities recommended.
   */
  const walk = (m: SkillOrderModel, kit: ChampionKit, upTo: number): string[] => {
    const live: AbilityRanks = { Q: 0, W: 0, E: 0, R: kit.freeRanks.R };
    const out: string[] = [];
    for (let level = 1; level <= upTo; level += 1) {
      const res = resolveNextSkill({ model: m, level, ranks: { ...live } });
      expect(res.kind, `level ${level} → ${res.kind === "none" ? res.because : ""}`).toBe("recommend");
      if (res.kind !== "recommend") break;
      expect(res.atLevel).toBe(level);
      expect(res.unspent).toBe(1);
      expect(res.toRank).toBeLessThanOrEqual(kit.maxRanks[res.ability]);
      live[res.ability] += 1;
      out.push(res.ability);
    }
    return out;
  };

  // ── JAYCE — the champion in the bug report ────────────────────────────────
  const JAYCE_15 = A("QWEQQWQWQWQWWEE");

  it("JAYCE: level 1 with his granted Transform gets a real recommendation", () => {
    // THE REGRESSION, in one assertion. Ranks are Q0 W0 E0 R1 because the game
    // grants Transform at level 1. The old engine computed spent=1, unspent=0
    // and said `no-unspent` — for all 18 levels of every Jayce game.
    const jayce = kitModel(JAYCE_15, KIT.jayce);
    expect(resolveNextSkill({ model: jayce, level: 1, ranks: ranks(0, 0, 0, 1) })).toEqual({
      kind: "recommend",
      ability: "Q",
      fromRank: 0,
      toRank: 1,
      atLevel: 1,
      unspent: 1,
    });
  });

  it("JAYCE: all 18 levels advise, and Q/W/E each reach SIX ranks", () => {
    const jayce = kitModel(JAYCE_15, KIT.jayce);
    expect(jayce.completed).toBe(true);
    const walked = walk(jayce, KIT.jayce, 18);
    expect(walked.join("")).toBe(jayce.order.join(""));
    expect(countRanks(walked as Ability[])).toEqual({ Q: 6, W: 6, E: 6, R: 0 });
  });

  it("JAYCE: ranking Q to 6 is ordinary, not non-standard-kit", () => {
    const jayce = kitModel(JAYCE_15, KIT.jayce);
    // order[10] is 'Q'; the player is on Q5 and the sixth rank is legal.
    expect(jayce.order[10]).toBe("Q");
    expect(resolveNextSkill({ model: jayce, level: 12, ranks: ranks(5, 4, 1, 1) })).toMatchObject({
      ability: "Q",
      fromRank: 5,
      toRank: 6,
    });
  });

  it("JAYCE: R is legal at level 1, and a second R rank is refused", () => {
    // His published order never names R (it costs no point), so an order that
    // DOES is synthetic — labelled as such. It tests the legality rule
    // directly: maxrank 1 means the schedule is [1].
    const synthetic: SkillOrderModel = { ...kitModel(JAYCE_15, KIT.jayce), order: A("RQWE"), completed: true };
    expect(resolveNextSkill({ model: synthetic, level: 1, ranks: ranks(0, 0, 0, 0) })).toMatchObject({
      kind: "recommend",
      ability: "R",
      toRank: 1,
    });
    // Already at his only rank -> capped, never a fabricated rank 2.
    expectNone(resolveNextSkill({ model: synthetic, level: 18, ranks: ranks(0, 0, 0, 1) }), "capped-ability");
  });

  it("JAYCE: a genuinely incoherent reading is still refused", () => {
    const jayce = kitModel(JAYCE_15, KIT.jayce);
    // Seven Q on a six-Q champion — a rank the game could not have granted.
    expectNone(resolveNextSkill({ model: jayce, level: 18, ranks: ranks(7, 1, 1, 1) }), "non-standard-kit");
    // R at 2 when his maxrank is 1.
    expectNone(resolveNextSkill({ model: jayce, level: 18, ranks: ranks(5, 5, 5, 2) }), "non-standard-kit");
  });

  // ── KARMA / ELISE / NIDALEE — the level-1 ultimate, 5/5/5/4 ──────────────
  const LEVEL1_ULT: Array<[string, string, keyof typeof KIT]> = [
    ["KARMA", "QEWQQRQEQEREEWW", "karma"],
    ["NIDALEE", "QEWQQRQEQEREEWW", "nidalee"],
    ["ELISE", "WQEQQRQWQWRWWEE", "elise"],
  ];

  it.each(LEVEL1_ULT)("%s: advises at EVERY level 1-18 despite the granted R rank", (name, path, key) => {
    const kit = KIT[key];
    const m = kitModel(A(path), kit);
    expect(m.completed, name).toBe(true);
    const walked = walk(m, kit, 18);
    expect(walked, name).toHaveLength(18);
    // Three PURCHASED R ranks; the fourth was granted at level 1.
    expect(countRanks(walked as Ability[]).R, name).toBe(3);
  });

  it.each(LEVEL1_ULT)("%s: R is legal at level 1 and reaches rank 4; rank 5 refuses", (name, path, key) => {
    const kit = KIT[key];
    // Synthetic R-first order — their published aggregate never spends a point
    // on R at level 1 (it is free), so this exercises the legality rule.
    const rFirst: SkillOrderModel = { ...kitModel(A(path), kit), order: A("RRRR"), completed: true };

    // Rank 1 at level 1 — the schedule is [1,6,11,16].
    expect(resolveNextSkill({ model: rFirst, level: 1, ranks: ranks(0, 0, 0, 0) }), name).toMatchObject({
      ability: "R",
      toRank: 1,
    });
    // Rank 4 at level 16 is legal for them (a standard champion caps at 3).
    expect(resolveNextSkill({ model: rFirst, level: 16, ranks: ranks(0, 0, 0, 3) }), name).toMatchObject({
      ability: "R",
      fromRank: 3,
      toRank: 4,
    });
    // ...but not before 16.
    expectNone(resolveNextSkill({ model: rFirst, level: 15, ranks: ranks(0, 0, 0, 3) }), "ultimate-illegal");
    // A fifth rank does not exist. Capped, never fabricated.
    expectNone(resolveNextSkill({ model: rFirst, level: 18, ranks: ranks(0, 0, 0, 4) }), "capped-ability");
    // And a live reading claiming rank 5 is incoherent.
    expectNone(resolveNextSkill({ model: rFirst, level: 18, ranks: ranks(0, 0, 0, 5) }), "non-standard-kit");
  });

  // ── UDYR — no true ultimate at all ───────────────────────────────────────
  it("UDYR: his R is a fourth basic — legal at level 1 and at level 2", () => {
    const udyr = kitModel(UDYR_15, KIT.udyr);
    // His published order ranks R at level 2. Previously `ultimate-illegal`.
    expect(udyr.order[1]).toBe("R");
    expect(resolveNextSkill({ model: udyr, level: 2, ranks: ranks(1, 0, 0, 0) })).toMatchObject({
      kind: "recommend",
      ability: "R",
      toRank: 1,
      atLevel: 2,
    });
    // Ungated means ungated: rank 1 at level 1 too.
    const rFirst: SkillOrderModel = { ...udyr, order: A("RQWE"), completed: true };
    expect(resolveNextSkill({ model: rFirst, level: 1, ranks: ranks(0, 0, 0, 0) })).toMatchObject({
      ability: "R",
      toRank: 1,
    });
  });

  it("UDYR: advises at EVERY level 1-18 — the user report that reached 15 and stopped", () => {
    const udyr = kitModel(UDYR_15, KIT.udyr);
    // THE REGRESSION THIS TEST PINS. He has 24 purchasable ranks against 18
    // points, so subtraction alone cannot say which three he skips — and this
    // used to be `completed: false`, which made the panel go permanently dark
    // from level 16 on. The max-priority order resolves it: Q and E are maxed
    // at 15, so the last three points are W's.
    expect(udyr.completed).toBe(true);
    const walked = walk(udyr, KIT.udyr, 18);
    expect(walked).toHaveLength(18);
    expect(walked.slice(0, 15).join("")).toBe(UDYR_15.join(""));
    expect(walked.slice(15).join("")).toBe("WWW");
    expect(countRanks(walked as Ability[])).toEqual({ Q: 6, W: 5, E: 6, R: 1 });
  });

  it("UDYR: `model-incomplete` no longer fires merely because the source stopped at 15", () => {
    // The refusal still EXISTS and is still correct — it is what keeps the
    // overlay silent when a tail genuinely could not be derived. What changed
    // is that "the source published only 15 levels" is no longer sufficient
    // reason for it. A level-16 Udyr now gets a real answer.
    const udyr = kitModel(UDYR_15, KIT.udyr);
    expect(resolveNextSkill({ model: udyr, level: 16, ranks: ranks(6, 2, 6, 1) })).toMatchObject({
      kind: "recommend",
      ability: "W",
      fromRank: 2,
      toRank: 3,
      atLevel: 16,
    });

    // ...and it DOES still fire on a model that really is incomplete. Kha'Zix
    // is the live example: lib/opgg.ts refuses his evolution tokens outright,
    // but a hand-truncated order stands in for any future refusal shape.
    const short: SkillOrderModel = { ...udyr, order: UDYR_15, completed: false, observedLevels: 15 };
    expectNone(resolveNextSkill({ model: short, level: 16, ranks: ranks(6, 2, 6, 1) }), "model-incomplete");
  });

  it("UDYR: a seventh rank is still incoherent", () => {
    const udyr = kitModel(UDYR_15, KIT.udyr);
    expectNone(resolveNextSkill({ model: udyr, level: 18, ranks: ranks(7, 0, 0, 0) }), "non-standard-kit");
  });

  // ── YUUMI / APHELIOS — real ultimate, six-rank basics ────────────────────
  it("YUUMI: Q reaches six ranks while W/E cap at five, and R stays gated at 6/11/16", () => {
    const yuumi = kitModel(A("QEQEQRQEQERQEWW"), KIT.yuumi);
    const walked = walk(yuumi, KIT.yuumi, 15);
    expect(countRanks(walked as Ability[])).toEqual({ Q: 6, W: 2, E: 5, R: 2 });
    // Her ultimate is a true ultimate — no level-1 exception.
    const rFirst: SkillOrderModel = { ...yuumi, order: A("RRR"), completed: true };
    expectNone(resolveNextSkill({ model: rFirst, level: 5, ranks: ranks(0, 0, 0, 0) }), "ultimate-illegal");
    // A sixth W is incoherent for her even though her Q allows six.
    expectNone(resolveNextSkill({ model: yuumi, level: 18, ranks: ranks(0, 6, 0, 0) }), "non-standard-kit");
  });

  it("APHELIOS: Q and E reach six, W caps at six too, R gated normally", () => {
    const aphelios = kitModel(A("QQQEQREQEQEEREW"), KIT.aphelios);
    const walked = walk(aphelios, KIT.aphelios, 15);
    expect(countRanks(walked as Ability[])).toEqual({ Q: 6, W: 1, E: 6, R: 2 });
    expectNone(resolveNextSkill({ model: aphelios, level: 18, ranks: ranks(0, 0, 0, 4) }), "non-standard-kit");
  });

  // ── The unresolved-kit path ──────────────────────────────────────────────
  it("a NULL kit refuses outright rather than assuming 5/5/5/3", () => {
    // "Known non-standard champion, ddragon unreachable." Assuming the
    // standard model here is exactly the wrong answer — it is what produced
    // the blank Jayce — so the refusal is explicit and named.
    const unresolved: SkillOrderModel = { ...model(JAYCE_15), kit: null };
    expectNone(resolveNextSkill({ model: unresolved, level: 1, ranks: ranks(0, 0, 0, 1) }), "unknown-kit");
    // It wins over every other refusal, including ones that would otherwise
    // fire on the same input — we cannot classify a reading we cannot model.
    expectNone(resolveNextSkill({ model: unresolved, level: 99, ranks: ranks(0, 0, 0, 1) }), "unknown-kit");
  });

  it("an ABSENT kit behaves exactly as this function did before kits existed", () => {
    const ahri = model(AHRI_15);
    expect(ahri.kit).toBeUndefined();
    expect(resolveNextSkill({ model: ahri, level: 6, ranks: ranks(3, 1, 1, 0) })).toEqual({
      kind: "recommend",
      ability: "R",
      fromRank: 0,
      toRank: 1,
      atLevel: 6,
      unspent: 1,
    });
    // ...and an explicit standard kit is indistinguishable from its absence.
    const withKit = kitModel(AHRI_15, KIT.ahri);
    expect(resolveNextSkill({ model: withKit, level: 6, ranks: ranks(3, 1, 1, 0) })).toEqual(
      resolveNextSkill({ model: ahri, level: 6, ranks: ranks(3, 1, 1, 0) })
    );
  });

  it("pointsSpent excludes granted ranks — the arithmetic the walks depend on", () => {
    expect(pointsSpent(ranks(0, 0, 0, 1), KIT.jayce)).toBe(0);
    expect(pointsSpent(ranks(6, 6, 6, 1), KIT.jayce)).toBe(18);
    expect(pointsSpent(ranks(0, 0, 0, 1), KIT.karma)).toBe(0);
    expect(pointsSpent(ranks(5, 5, 5, 4), KIT.karma)).toBe(18);
    // No free ranks anywhere else — identical to the pre-kit behaviour.
    expect(pointsSpent(ranks(0, 0, 0, 1), KIT.udyr)).toBe(1);
    expect(pointsSpent(ranks(5, 5, 5, 3))).toBe(18);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// parseLiveSkillState — a NARROWING GUARD, not a wire-format proof.
//
// These cases assert only that the guard rejects what it does not recognise.
// A passing suite here means "this function will not hand a malformed object to
// the resolver." It does NOT mean the field names are right — see this file's
// header. If the real API turns out to nest things differently, every one of
// these still passes and the feature still shows nothing, which is the
// intended failure mode.
// ─────────────────────────────────────────────────────────────────────────────
describe("parseLiveSkillState (guard only — the wire format is ASSUMED, not verified)", () => {
  it("accepts the shape the companion is written to emit", () => {
    expect(parseLiveSkillState({ level: 9, abilities: { Q: 4, W: 2, E: 1, R: 1 } })).toEqual({
      level: 9,
      abilities: { Q: 4, W: 2, E: 1, R: 1 },
    });
  });

  it("drops anything extra rather than passing it through", () => {
    const parsed = parseLiveSkillState({
      level: 3,
      abilities: { Passive: { abilityLevel: 1 }, Q: 2, W: 1, E: 0, R: 0 },
      summonerName: "someone",
    });
    expect(parsed).toEqual({ level: 3, abilities: { Q: 2, W: 1, E: 0, R: 0 } });
  });

  it("rejects a PARTIAL reading outright — never a half-populated snapshot", () => {
    expect(parseLiveSkillState({ level: 9, abilities: { Q: 4, W: 2, E: 1 } })).toBeNull();
    expect(parseLiveSkillState({ abilities: { Q: 0, W: 0, E: 0, R: 0 } })).toBeNull();
    expect(parseLiveSkillState({ level: 9 })).toBeNull();
  });

  it("rejects the shapes a wrong guess about the wire format would produce", () => {
    // If Riot actually nests the rank (it does, as `{abilityLevel: n}` — the
    // companion is what flattens it), an un-flattened payload must NOT be
    // silently coerced into ranks of NaN or 0.
    expect(parseLiveSkillState({ level: 9, abilities: { Q: { abilityLevel: 4 }, W: {}, E: {}, R: {} } })).toBeNull();
    expect(parseLiveSkillState({ level: "9", abilities: { Q: 1, W: 0, E: 0, R: 0 } })).toBeNull();
    expect(parseLiveSkillState({ level: 9, abilities: { Q: "4", W: 0, E: 0, R: 0 } })).toBeNull();
    expect(parseLiveSkillState({ level: 9, abilities: { Q: -1, W: 0, E: 0, R: 0 } })).toBeNull();
    expect(parseLiveSkillState({ level: 9, abilities: { Q: 1.5, W: 0, E: 0, R: 0 } })).toBeNull();
  });

  it("rejects non-objects and the error envelope", () => {
    for (const bad of [null, undefined, 0, "", "no-live", [], { error: "no-live" }]) {
      expect(parseLiveSkillState(bad)).toBeNull();
    }
  });

  it("isLiveSkillError distinguishes the no-game envelope from a reading", () => {
    expect(isLiveSkillError({ error: "no-live" })).toBe(true);
    expect(isLiveSkillError({ level: 1, abilities: { Q: 0, W: 0, E: 0, R: 0 } })).toBe(false);
  });
});
