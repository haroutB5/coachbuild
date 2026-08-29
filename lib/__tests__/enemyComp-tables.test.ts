import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  deriveCounterItems,
  deriveDamageBaseline,
  DAMAGE_MARGIN,
} from "@/scripts/derive-enemycomp-tables.mjs";
import {
  MAGIC_RESIST_BOOTS,
  ARMOR_BOOTS,
  ANTI_HEAL,
  counterBootsClass,
  isAntiHeal,
} from "@/lib/enemyComp/counterItems";
import {
  CHAMPION_DAMAGE_TYPE,
  DAMAGE_TYPE_CORRECTIONS,
  getDamageType,
} from "@/lib/enemyComp/damageType";

// The catalogue the derivation runs against. Captured, reduced to the fields
// the derivation reads, and UNFILTERED: every entry is kept, so the derivation
// sees the same candidate space the live catalogue offers and cannot pass by
// having been handed a pre-narrowed set.
const items = JSON.parse(readFileSync("fixtures/enemycomp/catalogue-items-16.16.1.json", "utf8"));
const champs = JSON.parse(
  readFileSync("fixtures/enemycomp/catalogue-champions-16.16.1.json", "utf8")
);

describe("counterItems.ts is the derivation, pinned", () => {
  it("matches scripts/derive-enemycomp-tables.mjs run against the captured catalogue", async () => {
    // THE POINT OF THIS TEST. The tables are ids in source rather than a
    // runtime regex, so the failure mode they replace (upstream renames a
    // keyword, a whole class silently empties) has to be caught somewhere.
    // Here. When Riot changes the wording again this goes red instead of the
    // feature going quiet.
    const derived = await deriveCounterItems(items);
    expect([...MAGIC_RESIST_BOOTS].sort((a, b) => a - b)).toEqual(derived.tenacityBoots);
    expect([...ARMOR_BOOTS].sort((a, b) => a - b)).toEqual(derived.armorBoots);
    expect([...ANTI_HEAL].sort((a, b) => a - b)).toEqual(derived.antiHeal);
  });

  it('finds the anti-heal items that say "Wounds" and not "Grievous Wounds"', () => {
    // The measured trap, kept as a test because it is not obvious and it cost
    // real time: on Summoner's Rift, Thornmail and Chempunk Chainsword read
    // "apply 40% Wounds". Only their Arena variants spell it out in full, so a
    // /Grievous Wounds/ classifier finds Mortal Reminder and Morellonomicon
    // and misses half the class with no error anywhere.
    expect(isAntiHeal(3075)).toBe(true); // Thornmail
    expect(isAntiHeal(6609)).toBe(true); // Chempunk Chainsword
    expect(items.data["3075"].description).toMatch(/\bWounds\b/i);
    expect(items.data["3075"].description).not.toMatch(/Grievous Wounds/i);
  });

  it("excludes mode variants, which carry maps.11 and are not Summoner's Rift items", () => {
    // The second measured trap. 323075 (Thornmail), 323222 (Mikael's) and
    // 663172 (Zephyr) all set maps["11"], so maps alone is not a filter and
    // id < 10000 is required too.
    for (const variant of [223075, 226609, 323075, 323222, 663172]) {
      expect(ANTI_HEAL.has(variant)).toBe(false);
      expect(MAGIC_RESIST_BOOTS.has(variant)).toBe(false);
      expect(ARMOR_BOOTS.has(variant)).toBe(false);
    }
    expect(items.data["323075"]?.maps["11"]).toBe(true); // the trap is real
  });

  it("classifies boots fail-closed: an unknown id is not a counter boot", () => {
    expect(counterBootsClass(3111)).toBe("magic-resist");
    expect(counterBootsClass(3047)).toBe("armor");
    expect(counterBootsClass(3020)).toBeNull(); // Sorcerer's Shoes: offensive
    expect(counterBootsClass(999999)).toBeNull();
  });

  it("keeps the two boot classes disjoint", () => {
    for (const id of MAGIC_RESIST_BOOTS) expect(ARMOR_BOOTS.has(id)).toBe(false);
  });
});

describe("damageType.ts carries a row for every live champion", () => {
  const liveIds = Object.values(champs.data as Record<string, { key: string }>)
    .map((c) => parseInt(c.key, 10))
    .filter((id) => id < 10000);

  it("resolves every champion on the live roster, with none left over", () => {
    // Mirrors compRatings.ts's own CI test. A new champion must be a
    // hand-added row, and until it is this fails rather than silently
    // resolving to a fallback nobody chose.
    for (const id of liveIds) expect(CHAMPION_DAMAGE_TYPE[id], `champion ${id}`).toBeDefined();
    const tableIds = Object.keys(CHAMPION_DAMAGE_TYPE).map(Number).sort((a, b) => a - b);
    expect(tableIds).toEqual([...liveIds].sort((a, b) => a - b));
  });

  it("every hand correction genuinely disagrees with the derived baseline", () => {
    // A correction that upstream has since caught up with is dead weight
    // carrying an authority it no longer has. This is the test that would
    // catch that, rather than the table quietly accumulating stale overrides.
    const baseline = deriveDamageBaseline(champs);
    for (const id of DAMAGE_TYPE_CORRECTIONS) {
      expect(baseline[id], `correction for ${id} is for a champion off the roster`).toBeDefined();
      expect(
        baseline[id],
        `correction for ${id} is redundant: the ddragon baseline already says ${baseline[id]}`
      ).not.toBe(CHAMPION_DAMAGE_TYPE[id]);
    }
  });

  it("corrects every champion ddragon has no read for at all", () => {
    // A 0/0 info block is UNKNOWN, not "balanced". Four champions carry one
    // (Seraphine, Akshan, Rell, Vex) and each must be a deliberate row rather
    // than an accident of arithmetic.
    const baseline = deriveDamageBaseline(champs);
    const unknown = Object.entries(baseline)
      .filter(([, v]) => v === null)
      .map(([id]) => Number(id));
    expect(unknown.length).toBeGreaterThan(0);
    for (const id of unknown) expect(DAMAGE_TYPE_CORRECTIONS).toContain(id);
  });

  it("keeps the derived margin the source file documents", () => {
    expect(DAMAGE_MARGIN).toBe(3);
  });

  it("resolves an unknown id to mixed, which can never make a rule fire", () => {
    expect(getDamageType(999999)).toBe("mixed");
  });

  it("agrees with the spot checks the header names", () => {
    // The four cases the header cites as evidence that ddragon's info block is
    // not a damage-type source. If any of these regress, the argument in the
    // header stopped being true and the table needs re-reading.
    expect(getDamageType(887)).toBe("ap"); // Gwen, ddragon says 7 attack / 5 magic
    expect(getDamageType(24)).toBe("ad"); // Jax, ddragon ties at 7/7
    expect(getDamageType(412)).toBe("ap"); // Thresh, ddragon says 5/6
    expect(getDamageType(89)).toBe("ap"); // Leona, ddragon says 4/3
  });
});
