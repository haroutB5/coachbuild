// v0.34.1 rewrite (user feedback after confirming item sets work in-game):
// buildItemSets now returns ONE set per champ+role (Core/Optimized/Pro/
// Situational as BLOCKS, not separate sets) and every build line (Core,
// Optimized, Pro) is run through the 6-items/1-boots invariant. See
// components/hextech/itemSetBody.ts's header for the two live bugs this
// closes (a line with 2 boots; an Optimized line with only 3 items).
//
// v0.36.0 rewrite (user on-device evidence + feedback): every fixture now
// threads real ItemDetail metadata (the full-items-only rule needs it —
// see itemSetBody.ts's isFullItem). "Optimized order" renamed to "Buy
// order". New coverage: the Dark Seal regression (a non-full item must
// never reach a build LINE but IS allowed in Situational), and the three
// themed lines (Highest WPA / Tanky / Burst).
import { describe, it, expect } from "vitest";
import { buildItemSets, champScopedReplacePrefix } from "../hextech/itemSetBody";
import { STARTING_ITEM_ALLOWLIST } from "../hextech/proConsensus";
import type { ChampionRef, BuildResponse, ItemsBlock, Pick, RunesBlock } from "@/lib/types";
import type { ItemDetail } from "@/components/itemDetail";

function pick(id: number, wpa = 0.02): Pick {
  return { id, name: `Item ${id}`, icon: `icon-${id}`, wpa, winrate: 52, occurrence: 500 };
}

// ── Item metadata fixtures ──────────────────────────────────────────────────
// Full item by default (empty `into` -> a genuine recipe-tree leaf, per
// isFullItem). `bootsMeta` mirrors a real tier-2 boot (Boots tag, built FROM
// something, but with its own non-empty `into` -- the optional tier-3
// enchant every boot has post-2026-rework) so the boots special case is the
// thing actually proven, not an accidental "empty into" pass-through.
function meta(id: number, overrides: Partial<ItemDetail> = {}): ItemDetail {
  return {
    id,
    name: `Item ${id}`,
    goldTotal: 3000,
    descriptionText: "",
    into: [],
    from: ["1000"],
    tags: [],
    purchasable: true,
    ...overrides,
  };
}

function bootsMeta(id: number, overrides: Partial<ItemDetail> = {}): ItemDetail {
  return meta(id, { tags: ["Boots"], from: ["1001"], into: ["900000"], ...overrides });
}

function metaMap(...entries: ItemDetail[]): Map<number, ItemDetail> {
  return new Map(entries.map((e) => [e.id, e]));
}

/** Every id the file's DEFAULT fixtures (baseItems/baseBuild + the common
 *  optimizedPath/pro/alts ids reused across tests) can reference, all full
 *  items unless noted. Tests needing a NON-full item (Dark Seal) or a
 *  themed tag build their own bespoke map instead. */
function baseItemMetaMap(): Map<number, ItemDetail> {
  return metaMap(
    meta(1054), // starter (Doran's Shield) -- Starting never filters, meta not load-bearing
    bootsMeta(3006), // items.boots default
    meta(3031),
    meta(3036),
    meta(3095),
    meta(3072),
    meta(3046),
    meta(3020),
    bootsMeta(3157),
    meta(3200),
    meta(3153),
    bootsMeta(3111),
    bootsMeta(3158),
    meta(9001),
    meta(9999),
    meta(8888),
    meta(42),
    meta(100),
    meta(101),
    meta(102),
    meta(103),
    meta(104)
  );
}

function baseItems(overrides: Partial<ItemsBlock> = {}): ItemsBlock {
  return {
    starter: pick(1054),
    boots: pick(3006),
    first: pick(3031),
    second: pick(3036),
    third: pick(3095),
    fourthPlus: [pick(3072), pick(3046)],
    ...overrides,
  };
}

function baseRunes(): RunesBlock {
  return {
    primaryTree: { id: 8000, name: "Precision", icon: "t8000" },
    secondaryTree: { id: 8100, name: "Domination", icon: "t8100" },
    keystone: pick(8005),
    primary: [pick(9111), pick(9104), pick(8014)],
    secondary: [pick(8143), pick(8135)],
    shards: { offense: pick(5005), flex: pick(5008), defense: pick(5002) },
  };
}

const CHAMP: ChampionRef = { id: 222, key: "Jinx", name: "Jinx", icon: "jinx.png" };

function baseBuild(items: ItemsBlock): BuildResponse {
  return {
    champion: CHAMP,
    role: 3,
    roleLabel: "Bot",
    patch: "16.13",
    tierLabel: "High Elo",
    runes: baseRunes(),
    spells: [pick(4), pick(7)],
    items,
    generatedAt: new Date().toISOString(),
    sources: { provider: "coachless.gg" },
  };
}

function blockTypes(sets: ReturnType<typeof buildItemSets>): string[] {
  return sets[0].blocks.map((b) => b.type);
}

function findBlock(sets: ReturnType<typeof buildItemSets>, type: string) {
  return sets[0].blocks.find((b) => b.type === type);
}

// Boots ids in these fixtures: 3006 (items.boots). A "second boots" is
// introduced per-test via items.alts.boots or pro.boots, never hardcoded
// elsewhere, so a fixture's boots-ness is always traceable to one of those
// two structural sources (see itemSetBody.ts header on why boots detection
// here is structural, not tag-based).

describe("buildItemSets — always exactly ONE set per champ+role", () => {
  it("returns a single set regardless of how many blocks resolve", () => {
    const build = baseBuild(baseItems());
    const sets = buildItemSets(CHAMP, "Bot", build, null, baseItemMetaMap());
    expect(sets).toHaveLength(1);
  });

  it("title is 'CoachBuild <champ> <role>' with NO variant suffix", () => {
    const build = baseBuild(baseItems());
    const sets = buildItemSets(CHAMP, "Bot", build, null, baseItemMetaMap());
    expect(sets[0].title).toBe("CoachBuild Jinx Bot");
  });

  it("uid is a slug of champ+role with NO variant suffix", () => {
    const build = baseBuild(baseItems());
    const sets = buildItemSets(CHAMP, "Bot", build, null, baseItemMetaMap());
    expect(sets[0].uid).toBe("coachbuild-jinx-bot");
  });

  it("handles a multi-word/apostrophe champion name in the slug", () => {
    const champ: ChampionRef = { id: 145, key: "Kaisa", name: "Kai'Sa", icon: "k.png" };
    const build = baseBuild(baseItems());
    build.champion = champ;
    const sets = buildItemSets(champ, "Bot", build, null, baseItemMetaMap());
    expect(sets[0].uid).toBe("coachbuild-kai-sa-bot");
    expect(sets[0].title).toBe("CoachBuild Kai'Sa Bot");
  });

  it("associatedChampions carries exactly the champion's id", () => {
    const build = baseBuild(baseItems());
    const sets = buildItemSets(CHAMP, "Bot", build, null, baseItemMetaMap());
    expect(sets[0].associatedChampions).toEqual([222]);
  });

  it("every item id in every block is a string with count 1 (wire contract)", () => {
    const build = baseBuild(
      baseItems({ optimizedPath: [pick(3095, 0.09), pick(3036, 0.08), pick(3031, 0.07)] })
    );
    const pro = { items: [{ itemId: 42, share: 0.5 }], boots: [] };
    const sets = buildItemSets(CHAMP, "Bot", build, pro, baseItemMetaMap());
    for (const block of sets[0].blocks) {
      for (const item of block.items) {
        expect(typeof item.id).toBe("string");
        expect(item.count).toBe(1);
      }
    }
  });

  it("itemMeta is OPTIONAL — omitting it degrades build lines to empty (never assume, never invent) while Starting/Situational are unaffected", () => {
    const build = baseBuild(baseItems({ alts: { first: [pick(9001, 0.05)] } }));
    const sets = buildItemSets(CHAMP, "Bot", build); // no itemMeta at all
    expect(findBlock(sets, "Starting")!.items).toEqual([{ id: "1054", count: 1 }]);
    expect(findBlock(sets, "Core build")!.items).toEqual([]); // every id unknown -> excluded
    expect(findBlock(sets, "Situational swaps")!.items.map((i) => i.id)).toContain("9001"); // unaffected
  });
});

describe("buildItemSets — block presence", () => {
  // NOTE: "Highest WPA" has no tag requirement, only a ≥4-qualifying-item
  // pool-size threshold — Core alone (6 full items) already clears it, so it
  // legitimately appears in almost every fixture below alongside Starting +
  // Core build. The five archetype categories (Tank/AP-Mage/AD-Lethality/
  // Attack Speed/Support-Utility, v0.43.0) are archetype-GATED (see the
  // dedicated "archetype category lines" describe block) — CHAMP (Jinx)
  // carries no `tags` in this fixture and none of the fixtures below give it
  // any category-tagged real items, so every category gate stays closed and
  // none of them appear here either.

  it("Starting + Core build (+ Highest WPA, pool-size only) when there's no optimizedPath, no pro data, no alts", () => {
    const build = baseBuild(baseItems());
    const sets = buildItemSets(CHAMP, "Bot", build, null, baseItemMetaMap());
    expect(blockTypes(sets)).toEqual(["Starting", "Core build", "Highest WPA"]);
  });

  it("adds Buy order when optimizedPath genuinely differs from the core prefix", () => {
    const build = baseBuild(baseItems({ optimizedPath: [pick(3046), pick(3072)] })); // reversed vs fourthPlus
    const sets = buildItemSets(CHAMP, "Bot", build, null, baseItemMetaMap());
    expect(blockTypes(sets)).toEqual(["Starting", "Core build", "Buy order", "Highest WPA"]);
  });

  it("excludes Buy order when optimizedPath is IDENTICAL to the core prefix", () => {
    const build = baseBuild(baseItems({ optimizedPath: [pick(3031), pick(3036)] })); // == [first, second]
    const sets = buildItemSets(CHAMP, "Bot", build, null, baseItemMetaMap());
    expect(blockTypes(sets)).toEqual(["Starting", "Core build", "Highest WPA"]);
  });

  it("excludes Buy order when optimizedPath is empty", () => {
    const build = baseBuild(baseItems({ optimizedPath: [] }));
    const sets = buildItemSets(CHAMP, "Bot", build, null, baseItemMetaMap());
    expect(blockTypes(sets)).toEqual(["Starting", "Core build", "Highest WPA"]);
  });

  it("adds Pro build when pro-consensus data is supplied and non-empty", () => {
    const build = baseBuild(baseItems());
    const pro = { items: [{ itemId: 3020, share: 0.6 }], boots: [{ itemId: 3006, share: 0.4 }] };
    const sets = buildItemSets(CHAMP, "Bot", build, pro, baseItemMetaMap());
    expect(blockTypes(sets)).toEqual(["Starting", "Core build", "Pro build", "Highest WPA"]);
  });

  it("omits Pro build when pro-consensus data is null/absent", () => {
    const build = baseBuild(baseItems());
    expect(blockTypes(buildItemSets(CHAMP, "Bot", build, null, baseItemMetaMap()))).toEqual([
      "Starting",
      "Core build",
      "Highest WPA",
    ]);
    expect(blockTypes(buildItemSets(CHAMP, "Bot", build, undefined, baseItemMetaMap()))).toEqual([
      "Starting",
      "Core build",
      "Highest WPA",
    ]);
  });

  it("omits Pro build when pro-consensus items AND boots are both empty (never an empty block)", () => {
    const build = baseBuild(baseItems());
    const sets = buildItemSets(CHAMP, "Bot", build, { items: [], boots: [] }, baseItemMetaMap());
    expect(blockTypes(sets)).toEqual(["Starting", "Core build", "Highest WPA"]);
  });

  it("adds Situational swaps only when alts exist; omits entirely otherwise", () => {
    const withAlts = buildItemSets(
      CHAMP,
      "Bot",
      baseBuild(baseItems({ alts: { first: [pick(9001, 0.05)] } })),
      null,
      baseItemMetaMap()
    );
    expect(blockTypes(withAlts)).toEqual(["Starting", "Core build", "Highest WPA", "Situational swaps"]);

    const withoutAlts = buildItemSets(CHAMP, "Bot", baseBuild(baseItems()), null, baseItemMetaMap());
    expect(blockTypes(withoutAlts)).toEqual(["Starting", "Core build", "Highest WPA"]);
  });

  it("all resolvable blocks appear together, in order: Starting, Core, Buy order, Pro, Highest WPA, Tank, AP/Mage, AD/Lethality, Situational", () => {
    // CHAMP (Jinx) carries no `tags`, so Tank/AP-Mage/AD-Lethality here are
    // gated open purely via the live-data escape hatch (≥1 tag-matched real
    // item) -- each given exactly 4 so all three land as MEASURED lines
    // (no "(low data)" suffix). Attack Speed/On-hit and Support/Utility are
    // deliberately left with zero qualifying items AND no archetype gate,
    // so they stay omitted -- this fixture is also the "not all five
    // always" case.
    const build = baseBuild(
      baseItems({
        optimizedPath: [pick(3046), pick(3072)],
        alts: {
          first: [
            pick(5001, 0.09), // Tank (Health+Armor)
            pick(5002, 0.08), // Tank (Armor)
            pick(5003, 0.07), // Tank (Health+SpellBlock)
            pick(5004, 0.065), // Tank (Health) -- 4th, clears the ≥4 threshold
            pick(6001, 0.06), // AP/Mage (SpellDamage)
            pick(6003, 0.04), // AP/Mage (SpellDamage)
            pick(6004, 0.035), // AP/Mage (MagicPenetration) -- 3rd
            pick(6009, 0.03), // AP/Mage (SpellDamage) -- 4th, clears the ≥4 threshold
            pick(6002, 0.05), // AD/Lethality (Damage+ArmorPenetration)
            pick(6010, 0.045), // AD/Lethality (CriticalStrike)
            pick(6011, 0.038), // AD/Lethality (Damage) -- 3rd
            pick(6012, 0.032), // AD/Lethality (ArmorPenetration) -- 4th, clears the ≥4 threshold
          ],
        },
      })
    );
    const pro = { items: [{ itemId: 3020, share: 0.6 }], boots: [{ itemId: 3006, share: 0.4 }] };
    const richMeta = metaMap(
      ...Array.from(baseItemMetaMap().values()),
      meta(5001, { tags: ["Health", "Armor"] }),
      meta(5002, { tags: ["Armor"] }),
      meta(5003, { tags: ["Health", "SpellBlock"] }),
      meta(5004, { tags: ["Health"] }),
      meta(6001, { tags: ["SpellDamage"] }),
      meta(6003, { tags: ["SpellDamage"] }),
      meta(6004, { tags: ["MagicPenetration"] }),
      meta(6009, { tags: ["SpellDamage"] }),
      meta(6002, { tags: ["Damage", "ArmorPenetration"] }),
      meta(6010, { tags: ["CriticalStrike"] }),
      meta(6011, { tags: ["Damage"] }),
      meta(6012, { tags: ["ArmorPenetration"] })
    );
    const sets = buildItemSets(CHAMP, "Bot", build, pro, richMeta);
    expect(blockTypes(sets)).toEqual([
      "Starting",
      "Core build",
      "Buy order",
      "Pro build",
      "Highest WPA",
      "Tank",
      "AP/Mage",
      "AD/Lethality",
      "Situational swaps",
    ]);
  });
});

describe("buildItemSets — Starting block", () => {
  it("carries exactly the starter item, exempt from the 6-item rule", () => {
    const build = baseBuild(baseItems());
    const sets = buildItemSets(CHAMP, "Bot", build, null, baseItemMetaMap());
    const starting = findBlock(sets, "Starting")!;
    expect(starting.items).toEqual([{ id: "1054", count: 1 }]);
  });
});

describe("buildItemSets — Core build: 6 items, exactly 1 boots, no dupes, full items only", () => {
  it("standard fixture: first/second/third/boots/fourthPlus(2) => 6 items, boots in the historical slot", () => {
    const build = baseBuild(baseItems());
    const sets = buildItemSets(CHAMP, "Bot", build, null, baseItemMetaMap());
    const core = findBlock(sets, "Core build")!;
    expect(core.items.map((i) => i.id)).toEqual(["3031", "3036", "3095", "3006", "3072", "3046"]);
  });

  it("fourthPlus with 3 items (7 raw candidates) trims to exactly 6, still exactly 1 boots", () => {
    const build = baseBuild(baseItems({ fourthPlus: [pick(3072), pick(3046), pick(3153)] }));
    const sets = buildItemSets(CHAMP, "Bot", build, null, baseItemMetaMap());
    const core = findBlock(sets, "Core build")!;
    expect(core.items).toHaveLength(6);
    expect(core.items.filter((i) => i.id === "3006")).toHaveLength(1);
    const ids = core.items.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length); // no dupes
  });

  it("REGRESSION (live bug: 'a line with 2 boots') -- a second boots id reaching the core line via alts.boots/fourthPlus is deduped to the single highest-wpa one", () => {
    const build = baseBuild(
      baseItems({
        // 3157 will be flagged boots via alts.boots below; 3200 is a plain
        // non-boots 4th-plus item so the line still has enough real
        // candidates to reach 6 once the duplicate boots is dropped.
        fourthPlus: [pick(3072), pick(3157, 0.09), pick(3200, 0.05)],
        alts: { boots: [pick(3157, 0.09)] },
      })
    );
    const sets = buildItemSets(CHAMP, "Bot", build, null, baseItemMetaMap());
    const core = findBlock(sets, "Core build")!;
    expect(core.items).toHaveLength(6);
    // Exactly one of {3006, 3157} survives -- the higher-wpa one (3157, 0.09 > items.boots' default 0.02).
    const bootsPresent = core.items.filter((i) => i.id === "3006" || i.id === "3157");
    expect(bootsPresent).toHaveLength(1);
    expect(bootsPresent[0].id).toBe("3157");
    const ids = core.items.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length); // no dupes
  });

  it("never invents items: a maximally sparse fixture ships what exists rather than padding with junk", () => {
    // fourthPlus empty -> only first/second/third/boots = 4 candidates, no fallback pools at all.
    const build = baseBuild(baseItems({ fourthPlus: [] }));
    const sets = buildItemSets(CHAMP, "Bot", build, null, baseItemMetaMap());
    const core = findBlock(sets, "Core build")!;
    expect(core.items).toHaveLength(4); // ships what exists, not padded with invented ids
    expect(core.items.filter((i) => i.id === "3006")).toHaveLength(1);
  });

  it("REGRESSION (live bug: Dark Seal reached a build line) -- a non-full item (into non-empty) in fourthPlus is excluded from Core, never padded with a substitute when pools are empty", () => {
    const darkSeal = meta(1082, { tags: ["Health", "SpellDamage", "Lane"], into: ["3041"] }); // Mejai's -- a real, non-empty upgrade path
    const build = baseBuild(baseItems({ fourthPlus: [pick(3072), pick(1082, 0.09)] }));
    const richMeta = metaMap(...Array.from(baseItemMetaMap().values()), darkSeal);
    const sets = buildItemSets(CHAMP, "Bot", build, null, richMeta);
    const core = findBlock(sets, "Core build")!;
    expect(core.items.map((i) => i.id)).not.toContain("1082");
    expect(core.items).toHaveLength(5); // first/second/third/boots/3072 -- Dark Seal excluded, nothing to pad with here
  });

  it("an item with NO metadata entry at all is excluded from Core (never assume it's finished)", () => {
    const sparse = metaMap(meta(3031), meta(3036), meta(3095), bootsMeta(3006)); // 3072/3046 deliberately have no entry
    const build = baseBuild(baseItems());
    const sets = buildItemSets(CHAMP, "Bot", build, null, sparse);
    const core = findBlock(sets, "Core build")!;
    expect(core.items.map((i) => i.id)).toEqual(["3031", "3036", "3095", "3006"]); // 3072/3046 excluded, nothing to pad with
  });
});

describe("buildItemSets — Buy order (renamed from 'Optimized order'): 6 items, exactly 1 boots, no dupes, padded from the CORE remainder", () => {
  it("REGRESSION (live bug: 'optimized line with only 3 items') -- a 3-item optimizedPath is padded to exactly 6", () => {
    const build = baseBuild(
      baseItems({ optimizedPath: [pick(3095, 0.09), pick(3036, 0.08), pick(3072, 0.07)] })
    );
    const sets = buildItemSets(CHAMP, "Bot", build, null, baseItemMetaMap());
    const buyOrder = findBlock(sets, "Buy order")!;
    expect(buyOrder.items).toHaveLength(6);
    expect(buyOrder.items.filter((i) => i.id === "3006")).toHaveLength(1); // exactly one boots, inserted from core
    const ids = buyOrder.items.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length); // no dupes even though 3036/3072 also live in core
  });

  it("preserves the optimizedPath's own item order at the front of the line", () => {
    const build = baseBuild(baseItems({ optimizedPath: [pick(3020, 0.09), pick(3157, 0.08)] }));
    const sets = buildItemSets(CHAMP, "Bot", build, null, baseItemMetaMap());
    const buyOrder = findBlock(sets, "Buy order")!;
    expect(buyOrder.items.slice(0, 2).map((i) => i.id)).toEqual(["3020", "3157"]);
  });

  it("pads using the core remainder, not situational/pro pools", () => {
    const build = baseBuild(
      baseItems({
        optimizedPath: [pick(3046), pick(3072)], // 2-item path
        alts: { first: [pick(9999, 0.5)] }, // a high-wpa situational alt that must NOT leak in
      })
    );
    const pro = { items: [{ itemId: 8888, share: 0.99 }], boots: [] }; // must NOT leak in either
    const sets = buildItemSets(CHAMP, "Bot", build, pro, baseItemMetaMap());
    const buyOrder = findBlock(sets, "Buy order")!;
    const ids = buyOrder.items.map((i) => i.id);
    expect(ids).not.toContain("9999");
    expect(ids).not.toContain("8888");
    expect(ids).toHaveLength(6);
  });
});

describe("buildItemSets — Pro build: 6 items, exactly 1 boots, no dupes, full items only", () => {
  it("REGRESSION (live bug source: pro.boots carrying 2 entries) -- two pro-consensus boots dedupe to the higher-share one", () => {
    const build = baseBuild(baseItems());
    const pro = {
      items: [
        { itemId: 100, share: 0.9 },
        { itemId: 101, share: 0.8 },
        { itemId: 102, share: 0.7 },
        { itemId: 103, share: 0.6 },
        { itemId: 104, share: 0.5 },
      ],
      boots: [
        { itemId: 3006, share: 0.5 }, // higher share -- kept
        { itemId: 3111, share: 0.3 }, // lower share -- dropped
      ],
    };
    const sets = buildItemSets(CHAMP, "Bot", build, pro, baseItemMetaMap());
    const proBlock = findBlock(sets, "Pro build")!;
    expect(proBlock.items).toHaveLength(6);
    const bootsPresent = proBlock.items.filter((i) => i.id === "3006" || i.id === "3111");
    expect(bootsPresent).toHaveLength(1);
    expect(bootsPresent[0].id).toBe("3006");
    const ids = proBlock.items.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("boots-deduped keep-highest-pct also applies when the non-boots entries alone can't reach 6 (pads from optimized/situational)", () => {
    const build = baseBuild(baseItems({ alts: { first: [pick(9001, 0.05)] } }));
    const pro = {
      items: [{ itemId: 3020, share: 0.6 }],
      boots: [
        { itemId: 3006, share: 0.5 },
        { itemId: 3111, share: 0.9 }, // higher share -- kept
      ],
    };
    const sets = buildItemSets(CHAMP, "Bot", build, pro, baseItemMetaMap());
    const proBlock = findBlock(sets, "Pro build")!;
    const bootsPresent = proBlock.items.filter((i) => i.id === "3006" || i.id === "3111");
    expect(bootsPresent).toHaveLength(1);
    expect(bootsPresent[0].id).toBe("3111");
    expect(proBlock.items.map((i) => i.id)).toContain("9001"); // padded in from situational
  });

  it("REGRESSION (live bug: Dark Seal reached a Pro build line via pro-consensus) -- a non-full pro-consensus item never reaches the Pro build line", () => {
    const darkSeal = meta(1082, { tags: ["Health", "SpellDamage", "Lane"], into: ["3041"] });
    const build = baseBuild(baseItems());
    const pro = {
      // Dark Seal (1082) is allowlist-included in proConsensus.ts's own
      // isBuildItem for the Pro Consensus CARD's display, so it's a
      // realistic entry to see arrive here with a high share.
      items: [
        { itemId: 1082, share: 0.9 },
        { itemId: 100, share: 0.8 },
        { itemId: 101, share: 0.7 },
        { itemId: 102, share: 0.6 },
        { itemId: 103, share: 0.5 },
        { itemId: 104, share: 0.4 },
      ],
      boots: [{ itemId: 3006, share: 0.3 }],
    };
    const richMeta = metaMap(...Array.from(baseItemMetaMap().values()), darkSeal);
    const sets = buildItemSets(CHAMP, "Bot", build, pro, richMeta);
    const proBlock = findBlock(sets, "Pro build")!;
    expect(proBlock.items.map((i) => i.id)).not.toContain("1082");
    expect(proBlock.items).toHaveLength(6); // the 5 real full items + boots, Dark Seal correctly skipped
  });

  it("VERIFY-NOT-ASSUME (2026-07-22): isFullItem has NO allowlist escape hatch, checked against the REAL STARTING_ITEM_ALLOWLIST constant, not just Dark Seal", () => {
    // Companion round to proConsensus.ts's own hard directive ("Dark Seal
    // must never appear as a full/completed item anywhere"). The existing
    // Dark Seal-only regressions above prove isFullItem excludes id 1082
    // specifically; this proves the underlying INVARIANT generically -- if a
    // future edit ever gave isFullItem an "unless it's on the starting
    // allowlist" branch (i.e. re-imported proConsensus's rule instead of
    // staying deliberately narrower, per this module's own header comment),
    // this catches it for every current AND future allowlist entry, not just
    // the two ids hardcoded in the tests above. Real allowlist ids imported
    // directly from proConsensus.ts -- never re-derived/hardcoded here.
    const allowlistIds = Array.from(STARTING_ITEM_ALLOWLIST);
    // Worst-case-for-the-bug metadata: a real, non-empty `into` on every id
    // (the shape that actually needs isFullItem's rule, not the allowlist,
    // to exclude it -- an empty-into allowlist entry, e.g. Doran's Ring,
    // would pass as a genuine recipe-tree leaf regardless of the allowlist,
    // which is correct, separate behavior this test isn't exercising).
    const richMeta = metaMap(
      ...Array.from(baseItemMetaMap().values()),
      ...allowlistIds.map((id) => meta(id, { tags: ["Health"], into: ["999999"] }))
    );
    const build = baseBuild(
      baseItems({
        fourthPlus: allowlistIds.map((id) => pick(id, 0.09)),
      })
    );
    const pro = {
      items: allowlistIds.map((id, i) => ({ itemId: id, share: 0.9 - i * 0.01 })),
      boots: [],
    };
    const sets = buildItemSets(CHAMP, "Bot", build, pro, richMeta);
    for (const type of ["Core build", "Buy order", "Pro build", "Highest WPA"]) {
      const block = findBlock(sets, type);
      if (!block) continue;
      for (const allowId of allowlistIds) {
        expect(block.items.map((i) => i.id)).not.toContain(String(allowId));
      }
    }
    // Starting stays exempt (unaffected either way -- it renders items.starter
    // only, never consults fourthPlus/pro at all).
    expect(findBlock(sets, "Starting")!.items).toEqual([{ id: "1054", count: 1 }]);
  });
});

describe("buildItemSets — Situational swaps: cap 6, exempt from the one-boots rule AND the full-items rule", () => {
  it("caps at 6 even with more alternates available", () => {
    const alts = { first: Array.from({ length: 10 }, (_, i) => pick(9000 + i, 0.1 - i * 0.001)) };
    const build = baseBuild(baseItems({ alts }));
    const sets = buildItemSets(CHAMP, "Bot", build, null, baseItemMetaMap());
    const situational = findBlock(sets, "Situational swaps")!;
    expect(situational.items).toHaveLength(6);
  });

  it("may legitimately carry more than one boots option (swap suggestions, not a worn loadout)", () => {
    const alts = { boots: [pick(3111, 0.09), pick(3158, 0.08)] };
    const build = baseBuild(baseItems({ alts }));
    const sets = buildItemSets(CHAMP, "Bot", build, null, baseItemMetaMap());
    const situational = findBlock(sets, "Situational swaps")!;
    expect(situational.items.map((i) => i.id)).toEqual(expect.arrayContaining(["3111", "3158"]));
  });

  it("REGRESSION (live bug: Dark Seal must be allowed HERE, but never in a build line, in the SAME build) -- a non-full item in alts is kept in Situational and excluded from every build line", () => {
    const darkSeal = meta(1082, { tags: ["Health", "SpellDamage", "Lane"], into: ["3041"] });
    const build = baseBuild(baseItems({ alts: { first: [pick(1082, 0.09)] } }));
    const pro = { items: [{ itemId: 1082, share: 0.9 }, { itemId: 100, share: 0.5 }], boots: [] };
    const richMeta = metaMap(...Array.from(baseItemMetaMap().values()), darkSeal);
    const sets = buildItemSets(CHAMP, "Bot", build, pro, richMeta);

    const situational = findBlock(sets, "Situational swaps")!;
    expect(situational.items.map((i) => i.id)).toContain("1082"); // allowed here

    for (const type of [
      "Core build",
      "Buy order",
      "Pro build",
      "Highest WPA",
      "Tank",
      "AP/Mage",
      "AD/Lethality",
      "Attack Speed/On-hit",
      "Support/Utility",
    ]) {
      // Category blocks may render with a "(low data)" suffix -- match by
      // prefix so this loop still checks them regardless of which mode fired.
      const block = sets[0].blocks.find((b) => b.type === type || b.type.startsWith(`${type} (`));
      if (block) expect(block.items.map((i) => i.id)).not.toContain("1082"); // never in a build line
    }
  });
});

describe("buildItemSets — Highest WPA (v0.36.0, UNCHANGED by v0.43.0 — byte-identical regression pin)", () => {
  function richBuild(): BuildResponse {
    return baseBuild(
      baseItems({
        alts: {
          first: [
            pick(5001, 0.09), // Tank (Health+Armor)
            pick(5002, 0.08), // Tank (Armor)
            pick(5003, 0.07), // Tank (Health+SpellBlock)
            pick(6001, 0.06), // AP/Mage (SpellDamage)
            pick(6002, 0.05), // AD/Lethality (Damage+ArmorPenetration)
            pick(6003, 0.04), // AP/Mage (SpellDamage)
            pick(6004, 0.025), // AP/Mage (MagicPenetration)
          ],
          boots: [pick(3111, 0.03)], // Tank-tagged boots (SpellBlock) -- themed-boots preference case
        },
      })
    );
  }

  function richMeta(): Map<number, ItemDetail> {
    return metaMap(
      ...Array.from(baseItemMetaMap().values()),
      meta(5001, { tags: ["Health", "Armor"] }),
      meta(5002, { tags: ["Armor"] }),
      meta(5003, { tags: ["Health", "SpellBlock"] }),
      meta(6001, { tags: ["SpellDamage"] }),
      meta(6002, { tags: ["Damage", "ArmorPenetration"] }),
      meta(6003, { tags: ["SpellDamage"] }),
      meta(6004, { tags: ["MagicPenetration"] }),
      bootsMeta(3111, { tags: ["Boots", "SpellBlock"] })
    );
  }

  it("top-6 by weight across the WHOLE pool (core + situational), one boots (the best boots available, itself ranked by weight) -- exact same call/fixture shape as pre-v0.43.0", () => {
    const sets = buildItemSets(CHAMP, "Bot", richBuild(), null, richMeta());
    const line = findBlock(sets, "Highest WPA")!;
    expect(line.items).toHaveLength(6);
    expect(line.items.map((i) => i.id)).toEqual(["5001", "5002", "5003", "3111", "6001", "6002"]);
  });
});

// ── Archetype category lines (v0.43.0) ──────────────────────────────────────
// Replaces the old Tanky/Burst pair with Tank / AP-Mage / AD-Lethality /
// Attack Speed-On-hit / Support-Utility. `wideCatalogMeta` adds a catalog-
// only item pool (ids the champion's own build never recommends) per
// category, purely so the low-data fill path has real material to pad
// with — proving it reaches into item META, not just into the champ's own
// (absent) real picks.
function catalogItem(id: number, tags: string[], goldTotal = 2000): ItemDetail {
  return meta(id, { tags, goldTotal });
}

function wideCatalogMeta(): Map<number, ItemDetail> {
  return metaMap(
    ...Array.from(baseItemMetaMap().values()),
    catalogItem(7101, ["Health", "Armor"], 3200),
    catalogItem(7102, ["Armor"], 2900),
    catalogItem(7103, ["Health", "SpellBlock"], 2700),
    catalogItem(7104, ["Health"], 2500),
    catalogItem(7105, ["SpellBlock"], 2300),
    catalogItem(7201, ["SpellDamage"], 3300),
    catalogItem(7202, ["SpellDamage", "MagicPenetration"], 3100),
    catalogItem(7203, ["MagicPenetration"], 2800),
    catalogItem(7204, ["SpellDamage"], 2600),
    catalogItem(7205, ["SpellDamage"], 2400),
    catalogItem(7301, ["Damage", "ArmorPenetration"], 3400),
    catalogItem(7302, ["CriticalStrike"], 3000),
    catalogItem(7303, ["Damage"], 2900),
    catalogItem(7304, ["ArmorPenetration"], 2600),
    catalogItem(7305, ["CriticalStrike"], 2500),
    catalogItem(7401, ["AttackSpeed", "OnHit"], 3200),
    catalogItem(7402, ["AttackSpeed"], 2800),
    catalogItem(7403, ["OnHit"], 2600),
    catalogItem(7404, ["AttackSpeed"], 2400),
    catalogItem(7405, ["OnHit"], 2200),
    catalogItem(7501, ["Aura", "ManaRegen"], 2600),
    catalogItem(7502, ["GoldPer"], 900),
    catalogItem(7503, ["CooldownReduction"], 2400),
    catalogItem(7504, ["HealthRegen"], 2200),
    catalogItem(7505, ["Aura"], 2500)
  );
}

describe("buildItemSets — archetype category lines: measured (>=4 real tag-matched items)", () => {
  it("Tank: only Health/Armor/SpellBlock-tagged full items, boots preferred from WITHIN the theme when one exists", () => {
    const build = baseBuild(
      baseItems({
        alts: {
          first: [pick(5001, 0.09), pick(5002, 0.08), pick(5003, 0.07)],
          boots: [pick(3111, 0.03)],
        },
      })
    );
    const richMeta = metaMap(
      ...Array.from(baseItemMetaMap().values()),
      meta(5001, { tags: ["Health", "Armor"] }),
      meta(5002, { tags: ["Armor"] }),
      meta(5003, { tags: ["Health", "SpellBlock"] }),
      bootsMeta(3111, { tags: ["Boots", "SpellBlock"] })
    );
    const sets = buildItemSets(CHAMP, "Bot", build, null, richMeta);
    const line = findBlock(sets, "Tank")!;
    // 5001/5002/5003 (tank, non-boots) + 3111 (tank-tagged boots) -- exactly
    // 4 qualify (the live-data escape hatch opens the gate, and 4 clears
    // MIN_THEMED_POOL), so this is a MEASURED line, no "(low data)" suffix.
    expect(line.items.map((i) => i.id)).toEqual(["5001", "5002", "5003", "3111"]);
    expect(line.items.filter((i) => i.id === "3111")).toHaveLength(1);
  });

  it("a category line's candidates are also full-items-only (Dark Seal never reaches Tank even though it's Health-tagged)", () => {
    const darkSeal = meta(1082, { tags: ["Health", "SpellDamage", "Lane"], into: ["3041"] });
    const build = baseBuild(
      baseItems({
        alts: {
          first: [pick(1082, 0.5), pick(5001, 0.09), pick(5002, 0.08), pick(5003, 0.07), pick(5004, 0.06)],
        },
      })
    );
    const richWithDarkSeal = metaMap(
      ...Array.from(baseItemMetaMap().values()),
      darkSeal,
      meta(5001, { tags: ["Health", "Armor"] }),
      meta(5002, { tags: ["Armor"] }),
      meta(5003, { tags: ["Health"] }),
      meta(5004, { tags: ["Health"] })
    );
    const sets = buildItemSets(CHAMP, "Bot", build, null, richWithDarkSeal);
    const tank = findBlock(sets, "Tank");
    expect(tank).toBeDefined();
    expect(tank!.items.map((i) => i.id)).not.toContain("1082");
  });
});

describe("buildItemSets — archetype category lines: thin data is NEVER omitted once sensible (v0.43.0 user ask)", () => {
  it("fewer than 4 real tag-matched items -- ships a '(low data)' line instead of omitting (old pre-v0.43.0 behavior would have omitted this)", () => {
    // Only 3 Tank-tagged items -- one short of MIN_THEMED_POOL. CHAMP (Jinx)
    // carries no `tags`, so Tank is sensible ONLY via the live-data escape
    // hatch (poolLen 3 > 0).
    const build = baseBuild(
      baseItems({ alts: { first: [pick(5001, 0.09), pick(5002, 0.08), pick(5003, 0.07)] } })
    );
    const sparse = metaMap(
      ...Array.from(baseItemMetaMap().values()),
      meta(5001, { tags: ["Health"] }),
      meta(5002, { tags: ["Armor"] }),
      meta(5003, { tags: ["Health"] })
    );
    const sets = buildItemSets(CHAMP, "Bot", build, null, sparse);
    const tank = sets[0].blocks.find((b) => b.type.startsWith("Tank"));
    expect(tank).toBeDefined();
    expect(tank!.type).toBe("Tank (low data)"); // honest label -- never presented as measured
    expect(findBlock(sets, "AP/Mage")).toBeUndefined(); // zero qualifying items AND no archetype gate -- still omitted
    expect(findBlock(sets, "Highest WPA")).toBeDefined(); // Highest WPA's own pool-size gate is untouched
  });

  it("ZERO real tag-matched items, but the champion's ARCHETYPE gate is open -- still fills, exactly 6 items + exactly 1 boots, real per-champ boots folded in", () => {
    // CHAMP.tags carries "Support" here specifically to open the Support/
    // Utility gate with zero live per-champ support-tagged data at all --
    // proving the archetype gate alone (no live-data escape hatch needed)
    // is sufficient to trigger a fill.
    const champ: ChampionRef = { id: 902, key: "Milio", name: "Milio", icon: "milio.png", tags: ["Support"] };
    const build = baseBuild(baseItems());
    build.champion = champ;
    const sets = buildItemSets(champ, "Support", build, null, wideCatalogMeta());
    const support = sets[0].blocks.find((b) => b.type.startsWith("Support/Utility"))!;
    expect(support.type).toBe("Support/Utility (low data)");
    expect(support.items).toHaveLength(6);
    // Real boots (items.boots = 3006, tagged Boots via bootsMeta in
    // baseItemMetaMap) is folded in as the primary boots pick -- the fill
    // never invents a boots choice when the champ's own real one is known.
    const bootsInLine = support.items.filter((i) => i.id === "3006");
    expect(bootsInLine).toHaveLength(1);
    // The rest are catalog-default Support-tagged fills (7501-7505 range).
    const nonBootsIds = support.items.map((i) => i.id).filter((id) => id !== "3006");
    expect(nonBootsIds.every((id) => id.startsWith("75"))).toBe(true);
  });

  it("real per-item data (however little) always ranks ahead of catalog-default fill, never the reverse", () => {
    // One real AD/Lethality item (6002, high wpa) + a champion whose
    // archetype gate is open (Marksman) -- the real item must be PRESENT
    // in the resulting line even though it's far short of the ≥4 threshold,
    // not dropped in favor of pure catalog defaults.
    const champ: ChampionRef = { id: 51, key: "Caitlyn", name: "Caitlyn", icon: "cait.png", tags: ["Marksman"] };
    const build = baseBuild(baseItems({ alts: { first: [pick(6002, 0.5)] } }));
    build.champion = champ;
    const richMeta = metaMap(
      ...Array.from(wideCatalogMeta().values()),
      meta(6002, { tags: ["Damage", "ArmorPenetration"] })
    );
    const sets = buildItemSets(champ, "Bot", build, null, richMeta);
    const ad = sets[0].blocks.find((b) => b.type.startsWith("AD/Lethality"))!;
    expect(ad.type).toBe("AD/Lethality (low data)");
    expect(ad.items.map((i) => i.id)).toContain("6002");
    expect(ad.items).toHaveLength(6);
  });
});

describe("buildItemSets — archetype category lines: sensibility gating exemplars", () => {
  it("Yuumi (pure enchanter, id 350): no AD/Lethality or Attack Speed line; gets a Support/Utility fill", () => {
    const yuumi: ChampionRef = { id: 350, key: "Yuumi", name: "Yuumi", icon: "yuumi.png", tags: ["Support"] };
    const build = baseBuild(baseItems());
    build.champion = yuumi;
    const sets = buildItemSets(yuumi, "Support", build, null, wideCatalogMeta());
    expect(findBlock(sets, "AD/Lethality")).toBeUndefined();
    expect(sets[0].blocks.find((b) => b.type.startsWith("AD/Lethality"))).toBeUndefined();
    expect(sets[0].blocks.find((b) => b.type.startsWith("Attack Speed"))).toBeUndefined();
    expect(sets[0].blocks.find((b) => b.type.startsWith("Support/Utility"))).toBeDefined();
  });

  it("Malphite (tank-fighter, id 54, tags Tank+Fighter): gets Tank, AD/Lethality, Attack Speed; no AP/Mage or Support", () => {
    const malphite: ChampionRef = { id: 54, key: "Malphite", name: "Malphite", icon: "m.png", tags: ["Tank", "Fighter"] };
    const build = baseBuild(baseItems());
    build.champion = malphite;
    const sets = buildItemSets(malphite, "Top", build, null, wideCatalogMeta());
    expect(sets[0].blocks.find((b) => b.type.startsWith("Tank"))).toBeDefined();
    expect(sets[0].blocks.find((b) => b.type.startsWith("AD/Lethality"))).toBeDefined();
    expect(sets[0].blocks.find((b) => b.type.startsWith("Attack Speed"))).toBeDefined();
    expect(sets[0].blocks.find((b) => b.type.startsWith("AP/Mage"))).toBeUndefined();
    expect(sets[0].blocks.find((b) => b.type.startsWith("Support/Utility"))).toBeUndefined();
  });

  it("Zed (pure assassin, id 238, tags Assassin): gets ONLY AD/Lethality among the five categories", () => {
    const zed: ChampionRef = { id: 238, key: "Zed", name: "Zed", icon: "zed.png", tags: ["Assassin"] };
    const build = baseBuild(baseItems());
    build.champion = zed;
    const sets = buildItemSets(zed, "Mid", build, null, wideCatalogMeta());
    const categoryTitles = ["Tank", "AP/Mage", "AD/Lethality", "Attack Speed", "Support/Utility"];
    const present = categoryTitles.filter((t) => sets[0].blocks.some((b) => b.type.startsWith(t)));
    expect(present).toEqual(["AD/Lethality"]);
  });

  it("Ashe (CC-marksman hybrid, id 22, tags Marksman): gets AD/Lethality and Attack Speed/On-hit, not Tank/AP/Support", () => {
    const ashe: ChampionRef = { id: 22, key: "Ashe", name: "Ashe", icon: "ashe.png", tags: ["Marksman"] };
    const build = baseBuild(baseItems());
    build.champion = ashe;
    const sets = buildItemSets(ashe, "Bot", build, null, wideCatalogMeta());
    const categoryTitles = ["Tank", "AP/Mage", "AD/Lethality", "Attack Speed", "Support/Utility"];
    const present = categoryTitles.filter((t) => sets[0].blocks.some((b) => b.type.startsWith(t)));
    expect(present).toEqual(["AD/Lethality", "Attack Speed"]);
  });
});

describe("buildItemSets — archetype category lines: invariants hold in every mode (measured + low-data)", () => {
  it("no category line ever exceeds 6 items or carries more than 1 boots id, and every item resolves to a full item in the supplied meta", () => {
    const champ: ChampionRef = {
      id: 897,
      key: "KSante",
      name: "K'Sante",
      icon: "ksante.png",
      tags: ["Tank", "Fighter"],
    };
    const build = baseBuild(
      baseItems({
        alts: {
          first: [pick(5001, 0.09), pick(5002, 0.08), pick(5003, 0.07), pick(5004, 0.06)], // Tank, measured
        },
      })
    );
    build.champion = champ;
    const richMeta = metaMap(
      ...Array.from(wideCatalogMeta().values()),
      meta(5001, { tags: ["Health", "Armor"] }),
      meta(5002, { tags: ["Armor"] }),
      meta(5003, { tags: ["Health", "SpellBlock"] }),
      meta(5004, { tags: ["Health"] })
    );
    const sets = buildItemSets(champ, "Top", build, null, richMeta);
    const bootsIds = new Set(["3006"]); // items.boots default in baseItems()
    const categoryTypes = ["Tank", "AP/Mage", "AD/Lethality", "Attack Speed/On-hit", "Support/Utility"];
    for (const block of sets[0].blocks) {
      if (!categoryTypes.some((t) => block.type === t || block.type === `${t} (low data)`)) continue;
      expect(block.items.length).toBeLessThanOrEqual(6);
      const bootsCount = block.items.filter((i) => bootsIds.has(i.id)).length;
      expect(bootsCount).toBeLessThanOrEqual(1);
      for (const item of block.items) {
        const m = richMeta.get(Number(item.id));
        expect(m).toBeDefined();
        const isFull = (m!.tags.includes("Boots") && m!.from.length > 0) || m!.into.length === 0;
        expect(isFull).toBe(true);
      }
    }
  });
});

describe("champScopedReplacePrefix — v0.35.0 lane-flip stale-removal prefix", () => {
  it("is champ-scoped (NOT role-scoped) with a trailing space", () => {
    expect(champScopedReplacePrefix(CHAMP)).toBe("CoachBuild Jinx ");
  });

  it("matches both an old-lane title and an old-3-set-era title for the SAME champion", () => {
    const prefix = champScopedReplacePrefix(CHAMP);
    expect("CoachBuild Jinx Support".startsWith(prefix)).toBe(true);
    expect(`CoachBuild Jinx Bot — Core`.startsWith(prefix)).toBe(true);
  });

  it("does NOT match a different champion whose name starts with the same letters", () => {
    // Regression target: "CoachBuild Vi " must not swallow "CoachBuild Viktor ...".
    const vi: ChampionRef = { id: 254, key: "Vi", name: "Vi", icon: "vi.png" };
    const prefix = champScopedReplacePrefix(vi);
    expect("CoachBuild Viktor Mid".startsWith(prefix)).toBe(false);
  });

  it("mirrors companion.ps1's champ-scoped removal semantics for a multi-word/apostrophe champion name", () => {
    const champ: ChampionRef = { id: 145, key: "Kaisa", name: "Kai'Sa", icon: "k.png" };
    const prefix = champScopedReplacePrefix(champ);
    expect(prefix).toBe("CoachBuild Kai'Sa ");
    expect("CoachBuild Kai'Sa Bot".startsWith(prefix)).toBe(true);
    expect("CoachBuild Kai'Sa Support".startsWith(prefix)).toBe(true);
  });
});

describe("buildItemSets — companion.ps1 stale-set migration (prefix match, pinned web-side)", () => {
  // Mirrors Merge-ItemSets' own prefix computation (public/companion.ps1):
  //   $prefix = $newArr[0].title -replace ('\s+' + [char]0x2014 + '.*$'), ''
  // i.e. strip everything from " <EM DASH>" onward. Existing sets whose
  // title does NOT start with $prefix are kept; the rest are replaced.
  function psPrefixOf(title: string): string {
    return title.replace(/\s+—.*$/, "");
  }

  it("the new no-suffix title IS its own prefix (no em dash to strip)", () => {
    const build = baseBuild(baseItems());
    const sets = buildItemSets(CHAMP, "Bot", build, null, baseItemMetaMap());
    expect(psPrefixOf(sets[0].title)).toBe(sets[0].title);
  });

  it("old suffixed titles from the pre-restructure shape still start with the new prefix (auto-cleaned on next export)", () => {
    const build = baseBuild(baseItems());
    const sets = buildItemSets(CHAMP, "Bot", build, null, baseItemMetaMap());
    const prefix = psPrefixOf(sets[0].title);
    for (const suffix of ["Core", "Optimized", "Pro"]) {
      const oldTitle = `${sets[0].title} — ${suffix}`;
      expect(oldTitle.startsWith(prefix)).toBe(true);
    }
  });
});

describe("buildItemSets — single-set payload satisfies the wire contract (1-3 sets, companion.ps1 Test-ItemSetsPayload)", () => {
  it("sets array has exactly 1 entry, well within the 1-3 bound", () => {
    const build = baseBuild(baseItems());
    const sets = buildItemSets(CHAMP, "Bot", build, null, baseItemMetaMap());
    expect(sets.length).toBeGreaterThanOrEqual(1);
    expect(sets.length).toBeLessThanOrEqual(3);
    expect(sets).toHaveLength(1);
  });

  it("the set's title starts with 'CoachBuild' (companion bridge validation)", () => {
    const build = baseBuild(baseItems());
    const sets = buildItemSets(CHAMP, "Bot", build, null, baseItemMetaMap());
    expect(sets[0].title.startsWith("CoachBuild")).toBe(true);
  });
});
