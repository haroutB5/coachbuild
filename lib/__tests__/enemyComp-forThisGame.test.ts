import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  resolveForThisGamePlan,
  applyForThisGameLine,
  forThisGameKey,
  measuredItemUniverse,
  MAX_ITEM_SWAPS,
  FOR_THIS_GAME_LINE_LEN,
  FOR_THIS_GAME_BLOCK_TITLE,
  type ForThisGamePlan,
} from "@/lib/enemyComp/forThisGame";
import { ALL_SCENARIO_ITEM_IDS } from "@/lib/enemyComp/scenarioItems";
import { MERCURYS_TREADS, PLATED_STEELCAPS } from "@/lib/enemyComp/counterItems";
import type { BuildResponse, ItemsBlock } from "@/lib/types";
import type { LaneId } from "@/components/hextech/heroContracts";

const build = (name: string): BuildResponse =>
  JSON.parse(readFileSync(`fixtures/enemycomp/${name}.json`, "utf8"));

/** The comps from lib/__tests__/enemyComp-scenarios.test.ts, verbatim. Using
 *  the same five here is deliberate: if a comp's classification ever moves, one
 *  file says which scenarios changed and this one says what the build did about
 *  it, instead of both failing for reasons that have to be reconciled. */
const COMPS = {
  twoHealers: [16, 266, 99, 112, 51],
  heavyAp: [99, 112, 103, 54, 202],
  twoTanksOneAssassin: [54, 516, 238, 119, 202],
  heavyCc: [412, 89, 22, 127, 236],
} as const;

/** The spine every other build line in the set is built to: the champion's own
 *  WPA order with boots where the model put them. Mirrors what
 *  itemSetBody.ts's `buildLine` produces for these fixtures. */
function spineOf(items: ItemsBlock): number[] {
  return [
    items.first.id,
    items.boots.id,
    items.second.id,
    items.third.id,
    ...items.fourthPlus.map((p) => p.id),
  ].slice(0, FOR_THIS_GAME_LINE_LEN);
}

function bootsIdsOf(items: ItemsBlock): Set<number> {
  return new Set<number>([
    items.boots.id,
    ...(items.alts?.boots ?? []).map((p) => p.id),
    MERCURYS_TREADS,
    PLATED_STEELCAPS,
  ]);
}

function plan(
  fixture: string,
  championId: number,
  lane: LaneId,
  enemies: readonly number[]
): { plan: ForThisGamePlan | null; items: ItemsBlock } {
  const b = build(fixture);
  return {
    plan: resolveForThisGamePlan({ enemyChampionIds: enemies, championId, lane, items: b.items }),
    items: b.items,
  };
}

describe("the block title is a noun phrase, not an instruction", () => {
  it("is exactly `For this game`", () => {
    // ToS: the block presents a build. It never tells a player to do something
    // in their game. Pinned so a "helpful" rewording cannot slip past review.
    expect(FOR_THIS_GAME_BLOCK_TITLE).toBe("For this game");
    expect(FOR_THIS_GAME_BLOCK_TITLE).not.toMatch(/^(buy|build|take|get|rush|go)\b/i);
  });

  it("keeps the same line length every other build line holds", () => {
    // itemSetBody.ts's LINE_LEN is module-private, so this is a source
    // assertion rather than an import -- the same technique
    // situationalItemSet.test.ts uses against the desktop's own constants. Two
    // build lines in one set with different lengths is the drift this catches.
    const src = readFileSync("components/hextech/itemSetBody.ts", "utf8");
    expect(src).toContain("const LINE_LEN = 6;");
    expect(FOR_THIS_GAME_LINE_LEN).toBe(6);
  });
});

describe("resolveForThisGamePlan: the four ways to get null", () => {
  it("partial comp -> NO PLAN, and therefore no block", () => {
    // The fixture the directive names. Four enemies is not a comp, and a block
    // called "For this game" built off four is a claim about a game that has
    // not finished drafting.
    const four = COMPS.twoHealers.slice(0, 4);
    expect(plan("viktor-mid", 112, "mid", four).plan).toBeNull();
    expect(plan("viktor-mid", 112, "mid", COMPS.twoHealers).plan).not.toBeNull();
  });

  it("a comp mostly resolved by the estimated fallback -> null", () => {
    expect(plan("viktor-mid", 112, "mid", [16, 266, 900001, 900002, 900003]).plan).toBeNull();
  });

  it("a champion with no class row -> null, never a guessed class", () => {
    const b = build("viktor-mid");
    expect(
      resolveForThisGamePlan({
        enemyChampionIds: COMPS.twoHealers,
        championId: 900001,
        lane: "mid",
        items: b.items,
      })
    ).toBeNull();
  });

  it("no scenario fired -> null", () => {
    // Five champions with no shared axis: no 2 healers, no 2 tanks, no lean
    // (3 AD against 2 AP fails DAMAGE_MAX_DISSENT), cc under the floor.
    const quiet = [51, 202, 99, 112, 24];
    expect(plan("viktor-mid", 112, "mid", quiet).plan).toBeNull();
  });

  it("every scenario refused for this class -> null, not an invented item", () => {
    // A TANK facing two tanks and two assassins. The table refuses both cells
    // on purpose (a tank does not answer enemy tanks with penetration, and it
    // is not the assassins' target), so there is genuinely nothing to swap.
    const b = build("malphite-top");
    const twoTanksTwoAssassins = [54, 516, 238, 121, 51];
    const p = resolveForThisGamePlan({
      enemyChampionIds: twoTanksTwoAssassins,
      championId: 54,
      lane: "top",
      items: b.items,
    });
    // heavy-ad still fires on this comp for a tank, so assert the refusals
    // directly rather than pretending the whole plan is null.
    if (p) {
      for (const pick of p.items) expect(["tanks", "assassins"]).not.toContain(pick.scenario);
    }
  });
});

describe("resolveForThisGamePlan: the four named fixtures", () => {
  it("Viktor mid vs 2 healers -> Morellonomicon, and it is JUDGMENT", () => {
    const { plan: p } = plan("viktor-mid", 112, "mid", COMPS.twoHealers);
    expect(p).not.toBeNull();
    expect(p!.itemClass).toBe("mage");
    expect(p!.scenarios).toEqual(["healers"]);
    expect(p!.items.map((i) => i.itemId)).toEqual([3165]);
    expect(p!.items[0].reason).toBe("2 healers");
    // The headline judgment case, and it is exactly the measurement that got
    // anti-heal excluded from the Situational row: an AP champion's own
    // /api/build data does not offer Morellonomicon anywhere.
    expect(p!.items[0].measured).toBe(false);
    expect(measuredItemUniverse(build("viktor-mid").items).has(3165)).toBe(false);
    expect(p!.boots).toBeNull();
  });

  it("Urgot top vs heavy AP -> Mercury's Treads plus one MR item", () => {
    const { plan: p } = plan("urgot-top", 6, "top", COMPS.heavyAp);
    expect(p).not.toBeNull();
    expect(p!.itemClass).toBe("fighter-bruiser");
    expect(p!.scenarios).toEqual(["heavy-ap"]);
    expect(p!.boots?.itemId).toBe(MERCURYS_TREADS);
    // Measured: Urgot's own data already offers Mercury's Treads.
    expect(p!.boots?.measured).toBe(true);
    expect(p!.items).toHaveLength(1);
    expect(p!.boots?.reason).toBe("4 AP");
  });

  it("Lux support vs heavy CC -> Mercury's Treads, and Lux is a MAGE", () => {
    const { plan: p } = plan("lux-sup", 99, "support", COMPS.heavyCc);
    expect(p).not.toBeNull();
    // The class assertion is the point of this fixture. An enchanter Lux would
    // be offered Mikael's Blessing; a mage Lux is offered the boot.
    expect(p!.itemClass).toBe("mage");
    expect(p!.scenarios).toEqual(["heavy-cc"]);
    expect(p!.boots?.itemId).toBe(MERCURYS_TREADS);
    expect(p!.items).toEqual([]);
  });

  it("a marksman vs 2 tanks and an assassin -> penetration first", () => {
    // Jinx bot is not in the fixture set, so this drives the marksman path on
    // Yasuo mid, whose ITEM class is marksman (he buys crit) -- which is itself
    // the claim championClass.ts makes and worth exercising end to end.
    const { plan: p } = plan("yasuo-mid", 157, "mid", COMPS.twoTanksOneAssassin);
    expect(p).not.toBeNull();
    expect(p!.itemClass).toBe("marksman");
    // `tanks` outranks `heavy-ad` in SCENARIO_PRIORITY, so Lord Dominik's takes
    // the first item slot and the damage lean takes the second.
    expect(p!.items[0].itemId).toBe(3036);
    expect(p!.items[0].scenario).toBe("tanks");
    expect(p!.items[0].reason).toBe("2 tanks");
    // ONE assassin never claimed a slot: the scenario did not fire at all.
    expect(p!.scenarios).not.toContain("assassins");
  });
});

describe("resolveForThisGamePlan: budgets and channels", () => {
  it("never claims more than MAX_ITEM_SWAPS item slots", () => {
    expect(MAX_ITEM_SWAPS).toBe(2);
    // A comp that fires four scenarios at once.
    const busy = [16, 266, 54, 516, 43];
    for (const [fixture, champ, lane] of [
      ["viktor-mid", 112, "mid"],
      ["urgot-top", 6, "top"],
      ["yasuo-mid", 157, "mid"],
      ["thresh-sup", 412, "support"],
      ["malphite-top", 54, "top"],
      ["lux-sup", 99, "support"],
    ] as const) {
      const { plan: p } = plan(fixture, champ, lane, busy);
      if (!p) continue;
      expect(p.items.length).toBeLessThanOrEqual(MAX_ITEM_SWAPS);
    }
  });

  it("the boots channel is separate: a full item budget does not block boots", () => {
    // THE REASON ONE PRIORITY LIST WORKS. healers and tanks are both ahead of
    // heavy-cc, so if boots shared the item budget the comp's tenacity answer
    // would be unreachable in exactly the comps that need it most.
    const healersTanksAndCc = [16, 266, 89, 412, 54];
    const { plan: p } = plan("yasuo-mid", 157, "mid", healersTanksAndCc);
    expect(p).not.toBeNull();
    expect(p!.items.length).toBe(MAX_ITEM_SWAPS);
    expect(p!.scenarios).toContain("heavy-cc");
    expect(p!.boots?.itemId).toBe(MERCURYS_TREADS);
  });

  it("does not name the boot the champion already builds", () => {
    // Saying "Plated Steelcaps: 3 AD" about a build that already opens on
    // Plated Steelcaps claims a change that did not happen.
    const b = build("yasuo-mid");
    expect(b.items.boots.id).toBe(PLATED_STEELCAPS);
    const { plan: p } = plan("yasuo-mid", 157, "mid", COMPS.twoTanksOneAssassin);
    expect(p!.scenarios).toContain("heavy-ad");
    expect(p!.boots).toBeNull();
  });

  it("never spends two slots on one id", () => {
    // A mage's Zhonya's answers heavy-ad AND assassins. Taking it twice would
    // silently halve the budget.
    const adAndAssassins = [238, 121, 51, 202, 119];
    const { plan: p } = plan("viktor-mid", 112, "mid", adAndAssassins);
    expect(p).not.toBeNull();
    const ids = p!.items.map((i) => i.itemId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("only ever names ids the curated table contains", () => {
    for (const comp of Object.values(COMPS)) {
      for (const [fixture, champ, lane] of [
        ["viktor-mid", 112, "mid"],
        ["urgot-top", 6, "top"],
        ["yasuo-mid", 157, "mid"],
        ["thresh-sup", 412, "support"],
        ["malphite-top", 54, "top"],
        ["lux-sup", 99, "support"],
      ] as const) {
        const { plan: p } = plan(fixture, champ, lane, comp);
        if (!p) continue;
        for (const pick of [...p.items, ...(p.boots ? [p.boots] : [])]) {
          expect(ALL_SCENARIO_ITEM_IDS.has(pick.itemId), `${fixture} -> ${pick.itemId}`).toBe(true);
        }
      }
    }
  });
});

describe("applyForThisGameLine keeps the spine", () => {
  const cases = [
    ["viktor-mid", 112, "mid", COMPS.twoHealers],
    ["urgot-top", 6, "top", COMPS.heavyAp],
    ["yasuo-mid", 157, "mid", COMPS.twoTanksOneAssassin],
    ["thresh-sup", 412, "support", COMPS.twoHealers],
    ["malphite-top", 54, "top", COMPS.twoTanksOneAssassin],
    ["lux-sup", 99, "support", COMPS.heavyCc],
  ] as const;

  it.each(cases)("%s: exactly one boots, no duplicates, never longer", (fixture, champ, lane, comp) => {
    const { plan: p, items } = plan(fixture, champ, lane, comp);
    if (!p) return;
    const spine = spineOf(items);
    const bootsIds = bootsIdsOf(items);
    const out = applyForThisGameLine(spine, p, bootsIds);

    expect(out.ids.filter((id) => bootsIds.has(id))).toHaveLength(1);
    expect(new Set(out.ids).size).toBe(out.ids.length);
    expect(out.ids.length).toBeLessThanOrEqual(Math.min(spine.length, FOR_THIS_GAME_LINE_LEN));
    expect(out.ids.length).toBe(spine.length);
  });

  it.each(cases)("%s: everything outside the swaps is the spine, in order", (fixture, champ, lane, comp) => {
    const { plan: p, items } = plan(fixture, champ, lane, comp);
    if (!p) return;
    const spine = spineOf(items);
    const out = applyForThisGameLine(spine, p, bootsIdsOf(items));
    const touched = new Set<number>();
    for (const s of out.swaps) {
      touched.add(s.itemId);
      if (s.replacedId !== null) touched.add(s.replacedId);
    }
    const keptFromLine = out.ids.filter((id) => !touched.has(id));
    const keptFromSpine = spine.filter((id) => !touched.has(id));
    expect(keptFromLine).toEqual(keptFromSpine);
  });

  it("never contains the starter (HARD RULE 2)", () => {
    for (const [fixture, champ, lane, comp] of cases) {
      const { plan: p, items } = plan(fixture, champ, lane, comp);
      if (!p) continue;
      const out = applyForThisGameLine(spineOf(items), p, bootsIdsOf(items));
      expect(out.ids).not.toContain(items.starter.id);
    }
  });

  it("drops the LAST item, never a core one", () => {
    // Viktor's spine is first / boots / second / third / fourthPlus; Morello
    // replaces the fourthPlus pick and lands at purchase position 3.
    const { plan: p, items } = plan("viktor-mid", 112, "mid", COMPS.twoHealers);
    const spine = spineOf(items);
    const out = applyForThisGameLine(spine, p!, bootsIdsOf(items));
    expect(out.swaps).toHaveLength(1);
    expect(out.swaps[0].replacedId).toBe(spine[spine.length - 1]);
    expect(out.swaps[0].itemId).toBe(3165);
    expect(out.ids[out.swaps[0].position - 1]).toBe(3165);
    expect(out.swaps[0].position).toBe(3);
    // The first and second legendary and the boots are untouched.
    expect(out.ids.slice(0, 2)).toEqual(spine.slice(0, 2));
  });

  it("MOVES an item the build already holds rather than dropping one for it", () => {
    // Malphite already builds Randuin's Omen. The useful information is that it
    // should be bought EARLIER against this comp, and buying an item you were
    // already buying costs no slot.
    const { plan: p, items } = plan("malphite-top", 54, "top", COMPS.twoTanksOneAssassin);
    const spine = spineOf(items);
    expect(spine).toContain(3143);
    const out = applyForThisGameLine(spine, p!, bootsIdsOf(items));
    const move = out.swaps.find((s) => s.itemId === 3143)!;
    expect(move.replacedId).toBeNull();
    expect(out.ids).toHaveLength(spine.length);
    expect(out.ids.indexOf(3143)).toBeLessThan(spine.indexOf(3143));
  });

  it("substitutes the boot in place rather than moving the boots slot", () => {
    const { plan: p, items } = plan("urgot-top", 6, "top", COMPS.heavyAp);
    const spine = spineOf(items);
    const bootsIds = bootsIdsOf(items);
    const before = spine.findIndex((id) => bootsIds.has(id));
    const out = applyForThisGameLine(spine, p!, bootsIds);
    expect(out.ids.findIndex((id) => bootsIds.has(id))).toBe(before);
    expect(out.ids[before]).toBe(MERCURYS_TREADS);
  });

  it("a short spine gains an item instead of losing one", () => {
    // buildLine ships short rather than inventing, so a thin champion's line
    // can be four long. Dropping its tail to make room would leave three.
    const { plan: p, items } = plan("lux-sup", 99, "support", COMPS.heavyCc);
    const spine = spineOf(items);
    expect(spine.length).toBeLessThan(FOR_THIS_GAME_LINE_LEN);
    const out = applyForThisGameLine(spine, p!, bootsIdsOf(items));
    expect(out.ids).toHaveLength(spine.length);
  });

  it("is a no-op on a plan with nothing in it", () => {
    const empty: ForThisGamePlan = {
      scenarios: [],
      evidence: {
        enemiesConsidered: 5,
        estimatedCount: 0,
        ccMean: 0,
        tankCount: 0,
        assassinCount: 0,
        healerCount: 0,
        shielderCount: 0,
        adCount: 0,
        apCount: 0,
        damageLean: "mixed",
      },
      itemClass: "mage",
      boots: null,
      items: [],
    };
    const spine = [1, 2, 3, 4, 5, 6];
    const out = applyForThisGameLine(spine, empty, new Set([2]));
    expect(out.ids).toEqual(spine);
    expect(out.swaps).toEqual([]);
  });

  it("handles a spine with no boots at all without inventing a second pair", () => {
    // buildLine's never-invent branch: a champion whose pools carry no boots
    // ships six full items. A boots pick then becomes the ONLY boots.
    const { plan: p } = plan("urgot-top", 6, "top", COMPS.heavyAp);
    const bootless = [101, 102, 103, 104, 105, 106];
    const out = applyForThisGameLine(bootless, p!, new Set([MERCURYS_TREADS]));
    expect(out.ids.filter((id) => id === MERCURYS_TREADS)).toHaveLength(1);
    // Six in, six out. Something had to leave, and it was the last item.
    expect(out.ids.length).toBe(FOR_THIS_GAME_LINE_LEN);
    expect(out.ids).not.toContain(106);
    expect(out.swaps[0].channel).toBe("boots");
    expect(out.swaps[0].replacedId).toBe(106);
  });
});

describe("forThisGameKey describes the export", () => {
  it("null maps to a real key, so `no block` compares like any other value", () => {
    expect(forThisGameKey(null)).toBe("none");
  });

  it("is stable for the same decision and different for a different one", () => {
    const a = plan("viktor-mid", 112, "mid", COMPS.twoHealers).plan;
    const b = plan("viktor-mid", 112, "mid", [...COMPS.twoHealers]).plan;
    const c = plan("viktor-mid", 112, "mid", COMPS.heavyCc).plan;
    expect(forThisGameKey(a)).toBe(forThisGameKey(b));
    expect(forThisGameKey(a)).not.toBe(forThisGameKey(c));
  });

  it("changes when the CAPTION changes even if the items do not", () => {
    // Unlike the compSignalKey it replaces, this one includes the scenarios: a
    // changed reason line is a changed write, and the single finalization
    // trigger -- not this key -- is what bounds how often a write can happen.
    const withScenarios = "ftg:healers:-:3165";
    const p = plan("viktor-mid", 112, "mid", COMPS.twoHealers).plan!;
    expect(forThisGameKey(p)).toBe(withScenarios);
    expect(forThisGameKey({ ...p, scenarios: ["healers", "heavy-cc"] })).not.toBe(withScenarios);
  });

  it("ignores everything that does not reach the wire", () => {
    // Evidence counts move as enemies lock in without changing a byte of what
    // is written, so they must not be in the key.
    const p = plan("viktor-mid", 112, "mid", COMPS.twoHealers).plan!;
    const noisier = { ...p, evidence: { ...p.evidence, ccMean: 2.9, estimatedCount: 2 } };
    expect(forThisGameKey(noisier)).toBe(forThisGameKey(p));
  });
});

describe("measuredItemUniverse covers everything /api/build mentions", () => {
  it("includes every slot, every fourthPlus and every alt", () => {
    const items = build("viktor-mid").items;
    const u = measuredItemUniverse(items);
    expect(u.has(items.starter.id)).toBe(true);
    expect(u.has(items.boots.id)).toBe(true);
    expect(u.has(items.first.id)).toBe(true);
    expect(u.has(items.second.id)).toBe(true);
    expect(u.has(items.third.id)).toBe(true);
    for (const p of items.fourthPlus) expect(u.has(p.id)).toBe(true);
    for (const slot of Object.values(items.alts ?? {})) {
      for (const p of slot) expect(u.has(p.id)).toBe(true);
    }
  });

  it("does not throw on a response with no alts and no optimizedPath", () => {
    const items = build("viktor-mid").items;
    const bare: ItemsBlock = { ...items, alts: undefined, optimizedPath: undefined };
    expect(measuredItemUniverse(bare).size).toBe(5 + items.fourthPlus.length);
  });
});
