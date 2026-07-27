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
import type { Ability, SkillOrderModel } from "@/lib/types";

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

describe("resolveNextSkill — non-standard champions degrade, never mislead", () => {
  it("Udyr: six ranks on a basic -> non-standard-kit", () => {
    const udyr = model(UDYR_15);
    expect(udyr.completed).toBe(false);
    expect(udyr.order).toHaveLength(15);
    // Mid-game, once Q passes the standard cap.
    expectNone(resolveNextSkill({ model: udyr, level: 14, ranks: ranks(6, 1, 4, 1) }), "non-standard-kit");
  });

  it("Udyr: EARLY game, before any cap is exceeded, is caught by ultimate legality", () => {
    // Udyr's published order puts "R" at level 2. His R is really a fourth
    // basic and CAN be ranked there — but we have no way to know that from the
    // data, and League's rule for a real ultimate says level 6. Refusing a
    // correct-for-Udyr recommendation is the right trade: the alternative is a
    // rule that would approve an illegal ultimate rank for every other
    // champion in the game.
    const udyr = model(UDYR_15);
    expectNone(resolveNextSkill({ model: udyr, level: 2, ranks: ranks(1, 0, 0, 0) }), "ultimate-illegal");
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
