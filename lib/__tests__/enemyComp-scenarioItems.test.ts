import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { deriveCounterItems } from "@/scripts/derive-enemycomp-tables.mjs";
import {
  CLASS_SCENARIO_ITEMS,
  ALL_SCENARIO_ITEM_IDS,
  itemCandidates,
  chooseCandidate,
  type ScenarioCandidate,
} from "@/lib/enemyComp/scenarioItems";
import {
  ANTI_HEAL,
  MERCURYS_TREADS,
  PLATED_STEELCAPS,
  MAGIC_RESIST_BOOTS,
  ARMOR_BOOTS,
} from "@/lib/enemyComp/counterItems";
import { SCENARIO_PRIORITY, type CompScenario } from "@/lib/enemyComp/scenarios";
import type { ChampionItemClass } from "@/lib/enemyComp/championClass";

const CATALOGUE = JSON.parse(readFileSync("fixtures/enemycomp/catalogue-items-16.17.1.json", "utf8"));
const ITEMS = CATALOGUE.data as Record<
  string,
  { name: string; tags?: string[]; maps?: Record<string, boolean>; gold?: { purchasable?: boolean } }
>;

const CLASSES = Object.keys(CLASS_SCENARIO_ITEMS) as ChampionItemClass[];

describe("every id the table names is a real 16.17.1 item", () => {
  it.each([...ALL_SCENARIO_ITEM_IDS].sort((a, b) => a - b))("%i exists and is purchasable on SR", (id) => {
    const entry = ITEMS[String(id)];
    expect(entry, `id ${id} is not in the captured catalogue`).toBeDefined();
    // The same three clauses derive-enemycomp-tables.mjs uses, for the same
    // measured reason: maps["11"] alone admits mode variants (323075, 323222,
    // 663172), so id < 10000 is required too.
    expect(id).toBeLessThan(10000);
    expect(entry.maps?.["11"]).toBe(true);
    expect(entry.gold?.purchasable).toBe(true);
  });

  it("names no id twice under one class -- a duplicate would fill a slot with itself", () => {
    for (const cls of CLASSES) {
      const seen = new Map<number, CompScenario[]>();
      for (const [scenario, candidate] of Object.entries(CLASS_SCENARIO_ITEMS[cls]) as [
        CompScenario,
        ScenarioCandidate,
      ][]) {
        for (const list of [candidate.boots, candidate.any, candidate.ad, candidate.ap]) {
          for (const id of list ?? []) {
            const dupes = seen.get(id) ?? [];
            // The same id may legitimately answer two DIFFERENT scenarios (a
            // mage's Zhonya's answers both heavy-ad and assassins). What must
            // not happen is the same id twice inside ONE candidate list.
            seen.set(id, [...dupes, scenario]);
          }
        }
        for (const list of [candidate.boots, candidate.any, candidate.ad, candidate.ap]) {
          if (!list) continue;
          expect(new Set(list).size, `${cls}/${scenario} repeats an id`).toBe(list.length);
        }
      }
    }
  });
});

describe("the table's anti-heal entries are still anti-heal upstream", () => {
  it("every anti-heal id it names is in the DERIVED set", async () => {
    // The load-bearing check. counterItems.ts's ANTI_HEAL is derived from the
    // catalogue's own description text, and this asserts the curated table
    // never drifts off it -- so a Riot keyword rename fails the build instead
    // of quietly recommending an item that no longer applies Wounds.
    const derived = await deriveCounterItems(CATALOGUE);
    const derivedSet = new Set(derived.antiHeal);
    expect([...ANTI_HEAL].filter((id) => !derivedSet.has(id))).toEqual([]);

    // Morellonomicon, Mortal Reminder, Chempunk Chainsword and Thornmail are
    // the four the table actually uses.
    for (const id of [3165, 3033, 6609, 3075]) {
      expect(ALL_SCENARIO_ITEM_IDS.has(id), `${id} should be reachable from the table`).toBe(true);
      expect(ANTI_HEAL.has(id), `${id} should be a pinned anti-heal id`).toBe(true);
      expect(derivedSet.has(id), `${id} should still read as anti-heal upstream`).toBe(true);
    }
  });

  it("every class has an answer to two healers", () => {
    // The one scenario with no refusals: an unanswered healers comp is the case
    // the user's directive names first, and there is a real item for all six.
    for (const cls of CLASSES) {
      const cell = CLASS_SCENARIO_ITEMS[cls].healers;
      expect(cell, `${cls} has no answer to healers`).toBeDefined();
      const ids = [...(cell!.any ?? []), ...(cell!.ad ?? []), ...(cell!.ap ?? [])];
      expect(ids.length).toBeGreaterThan(0);
      for (const id of ids) expect(ANTI_HEAL.has(id), `${cls} healers -> ${id}`).toBe(true);
    }
  });
});

describe("the boots answers stay guarded by the catalogue derivation", () => {
  it("the two named boot ids are members of the derived boot classes", () => {
    expect(MAGIC_RESIST_BOOTS.has(MERCURYS_TREADS)).toBe(true);
    expect(ARMOR_BOOTS.has(PLATED_STEELCAPS)).toBe(true);
    expect(MERCURYS_TREADS).toBe(3111);
    expect(PLATED_STEELCAPS).toBe(3047);
  });

  it("boots appear on exactly the three scenarios that have a boots answer", () => {
    const withBoots = new Set<CompScenario>();
    for (const cls of CLASSES) {
      for (const [scenario, candidate] of Object.entries(CLASS_SCENARIO_ITEMS[cls]) as [
        CompScenario,
        ScenarioCandidate,
      ][]) {
        if (candidate.boots) withBoots.add(scenario);
      }
    }
    expect([...withBoots].sort()).toEqual(["heavy-ad", "heavy-ap", "heavy-cc"]);
  });

  it("never offers a tier-3 boot enchant as the comp answer", () => {
    // The decision is WHICH BOOT. An enchant is a later upgrade of whichever
    // boot you took, not a different reading of the comp, and offering one
    // would silently raise the price of the swap.
    for (const cls of CLASSES) {
      for (const candidate of Object.values(CLASS_SCENARIO_ITEMS[cls]) as ScenarioCandidate[]) {
        for (const id of candidate.boots ?? []) {
          expect([MERCURYS_TREADS, PLATED_STEELCAPS]).toContain(id);
        }
      }
    }
  });

  it("heavy-cc and heavy-ap converge on the SAME boot, by construction", () => {
    // Riot ships one defensive boot per damage type, so the two rules cannot
    // disagree here. That convergence is why the priority order between them
    // only ever matters for the reason STRING, never for the item.
    for (const cls of CLASSES) {
      const cc = CLASS_SCENARIO_ITEMS[cls]["heavy-cc"]?.boots;
      const ap = CLASS_SCENARIO_ITEMS[cls]["heavy-ap"]?.boots;
      expect(cc).toEqual(ap);
    }
  });
});

describe("itemCandidates resolves against OUR OWN damage type", () => {
  it("prefers `any` over the damage-typed lists", () => {
    const cell: ScenarioCandidate = { any: [1], ad: [2], ap: [3] };
    expect(itemCandidates(cell, "ad")).toEqual([1]);
    expect(itemCandidates(cell, "ap")).toEqual([1]);
    expect(itemCandidates(cell, "mixed")).toEqual([1]);
  });

  it("splits ad and ap where the answer genuinely differs", () => {
    // An assassin facing two tanks: Zed buys Serylda's, Akali buys Void Staff.
    const cell = CLASS_SCENARIO_ITEMS.assassin.tanks!;
    expect(itemCandidates(cell, "ad")[0]).toBe(6694);
    expect(itemCandidates(cell, "ap")[0]).toBe(3135);
  });

  it("a MIXED champion reaches only `any`, and gets nothing when there is none", () => {
    // damageType.ts's honest third answer. Guessing which half of Corki's or
    // Ornn's damage matters would be a fabrication, so the cell refuses.
    const cell = CLASS_SCENARIO_ITEMS.assassin.tanks!;
    expect(itemCandidates(cell, "mixed")).toEqual([]);
    expect(chooseCandidate(itemCandidates(cell, "mixed"), new Set())).toBeNull();
  });

  it("an absent cell is a refusal, not a crash", () => {
    expect(itemCandidates(undefined, "ad")).toEqual([]);
    expect(CLASS_SCENARIO_ITEMS.tank.tanks).toBeUndefined();
    expect(CLASS_SCENARIO_ITEMS.mage.shielders).toBeUndefined();
    expect(CLASS_SCENARIO_ITEMS.marksman.shielders).toBeUndefined();
  });

  it("every cell that exists names at least one id in some channel", () => {
    for (const cls of CLASSES) {
      for (const [scenario, candidate] of Object.entries(CLASS_SCENARIO_ITEMS[cls]) as [
        CompScenario,
        ScenarioCandidate,
      ][]) {
        const total =
          (candidate.boots?.length ?? 0) +
          (candidate.any?.length ?? 0) +
          (candidate.ad?.length ?? 0) +
          (candidate.ap?.length ?? 0);
        expect(total, `${cls}/${scenario} is an empty cell -- delete it instead`).toBeGreaterThan(0);
      }
    }
  });

  it("names no scenario outside CompScenario", () => {
    const known = new Set<string>(SCENARIO_PRIORITY);
    for (const cls of CLASSES) {
      for (const scenario of Object.keys(CLASS_SCENARIO_ITEMS[cls])) {
        expect(known.has(scenario), `${cls} names unknown scenario ${scenario}`).toBe(true);
      }
    }
  });
});

describe("chooseCandidate prefers the measured, falls back to the curated", () => {
  it("takes the first candidate the champion's own data already offers", () => {
    // Not the first in the list: the SECOND, because the first is not in the
    // champion's universe. This is the whole selection rule.
    expect(chooseCandidate([3135, 3137], new Set([3137, 9999]))).toEqual({
      itemId: 3137,
      measured: true,
    });
  });

  it("takes the head of the list when the universe offers none, and SAYS so", () => {
    // The branch that makes this block JUDGMENT rather than MEASURED. It is
    // reported on the result, not hidden.
    expect(chooseCandidate([3135, 3137], new Set([9999]))).toEqual({
      itemId: 3135,
      measured: false,
    });
  });

  it("prefers an earlier measured candidate over a later one", () => {
    expect(chooseCandidate([3135, 3137], new Set([3135, 3137]))).toEqual({
      itemId: 3135,
      measured: true,
    });
  });

  it("returns null for an empty list rather than inventing an item", () => {
    expect(chooseCandidate([], new Set([3135]))).toBeNull();
  });
});
