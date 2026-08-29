import { describe, it, expect } from "vitest";
import {
  classifyEnemyComp,
  scenarioReason,
  SCENARIO_PRIORITY,
  MIN_ENEMIES_FOR_PLAN,
  TANK_FLOOR,
  DAMAGE_MIN_LEAN,
  DAMAGE_MAX_DISSENT,
  CC_HEAVY_FLOOR,
  type CompScenario,
} from "@/lib/enemyComp/scenarios";
import { CC_HEAVY_FLOOR as TAKEAWAYS_CC_FLOOR } from "@/lib/draft/compTakeaways";
import { COMP_RATINGS } from "@/lib/draft/compRatings";
import { MAX_DRAFT_ENEMIES } from "@/components/live/draftLiveSync";

// The five comps the whole feature is specified against. Each one is a real
// champion id list, chosen so that exactly the intended scenarios fire -- a
// fixture that also trips two neighbouring rules proves much less about the
// rule it was written for.
const COMPS = {
  /** Soraka + Aatrox (heal 3 each), Lux, Viktor, Caitlyn. */
  twoHealers: [16, 266, 99, 112, 51],
  /** Lux, Viktor, Ahri, Malphite (all ap) + Jhin. */
  heavyAp: [99, 112, 103, 54, 202],
  /** Malphite + Ornn (tankiness 3), Zed, Draven, Jhin. */
  twoTanksOneAssassin: [54, 516, 238, 119, 202],
  /** Thresh, Leona, Ashe, Lissandra (cc 3 each) + Lucian. */
  heavyCc: [412, 89, 22, 127, 236],
  /** Karma, Lulu, Janna, Morgana, Renata -- shield 3 across the board. */
  shielders: [43, 117, 40, 25, 888],
} as const;

describe("classifyEnemyComp refuses rather than guessing", () => {
  it("needs a FULL comp: four enemies is null", () => {
    expect(classifyEnemyComp(COMPS.twoHealers.slice(0, 4))).toBeNull();
    expect(classifyEnemyComp(COMPS.twoHealers)).not.toBeNull();
  });

  it("MIN_ENEMIES_FOR_PLAN is the draft cap, not a second number", () => {
    // If these ever diverge, the block can be built from a comp the enemy
    // picker itself considers incomplete.
    expect(MIN_ENEMIES_FOR_PLAN).toBe(MAX_DRAFT_ENEMIES);
    expect(MIN_ENEMIES_FOR_PLAN).toBe(5);
  });

  it("normalises through draftLiveSync: duplicates and junk do not pad the comp", () => {
    // Four real enemies plus a duplicate and a zero is still four enemies.
    expect(classifyEnemyComp([16, 266, 99, 112, 16, 0, -3])).toBeNull();
  });

  it("refuses a comp it is mostly guessing at", () => {
    // Three unknown ids of five resolve through compRatings' estimated
    // fallback, so the cc axis is mostly a guess and the whole read is refused.
    expect(classifyEnemyComp([16, 266, 900001, 900002, 900003])).toBeNull();
    // Two of five estimated still classifies -- strictly more than half.
    expect(classifyEnemyComp([16, 266, 99, 900002, 900003])).not.toBeNull();
  });

  it("never throws on an unrecognised enemy", () => {
    expect(() => classifyEnemyComp([900001, 900002, 900003, 900004, 900005])).not.toThrow();
  });
});

describe("classifyEnemyComp scenario fixtures", () => {
  it("two healers, and nothing else", () => {
    const c = classifyEnemyComp(COMPS.twoHealers)!;
    expect(c.scenarios).toEqual(["healers"]);
    expect(c.evidence.healerCount).toBe(2);
    expect(c.evidence.damageLean).toBe("mixed");
  });

  it("heavy AP, and the damage lean is reported as ap", () => {
    const c = classifyEnemyComp(COMPS.heavyAp)!;
    expect(c.scenarios).toEqual(["heavy-ap"]);
    expect(c.evidence.apCount).toBe(4);
    expect(c.evidence.adCount).toBe(1);
    expect(c.evidence.damageLean).toBe("ap");
  });

  it("two tanks and a lone assassin: tanks fires, assassins does not", () => {
    const c = classifyEnemyComp(COMPS.twoTanksOneAssassin)!;
    expect(c.scenarios).toEqual(["tanks", "heavy-ad"]);
    expect(c.evidence.tankCount).toBe(2);
    // ONE assassin is not a scenario. The floor is 2 on every kit axis and this
    // is the fixture that proves a single threat does not move the build.
    expect(c.evidence.assassinCount).toBe(1);
    expect(c.scenarios).not.toContain("assassins");
  });

  it("heavy CC, on the draft page's own floor", () => {
    const c = classifyEnemyComp(COMPS.heavyCc)!;
    expect(c.scenarios).toEqual(["heavy-cc"]);
    expect(c.evidence.ccMean).toBeGreaterThanOrEqual(CC_HEAVY_FLOOR);
  });

  it("shielders are counted separately from healers", () => {
    const c = classifyEnemyComp(COMPS.shielders)!;
    expect(c.scenarios).toContain("shielders");
    expect(c.evidence.shielderCount).toBe(5);
    // The whole reason the user's single "healers/shielders" axis is split:
    // this comp shields constantly and barely heals, and the two are answered
    // by completely different items.
    expect(c.evidence.healerCount).toBeLessThan(2);
    expect(c.scenarios).not.toContain("healers");
  });

  it("returns scenarios in SCENARIO_PRIORITY order, always", () => {
    for (const comp of Object.values(COMPS)) {
      const c = classifyEnemyComp(comp);
      if (!c) continue;
      const positions = c.scenarios.map((s) => SCENARIO_PRIORITY.indexOf(s));
      expect(positions).toEqual([...positions].sort((a, b) => a - b));
    }
  });
});

describe("the shared axes are shared, not copied", () => {
  it("CC_HEAVY_FLOOR is compTakeaways' constant, re-exported", () => {
    // A second 2.2 living here would let the draft page say "Heavy CC" while
    // this block silently disagreed about the same comp.
    expect(CC_HEAVY_FLOOR).toBe(TAKEAWAYS_CC_FLOOR);
  });

  it("TANK_FLOOR sits at compRatings' own top rubric band", () => {
    expect(TANK_FLOOR).toBe(3);
    // And the band is populated: dropping to 2 would admit champions who buy
    // damage, which is what the constant's comment claims.
    const atThree = Object.values(COMP_RATINGS).filter((r) => r.tankiness >= 3).length;
    const atTwo = Object.values(COMP_RATINGS).filter((r) => r.tankiness >= 2).length;
    expect(atThree).toBeGreaterThan(10);
    expect(atTwo).toBeGreaterThan(atThree * 1.5);
    // Aatrox and Renekton are the named false positives at 2.
    expect(COMP_RATINGS[266].tankiness).toBe(2);
    expect(COMP_RATINGS[58].tankiness).toBe(2);
  });

  it("the damage rule needs a majority AND near-unanimity", () => {
    expect(DAMAGE_MIN_LEAN).toBe(3);
    expect(DAMAGE_MAX_DISSENT).toBe(1);
    // A 3-2 split is not a finding. Soraka/Lux/Viktor ap vs Caitlyn/Jhin ad.
    const c = classifyEnemyComp([16, 99, 112, 51, 202])!;
    expect(c.evidence.apCount).toBe(3);
    expect(c.evidence.adCount).toBe(2);
    expect(c.evidence.damageLean).toBe("mixed");
    expect(c.scenarios).not.toContain("heavy-ap");
    expect(c.scenarios).not.toContain("heavy-ad");
  });

  it("heavy-ad and heavy-ap can never both fire, so their order is unobservable", () => {
    // Asserted rather than assumed: DAMAGE_MAX_DISSENT < DAMAGE_MIN_LEAN is
    // what makes the two mutually exclusive on a five-champion comp, and the
    // priority list's comment leans on exactly that.
    expect(DAMAGE_MAX_DISSENT).toBeLessThan(DAMAGE_MIN_LEAN);
    for (const comp of Object.values(COMPS)) {
      const c = classifyEnemyComp(comp);
      if (!c) continue;
      const both = c.scenarios.includes("heavy-ad") && c.scenarios.includes("heavy-ap");
      expect(both).toBe(false);
    }
  });
});

describe("scenarioReason carries the number, not just the category", () => {
  it("names every scenario with its own count", () => {
    const c = classifyEnemyComp(COMPS.twoTanksOneAssassin)!;
    expect(scenarioReason("tanks", c.evidence)).toBe("2 tanks");
    expect(scenarioReason("heavy-ad", c.evidence)).toBe("3 AD");
  });

  it("is total over CompScenario -- every member returns a non-empty string", () => {
    const c = classifyEnemyComp(COMPS.heavyCc)!;
    for (const s of SCENARIO_PRIORITY) {
      const reason = scenarioReason(s as CompScenario, c.evidence);
      expect(typeof reason).toBe("string");
      expect(reason.length).toBeGreaterThan(0);
    }
  });

  it("prints the cc mean rather than asserting the category bare", () => {
    const c = classifyEnemyComp(COMPS.heavyCc)!;
    expect(scenarioReason("heavy-cc", c.evidence)).toBe("heavy CC (2.4)");
  });
});

describe("ToS: champ-select ids only", () => {
  it("classification is a pure function of champion ids and nothing else", () => {
    // Same ids, same answer, forever -- no clock, no storage, no fetch. If this
    // ever stops holding, something outside champ select has reached in.
    const a = classifyEnemyComp(COMPS.heavyAp);
    const b = classifyEnemyComp([...COMPS.heavyAp]);
    expect(a).toEqual(b);
  });
});
