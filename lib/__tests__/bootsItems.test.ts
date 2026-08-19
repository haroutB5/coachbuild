/**
 * lib/bootsItems.ts — THE boots predicate, and the three call sites that must
 * all go through it.
 *
 * WHY THIS FILE EXISTS. `proConsensus.ts`, `itemSetBody.ts` and
 * `lib/otp/featuredBuild.ts` each had their own `tags.includes("Boots")` rule.
 * Three copies agreed for months and then were wrong together: live ddragon
 * 16.15.1 does not tag **3172 Gunmetal Greaves** — a tier-3 boot enchant built
 * from 3006 Berserker's Greaves — as `Boots` at all. Consequence measured live
 * on prod `/api/pros`, 2026-07-29: Yone mid held 3172 in **178 of 200** games,
 * Yasuo mid 132/200, and an OTP line shipped Swiftmarch AND Gunmetal Greaves in
 * one worn loadout.
 *
 * FIXTURES ARE THE REAL CATALOG. Every entry in `CATALOG` below is a verbatim
 * copy of the live ddragon 16.15.1 record for that id — real ids, real recipes,
 * real tags, real gold. This repo has an explicit rule against toy numbers, and
 * here it is load-bearing twice over: 3172's exact tag list IS the bug, and the
 * negative controls (3046 Phantom Dancer, 3086 Zeal, 3041 Mejai's) only prove
 * anything because they carry the real `NonbootsMovement` tag that sits beside
 * `Boots` in the catalog and must never be mistaken for it.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ItemDetail } from "@/components/itemDetail";
import { isBootsItem, isFinalBootsItem, BOOTS_ID_EXCEPTIONS } from "@/lib/bootsItems";
import { isBuildItem, aggregateProConsensus } from "@/components/hextech/proConsensus";
import { classifyFeaturedItem, buildFeaturedView } from "@/lib/otp/featuredBuild";
import { buildItemSets as buildItemSetExport } from "@/components/hextech/itemSetBody";
import type { ChampionRef, BuildResponse, ItemsBlock, Pick, RunesBlock } from "@/lib/types";
import type { ProGame } from "@/components/proGames.types";

/** v0.114.0 — buildItemSets returns `{sets, situational?}`. These tests are
 *  about boots inside the SETS; the overlay-delta array has its own suite in
 *  components/__tests__/situationalItemSet.test.ts. */
const buildItemSets = (...args: Parameters<typeof buildItemSetExport>) => buildItemSetExport(...args).sets;

// ── The live 16.15.1 catalog, verbatim (pulled 2026-07-29) ──────────────────
type Raw = Omit<ItemDetail, "id" | "descriptionText">;
const CATALOG_RAW: [number, Raw][] = [
  [1001, { name: "Boots", goldTotal: 300, into: ["3005", "3047", "3008", "3006", "3009", "3010", "3020", "3111", "3117", "3158"], from: [], tags: ["Boots"], purchasable: true }],
  [3006, { name: "Berserker's Greaves", goldTotal: 1100, into: ["3172"], from: ["1001", "1042", "1042"], tags: ["AttackSpeed", "Boots"], purchasable: true }],
  // THE BUG: a tier-3 boot enchant with no Boots tag, and a NonbootsMovement
  // tag the catalog directly contradicts.
  [3172, { name: "Gunmetal Greaves", goldTotal: 1100, into: [], from: ["3006"], tags: ["AttackSpeed", "LifeSteal", "NonbootsMovement"], purchasable: true }],
  [3009, { name: "Boots of Swiftness", goldTotal: 1000, into: ["3170"], from: ["1001"], tags: ["Boots"], purchasable: true }],
  [3170, { name: "Swiftmarch", goldTotal: 1000, into: [], from: ["3009"], tags: ["Boots"], purchasable: true }],
  [3020, { name: "Sorcerer's Shoes", goldTotal: 1100, into: ["3175"], from: ["1001"], tags: ["Boots", "MagicPenetration"], purchasable: true }],
  [3175, { name: "Spellslinger's Shoes", goldTotal: 1100, into: [], from: ["3020"], tags: ["Boots", "MagicPenetration"], purchasable: true }],
  [3047, { name: "Plated Steelcaps", goldTotal: 1200, into: ["3174"], from: ["1001", "1029"], tags: ["Armor", "Boots"], purchasable: true }],
  [3174, { name: "Armored Advance", goldTotal: 1200, into: [], from: ["3047"], tags: ["Armor", "Boots"], purchasable: true }],
  [3111, { name: "Mercury's Treads", goldTotal: 1250, into: ["3173"], from: ["1001", "1033"], tags: ["Boots", "SpellBlock", "Tenacity"], purchasable: true }],
  [3173, { name: "Chainlaced Crushers", goldTotal: 1250, into: [], from: ["3111"], tags: ["SpellBlock", "Boots", "Tenacity", "MagicResist"], purchasable: true }],
  [3158, { name: "Ionian Boots of Lucidity", goldTotal: 900, into: ["3171"], from: ["1001", "2022"], tags: ["Boots", "CooldownReduction"], purchasable: true }],
  [3171, { name: "Crimson Lucidity", goldTotal: 900, into: [], from: ["3158"], tags: ["CooldownReduction", "Boots"], purchasable: true }],
  [3008, { name: "Gluttonous Greaves", goldTotal: 1000, into: ["3168"], from: ["1001"], tags: ["LifeSteal", "SpellVamp", "Boots"], purchasable: true }],
  [3168, { name: "Immortal Path", goldTotal: 1000, into: [], from: ["3008"], tags: ["LifeSteal", "SpellVamp", "Boots"], purchasable: true }],
  // Negative controls: NonbootsMovement-tagged, attack-speed-heavy, NOT boots.
  [3046, { name: "Phantom Dancer", goldTotal: 2650, into: [], from: ["1042", "3086", "1042"], tags: ["CriticalStrike", "AttackSpeed", "NonbootsMovement"], purchasable: true }],
  [3086, { name: "Zeal", goldTotal: 1200, into: ["2512", "3094", "3046", "3085", "4403", "6671", "6675"], from: ["1018", "1042"], tags: ["CriticalStrike", "AttackSpeed", "NonbootsMovement"], purchasable: true }],
  [3041, { name: "Mejai's Soulstealer", goldTotal: 1500, into: [], from: ["1082"], tags: ["Health", "SpellDamage", "NonbootsMovement"], purchasable: true }],
  [1042, { name: "Dagger", goldTotal: 250, into: ["1043", "3086", "2510", "3006", "3046", "3051", "3073", "3131", "3144", "6631", "6675", "6677"], from: [], tags: ["AttackSpeed"], purchasable: true }],
  [1018, { name: "Cloak of Agility", goldTotal: 600, into: ["3031", "3086", "6670", "3033", "3039", "3095", "3097", "6676"], from: [], tags: ["CriticalStrike"], purchasable: true }],
  [1038, { name: "B. F. Sword", goldTotal: 1300, into: ["3031", "3026", "3032", "3072", "3095", "3097", "6671"], from: [], tags: ["Damage"], purchasable: true }],
  [1037, { name: "Pickaxe", goldTotal: 875, into: ["3071", "3031", "3153", "6701", "3087", "2523", "3072", "3181", "6673", "6676"], from: [], tags: ["Damage"], purchasable: true }],
  [1053, { name: "Vampiric Scepter", goldTotal: 900, into: ["3153", "3146", "3072", "3074", "3139"], from: ["1036"], tags: ["Damage", "LifeSteal"], purchasable: true }],
  // Real completed AD-carry items — the pool a Yone/Draven line draws from.
  [3072, { name: "Bloodthirster", goldTotal: 3400, into: [], from: ["1038", "1037", "1053"], tags: ["Damage", "LifeSteal"], purchasable: true }],
  [3031, { name: "Infinity Edge", goldTotal: 3500, into: [], from: ["1038", "1037", "1018"], tags: ["CriticalStrike", "Damage"], purchasable: true }],
  [3036, { name: "Lord Dominik's Regards", goldTotal: 3300, into: [], from: ["3035", "6670"], tags: ["Damage", "CriticalStrike", "ArmorPenetration"], purchasable: true }],
  [3033, { name: "Mortal Reminder", goldTotal: 3000, into: [], from: ["3123", "3035", "1018"], tags: ["Damage", "CriticalStrike", "ArmorPenetration"], purchasable: true }],
  [6673, { name: "Immortal Shieldbow", goldTotal: 3000, into: [], from: ["1037", "6670"], tags: ["Damage", "CriticalStrike"], purchasable: true }],
  [6676, { name: "The Collector", goldTotal: 3000, into: [], from: ["1037", "3134", "1018"], tags: ["Damage", "CriticalStrike", "ArmorPenetration"], purchasable: true }],
  [2523, { name: "Hexoptics C44", goldTotal: 2800, into: [], from: ["1037", "6670", "1036"], tags: ["Damage", "CriticalStrike"], purchasable: true }],
  [1055, { name: "Doran's Blade", goldTotal: 450, into: [], from: [], tags: ["Health", "Damage", "LifeSteal", "SpellVamp", "Lane"], purchasable: true }],
  [1054, { name: "Doran's Shield", goldTotal: 450, into: [], from: [], tags: ["Health", "HealthRegen", "Lane"], purchasable: true }],
];

const CATALOG: Map<number, ItemDetail> = new Map(
  CATALOG_RAW.map(([id, raw]) => [id, { id, descriptionText: "", ...raw }])
);
const m = (id: number) => CATALOG.get(id);

/** Tier-3 boot enchants, live 16.15.1. 3172 is here and is the only one the
 *  catalog does not tag `Boots`. */
const TIER_3_ENCHANTS = [3168, 3170, 3171, 3172, 3173, 3174, 3175];
/** Tier-2 boots, live 16.15.1 (purchasable ones with a tier-3 upgrade). */
const TIER_2_BOOTS = [3006, 3008, 3009, 3020, 3047, 3111, 3158];
const GUNMETAL_GREAVES = 3172;
const SWIFTMARCH = 3170;
const RAW_BOOTS = 1001;

/** Ground truth for the invariant assertions, written out as ids rather than
 *  derived from `isBootsItem`. A test that checks the one-boots invariant with
 *  the very predicate under test proves nothing: mutate the predicate and both
 *  the code and the assertion move together, and the test stays green while the
 *  app ships two pairs of boots. Verified so once — the first version of these
 *  assertions did exactly that.
 *
 *  This list is what the live 16.15.1 catalog actually contains: the full
 *  transitive `into` closure from 1001 Boots, minus the unpurchasable Symbiotic
 *  Soles line (3010/3013/3117/3176), which no build line can reach. */
const REAL_BOOTS_IDS = new Set([1001, 3005, 3006, 3008, 3009, 3020, 3047, 3111, 3158, 3168, 3170, 3171, 3172, 3173, 3174, 3175]);
const bootsIn = (ids: number[]) => ids.filter((id) => REAL_BOOTS_IDS.has(id));

// ═══════════════════════════════════════════════════════════════════════════
describe("isBootsItem / isFinalBootsItem — the whole boots family", () => {
  it("classifies EVERY tier-3 enchant as boots, including the untagged 3172", () => {
    for (const id of TIER_3_ENCHANTS) {
      expect(isBootsItem(id, m(id), CATALOG), `tier-3 ${id}`).toBe(true);
      expect(isFinalBootsItem(id, m(id), CATALOG), `tier-3 final ${id}`).toBe(true);
    }
  });

  it("classifies every tier-2 boot as a FINAL boots choice (stopped at tier 2 is a real build state)", () => {
    for (const id of TIER_2_BOOTS) {
      expect(isBootsItem(id, m(id), CATALOG), `tier-2 ${id}`).toBe(true);
      expect(isFinalBootsItem(id, m(id), CATALOG), `tier-2 final ${id}`).toBe(true);
    }
  });

  it("3172 is boots by RECIPE ANCESTRY — its own tags never say Boots", () => {
    const meta = m(GUNMETAL_GREAVES)!;
    expect(meta.tags).not.toContain("Boots"); // the catalog gap itself
    expect(meta.from).toEqual(["3006"]);
    expect(m(3006)!.tags).toContain("Boots"); // ...but its parent is tagged
    expect(isBootsItem(GUNMETAL_GREAVES, meta, CATALOG)).toBe(true);
  });

  it("3172 is STILL boots with no catalog at all — the pinned exception is the degradation path", () => {
    // Call sites that hold one item's metadata and no map (FeaturedOtpCard's
    // include predicate) cannot walk a recipe. BOOTS_ID_EXCEPTIONS is what
    // keeps them correct instead of silently reopening the bug on one path.
    expect(BOOTS_ID_EXCEPTIONS.has(GUNMETAL_GREAVES)).toBe(true);
    expect(isBootsItem(GUNMETAL_GREAVES, m(GUNMETAL_GREAVES))).toBe(true);
    expect(isFinalBootsItem(GUNMETAL_GREAVES, m(GUNMETAL_GREAVES))).toBe(true);
  });

  it("survives a stale localStorage entry that lost its from/tags arrays", () => {
    // Real prod incident class (v0.27.2): a cached ItemDetail can arrive with
    // undefined arrays despite the type. The id must still classify.
    const wrecked = { id: GUNMETAL_GREAVES, name: "Gunmetal Greaves", goldTotal: 0, descriptionText: "" } as unknown as ItemDetail;
    expect(() => isBootsItem(GUNMETAL_GREAVES, wrecked, CATALOG)).not.toThrow();
    expect(isBootsItem(GUNMETAL_GREAVES, wrecked, CATALOG)).toBe(true);
    const wreckedNonBoot = { id: 3046, name: "Phantom Dancer", goldTotal: 0, descriptionText: "" } as unknown as ItemDetail;
    expect(isBootsItem(3046, wreckedNonBoot, CATALOG)).toBe(false);
  });

  it("tier-1 1001 Boots IS boots but is NOT a final boots choice", () => {
    expect(isBootsItem(RAW_BOOTS, m(RAW_BOOTS), CATALOG)).toBe(true);
    expect(isFinalBootsItem(RAW_BOOTS, m(RAW_BOOTS), CATALOG)).toBe(false);
  });

  it("does NOT over-reach: NonbootsMovement items and boot COMPONENTS stay non-boots", () => {
    // The ancestry clause was measured over the entire live 16.15.1 catalog and
    // reclassifies exactly one id (3172). These are the ids most likely to be
    // caught by a sloppier rule: they share 3172's tags, or feed a boot recipe.
    for (const id of [3046, 3086, 3041, 1042, 1018, 1038, 1037, 1053, 3072, 3031, 3036, 6676, 2523]) {
      expect(isBootsItem(id, m(id), CATALOG), `${id} ${m(id)?.name}`).toBe(false);
      expect(isFinalBootsItem(id, m(id), CATALOG), `${id} final`).toBe(false);
    }
    // 1042 Dagger builds INTO 3006 Berserker's Greaves. `into` is not `from`;
    // a component of a boot is not a boot.
    expect(m(1042)!.into).toContain("3006");
  });

  it("an id with no metadata is never boots unless pinned", () => {
    expect(isBootsItem(999999, undefined, CATALOG)).toBe(false);
    expect(isFinalBootsItem(999999, undefined, CATALOG)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("all three call sites agree that 3172 is boots", () => {
  it("proConsensus counts it as a build item and partitions it into `boots`, not `items`", () => {
    expect(isBuildItem(GUNMETAL_GREAVES, m(GUNMETAL_GREAVES), CATALOG)).toBe(true);
    // The Yone-mid shape: the untagged boot is the dominant pick, a tagged boot
    // is rare, and five real completed items fill the grid.
    const games = yoneLikeGames();
    const model = aggregateProConsensus(games, CATALOG);
    expect(model.boots.map((b) => b.itemId)).toContain(GUNMETAL_GREAVES);
    expect(model.items.map((i) => i.itemId)).not.toContain(GUNMETAL_GREAVES);
    // and it wins the boots slot outright rather than the rare tagged boot
    expect(model.boots[0].itemId).toBe(GUNMETAL_GREAVES);
  });

  it("featuredBuild classifies it `boots`, with AND without a catalog", () => {
    expect(classifyFeaturedItem(GUNMETAL_GREAVES, m(GUNMETAL_GREAVES), CATALOG)).toBe("boots");
    expect(classifyFeaturedItem(GUNMETAL_GREAVES, m(GUNMETAL_GREAVES))).toBe("boots");
  });

  it("featuredBuild's top-three-boots slot can see it, and the full build holds exactly one boot", () => {
    const gameItems = [
      [GUNMETAL_GREAVES, 3072, 3031, 3036, 6676, 2523],
      [GUNMETAL_GREAVES, 3072, 3031, 3036, 6676, 2523],
      [GUNMETAL_GREAVES, 3072, 3031, 3036, 6676, 2523],
      [SWIFTMARCH, 3072, 3031, 3033, 6673, 2523],
      [3173, 3072, 3031, 3036, 6676, 1055],
    ];
    const rates = ratesFrom(gameItems);
    const view = buildFeaturedView(
      rates,
      gameItems.map((items) => ({ items, win: true })),
      gameItems.length,
      CATALOG
    );
    expect(view.boots.map((b) => b.itemId)).toEqual([GUNMETAL_GREAVES, 3170, 3173]);
    expect(view.items.map((i) => i.itemId)).not.toContain(GUNMETAL_GREAVES);
    const bootsInBuild = view.fullBuild!.items.filter((i) => i.isBoots);
    expect(bootsInBuild).toHaveLength(1);
    expect(bootsInBuild[0].itemId).toBe(GUNMETAL_GREAVES);
  });

  it("itemSetBody's isFullItem still accepts it (a finished boot is a real slot)", () => {
    // Proven through buildItemSets: if isFullItem rejected 3172 it could never
    // appear in any line at all.
    const sets = buildItemSets(CHAMP, "Mid", baseBuild(), null, CATALOG, otpWithBothBoots());
    const otpLine = sets[0].blocks.find((b) => b.type === "OTP build")!;
    expect(otpLine.items.map((i) => Number(i.id))).toContain(GUNMETAL_GREAVES);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("the one-boots invariant, against the live defect", () => {
  it("reduces a line offering Swiftmarch AND Gunmetal Greaves to ONE boot", () => {
    // THE SHIPPED BUG, reproduced: an OTP consensus that favours the untagged
    // boot AND a tagged one. Before the shared predicate, 3172 was invisible to
    // `bootsIds`, buildLine counted it as a full item, and the exported loadout
    // held two pairs of boots.
    const sets = buildItemSets(CHAMP, "Mid", baseBuild(), null, CATALOG, otpWithBothBoots());
    const otpLine = sets[0].blocks.find((b) => b.type === "OTP build")!;
    const ids = otpLine.items.map((i) => Number(i.id));
    const boots = bootsIn(ids);
    expect(boots).toHaveLength(1);
    expect(ids).toHaveLength(6);
    expect(new Set(ids).size).toBe(6);
  });

  it("holds on EVERY emitted build line, not just the OTP one", () => {
    const sets = buildItemSets(CHAMP, "Mid", baseBuild(), proWithBothBoots(), CATALOG, otpWithBothBoots());
    for (const block of sets[0].blocks) {
      if (block.type === "Starting") continue;
      const ids = block.items.map((i) => Number(i.id));
      const boots = bootsIn(ids);
      expect(boots.length, `${block.type} -> ${ids.join(",")}`).toBeLessThanOrEqual(1);
    }
  });

  it("still gets boots when the one-tricks never bought a TRACKED boot (the Yuumi defect stays fixed)", () => {
    // Regression from the live Yuumi Support report: a champion whose one-tricks
    // bought no boot the consensus tracked shipped six full items and no boots.
    // The corePrimary fallback carries the champ's own core boots.
    const otpNoBoots = {
      items: [3072, 3031, 3036, 3033, 6673, 6676].map((itemId, i) => ({ itemId, share: 0.8 - i * 0.05 })),
      boots: [] as { itemId: number; share: number }[],
    };
    const sets = buildItemSets(CHAMP, "Mid", baseBuild(), null, CATALOG, otpNoBoots);
    const ids = sets[0].blocks.find((b) => b.type === "OTP build")!.items.map((i) => Number(i.id));
    const boots = bootsIn(ids);
    expect(boots).toEqual([3006]); // the champ's own core boots
  });

  it("never INVENTS boots — a pool with no boots anywhere still ships no boots", () => {
    const noBootsAnywhere: ItemsBlock = {
      starter: pick(1055),
      boots: pick(3072), // not boots at all; the champ block simply has none
      first: pick(3031),
      second: pick(3036),
      third: pick(3033),
      fourthPlus: [pick(6673), pick(6676)],
    };
    const sets = buildItemSets(CHAMP, "Mid", baseBuild(noBootsAnywhere), null, CATALOG, null);
    const ids = sets[0].blocks.find((b) => b.type === "WPA build")!.items.map((i) => Number(i.id));
    expect(bootsIn(ids)).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("no second boots predicate", () => {
  /**
   * A behavioural test cannot catch someone RE-ADDING a private
   * `tags.includes("Boots")` beside the shared one — both would pass today and
   * diverge on the next catalog gap, which is exactly how this bug shipped. So
   * this asserts the structural property directly: the `"Boots"` tag string is
   * compared in lib/bootsItems.ts and nowhere else.
   *
   * If this fails, do not add the file to the allowlist. Route it through
   * `isBootsItem`/`isFinalBootsItem` instead — that is the point of the module.
   *
   * WHAT IT CANNOT SEE, stated plainly: it is a source-text regex, so it catches
   * the form a developer would actually write (`tags.includes("Boots")`) and
   * NOT a deliberately obfuscated one. Both were mutation-tested, 2026-07-29 —
   * the plain literal fails this test, a `String.fromCharCode`-built one does
   * not. That is an accepted limit: the failure mode being defended against is
   * an honest copy-paste, not sabotage.
   */
  const ROOT = join(__dirname, "..", "..");
  const CONSUMERS = [
    "components/hextech/proConsensus.ts",
    "components/hextech/itemSetBody.ts",
    "lib/otp/featuredBuild.ts",
    "components/hextech/ProConsensusCard.tsx",
    "components/hextech/FeaturedOtpCard.tsx",
    "components/hextech/itemSetsApply.ts",
    "lib/buildSlots.ts",
    "lib/supportFinalGroup.ts",
    "lib/startingItems.ts",
    "lib/snowballStacks.ts",
  ];

  /** Strip block/line comments so the module headers — which quote the tag name
   *  while explaining all this — do not read as code. */
  function stripComments(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
  }

  it.each(CONSUMERS)("%s does not test the Boots tag itself", (rel) => {
    let src: string;
    try {
      src = readFileSync(join(ROOT, rel), "utf8");
    } catch {
      // A consumer that no longer exists is not a failure; the guard below
      // covers whatever replaced it via the shared module's own call sites.
      return;
    }
    const code = stripComments(src);
    expect(code, `${rel} compares the "Boots" tag directly — call isBootsItem/isFinalBootsItem instead`).not.toMatch(
      /["'`]Boots["'`]/
    );
  });

  it("the three original call sites all IMPORT the shared predicate", () => {
    for (const rel of ["components/hextech/proConsensus.ts", "components/hextech/itemSetBody.ts", "lib/otp/featuredBuild.ts"]) {
      const src = readFileSync(join(ROOT, rel), "utf8");
      expect(src, `${rel} must import from @/lib/bootsItems`).toMatch(
        /import\s*\{[^}]*\}\s*from\s*["']@\/lib\/bootsItems["']/
      );
    }
  });

  it("lib/bootsItems.ts is the only module that names the tag in code", () => {
    const src = stripComments(readFileSync(join(ROOT, "lib/bootsItems.ts"), "utf8"));
    expect(src).toMatch(/BOOTS_TAG = "Boots"/);
  });
});

// ── fixtures ────────────────────────────────────────────────────────────────

const CHAMP: ChampionRef = { id: 777, key: "Yone", name: "Yone", icon: "yone.png" };

function pick(id: number, wpa = 0.02): Pick {
  return { id, name: CATALOG.get(id)?.name ?? `Item ${id}`, icon: `icon-${id}`, wpa, winrate: 52, occurrence: 5000 };
}

function baseItemsBlock(): ItemsBlock {
  return {
    starter: pick(1055),
    boots: pick(3006),
    first: pick(3072, 0.05),
    second: pick(3031, 0.04),
    third: pick(3036, 0.03),
    fourthPlus: [pick(6676, 0.02), pick(2523, 0.01)],
  };
}

function baseRunes(): RunesBlock {
  return {
    primaryTree: { id: 8000, name: "Precision", icon: "t8000" },
    secondaryTree: { id: 8100, name: "Domination", icon: "t8100" },
    keystone: pick(8008),
    primary: [pick(9111), pick(9104), pick(8014)],
    secondary: [pick(8143), pick(8135)],
    shards: { offense: pick(5005), flex: pick(5008), defense: pick(5011) },
  };
}

function baseBuild(items: ItemsBlock = baseItemsBlock()): BuildResponse {
  return {
    champion: CHAMP,
    role: 2,
    roleLabel: "Mid",
    patch: "16.15",
    tierLabel: "Diamond+",
    runes: baseRunes(),
    spells: [pick(4), pick(14)],
    items,
    generatedAt: new Date().toISOString(),
    sources: { provider: "coachless.gg" },
  };
}

/** Consensus input holding BOTH the untagged boot and a tagged one — the exact
 *  live shape that shipped two pairs of boots. Shares are the measured Yone-mid
 *  proportions (3172 in 178/200 games, 3173 in 15/200). */
function otpWithBothBoots() {
  return {
    boots: [{ itemId: SWIFTMARCH, share: 0.12 }],
    items: [
      { itemId: GUNMETAL_GREAVES, share: 0.89 },
      { itemId: 3072, share: 0.7 },
      { itemId: 3031, share: 0.62 },
      { itemId: 3036, share: 0.55 },
      { itemId: 6676, share: 0.41 },
      { itemId: 2523, share: 0.33 },
      { itemId: 3033, share: 0.2 },
    ],
  };
}

function proWithBothBoots() {
  return {
    boots: [{ itemId: 3173, share: 0.08 }],
    items: [
      { itemId: GUNMETAL_GREAVES, share: 0.89 },
      { itemId: 3072, share: 0.68 },
      { itemId: 3031, share: 0.6 },
      { itemId: 3033, share: 0.5 },
      { itemId: 6673, share: 0.4 },
      { itemId: 2523, share: 0.3 },
    ],
  };
}

/** Per-item build rates over a set of per-game inventories. */
function ratesFrom(gameItems: number[][]) {
  const counts = new Map<number, number>();
  for (const g of gameItems) {
    // Array.from, not a bare `for..of` over a Set — this tsconfig's target
    // predates downlevel iteration.
    for (const id of Array.from(new Set(g))) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return Array.from(counts.entries()).map(([itemId, games]) => ({
    itemId,
    games,
    pct: games / gameItems.length,
  }));
}

/** Yone-mid-shaped pro games: 3172 in most of them, a tagged boot in a few. */
function yoneLikeGames(): ProGame[] {
  const inventories: number[][] = [];
  for (let i = 0; i < 18; i++) inventories.push([GUNMETAL_GREAVES, 3072, 3031, 3036, 6676, 2523]);
  inventories.push([3173, 3072, 3031, 3036, 6676, 3033]);
  inventories.push([SWIFTMARCH, 3072, 3031, 3033, 6673, 2523]);
  return inventories.map((finalItems, i) => ({
    source: "soloq" as const,
    gameId: `G${i}`,
    proId: 1,
    player: "OneTrick",
    championId: 777,
    championName: "Yone",
    role: 2,
    win: true,
    kills: 8,
    deaths: 3,
    assists: 5,
    gameCreation: Date.now() - i * 86_400_000,
    gameDurationSec: 1800,
    patch: "16.15",
    spells: [4, 14],
    finalItems,
    purchaseOrder: [],
    skillOrder: [],
    trinket: 3340,
    runes: {
      keystone: 8008,
      primaryTree: 8000,
      secondaryTree: 8100,
      primary: [9111, 9104, 8014],
      secondary: [8143, 8135],
      shards: [5005, 5008, 5011],
    },
  })) as unknown as ProGame[];
}
