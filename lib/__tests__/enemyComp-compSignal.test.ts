import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  resolveCompSignal,
  MIN_ENEMIES_FOR_SIGNAL,
  MAX_WPA_COST,
  CC_HEAVY_FLOOR,
} from "@/lib/enemyComp/compSignal";
import { ANTI_HEAL } from "@/lib/enemyComp/counterItems";
import type { ItemsBlock } from "@/lib/types";

// -- Named fixtures, one per data source ------------------------------------
// These are REAL `GET /api/build` captures from production at patch 16.17
// (fixtures/enemycomp/*.json, each carrying its own `_capturedAt` and
// `_source`). A hand-written ItemsBlock would let the fixture supply a shape
// production does not, which is the exact way a green suite outruns the live
// path; the only hand-built inputs here are the enemy id lists.
function fixture(slug: string): ItemsBlock {
  return JSON.parse(readFileSync(`fixtures/enemycomp/${slug}.json`, "utf8")).items as ItemsBlock;
}
const VIKTOR_MID = fixture("viktor-mid");
const URGOT_TOP = fixture("urgot-top");
const THRESH_SUP = fixture("thresh-sup");
const MALPHITE_TOP = fixture("malphite-top");
const LUX_SUP = fixture("lux-sup");

// Enemy comps, by champion id. Ratings come from lib/draft/compRatings.ts.
const THREE_AD = [6, 122, 157]; // Urgot, Darius, Yasuo: ad 3 / ap 0, cc 2.00
const TWO_HEALERS = [16, 350, 8]; // Soraka, Yuumi, Vladimir: ap 3 / ad 0, cc 0.67
const CC_HEAVY = [89, 54, 113, 127]; // Leona, Malphite, Sejuani, Lissandra: cc 3.00
const THREE_AD_LOW_CC = [238, 91, 141]; // Zed, Talon, Kayn: ad 3 / ap 0, cc 1.00

const MERCS = 3111;
const STEELCAPS = 3047;

describe("resolveCompSignal: the four named cases from the plan", () => {
  it("Viktor mid vs 3 AD: refuses, because no armour boot exists in his own data", () => {
    // The honest no-op. Viktor's alts.boots is Ionian / Swifties / Mercury's;
    // Plated Steelcaps is not in his measured data at all, so the AD rule has
    // nothing it is ALLOWED to promote. It must not reach for one.
    expect(resolveCompSignal(THREE_AD, VIKTOR_MID)).toBeNull();
  });

  it("Viktor mid vs a CC comp: refuses on WPA cost, not on availability", () => {
    // Mercury's IS in Viktor's pool, at -1.74 against a chosen Sorcerer's
    // Shoes of +1.46. That is a 3.20 WPA cost, far past the tolerance, and the
    // gate must refuse it. This is the case that proves the tolerance is
    // load-bearing rather than decorative: availability alone is not enough.
    expect(resolveCompSignal(CC_HEAVY, VIKTOR_MID)).toBeNull();
  });

  it("Urgot top vs 2 healers: promotes a magic-resist boot and NEVER an anti-heal item", () => {
    // The comp is three AP champions, two of them healers. What Urgot gets is
    // a magic-resist boot, because that is what his own data offers. He gets
    // no anti-heal item, and cannot: measured across 24 champion-roles, an
    // anti-heal item is reachable for only 9, and Urgot is not one of them.
    const signal = resolveCompSignal(TWO_HEALERS, URGOT_TOP);
    expect(signal).not.toBeNull();
    expect(signal!.rule).toBe("damage-ap");
    expect(signal!.labelSuffix).toBe("vs AP");
    expect(signal!.promotedIds).toEqual([MERCS]);
    for (const id of signal!.promotedIds) expect(ANTI_HEAL.has(id)).toBe(false);
    // Chosen Swifties 2.60, Mercury's 1.73.
    expect(signal!.wpaCost).toBeCloseTo(0.87, 2);
  });

  it("Thresh support vs a CC-heavy comp: promotes Mercury's, and CC wins over damage type", () => {
    // cc aggregates to 3.00 and the comp is also 4-of-4 AP, so BOTH rules
    // could fire and they both point at the same boot. The rule reported must
    // be the CC one: it is the more specific claim, and the label the player
    // reads should name the reason that is actually strongest.
    const signal = resolveCompSignal(CC_HEAVY, THRESH_SUP);
    expect(signal).not.toBeNull();
    expect(signal!.rule).toBe("cc");
    expect(signal!.labelSuffix).toBe("vs CC");
    expect(signal!.promotedIds).toEqual([MERCS]);
    expect(signal!.wpaCost).toBeCloseTo(0.115, 3); // Ionian 1.2648 to Mercury's 1.1497
  });

  it("partial comp: nothing fires below the minimum, and firing is a step not a ramp", () => {
    for (const n of [0, 1, 2]) {
      expect(resolveCompSignal(CC_HEAVY.slice(0, n), THRESH_SUP)).toBeNull();
    }
    expect(MIN_ENEMIES_FOR_SIGNAL).toBe(3);
    expect(resolveCompSignal(CC_HEAVY.slice(0, 3), THRESH_SUP)).not.toBeNull();
  });
});

describe("resolveCompSignal: the AD rule", () => {
  it("Malphite top vs 3 AD assassins promotes Plated Steelcaps", () => {
    const signal = resolveCompSignal(THREE_AD_LOW_CC, MALPHITE_TOP);
    expect(signal).not.toBeNull();
    expect(signal!.rule).toBe("damage-ad");
    expect(signal!.labelSuffix).toBe("vs AD");
    expect(signal!.promotedIds).toEqual([STEELCAPS]);
  });

  it("a split comp does not fire: 2 AD and 2 AP is not a finding", () => {
    // Urgot + Darius (ad), Soraka + Vladimir (ap).
    expect(resolveCompSignal([6, 122, 16, 8], MALPHITE_TOP)).toBeNull();
  });

  it("3 AD with 2 AP does not fire either: the rule needs at most one dissenter", () => {
    expect(resolveCompSignal([6, 122, 157, 16, 8], MALPHITE_TOP)).toBeNull();
  });
});

describe("resolveCompSignal: invariants that must hold for every comp", () => {
  const FIXTURES = { VIKTOR_MID, URGOT_TOP, THRESH_SUP, MALPHITE_TOP, LUX_SUP };
  const COMPS = { THREE_AD, TWO_HEALERS, CC_HEAVY, THREE_AD_LOW_CC };

  it("never promotes an id that is not already in the champion's own situational pool", () => {
    for (const [fname, items] of Object.entries(FIXTURES)) {
      const pool = new Set(
        Object.values(items.alts ?? {})
          .flat()
          .map((p) => p.id)
      );
      for (const [cname, enemies] of Object.entries(COMPS)) {
        const signal = resolveCompSignal(enemies, items);
        if (!signal) continue;
        for (const id of signal.promotedIds) {
          expect(pool.has(id), `${fname} / ${cname} promoted ${id}, not in its pool`).toBe(true);
        }
      }
    }
  });

  it("NEVER promotes an anti-heal item, for any comp on any fixture", () => {
    // The structural form of the 2026-08-29 user decision. A rule that could
    // reach one of these ids is a rule that injects an unmeasured item.
    for (const items of Object.values(FIXTURES)) {
      for (const enemies of Object.values(COMPS)) {
        const signal = resolveCompSignal(enemies, items);
        for (const id of signal?.promotedIds ?? []) expect(ANTI_HEAL.has(id)).toBe(false);
      }
    }
  });

  it("never reports a cost past the tolerance", () => {
    for (const items of Object.values(FIXTURES)) {
      for (const enemies of Object.values(COMPS)) {
        const signal = resolveCompSignal(enemies, items);
        if (signal) expect(signal.wpaCost).toBeLessThanOrEqual(MAX_WPA_COST);
      }
    }
  });

  it("is a pure function of its inputs: repeated calls agree, and it never mutates the items", () => {
    const before = JSON.stringify(THRESH_SUP);
    const a = resolveCompSignal(CC_HEAVY, THRESH_SUP);
    const b = resolveCompSignal(CC_HEAVY, THRESH_SUP);
    expect(a).toEqual(b);
    expect(JSON.stringify(THRESH_SUP)).toBe(before);
  });
});

describe("resolveCompSignal: degradation", () => {
  it("an items block with no alts at all yields null, never a throw", () => {
    const bare: ItemsBlock = { ...VIKTOR_MID, alts: undefined };
    expect(resolveCompSignal(CC_HEAVY, bare)).toBeNull();
  });

  it("duplicate and non-positive enemy ids are normalised away before the minimum is applied", () => {
    // Two real enemies written five ways is still two enemies.
    expect(resolveCompSignal([89, 89, 0, -1, 54], THRESH_SUP)).toBeNull();
  });

  it("caps at five enemies, so a malformed longer list cannot dilute the aggregate", () => {
    const signal = resolveCompSignal([89, 54, 113, 127, 32, 111, 79], THRESH_SUP);
    expect(signal?.evidence.enemiesConsidered).toBeLessThanOrEqual(5);
  });

  it("refuses when most of the comp resolved through the estimated fallback", () => {
    // Ids with no curated rating row. A comp that is mostly guesses is not a
    // finding, and the CC axis it would produce is a fallback vector.
    expect(resolveCompSignal([9001, 9002, 9003], THRESH_SUP)).toBeNull();
  });

  it("exposes the thresholds it used, so a caller can explain the decision", () => {
    expect(CC_HEAVY_FLOOR).toBe(2.2);
    const signal = resolveCompSignal(CC_HEAVY, THRESH_SUP);
    expect(signal!.evidence.enemiesConsidered).toBe(4);
    expect(signal!.evidence.estimatedCount).toBe(0);
    expect(signal!.evidence.ccMean).toBeCloseTo(3.0, 2);
  });
});

describe("resolveCompSignal: the thresholds are load-bearing, not decoration", () => {
  // Two comps that differ by ONE champion and bracket CC_HEAVY_FLOOR from
  // either side, both deliberately damage-neutral (2 AP / 1 AD) so the damage
  // rule cannot fire and confound the result. Annie + Galio are common to
  // both; only the third champion moves.
  const JUST_BELOW = [1, 3, 236]; // Annie, Galio, Lucian: cc 2.000
  const JUST_ABOVE = [1, 3, 238]; // Annie, Galio, Zed:    cc 2.333

  it("does not fire just below the CC floor, and does just above it", () => {
    const below = resolveCompSignal(JUST_BELOW, THRESH_SUP);
    const above = resolveCompSignal(JUST_ABOVE, THRESH_SUP);
    expect(below).toBeNull();
    expect(above).not.toBeNull();
    expect(above!.rule).toBe("cc");
    // The bracket is genuinely tight around the constant, so a change to
    // CC_HEAVY_FLOOR in either direction breaks one of these two.
    expect(below === null && above !== null).toBe(true);
  });

  it("brackets the WPA tolerance with real costs from both sides", () => {
    // Urgot pays 0.87 and is accepted; Viktor would pay 3.20 and is refused.
    // Moving MAX_WPA_COST below 0.87 or above 3.20 breaks one of these.
    expect(resolveCompSignal(TWO_HEALERS, URGOT_TOP)!.wpaCost).toBeLessThan(MAX_WPA_COST);
    expect(resolveCompSignal(CC_HEAVY, VIKTOR_MID)).toBeNull();
  });
});

describe("negative control: with no signal, nothing about the row moves", () => {
  it("the null-signal order is the pre-feature order on every fixture", async () => {
    // The whole feature has to be invisible when no rule fires, which is the
    // overwhelmingly common case. `orderSituationalForComp(pool, [])` must
    // equal the untouched flattened pool, id for id, position for position,
    // on real data rather than on a constructed example.
    const { flattenSituational, orderSituationalForComp, situationalShortlist } = await import(
      "@/components/hextech/situational"
    );
    for (const [name, items] of Object.entries({ VIKTOR_MID, URGOT_TOP, THRESH_SUP, MALPHITE_TOP })) {
      const raw = flattenSituational(items);
      expect(orderSituationalForComp(raw, []).map((p) => p.id), name).toEqual(raw.map((p) => p.id));
      // And the exported window is still exactly what the shop ships today.
      expect(
        orderSituationalForComp(raw, []).slice(0, 6).map((p) => p.id),
        name
      ).toEqual(situationalShortlist(items, []).map((p) => p.id));
    }
  });

  it("a comp that fires still ships the same ITEMS, only reordered", async () => {
    const { flattenSituational, orderSituationalForComp } = await import(
      "@/components/hextech/situational"
    );
    const raw = flattenSituational(THRESH_SUP);
    const signal = resolveCompSignal(CC_HEAVY, THRESH_SUP)!;
    const after = orderSituationalForComp(raw, signal.promotedIds);
    expect(after.map((p) => p.id).sort()).toEqual(raw.map((p) => p.id).sort());
    expect(after.length).toBe(raw.length);
    expect(after[0].id).toBe(3111);
  });
});

describe("the invention guard, proven by the one fixture that can prove it", () => {
  // WHY THIS FIXTURE AND NOT VIKTOR. The "never promotes an id outside the
  // pool" test is worth nothing if some OTHER gate happens to refuse the
  // fabricated item first, and that is exactly what was happening: a mutant
  // that promoted a counter boot whether or not it existed SURVIVED the whole
  // suite, because on Viktor a fabricated pick priced at 0 WPA costs 1.46
  // against his Sorcerer's Shoes and the tolerance gate rejected it. The
  // membership check was never the thing doing the work.
  //
  // Lux support is the case where the two gates come apart. Her pool holds
  // neither Mercury's Treads nor Plated Steelcaps, and her chosen boots sit at
  // just 0.029 WPA, so an invented pick would cost 0.029 and sail through the
  // tolerance. If these return anything but null, the pool-membership check is
  // not real.
  it("refuses when the class is absent, even though the cost would be acceptable", () => {
    expect(LUX_SUP.boots.wpa).toBeLessThan(MAX_WPA_COST); // the premise, asserted
    const pool = new Set(Object.values(LUX_SUP.alts ?? {}).flat().map((p) => p.id));
    expect(pool.has(3111)).toBe(false);
    expect(pool.has(3047)).toBe(false);
    expect(resolveCompSignal(CC_HEAVY, LUX_SUP)).toBeNull();
    expect(resolveCompSignal(THREE_AD_LOW_CC, LUX_SUP)).toBeNull();
    expect(resolveCompSignal(TWO_HEALERS, LUX_SUP)).toBeNull();
  });
});
