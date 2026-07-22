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

// v0.47.0 — the non-archetype blocks. The archetype (damage-family) blocks are
// tested separately with dedicated fixtures; the structural describe blocks
// below care only about Core/Buy order/Pro/Situational/Highest WPA gating, so
// they filter to these to stay focused (and immune to a fixture id happening
// to collide with a curated archetype-pool id — see the archetype describes).
const STRUCTURAL_BLOCK_TYPES = new Set([
  "Starting",
  "Core build",
  "Buy order",
  "Pro build",
  "Highest WPA",
  "Situational swaps",
]);
function structuralBlockTypes(sets: ReturnType<typeof buildItemSets>): string[] {
  return blockTypes(sets).filter((t) => STRUCTURAL_BLOCK_TYPES.has(t));
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

describe("buildItemSets — block presence (structural blocks only)", () => {
  // NOTE: "Highest WPA" has no tag requirement, only a ≥4-qualifying-item
  // pool-size threshold — Core alone (6 full items) already clears it, so it
  // legitimately appears in almost every fixture below. The damage-family
  // archetype blocks (v0.47.0) are tested separately (see the "damage-family
  // archetype" describe blocks); these structural tests filter them out via
  // structuralBlockTypes so they stay focused on Core/Buy order/Pro/
  // Situational gating regardless of which family CHAMP's fixture resolves to.

  it("Starting + Core build (+ Highest WPA) when there's no optimizedPath, no pro data, no alts", () => {
    const build = baseBuild(baseItems());
    const sets = buildItemSets(CHAMP, "Bot", build, null, baseItemMetaMap());
    expect(structuralBlockTypes(sets)).toEqual(["Starting", "Core build", "Highest WPA"]);
  });

  it("adds Buy order when optimizedPath genuinely differs from the core prefix", () => {
    const build = baseBuild(baseItems({ optimizedPath: [pick(3046), pick(3072)] })); // reversed vs fourthPlus
    const sets = buildItemSets(CHAMP, "Bot", build, null, baseItemMetaMap());
    expect(structuralBlockTypes(sets)).toEqual(["Starting", "Core build", "Buy order", "Highest WPA"]);
  });

  it("excludes Buy order when optimizedPath is IDENTICAL to the core prefix", () => {
    const build = baseBuild(baseItems({ optimizedPath: [pick(3031), pick(3036)] })); // == [first, second]
    const sets = buildItemSets(CHAMP, "Bot", build, null, baseItemMetaMap());
    expect(structuralBlockTypes(sets)).toEqual(["Starting", "Core build", "Highest WPA"]);
  });

  it("excludes Buy order when optimizedPath is empty", () => {
    const build = baseBuild(baseItems({ optimizedPath: [] }));
    const sets = buildItemSets(CHAMP, "Bot", build, null, baseItemMetaMap());
    expect(structuralBlockTypes(sets)).toEqual(["Starting", "Core build", "Highest WPA"]);
  });

  it("adds Pro build when pro-consensus data is supplied and non-empty", () => {
    const build = baseBuild(baseItems());
    const pro = { items: [{ itemId: 3020, share: 0.6 }], boots: [{ itemId: 3006, share: 0.4 }] };
    const sets = buildItemSets(CHAMP, "Bot", build, pro, baseItemMetaMap());
    expect(structuralBlockTypes(sets)).toEqual(["Starting", "Core build", "Pro build", "Highest WPA"]);
  });

  it("omits Pro build when pro-consensus data is null/absent", () => {
    const build = baseBuild(baseItems());
    expect(structuralBlockTypes(buildItemSets(CHAMP, "Bot", build, null, baseItemMetaMap()))).toEqual([
      "Starting",
      "Core build",
      "Highest WPA",
    ]);
    expect(structuralBlockTypes(buildItemSets(CHAMP, "Bot", build, undefined, baseItemMetaMap()))).toEqual([
      "Starting",
      "Core build",
      "Highest WPA",
    ]);
  });

  it("omits Pro build when pro-consensus items AND boots are both empty (never an empty block)", () => {
    const build = baseBuild(baseItems());
    const sets = buildItemSets(CHAMP, "Bot", build, { items: [], boots: [] }, baseItemMetaMap());
    expect(structuralBlockTypes(sets)).toEqual(["Starting", "Core build", "Highest WPA"]);
  });

  it("adds Situational swaps only when alts exist; omits entirely otherwise", () => {
    const withAlts = buildItemSets(
      CHAMP,
      "Bot",
      baseBuild(baseItems({ alts: { first: [pick(9001, 0.05)] } })),
      null,
      baseItemMetaMap()
    );
    expect(structuralBlockTypes(withAlts)).toEqual([
      "Starting",
      "Core build",
      "Highest WPA",
      "Situational swaps",
    ]);

    const withoutAlts = buildItemSets(CHAMP, "Bot", baseBuild(baseItems()), null, baseItemMetaMap());
    expect(structuralBlockTypes(withoutAlts)).toEqual(["Starting", "Core build", "Highest WPA"]);
  });

  it("all blocks appear together in order for an AP champ: Starting, Core, Buy order, Pro, Highest WPA, AP/Mage, AP Burst, Tank Mage, Situational", () => {
    // v0.47.0 full-order check on a realistic AP champ (Viktor). Family
    // resolves to AP from his own items, so exactly the AP archetype set
    // (AP/Mage, AP Burst, Tank Mage) is emitted — never an AD line. Durable-AP
    // items in his alts give Tank Mage measured content.
    const viktor: ChampionRef = { id: 112, key: "Viktor", name: "Viktor", icon: "v.png", tags: ["Mage"] };
    const build = baseBuild(
      baseItems({
        starter: pick(1054),
        boots: pick(3020, 0.05),
        first: pick(6655, 0.09),
        second: pick(4645, 0.08),
        third: pick(3089, 0.07),
        fourthPlus: [pick(3135, 0.06), pick(3157, 0.055)],
        optimizedPath: [pick(3089, 0.09), pick(6655, 0.08)], // differs from core prefix -> Buy order
        alts: {
          first: [pick(3116, 0.05), pick(4633, 0.045), pick(6653, 0.04)], // durable AP (Rylai's/Riftmaker/Liandry's)
        },
      })
    );
    build.champion = viktor;
    const pro = { items: [{ itemId: 3135, share: 0.6 }], boots: [{ itemId: 3020, share: 0.4 }] };
    const richMeta = metaMap(
      meta(1054),
      bootsMeta(3020, { tags: ["Boots", "MagicPenetration"] }),
      meta(6655, { tags: ["SpellDamage", "Mana"] }),
      meta(4645, { tags: ["SpellDamage", "MagicPenetration"] }),
      meta(3089, { tags: ["SpellDamage"] }),
      meta(3135, { tags: ["SpellDamage", "MagicPenetration"] }),
      meta(3157, { tags: ["SpellDamage", "Armor"] }),
      meta(3116, { tags: ["SpellDamage", "Health"] }),
      meta(4633, { tags: ["SpellDamage", "Health"] }),
      meta(6653, { tags: ["SpellDamage", "Health"] })
    );
    const sets = buildItemSets(viktor, "Mid", build, pro, richMeta);
    expect(blockTypes(sets)).toEqual([
      "Starting",
      "Core build",
      "Buy order",
      "Pro build",
      "Highest WPA",
      "AP/Mage",
      "AP Burst",
      "Tank Mage",
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

    // Every block EXCEPT Starting/Situational is a full-item build line (Core/
    // Buy order/Pro/Highest WPA + any damage-family archetype line, measured or
    // "(low data)") -- Dark Seal (1082) must never reach any of them.
    for (const block of sets[0].blocks) {
      if (block.type === "Starting" || block.type === "Situational swaps") continue;
      expect(block.items.map((i) => i.id)).not.toContain("1082");
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

// ── Damage-family archetype lines (v0.47.0) ─────────────────────────────────
// Fixtures use ids in a "safe" range (5000-5999) that DO NOT collide with any
// curated archetype-pool id (the pools reference real ~16.13 ids — 30xx/31xx/
// 32xx/33xx/37xx/38xx/46xx/66xx/67xx/68xx — all avoided here), so a curated
// FILL can never leak a fixture id and confuse an assertion. `catalogMeta`
// supplies a broad, tagged catalog so the low-data FILL path has material.
const AP1 = 5201; // pure AP (SpellDamage)
const AP2 = 5202; // pure AP (SpellDamage + MagicPenetration)
const AP3 = 5203; // pure AP (SpellDamage)
const TM1 = 5211; // tank mage (SpellDamage + Health)
const TM2 = 5212; // tank mage (SpellDamage + Armor)
const TM3 = 5213; // tank mage (SpellDamage + SpellBlock)
const TK1 = 5101; // pure tank (Health + Armor)
const TK2 = 5102; // pure tank (Armor)
const TK3 = 5103; // pure tank (Health + SpellBlock)
const TK4 = 5104; // pure tank (Health)
const LE1 = 5301; // lethality (Damage + ArmorPenetration)
const LE2 = 5302; // lethality (ArmorPenetration)
const LE3 = 5303; // lethality (Damage, no durability/AS/crit)
const CR1 = 5401; // crit (CriticalStrike)
const CR2 = 5402; // crit (CriticalStrike + Damage)
const CR3 = 5403; // crit (CriticalStrike)
const OH1 = 5501; // on-hit (AttackSpeed + OnHit)
const OH2 = 5502; // on-hit (AttackSpeed)
const OH3 = 5503; // on-hit (OnHit)
const BR1 = 5601; // bruiser (Damage + Health)
const BR2 = 5602; // bruiser (ArmorPenetration + Health)
const BR3 = 5603; // bruiser (Damage + Armor)
const STARTER = 5000;
const BOOTS = 5900; // plain boots
const BOOTS_MR = 5901; // MR boots

function damageMeta(): Map<number, ItemDetail> {
  return metaMap(
    meta(STARTER),
    bootsMeta(BOOTS),
    bootsMeta(BOOTS_MR, { tags: ["Boots", "SpellBlock"] }),
    meta(AP1, { tags: ["SpellDamage"] }),
    meta(AP2, { tags: ["SpellDamage", "MagicPenetration"] }),
    meta(AP3, { tags: ["SpellDamage"] }),
    meta(TM1, { tags: ["SpellDamage", "Health"] }),
    meta(TM2, { tags: ["SpellDamage", "Armor"] }),
    meta(TM3, { tags: ["SpellDamage", "SpellBlock"] }),
    meta(TK1, { tags: ["Health", "Armor"] }),
    meta(TK2, { tags: ["Armor"] }),
    meta(TK3, { tags: ["Health", "SpellBlock"] }),
    meta(TK4, { tags: ["Health"] }),
    meta(LE1, { tags: ["Damage", "ArmorPenetration"] }),
    meta(LE2, { tags: ["ArmorPenetration"] }),
    meta(LE3, { tags: ["Damage"] }),
    meta(CR1, { tags: ["CriticalStrike"] }),
    meta(CR2, { tags: ["CriticalStrike", "Damage"] }),
    meta(CR3, { tags: ["CriticalStrike"] }),
    meta(OH1, { tags: ["AttackSpeed", "OnHit"] }),
    meta(OH2, { tags: ["AttackSpeed"] }),
    meta(OH3, { tags: ["OnHit"] }),
    meta(BR1, { tags: ["Damage", "Health"] }),
    meta(BR2, { tags: ["ArmorPenetration", "Health"] }),
    meta(BR3, { tags: ["Damage", "Armor"] })
  );
}

/** A build whose CORE is the given clean id set (so family resolution is
 *  unambiguous), with optional `alts`. core = [starter, boots, first, second,
 *  third, ...fourthPlus]. */
function famBuild(champ: ChampionRef, core: number[], alts?: ItemsBlock["alts"]): BuildResponse {
  const [starter, boots, first, second, third, ...rest] = core;
  const b = baseBuild(
    baseItems({
      starter: pick(starter),
      boots: pick(boots, 0.05),
      first: pick(first, 0.09),
      second: pick(second, 0.08),
      third: pick(third, 0.07),
      fourthPlus: rest.map((id, i) => pick(id, 0.06 - i * 0.005)),
      ...(alts ? { alts } : {}),
    })
  );
  b.champion = champ;
  return b;
}

function presentArchetypes(sets: ReturnType<typeof buildItemSets>): string[] {
  const titles = ["Tank Mage", "Tank", "AP/Mage", "AP Burst", "Bruiser (AD)", "Lethality/Assassin", "Crit/Marksman", "On-hit"];
  // Longest-first so "Tank Mage" isn't swallowed by "Tank"; report each once.
  const found = new Set<string>();
  for (const b of sets[0].blocks) {
    for (const t of titles) {
      if (b.type === t || b.type === `${t} (low data)`) found.add(t);
    }
  }
  return titles.filter((t) => found.has(t));
}

describe("buildItemSets — v0.47.0 AP family (Viktor 'tank mage' acceptance)", () => {
  const VIKTOR: ChampionRef = { id: 112, key: "Viktor", name: "Viktor", icon: "v.png", tags: ["Mage"] };

  it("Viktor emits AP/Mage, AP Burst AND Tank Mage; NEVER AD/On-hit/Attack-Speed or pure Tank", () => {
    // Core = pure AP (family resolves AP); alts add durable-AP so Tank Mage
    // has real measured content — the user's exact screenshot archetype.
    const build = famBuild(
      VIKTOR,
      [STARTER, BOOTS, AP1, AP2, AP3],
      { first: [pick(TM1, 0.06), pick(TM2, 0.055), pick(TM3, 0.05)] }
    );
    const sets = buildItemSets(VIKTOR, "Mid", build, null, damageMeta());
    const present = presentArchetypes(sets);
    expect(present).toContain("AP/Mage");
    expect(present).toContain("AP Burst");
    expect(present).toContain("Tank Mage");
    // No cross-family lines, no pure Tank (Viktor tankiness 0, no Tank tag).
    expect(present).not.toContain("Bruiser (AD)");
    expect(present).not.toContain("Lethality/Assassin");
    expect(present).not.toContain("Crit/Marksman");
    expect(present).not.toContain("On-hit");
    expect(present).not.toContain("Tank");
  });

  it("Viktor's Tank Mage line carries durable-AP items (SpellDamage + Health/Armor/MR), not glass-cannon-only", () => {
    const build = famBuild(
      VIKTOR,
      [STARTER, BOOTS, AP1, AP2, AP3],
      { first: [pick(TM1, 0.06), pick(TM2, 0.055), pick(TM3, 0.05)] }
    );
    const sets = buildItemSets(VIKTOR, "Mid", build, null, damageMeta());
    const tankMage = sets[0].blocks.find((b) => b.type.startsWith("Tank Mage"))!;
    const nonBoots = tankMage.items.map((i) => Number(i.id)).filter((id) => id !== BOOTS && id !== BOOTS_MR);
    expect(nonBoots.length).toBeGreaterThanOrEqual(3);
    // Every non-boots pick is a DURABLE-AP item (SpellDamage + a durability tag).
    for (const id of nonBoots) {
      const m = damageMeta().get(id)!;
      expect(m.tags).toContain("SpellDamage");
      expect(m.tags.some((t) => ["Health", "Armor", "SpellBlock"].includes(t))).toBe(true);
    }
  });

  it("Viktor's Tank Mage fills from the curated durable-AP pool (Rylai's/Riftmaker/Abyssal) when his own data is thin", () => {
    // No durable-AP in his build -> low data -> fills from the curated pool.
    // Meta includes the real curated ids (incl. Abyssal Mask, which carries NO
    // SpellDamage tag — proving the curated list is trusted verbatim).
    const build = famBuild(VIKTOR, [STARTER, BOOTS, AP1, AP2, AP3]);
    const richMeta = metaMap(
      ...Array.from(damageMeta().values()),
      meta(3116, { tags: ["SpellDamage", "Health"] }), // Rylai's
      meta(4633, { tags: ["SpellDamage", "Health"] }), // Riftmaker
      meta(3001, { tags: ["MagicResist", "Health"] }) // Abyssal Mask (no SpellDamage tag)
    );
    const sets = buildItemSets(VIKTOR, "Mid", build, null, richMeta);
    const tankMage = sets[0].blocks.find((b) => b.type.startsWith("Tank Mage"))!;
    expect(tankMage.type).toBe("Tank Mage (low data)");
    const ids = tankMage.items.map((i) => i.id);
    expect(ids).toEqual(expect.arrayContaining(["3116", "4633"]));
    expect(ids).toContain("3001"); // Abyssal via curated verbatim, despite no SpellDamage tag
  });
});

describe("buildItemSets — v0.47.0 AD family (bruiser / marksman / assassin)", () => {
  it("a bruiser (Renekton, Fighter) emits the AD family (Bruiser (AD) + On-hit), NEVER AP", () => {
    const renekton: ChampionRef = { id: 58, key: "Renekton", name: "Renekton", icon: "r.png", tags: ["Fighter"] };
    const build = famBuild(
      renekton,
      [STARTER, BOOTS, BR1, BR2, LE1],
      { first: [pick(OH1, 0.05), pick(OH2, 0.045), pick(OH3, 0.04)] }
    );
    const sets = buildItemSets(renekton, "Top", build, null, damageMeta());
    const present = presentArchetypes(sets);
    expect(present).toContain("Bruiser (AD)");
    expect(present).toContain("On-hit");
    // AD family -> never an AP line.
    expect(present).not.toContain("AP/Mage");
    expect(present).not.toContain("AP Burst");
    expect(present).not.toContain("Tank Mage");
    // Fighter is neither Assassin nor Marksman -> no Lethality/Crit.
    expect(present).not.toContain("Lethality/Assassin");
    expect(present).not.toContain("Crit/Marksman");
  });

  it("a marksman (Caitlyn) emits Crit/Marksman + On-hit; an assassin (Zed) emits ONLY Lethality/Assassin", () => {
    const caitlyn: ChampionRef = { id: 51, key: "Caitlyn", name: "Caitlyn", icon: "c.png", tags: ["Marksman"] };
    const caitBuild = famBuild(
      caitlyn,
      [STARTER, BOOTS, CR1, CR2, CR3],
      { first: [pick(OH1, 0.05), pick(OH2, 0.045), pick(OH3, 0.04)] }
    );
    const caitSets = buildItemSets(caitlyn, "Bot", caitBuild, null, damageMeta());
    const caitPresent = presentArchetypes(caitSets);
    expect(caitPresent).toEqual(expect.arrayContaining(["Crit/Marksman", "On-hit"]));
    expect(caitPresent).not.toContain("AP/Mage");
    expect(caitPresent).not.toContain("Bruiser (AD)"); // Marksman isn't Fighter

    const zed: ChampionRef = { id: 238, key: "Zed", name: "Zed", icon: "z.png", tags: ["Assassin"] };
    const zedBuild = famBuild(zed, [STARTER, BOOTS, LE1, LE2, LE3]);
    const zedSets = buildItemSets(zed, "Mid", zedBuild, null, damageMeta());
    expect(presentArchetypes(zedSets)).toEqual(["Lethality/Assassin"]);
  });

  it("real per-item data always ranks ahead of curated/catalog fill in an AD line", () => {
    // One real high-wpa Crit item in an otherwise-thin build; it must be
    // PRESENT (and first) even though it's short of the measured threshold.
    const caitlyn: ChampionRef = { id: 51, key: "Caitlyn", name: "Caitlyn", icon: "c.png", tags: ["Marksman"] };
    const build = famBuild(caitlyn, [STARTER, BOOTS, LE1, LE2, LE3], { first: [pick(CR1, 0.5)] });
    const sets = buildItemSets(caitlyn, "Bot", build, null, damageMeta());
    const crit = sets[0].blocks.find((b) => b.type.startsWith("Crit/Marksman"))!;
    expect(crit.type).toBe("Crit/Marksman (low data)");
    expect(crit.items.map((i) => i.id)).toContain(String(CR1));
    expect(crit.items[0].id).toBe(String(CR1)); // real data ranks first
    expect(crit.items).toHaveLength(4); // capped at CATEGORY_LINE_LEN
  });
});

describe("buildItemSets — v0.47.0 pure Tank (universal, actual tanks only)", () => {
  it("an actual tank (Ornn, Tank tag) emits pure Tank and NO damage-family low-data noise", () => {
    const ornn: ChampionRef = { id: 516, key: "Ornn", name: "Ornn", icon: "o.png", tags: ["Tank"] };
    const build = famBuild(ornn, [STARTER, BOOTS, TK1, TK2, TK3], { first: [pick(TK4, 0.06)] });
    const sets = buildItemSets(ornn, "Top", build, null, damageMeta());
    const present = presentArchetypes(sets);
    expect(present).toContain("Tank");
    // Ornn has no damage items and only a Tank tag -> family is NOT confident,
    // so no hollow catalog-filled AP/AD damage archetypes appear.
    expect(present).not.toContain("AP/Mage");
    expect(present).not.toContain("AP Burst");
    expect(present).not.toContain("Bruiser (AD)");
    const tank = sets[0].blocks.find((b) => b.type === "Tank")!;
    expect(tank.type).toBe("Tank"); // measured (4 tank items), no "(low data)"
  });

  it("a squishy mage (Viktor) does NOT get a pure Tank line even with an Armor-carrying AP item", () => {
    const viktor: ChampionRef = { id: 112, key: "Viktor", name: "Viktor", icon: "v.png", tags: ["Mage"] };
    // TM2 is SpellDamage+Armor (Zhonya's-like) — it belongs to Tank MAGE, not
    // pure Tank; pure Tank stays closed (tankiness 0, no Tank tag).
    const build = famBuild(viktor, [STARTER, BOOTS, AP1, AP2, TM2]);
    const sets = buildItemSets(viktor, "Mid", build, null, damageMeta());
    expect(presentArchetypes(sets)).not.toContain("Tank");
    expect(presentArchetypes(sets)).toContain("Tank Mage"); // the Armor AP item lands here
  });
});

describe("buildItemSets — v0.47.0 archetype invariants (every mode)", () => {
  it("no archetype line exceeds 4 items or carries >1 boots, and every item is a full item; Dark Seal never reaches one", () => {
    const ksante: ChampionRef = { id: 897, key: "KSante", name: "K'Sante", icon: "k.png", tags: ["Tank", "Fighter"] };
    const darkSeal = meta(1082, { tags: ["Health", "SpellDamage", "Lane"], into: ["3041"] });
    const build = famBuild(
      ksante,
      [STARTER, BOOTS, BR1, BR2, BR3],
      { first: [pick(TK1, 0.06), pick(TK2, 0.055), pick(TK3, 0.05), pick(TK4, 0.045), pick(1082, 0.5)] }
    );
    const richMeta = metaMap(...Array.from(damageMeta().values()), darkSeal);
    const sets = buildItemSets(ksante, "Top", build, null, richMeta);
    const bootsIds = new Set([String(BOOTS), String(BOOTS_MR)]);
    for (const block of sets[0].blocks) {
      if (STRUCTURAL_BLOCK_TYPES.has(block.type)) continue;
      // Every non-structural block is a damage-family archetype line.
      expect(block.items.length).toBeLessThanOrEqual(4);
      expect(block.items.filter((i) => bootsIds.has(i.id)).length).toBeLessThanOrEqual(1);
      expect(block.items.map((i) => i.id)).not.toContain("1082"); // Dark Seal excluded
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

// ── v0.47.0 — Viktor set JSON + byte budget ──────────────────────────────────
// The 413 payload guard from v0.46.0 (a single set must stay well under the LCU
// per-object limit; the 413 came from ACCUMULATION of many sets, never one) is
// re-proven here with the new damage-family archetypes — a Viktor set carries
// its Tank Mage block AND stays in budget, and a maximally-full set (4 category
// blocks) still fits comfortably under 4KB.
const ARCHETYPE_TITLE_RE = /^(Tank Mage|Tank|AP\/Mage|AP Burst|Bruiser \(AD\)|Lethality\/Assassin|Crit\/Marksman|On-hit)( \(low data\))?$/;

describe("buildItemSets — v0.47.0 Viktor set JSON (Tank Mage present + in byte budget)", () => {
  const VIKTOR: ChampionRef = { id: 112, key: "Viktor", name: "Viktor", icon: "viktor.png", tags: ["Mage"] };

  // Realistic durable-AP Viktor (the user's screenshot): Luden's, Shadowflame,
  // Rabadon's + durable-AP (Rylai's/Riftmaker/Zhonya's) + Sorcerer's Shoes.
  function viktorMeta(): Map<number, ItemDetail> {
    return metaMap(
      meta(1054),
      bootsMeta(3020, { tags: ["Boots", "MagicPenetration"] }), // Sorcerer's Shoes
      meta(6655, { tags: ["SpellDamage", "Mana", "AbilityHaste"] }), // Luden's
      meta(4645, { tags: ["SpellDamage", "MagicPenetration"] }), // Shadowflame
      meta(3089, { tags: ["SpellDamage"] }), // Rabadon's
      meta(3116, { tags: ["SpellDamage", "Health"] }), // Rylai's (durable AP)
      meta(4633, { tags: ["SpellDamage", "Health"] }), // Riftmaker (durable AP)
      meta(3157, { tags: ["SpellDamage", "Armor"] }) // Zhonya's (durable AP)
    );
  }

  function viktorBuild(): BuildResponse {
    const b = baseBuild(
      baseItems({
        starter: pick(1054),
        boots: pick(3020, 0.05),
        first: pick(6655, 0.09),
        second: pick(4645, 0.08),
        third: pick(3089, 0.07),
        fourthPlus: [pick(3116, 0.06), pick(3157, 0.055)],
        alts: { first: [pick(4633, 0.05)] },
      })
    );
    b.champion = VIKTOR;
    return b;
  }

  it("a Viktor set JSON contains a Tank Mage block whose items are all durable-AP, and the whole set is in byte budget", () => {
    const sets = buildItemSets(VIKTOR, "Mid", viktorBuild(), null, viktorMeta());
    const set = sets[0];
    const json = JSON.stringify(set);

    const tankMage = set.blocks.find((b) => b.type.startsWith("Tank Mage"));
    expect(tankMage).toBeDefined();
    const nonBoots = tankMage!.items.map((i) => Number(i.id)).filter((id) => id !== 3020);
    for (const id of nonBoots) {
      const m = viktorMeta().get(id)!;
      expect(m.tags).toContain("SpellDamage");
      expect(m.tags.some((t) => ["Health", "Armor", "SpellBlock"].includes(t))).toBe(true);
    }
    // Never a cross-family AD line.
    for (const t of ["Bruiser (AD)", "Lethality/Assassin", "Crit/Marksman", "On-hit"]) {
      expect(set.blocks.some((b) => b.type.startsWith(t))).toBe(false);
    }

    const bytes = Buffer.byteLength(json, "utf8");
    // eslint-disable-next-line no-console
    console.log(`[v0.47 viktor] set = ${bytes} bytes across ${set.blocks.length} blocks: ${blockTypes(sets).join(", ")}`);
    expect(bytes).toBeLessThan(4096);
  });
});

describe("buildItemSets — v0.47.0 maximally-full set byte budget", () => {
  // A bruiser-tank-assassin: AD family (confident) opens Bruiser + Lethality +
  // On-hit sub-lean archetypes, plus universal Tank -> 4 category blocks
  // (CATEGORY_MAX_EMIT). With Starting/Core/Buy order/Pro/Highest WPA/
  // Situational that's the largest set the code emits (10 blocks).
  const BRUISER: ChampionRef = { id: 999, key: "Bruiser", name: "Bruiser", icon: "b.png", tags: ["Fighter", "Tank", "Assassin"] };

  function fullMeta(): Map<number, ItemDetail> {
    return metaMap(
      meta(STARTER),
      bootsMeta(BOOTS_MR, { tags: ["Boots", "SpellBlock"] }),
      meta(BR1, { tags: ["Damage", "Health"] }),
      meta(BR2, { tags: ["ArmorPenetration", "Health"] }),
      meta(BR3, { tags: ["Damage", "Armor"] }),
      meta(LE1, { tags: ["Damage", "ArmorPenetration"] }),
      meta(LE2, { tags: ["ArmorPenetration"] }),
      meta(LE3, { tags: ["Damage"] }),
      meta(OH1, { tags: ["AttackSpeed", "OnHit"] }),
      meta(OH2, { tags: ["AttackSpeed"] }),
      meta(OH3, { tags: ["OnHit"] }),
      meta(TK1, { tags: ["Health", "Armor"] }),
      meta(TK2, { tags: ["Armor"] }),
      meta(TK3, { tags: ["Health", "SpellBlock"] })
    );
  }

  it("a maximally-full single set (4 category blocks + all others) serializes well under 4KB, and reports the budget", () => {
    const build = baseBuild(
      baseItems({
        starter: pick(STARTER),
        boots: pick(BOOTS_MR, 0.05),
        first: pick(BR1, 0.09),
        second: pick(BR2, 0.08),
        third: pick(LE1, 0.07),
        fourthPlus: [pick(OH1, 0.06), pick(TK1, 0.055)],
        optimizedPath: [pick(LE1, 0.09), pick(BR1, 0.08)], // differs from core -> Buy order
        alts: {
          first: [
            pick(BR3, 0.05),
            pick(LE2, 0.048),
            pick(LE3, 0.046),
            pick(OH2, 0.044),
            pick(OH3, 0.042),
            pick(TK2, 0.04),
            pick(TK3, 0.038),
          ],
        },
      })
    );
    build.champion = BRUISER;
    const pro = { items: [{ itemId: BR1, share: 0.5 }, { itemId: BR2, share: 0.3 }], boots: [{ itemId: BOOTS_MR, share: 0.4 }] };
    const sets = buildItemSets(BRUISER, "Top", build, pro, fullMeta());
    const set = sets[0];

    const categoryBlocks = set.blocks.filter((b) => ARCHETYPE_TITLE_RE.test(b.type));
    expect(categoryBlocks.length).toBeGreaterThanOrEqual(3);
    expect(categoryBlocks.length).toBeLessThanOrEqual(4); // CATEGORY_MAX_EMIT

    const bytes = Buffer.byteLength(JSON.stringify(set), "utf8");
    // eslint-disable-next-line no-console
    console.log(
      `[v0.47 budget] maximal set: ${bytes} bytes across ${set.blocks.length} blocks ` +
        `(${categoryBlocks.length} archetype blocks): ${blockTypes(sets).join(", ")}`
    );
    expect(bytes).toBeLessThan(4096);
  });
});
