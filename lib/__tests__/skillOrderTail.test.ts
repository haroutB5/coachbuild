// ─────────────────────────────────────────────────────────────────────────────
// The INFERRED tail (user directive 2026-07-29 — a recommended skill order must
// always read as a full 18 levels, like every reference site).
//
// Kept in its own file rather than appended to skillOrderModel.test.ts because
// it pins a different property: not "is the derivation right" but "does the
// GUESS stay quarantined". Inference must NEVER touch `order`, `levels`,
// `completed`, `observedLevels` or `completionBasis` — everything downstream of
// those, above all lib/nextSkill.ts's live in-game refusal past level 15, has
// to be provably unaffected by this feature existing.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import {
  buildSkillOrderModel,
  countRanks,
  inferSkillOrderTail,
  levelsByAbility,
  observedLevelCount,
  SOURCE_LEVELS,
  STANDARD_KIT,
  TOTAL_LEVELS,
  type Ability,
} from "@/lib/skillOrderModel";
import { kitFromMaxRanks } from "@/lib/championKit";
import type { ChampionKit } from "@/lib/types";

const A = (s: string): Ability[] => s.split("") as Ability[];

/** Ahri mid, verbatim from op.gg 2026-07-27 — the clean, determinate case. */
const AHRI_15 = A("WQEQQRQWQWRWWEE");
/** Udyr jungle, verbatim. Q and E hit SIX ranks; "R" ranked at level 2. */
const UDYR_15 = A("QRWEQQQEQEQEEEW");
/** Udyr's caps: four basics, no true ultimate, 24 purchasable ranks against 18
 *  points. The canonical surplus kit. */
const UDYR_KIT = kitFromMaxRanks([6, 6, 6, 6])!;

describe("inferSkillOrderTail", () => {
  it("fills the gap to 18 from a PUBLISHED priority, respecting the caps", () => {
    // Udyr's live 15 plus his published ids. Q and E are already maxed at 6, so
    // W (4 spare) takes all three tail points.
    const got = inferSkillOrderTail(UDYR_15, A("QEWR"), UDYR_KIT);
    expect(got).not.toBeNull();
    expect(got!.tail).toEqual(A("WWW"));
    expect(got!.basis).toBe("published");
  });

  it("falls back to the DERIVED priority and reports that basis honestly", () => {
    const got = inferSkillOrderTail(UDYR_15, undefined, UDYR_KIT);
    expect(got).not.toBeNull();
    expect(got!.basis).toBe("derived");
    // A derived priority can never name R (it sorts Q/W/E only), so only spare
    // basic ranks are reachable. That blindness is precisely why the basis is
    // reported rather than assumed — see resolveAllocationPriority's header.
    expect(got!.tail.every((a) => a !== "R")).toBe(true);
  });

  it("never exceeds the champion's own rank caps", () => {
    const got = inferSkillOrderTail(UDYR_15, A("QEWR"), UDYR_KIT)!;
    const counts = countRanks([...UDYR_15, ...got.tail]);
    for (const ability of A("QWER")) {
      expect(counts[ability]).toBeLessThanOrEqual(UDYR_KIT.maxRanks[ability]);
    }
  });

  it("takes an ultimate rank the schedule opens up in the tail FIRST (level 16)", () => {
    // Ahri by level 15 has spent two R ranks; the third is legal only at 16.
    const got = inferSkillOrderTail(AHRI_15, A("QWE"), STANDARD_KIT)!;
    expect(got.tail[0]).toBe("R");
  });

  it("returns null when there is nothing to infer (already 18 levels)", () => {
    expect(inferSkillOrderTail([...AHRI_15, ...A("REE")], A("QWE"), STANDARD_KIT)).toBeNull();
  });

  it("returns null on a bad token rather than guessing around it", () => {
    // Kha'Zix's `R-Q`/`R-W` shape. lib/opgg.ts already rejects that payload
    // upstream, so this is the belt-and-braces half of the same refusal.
    const bad = [...A("QWE"), "R-Q"] as unknown as Ability[];
    expect(inferSkillOrderTail(bad, A("QWE"), STANDARD_KIT)).toBeNull();
  });

  it("returns null on an empty order", () => {
    expect(inferSkillOrderTail([], A("QWE"), STANDARD_KIT)).toBeNull();
  });

  it("returns a SHORT tail rather than breaking a cap when nothing is left", () => {
    // THE BOUNDARY CASE the tail-inference path exists to handle honestly: a
    // synthetic kit with only 16 purchasable ranks. 15 are spent, one is spare,
    // and two levels genuinely cannot be filled — so the grid leaves them
    // blank rather than emitting a path the game would not allow.
    const tinyKit: ChampionKit = {
      maxRanks: { Q: 6, W: 5, E: 5, R: 0 },
      freeRanks: { Q: 0, W: 0, E: 0, R: 0 },
      ultimateLevels: null,
      purchasableTotal: 16,
    };
    const observed = A("QQQQQWWWWWEEEEE"); // Q5 W5 E5 = 15, one Q rank spare
    const got = inferSkillOrderTail(observed, A("QWE"), tinyKit)!;
    expect(got.tail).toEqual(A("Q"));
    expect(got.tail.length).toBeLessThan(TOTAL_LEVELS - observed.length);
  });

  it("still answers for an observed path that already BROKE a cap", () => {
    // `rank-over-cap` is a completion refusal; inference must not inherit it.
    // The over-cap ability simply has nothing left to give.
    const observed = A("QQQQQQWWWWWEEEE"); // Q six times under a 5-cap
    const got = inferSkillOrderTail(observed, A("QWE"), STANDARD_KIT);
    expect(got).not.toBeNull();
    expect(got!.tail).not.toContain("Q");
  });
});

describe("buildSkillOrderModel — inferred tail wiring", () => {
  const src = (order: Ability[], priorityIds?: Ability[]) => ({
    order,
    priorityIds,
    play: 1000,
    win: 500,
    pickRate: 0.4,
  });

  it("attaches inferredTail ONLY when the derivation refused", () => {
    const ahri = buildSkillOrderModel(src(AHRI_15, A("QWE")), STANDARD_KIT)!;
    expect(ahri.completed).toBe(true);
    expect(ahri.inferredTail).toBeUndefined();
    expect(ahri.inferredBasis).toBeUndefined();
  });

  it("attaches it on a refusal, and leaves `order` and its provenance untouched", () => {
    // A surplus kit with NO published priority → `kit-not-derivable`.
    const model = buildSkillOrderModel(src(UDYR_15), UDYR_KIT)!;
    expect(model.completed).toBe(false);
    expect(model.order).toEqual(UDYR_15);
    expect(model.order.length).toBe(SOURCE_LEVELS);
    expect(observedLevelCount(model)).toBe(SOURCE_LEVELS);
    expect(model.completionBasis).toBeUndefined();
    expect(model.inferredTail).toHaveLength(TOTAL_LEVELS - SOURCE_LEVELS);
    expect(model.inferredBasis).toBe("derived");
  });

  it("order + inferredTail reconstructs a full 18 levels", () => {
    const model = buildSkillOrderModel(src(UDYR_15), UDYR_KIT)!;
    expect([...model.order, ...(model.inferredTail ?? [])]).toHaveLength(TOTAL_LEVELS);
  });

  it("NEVER infers when the kit is null — the caps it would need are what is missing", () => {
    // `kit: null` means "known non-standard champion, ddragon unresolved".
    // Inferring under STANDARD_KIT there is the blank-Jayce bug's wrong
    // arithmetic wearing a different hat.
    const model = buildSkillOrderModel(src(UDYR_15, A("QEWR")), null)!;
    expect(model.completed).toBe(false);
    expect(model.inferredTail).toBeUndefined();
    expect(model.inferredBasis).toBeUndefined();
  });

  it("leaves `levels` derived from `order` alone, so no consumer sees a guess by accident", () => {
    const model = buildSkillOrderModel(src(UDYR_15), UDYR_KIT)!;
    expect(model.levels).toEqual(levelsByAbility(model.order));
    for (const ability of A("QWER")) {
      for (const lvl of model.levels[ability]) expect(lvl).toBeLessThanOrEqual(SOURCE_LEVELS);
    }
  });

  it("an already-18 order gets no inferred tail", () => {
    const model = buildSkillOrderModel(src([...AHRI_15, ...A("REE")], A("QWE")), STANDARD_KIT)!;
    expect(model.completed).toBe(false); // the `already-complete` refusal
    expect(model.inferredTail).toBeUndefined();
  });
});
