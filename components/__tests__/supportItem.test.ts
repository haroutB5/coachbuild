// v0.49.0 — support-item upgrade resolver (Build page, support role only).
// See components/hextech/supportItem.ts's header for the live-verified
// upgrade tree + the investigation finding this covers (the final item is
// never present in real /api/build data today — findSupportFinalInBuildData
// is exercised with a synthetic fixture that DOES include one, so the
// "measured" branch is proven even though it's unreachable in practice).
import { describe, it, expect } from "vitest";
import {
  findSupportFinalInBuildData,
  classifySupportArchetype,
  resolveSupportItemSuggestion,
  SUPPORT_FINAL_ITEMS,
} from "../hextech/supportItem";
import type { BuildResponse, ChampionRef, ItemsBlock, Pick, RunesBlock } from "@/lib/types";

function pick(id: number, wpa = 0.02, name = `Item ${id}`): Pick {
  return { id, name, icon: `icon-${id}`, wpa, winrate: 52, occurrence: 500 };
}

function baseRunes(): RunesBlock {
  return {
    primaryTree: { id: 8200, name: "Sorcery", icon: "t8200" },
    secondaryTree: { id: 8300, name: "Inspiration", icon: "t8300" },
    keystone: pick(8992),
    primary: [pick(8226), pick(8234), pick(8237)],
    secondary: [pick(8304), pick(8316)],
    shards: { offense: pick(5008), flex: pick(5010), defense: pick(5001) },
  };
}

function buildFor(champ: ChampionRef, items: ItemsBlock, roleOverrides: Partial<BuildResponse> = {}): BuildResponse {
  return {
    champion: champ,
    role: 4,
    roleLabel: "Support",
    patch: "16.13",
    tierLabel: "Diamond+",
    runes: baseRunes(),
    spells: [pick(4), pick(7)],
    items,
    generatedAt: new Date().toISOString(),
    sources: { provider: "coachless.gg" },
    ...roleOverrides,
  };
}

const WORLD_ATLAS = 3865;
const BOOTS = 3009;

// ── Fixtures mirroring the live probes in HANDOFF-engy.md ──────────────────

// Nami / Yuumi-shaped: pure enchanter items (Staff of Flowing Water, Echoes
// of Helia, Ardent Censer core; Redemption/Shurelya's/Moonstone Renewer 4th+).
function enchanterItems(): ItemsBlock {
  return {
    starter: pick(WORLD_ATLAS, 0, "World Atlas"),
    boots: pick(BOOTS, 0.2, "Boots of Swiftness"),
    first: pick(6616, 0.5, "Staff of Flowing Water"),
    second: pick(6620, 0.4, "Echoes of Helia"),
    third: pick(3504, 0.3, "Ardent Censer"),
    fourthPlus: [pick(3107, 0.1, "Redemption"), pick(2065, 0.1, "Shurelya's Battlesong")],
  };
}

// Leona/Braum/Thresh-shaped: tank/engage support items.
function tankItems(): ItemsBlock {
  return {
    starter: pick(WORLD_ATLAS, 0, "World Atlas"),
    boots: pick(BOOTS, 0.2, "Boots of Swiftness"),
    first: pick(3109, 0.5, "Knight's Vow"),
    second: pick(3190, 0.4, "Locket of the Iron Solari"),
    third: pick(3075, 0.3, "Thornmail"),
    fourthPlus: [pick(3110, 0.1, "Frozen Heart")],
  };
}

// Senna-shaped: full ADC crit build, zero support-item-pool matches.
function adCarryItems(): ItemsBlock {
  return {
    starter: pick(WORLD_ATLAS, 0, "World Atlas"),
    boots: pick(3009, 0.2, "Boots of Swiftness"),
    first: pick(3071, 0.5, "Black Cleaver"),
    second: pick(3087, 0.5, "Statikk Shiv"),
    third: pick(2523, -0.3, "Hexoptics C44"),
    fourthPlus: [pick(3094, -0.3, "Rapid Firecannon"), pick(3031, -0.8, "Infinity Edge")],
  };
}

const NAMI: ChampionRef = { id: 267, key: "Nami", name: "Nami", icon: "nami.png", tags: ["Support", "Mage"] };
const LEONA: ChampionRef = { id: 89, key: "Leona", name: "Leona", icon: "leona.png", tags: ["Tank", "Support"] };
const SENNA: ChampionRef = {
  id: 235,
  key: "Senna",
  name: "Senna",
  icon: "senna.png",
  tags: ["Support", "Marksman"],
};
const UNCURATED_MAGE_SUPPORT: ChampionRef = {
  id: 999001,
  key: "FakeMage",
  name: "FakeMage",
  icon: "fakemage.png",
  tags: ["Support", "Mage"],
};
const UNCURATED_TANK_SUPPORT: ChampionRef = {
  id: 999002,
  key: "FakeTank",
  name: "FakeTank",
  icon: "faketank.png",
  tags: ["Tank", "Support"],
};

describe("findSupportFinalInBuildData", () => {
  it("returns null when no final item appears anywhere in the build (the real-world case today)", () => {
    expect(findSupportFinalInBuildData(buildFor(NAMI, enchanterItems()))).toBeNull();
    expect(findSupportFinalInBuildData(buildFor(LEONA, tankItems()))).toBeNull();
    expect(findSupportFinalInBuildData(buildFor(SENNA, adCarryItems()))).toBeNull();
  });

  it("finds a final item sitting in fourthPlus", () => {
    const items = enchanterItems();
    items.fourthPlus = [...items.fourthPlus, pick(SUPPORT_FINAL_ITEMS.dreamMaker.id, 0.9, "Dream Maker")];
    const found = findSupportFinalInBuildData(buildFor(NAMI, items));
    expect(found?.id).toBe(SUPPORT_FINAL_ITEMS.dreamMaker.id);
  });

  it("finds a final item sitting in alts and prefers the highest-wpa match across slots", () => {
    const items = enchanterItems();
    items.fourthPlus = [
      ...items.fourthPlus,
      pick(SUPPORT_FINAL_ITEMS.dreamMaker.id, 0.5, "Dream Maker"),
    ];
    items.alts = {
      third: [pick(SUPPORT_FINAL_ITEMS.zazzaks.id, 0.95, "Zaz'Zak's Realmspike")],
    };
    const found = findSupportFinalInBuildData(buildFor(NAMI, items));
    expect(found?.id).toBe(SUPPORT_FINAL_ITEMS.zazzaks.id);
  });
});

describe("classifySupportArchetype", () => {
  it("Nami (enchanter real items) -> Enchanter", () => {
    expect(classifySupportArchetype(NAMI, buildFor(NAMI, enchanterItems()))).toBe("Enchanter");
  });

  it("Leona (tank real items + Tank tag) -> Tank/Engage", () => {
    expect(classifySupportArchetype(LEONA, buildFor(LEONA, tankItems()))).toBe("Tank/Engage");
  });

  it("Senna (Marksman tag, no item-pool match) -> AD/Aggressive", () => {
    expect(classifySupportArchetype(SENNA, buildFor(SENNA, adCarryItems()))).toBe("AD/Aggressive");
  });

  it("a Mage-tagged champ with no item-pool match -> AP/Poke default", () => {
    const items = adCarryItems();
    items.first = pick(9999001, 0.5, "Some Poke Item"); // not in any curated pool
    items.second = pick(9999002, 0.4, "Another Poke Item");
    const champ: ChampionRef = { id: 45, key: "Veigar", name: "Veigar", icon: "v.png", tags: ["Mage"] };
    expect(classifySupportArchetype(champ, buildFor(champ, items))).toBe("AP/Poke");
  });

  it("more enchanter matches than tank matches wins Enchanter even if both pools have a hit", () => {
    const items = enchanterItems();
    items.fourthPlus = [...items.fourthPlus, pick(3109, 0.1, "Knight's Vow")]; // one tank item too
    expect(classifySupportArchetype(NAMI, buildFor(NAMI, items))).toBe("Enchanter");
  });

  it("an uncurated Tank-tagged champ with no item match still resolves via tags (deriveFallbackRating), not a crash", () => {
    const items = adCarryItems(); // no pool matches at all
    expect(() => classifySupportArchetype(UNCURATED_TANK_SUPPORT, buildFor(UNCURATED_TANK_SUPPORT, items))).not.toThrow();
  });
});

describe("resolveSupportItemSuggestion", () => {
  it("measured branch: when a final IS present in the data, returns it with measured:true and the wire icon", () => {
    const items = enchanterItems();
    items.fourthPlus = [...items.fourthPlus, pick(SUPPORT_FINAL_ITEMS.dreamMaker.id, 0.9, "Dream Maker")];
    const build = buildFor(NAMI, items);
    const result = resolveSupportItemSuggestion(NAMI, build, "16.13.1");
    expect(result.measured).toBe(true);
    expect(result.item.id).toBe(SUPPORT_FINAL_ITEMS.dreamMaker.id);
    expect(result.icon).toBe(`icon-${SUPPORT_FINAL_ITEMS.dreamMaker.id}`);
    expect(result.archetype).toBe("Enchanter");
  });

  it("Nami's real build (no final present) -> Dream Maker, not measured", () => {
    const result = resolveSupportItemSuggestion(NAMI, buildFor(NAMI, enchanterItems()), "16.13.1");
    expect(result.measured).toBe(false);
    expect(result.item).toEqual(SUPPORT_FINAL_ITEMS.dreamMaker);
    expect(result.icon).toContain("16.13.1");
    expect(result.icon).toContain(String(SUPPORT_FINAL_ITEMS.dreamMaker.id));
  });

  it("Senna's real build -> Bloodsong, not measured", () => {
    const result = resolveSupportItemSuggestion(SENNA, buildFor(SENNA, adCarryItems()), "16.13.1");
    expect(result.measured).toBe(false);
    expect(result.item).toEqual(SUPPORT_FINAL_ITEMS.bloodsong);
  });

  it("Leona (cc:3, engage:3 curated rating) -> Solstice Sleigh", () => {
    const result = resolveSupportItemSuggestion(LEONA, buildFor(LEONA, tankItems()), "16.13.1");
    expect(result.measured).toBe(false);
    expect(result.item).toEqual(SUPPORT_FINAL_ITEMS.solsticeSleigh);
  });

  it("a lower-cc/engage tank champ -> Celestial Opposition, not Solstice Sleigh", () => {
    // Not in the curated COMP_RATINGS table and tags alone (Tank+Support)
    // derive cc:1/engage:0 via deriveFallbackRating -- below the cc>=3 &&
    // engage>=3 Solstice Sleigh threshold.
    const result = resolveSupportItemSuggestion(
      UNCURATED_TANK_SUPPORT,
      buildFor(UNCURATED_TANK_SUPPORT, tankItems()),
      "16.13.1"
    );
    expect(result.measured).toBe(false);
    expect(result.item).toEqual(SUPPORT_FINAL_ITEMS.celestialOpposition);
  });

  it("an uncurated Mage support with no item-pool match -> Zaz'Zak's Realmspike (AP/Poke default)", () => {
    const items = adCarryItems();
    items.first = pick(9999003, 0.5, "Poke Item A");
    items.second = pick(9999004, 0.4, "Poke Item B");
    const result = resolveSupportItemSuggestion(
      UNCURATED_MAGE_SUPPORT,
      buildFor(UNCURATED_MAGE_SUPPORT, items),
      "16.13.1"
    );
    expect(result.measured).toBe(false);
    expect(result.item).toEqual(SUPPORT_FINAL_ITEMS.zazzaks);
  });
});
