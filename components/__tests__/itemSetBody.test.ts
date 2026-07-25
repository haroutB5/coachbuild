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
  // pool-size threshold. The damage-family archetype blocks (v0.47.0) are tested
  // separately (see the "damage-family archetype" describe blocks); these
  // structural tests filter them out via structuralBlockTypes so they stay
  // focused on Core/Buy order/Pro/Situational gating regardless of which family
  // CHAMP's fixture resolves to.
  //
  // AUDIT P1-B changes what "present" means here. The pool-size threshold is a
  // NECESSARY condition for Highest WPA, not a sufficient one: a block also has
  // to be a DIFFERENT BUILD from every higher-priority block. `baseItems()` is
  // exactly 5 full items + boots and nothing else, so the whole candidate pool
  // IS the core build — every ordering of it lands on the same six ids, and
  // Highest WPA is Core build wearing a second name. It is now dropped, which is
  // the whole point of the fix. Fixtures below that WANT a second block
  // therefore have to supply a second build (see the alts case).

  it("Starting + Core build ONLY when there's no optimizedPath, no pro data, no alts — Highest WPA would be the core build under another name (P1-B)", () => {
    const build = baseBuild(baseItems());
    const sets = buildItemSets(CHAMP, "Bot", build, null, baseItemMetaMap());
    expect(structuralBlockTypes(sets)).toEqual(["Starting", "Core build"]);
  });

  it("adds Buy order when optimizedPath genuinely differs from the core prefix", () => {
    const build = baseBuild(baseItems({ optimizedPath: [pick(3046), pick(3072)] })); // reversed vs fourthPlus
    const sets = buildItemSets(CHAMP, "Bot", build, null, baseItemMetaMap());
    // Buy order carries the SAME six ids in a different ORDER — and survives,
    // because expressing the order is its entire purpose (the one carve-out in
    // the otherwise order-insensitive duplicate test).
    expect(structuralBlockTypes(sets)).toEqual(["Starting", "Core build", "Buy order"]);
    const [core, buy] = ["Core build", "Buy order"].map((t) => findBlock(sets, t)!.items.map((i) => i.id));
    expect([...core].sort()).toEqual([...buy].sort());
    expect(core).not.toEqual(buy);
  });

  it("excludes Buy order when optimizedPath is IDENTICAL to the core prefix", () => {
    const build = baseBuild(baseItems({ optimizedPath: [pick(3031), pick(3036)] })); // == [first, second]
    const sets = buildItemSets(CHAMP, "Bot", build, null, baseItemMetaMap());
    expect(structuralBlockTypes(sets)).toEqual(["Starting", "Core build"]);
  });

  it("excludes Buy order when optimizedPath is empty", () => {
    const build = baseBuild(baseItems({ optimizedPath: [] }));
    const sets = buildItemSets(CHAMP, "Bot", build, null, baseItemMetaMap());
    expect(structuralBlockTypes(sets)).toEqual(["Starting", "Core build"]);
  });

  it("adds Pro build when pro-consensus data is supplied and non-empty", () => {
    const build = baseBuild(baseItems());
    const pro = { items: [{ itemId: 3020, share: 0.6 }], boots: [{ itemId: 3006, share: 0.4 }] };
    const sets = buildItemSets(CHAMP, "Bot", build, pro, baseItemMetaMap());
    expect(structuralBlockTypes(sets)).toEqual(["Starting", "Core build", "Pro build"]);
    // Pro build survives because 3020 (pro-only) makes it a genuinely different
    // build; Highest WPA does not, because 3020 has no measured WPA at all and
    // is therefore FILL that never displaces a WPA-bearing item (P1-A).
    expect(findBlock(sets, "Pro build")!.items.map((i) => i.id)).toContain("3020");
  });

  it("omits Pro build when pro-consensus data is null/absent", () => {
    const build = baseBuild(baseItems());
    expect(structuralBlockTypes(buildItemSets(CHAMP, "Bot", build, null, baseItemMetaMap()))).toEqual([
      "Starting",
      "Core build",
    ]);
    expect(structuralBlockTypes(buildItemSets(CHAMP, "Bot", build, undefined, baseItemMetaMap()))).toEqual([
      "Starting",
      "Core build",
    ]);
  });

  it("omits Pro build when pro-consensus items AND boots are both empty (never an empty block)", () => {
    const build = baseBuild(baseItems());
    const sets = buildItemSets(CHAMP, "Bot", build, { items: [], boots: [] }, baseItemMetaMap());
    expect(structuralBlockTypes(sets)).toEqual(["Starting", "Core build"]);
  });

  it("adds Situational swaps only when alts exist; omits entirely otherwise", () => {
    // 9001 outranks every core pick on WPA, so Highest WPA is a genuinely
    // different build here and survives alongside Core build.
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
    expect(structuralBlockTypes(withoutAlts)).toEqual(["Starting", "Core build"]);
  });

  it("all blocks appear together in canonical order for an AP champ: Starting, Core, Buy order, Pro, Tank Mage, Situational (AP/Mage + AP Burst + Highest WPA all collapse into Core build)", () => {
    // v0.48.0 full-order check on a realistic AP champ (Viktor). Family resolves
    // to AP from his own items, so the AP archetype set is considered.
    //
    // AUDIT P1-B: this used to expect Highest WPA AND AP/Mage as separate
    // blocks. Both carry EXACTLY the same six ids as Core build — Viktor's whole
    // recommended pool is AP, so "his AP items ranked by WPA" and "his core
    // build" are the same build three times over. That is the duplication the
    // user complained about in v0.48.0, still firing between families. Only the
    // curated Tank Mage (durable-AP, distinct by construction) genuinely differs
    // and survives. Net: ONE standard build + ONE distinct off-meta variant.
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
      "Tank Mage (low data)",
      "Situational swaps",
    ]);
    // The survivors are all genuinely different builds — the guarantee the block
    // list above is really asserting.
    const sigs = sets[0].blocks
      .filter((b) => b.type !== "Starting" && b.type !== "Situational swaps")
      .map((b) => b.items.map((i) => i.id).sort().join(","));
    // Core build and Buy order share ids (same build, refined order); nothing else does.
    expect(new Set(sigs).size).toBe(sigs.length - 1);
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
const TK5 = 5105; // pure tank (Health + Armor) — 5th item, fills a 6-slot line
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
    meta(TK5, { tags: ["Health", "Armor"] }),
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
  // All THREE evidence states count as "present" — the audit's P1-C fix added
  // "(suggested)" for a line with zero measured non-boots items, and a helper
  // that only knew two states would silently under-report a block that IS in
  // the set (which is exactly how it failed when the suffix landed).
  const found = new Set<string>();
  for (const b of sets[0].blocks) {
    for (const t of titles) {
      if (b.type === t || b.type === `${t} (low data)` || b.type === `${t} (suggested)`) found.add(t);
    }
  }
  return titles.filter((t) => found.has(t));
}

// v0.48.0 — a realistic AP catalog (real ~16.13 ids covering the AP_MAGE /
// AP_BURST / TANK_MAGE curated pools) so AP/Mage and AP Burst pad from their
// curated pools to full builds and collapse EXACTLY as in prod. The abstract
// damageMeta lacks curated ids, so AP/Mage's broad catalog fill would pull the
// durable TM* items and inflate the line, masking the collapse — use this
// wherever the AP-family de-dup behaviour is under test.
function apRichMeta(): Map<number, ItemDetail> {
  return metaMap(
    meta(1054),
    bootsMeta(3020, { tags: ["Boots", "MagicPenetration"] }), // Sorcerer's Shoes
    meta(6655, { tags: ["SpellDamage", "Mana"] }), // Luden's
    meta(4645, { tags: ["SpellDamage", "MagicPenetration"] }), // Shadowflame
    meta(3089, { tags: ["SpellDamage"] }), // Rabadon's
    meta(3135, { tags: ["SpellDamage", "MagicPenetration"] }), // Void Staff
    meta(6653, { tags: ["SpellDamage", "Health"] }), // Liandry's (AP_MAGE curated)
    meta(3157, { tags: ["SpellDamage", "Armor"] }), // Zhonya's (AP_MAGE curated)
    meta(4646, { tags: ["SpellDamage", "MagicPenetration"] }), // Stormsurge (AP_BURST)
    meta(4628, { tags: ["SpellDamage", "MagicPenetration"] }), // Horizon Focus (AP_BURST)
    meta(3100, { tags: ["SpellDamage"] }), // Lich Bane (AP_BURST)
    meta(6657, { tags: ["SpellDamage", "Health", "Mana"] }), // Rod of Ages (TANK_MAGE)
    meta(4633, { tags: ["SpellDamage", "Health"] }), // Riftmaker (TANK_MAGE)
    meta(3116, { tags: ["SpellDamage", "Health"] }), // Rylai's (TANK_MAGE)
    meta(4629, { tags: ["SpellDamage", "MagicPenetration"] }), // Cosmic Drive (TANK_MAGE)
    meta(3001, { tags: ["MagicResist", "Health"] }) // Abyssal Mask (TANK_MAGE, no SpellDamage)
  );
}
// Realistic pure-burst Viktor: real burst core, no durable-AP in his own data.
function apRichBurstBuild(champ: ChampionRef): BuildResponse {
  const b = baseBuild(
    baseItems({
      starter: pick(1054),
      boots: pick(3020, 0.05),
      first: pick(6655, 0.09),
      second: pick(4645, 0.08),
      third: pick(3089, 0.07),
      fourthPlus: [pick(3135, 0.06)],
    })
  );
  b.champion = champ;
  return b;
}

describe("buildItemSets — v0.47.0 AP family (Viktor 'tank mage' acceptance)", () => {
  const VIKTOR: ChampionRef = { id: 112, key: "Viktor", name: "Viktor", icon: "v.png", tags: ["Mage"] };

  it("Viktor emits exactly ONE standard AP build + a distinct Tank Mage (AP Burst DE-DUPED); NEVER AD/On-hit/Attack-Speed or pure Tank", () => {
    // v0.48.0: realistic pure-burst Viktor. AP/Mage and AP Burst both pad from
    // their curated pools to near-identical builds (share 4/5) -> de-dup
    // collapses AP Burst into the higher-priority AP/Mage. Tank Mage (curated
    // durable-AP) is distinct by construction and survives. The user's exact
    // ask: don't duplicate, show one AP build + one coherent Tank Mage.
    const sets = buildItemSets(VIKTOR, "Mid", apRichBurstBuild(VIKTOR), null, apRichMeta());
    const present = presentArchetypes(sets);
    expect(present).toContain("AP/Mage");
    expect(present).toContain("Tank Mage");
    expect(present).not.toContain("AP Burst"); // collapsed into AP/Mage by de-dup
    // No cross-family lines, no pure Tank (Viktor tankiness 0, no Tank tag).
    expect(present).not.toContain("Bruiser (AD)");
    expect(present).not.toContain("Lethality/Assassin");
    expect(present).not.toContain("Crit/Marksman");
    expect(present).not.toContain("On-hit");
    expect(present).not.toContain("Tank");
  });

  it("DE-DUP: no two BUILD-LINE blocks for Viktor share an identical item set, AND Tank Mage != the core build", () => {
    // The general de-dup guarantee. AUDIT P1-B widened it from
    // archetype-vs-archetype to EVERY family, so this now asserts across all
    // build-line blocks — which is what the user actually sees in the shop panel
    // and where the 11 live duplicates were hiding. (Viktor's AP/Mage line IS
    // his core build here, so it is one of the blocks that collapses.)
    const build = famBuild(
      VIKTOR,
      [STARTER, BOOTS, AP1, AP2, AP3],
      { first: [pick(TM1, 0.06), pick(TM2, 0.055), pick(TM3, 0.05)] }
    );
    const sets = buildItemSets(VIKTOR, "Mid", build, null, damageMeta());
    const lineBlocks = sets[0].blocks.filter(
      (b) => b.type !== "Starting" && b.type !== "Situational swaps"
    );
    const sig = (b: (typeof lineBlocks)[number]) =>
      b.items
        .map((i) => Number(i.id))
        .sort((x, y) => x - y)
        .join(",");
    const sigs = lineBlocks.map(sig);
    expect(new Set(sigs).size).toBe(sigs.length); // every emitted line is a distinct build

    const core = lineBlocks.find((b) => b.type === "Core build")!;
    const tm = lineBlocks.find((b) => b.type.startsWith("Tank Mage"))!;
    expect(sig(tm)).not.toBe(sig(core)); // Tank Mage is NOT the standard build
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

  it("Viktor's Tank Mage is a CURATED durable-AP build (Rylai's/Riftmaker/Abyssal) even when his own data has zero durable-AP — and is labelled '(suggested)'", () => {
    // v0.48.0: Tank Mage is curated-pool-driven, so it produces a coherent
    // durable build straight from the curated pool regardless of the champ's
    // (pure-burst) data — the whole point of a "variant" archetype. Meta
    // includes the real curated ids (incl. Abyssal Mask, which carries NO
    // SpellDamage tag — proving the curated list is trusted verbatim, not
    // re-filtered through `match`).
    //
    // AUDIT P1-C: this assertion used to read `toBe("Tank Mage")` — a curated
    // variant could never be labelled at ANY fill level, because the label was
    // keyed off `arch.curated`. This fixture's own name says it: the champ has
    // ZERO durable-AP data, so 100% of this line is judgment. A bare title
    // sitting next to an "(On-hit) (low data)" block reads as the
    // better-evidenced of the two, which inverts the truth and breaks HARD RULE
    // 4. The label now follows the EVIDENCE (zero measured -> "(suggested)"),
    // not the flag, for curated and data-first archetypes alike.
    const build = famBuild(VIKTOR, [STARTER, BOOTS, AP1, AP2, AP3]);
    const richMeta = metaMap(
      ...Array.from(damageMeta().values()),
      meta(3116, { tags: ["SpellDamage", "Health"] }), // Rylai's
      meta(4633, { tags: ["SpellDamage", "Health"] }), // Riftmaker
      meta(3001, { tags: ["MagicResist", "Health"] }) // Abyssal Mask (no SpellDamage tag)
    );
    const sets = buildItemSets(VIKTOR, "Mid", build, null, richMeta);
    const tankMage = sets[0].blocks.find((b) => b.type.startsWith("Tank Mage"))!;
    expect(tankMage.type).toBe("Tank Mage (suggested)"); // 100% judgment fill, labelled as such
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

  it("real per-item data always ranks ahead of curated/catalog fill in an AD line, padded to a full 6-item build", () => {
    // One real high-wpa Crit item in an otherwise-thin build; it must be
    // PRESENT (and first) even though it's short of the measured threshold, and
    // the line pads to a full 6 items (v0.48.0) from the curated crit pool.
    const caitlyn: ChampionRef = { id: 51, key: "Caitlyn", name: "Caitlyn", icon: "c.png", tags: ["Marksman"] };
    const build = famBuild(caitlyn, [STARTER, BOOTS, LE1, LE2, LE3], { first: [pick(CR1, 0.5)] });
    // Enrich with real curated crit-pool ids so the fill can reach a full build
    // (in prod itemMeta is the whole catalog; the minimal damageMeta is not).
    const richMeta = metaMap(
      ...Array.from(damageMeta().values()),
      meta(3031, { tags: ["CriticalStrike", "Damage"] }), // Infinity Edge
      meta(3094, { tags: ["CriticalStrike", "AttackSpeed"] }), // Rapid Firecannon
      meta(3087, { tags: ["CriticalStrike", "AttackSpeed"] }) // Statikk Shiv
    );
    const sets = buildItemSets(caitlyn, "Bot", build, null, richMeta);
    const crit = sets[0].blocks.find((b) => b.type.startsWith("Crit/Marksman"))!;
    expect(crit.type).toBe("Crit/Marksman (low data)");
    expect(crit.items.map((i) => i.id)).toContain(String(CR1));
    expect(crit.items[0].id).toBe(String(CR1)); // real data ranks first
    expect(crit.items).toHaveLength(6); // full build (CATEGORY_LINE_LEN = 6)
    expect(crit.items.filter((i) => i.id === String(BOOTS) || i.id === String(BOOTS_MR))).toHaveLength(1);
  });

  it("v0.48.0 — a bruiser's AD VARIANT (Bruiser (AD), curated) is a distinct build from its Lethality/On-hit DATA builds", () => {
    // The AD-family analogue of the Tank Mage guarantee: the durable AD variant
    // is curated from real bruiser itemization, NOT a mirror of the champ's
    // lethality/on-hit data build. A Fighter+Assassin champ opens Bruiser
    // (curated) + Lethality (data) + On-hit (data); Bruiser must not equal
    // either. Curated bruiser-pool ids present in meta so it resolves to 6.
    const champ: ChampionRef = { id: 39, key: "Irelia", name: "Irelia", icon: "i.png", tags: ["Fighter", "Assassin"] };
    const build = famBuild(
      champ,
      [STARTER, BOOTS, LE1, LE2, LE3], // real data leans lethality
      { first: [pick(OH1, 0.05), pick(OH2, 0.045), pick(OH3, 0.04)] }
    );
    const richMeta = metaMap(
      ...Array.from(damageMeta().values()),
      // Curated Bruiser (AD) pool: Stridebreaker, Black Cleaver, Sundered Sky,
      // Death's Dance, Sterak's, Titanic, Trinity, Hullbreaker.
      meta(6631, { tags: ["Damage", "Health"] }),
      meta(3071, { tags: ["Damage", "ArmorPenetration", "Health"] }),
      meta(6610, { tags: ["Damage", "Health"] }),
      meta(6333, { tags: ["Damage", "Health"] }),
      meta(3053, { tags: ["Damage", "Health"] }),
      meta(3748, { tags: ["Damage", "Health"] }),
      meta(3078, { tags: ["Damage", "Health"] }),
      meta(3181, { tags: ["Damage", "Health"] })
    );
    const sets = buildItemSets(champ, "Top", build, null, richMeta);
    const present = presentArchetypes(sets);
    expect(present).toContain("Bruiser (AD)");
    expect(present).toContain("Lethality/Assassin");

    const nonBootsSig = (type: string) => {
      const b = sets[0].blocks.find((x) => x.type.startsWith(type))!;
      return b.items
        .map((i) => Number(i.id))
        .filter((id) => id !== BOOTS && id !== BOOTS_MR)
        .sort((a, c) => a - c)
        .join(",");
    };
    const bruiser = sets[0].blocks.find((b) => b.type.startsWith("Bruiser (AD)"))!;
    // AUDIT P1-C: Irelia's own data is lethality/on-hit — ZERO items satisfy the
    // bruiser `match`, so this whole line is the curated pool. That is the exact
    // shape the live Ornn Top `Bruiser (AD)` had, and it must say so.
    expect(bruiser.type).toBe("Bruiser (AD) (suggested)");
    expect(bruiser.items).toHaveLength(6);
    expect(nonBootsSig("Bruiser (AD)")).not.toBe(nonBootsSig("Lethality/Assassin"));
    if (present.includes("On-hit")) {
      expect(nonBootsSig("Bruiser (AD)")).not.toBe(nonBootsSig("On-hit"));
    }
    // Every Bruiser item is a durable-AD staple (Damage/ArmorPen + a durability tag).
    for (const item of bruiser.items) {
      const id = Number(item.id);
      if (id === BOOTS || id === BOOTS_MR) continue;
      const m = richMeta.get(id)!;
      expect(m.tags.some((t) => ["Damage", "ArmorPenetration"].includes(t))).toBe(true);
      expect(m.tags.some((t) => ["Health", "Armor", "SpellBlock"].includes(t))).toBe(true);
    }
  });
});

describe("buildItemSets — v0.48.0 de-dup keep-priority + determinism", () => {
  const VIKTOR: ChampionRef = { id: 112, key: "Viktor", name: "Viktor", icon: "v.png", tags: ["Mage"] };

  it("when AP/Mage and AP Burst collapse, the HIGHER-priority name (AP/Mage) is the one kept", () => {
    // Pure-burst Viktor (realistic catalog): AP/Mage and AP Burst pad to
    // near-identical builds -> de-dup keeps AP/Mage (higher in
    // ARCHETYPE_PRIORITY) and drops AP Burst.
    const sets = buildItemSets(VIKTOR, "Mid", apRichBurstBuild(VIKTOR), null, apRichMeta());
    const titles = sets[0].blocks.map((b) => b.type);
    expect(titles.some((t) => t.startsWith("AP/Mage"))).toBe(true);
    expect(titles.some((t) => t.startsWith("AP Burst"))).toBe(false);
  });

  it("de-dup is deterministic: building the same input twice yields byte-identical output", () => {
    const a = buildItemSets(VIKTOR, "Mid", apRichBurstBuild(VIKTOR), null, apRichMeta());
    const b = buildItemSets(VIKTOR, "Mid", apRichBurstBuild(VIKTOR), null, apRichMeta());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
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
    // 4 real tank items against a 6-slot line (5 non-boots + boots) means one
    // slot is curated FILL, so the line must carry "(low data)".
    //
    // This assertion used to read `toBe("Tank")` with the comment "measured (4
    // tank items)". That was written when CATEGORY_LINE_LEN was 4 and 3 real
    // items genuinely filled the line; the length went 4 -> 6 in v0.48.0 and
    // MIN_CATEGORY_MEASURED stayed at a hardcoded 3, so this test went on
    // asserting that a partially-fabricated line was measured. The threshold is
    // now derived from the line length, and the assertion follows the rule
    // rather than the old constant.
    const tank = sets[0].blocks.find((b) => b.type.startsWith("Tank"))!;
    expect(tank.type).toBe("Tank (low data)");
  });

  it("a tank with a FULL line of its own items is measured — no '(low data)' / '(suggested)' suffix", () => {
    // The complement of the case above, and the reason the threshold is
    // `CATEGORY_LINE_LEN - 1` rather than a literal: 5 real non-boots items
    // fill every non-boots slot, so nothing is padded in from judgment and the
    // line is honestly titled plain.
    //
    // The core carries ONE non-tank item (LE3) on purpose. Without it every
    // block this champ produces is the same six tank ids, the P1-B cross-family
    // de-dup collapses Tank into Core build, and there is no Tank title left to
    // assert on — correct behaviour, but it makes the label unobservable. One
    // damage item is also what a real tank's build looks like.
    const ornn: ChampionRef = { id: 516, key: "Ornn", name: "Ornn", icon: "o.png", tags: ["Tank"] };
    const build = famBuild(ornn, [STARTER, BOOTS, TK1, TK2, LE3], {
      first: [pick(TK3, 0.06), pick(TK4, 0.055), pick(TK5, 0.05)],
    });
    const sets = buildItemSets(ornn, "Top", build, null, damageMeta());
    const tank = sets[0].blocks.find((b) => b.type.startsWith("Tank") && !b.type.startsWith("Tank Mage"))!;
    expect(tank.type).toBe("Tank");
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
  it("no archetype line exceeds 6 items or carries >1 boots, and every item is a full item; Dark Seal never reaches one", () => {
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
      // Every non-structural block is a damage-family archetype line (now a
      // FULL 6-item build, v0.48.0 — CATEGORY_LINE_LEN raised 4 -> 6).
      expect(block.items.length).toBeLessThanOrEqual(6);
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

// ─────────────────────────────────────────────────────────────────────────────
// AUDIT 2026-07-25 — P1-A / P1-B / P1-C
//
// Every test below would have PASSED against the pre-audit module for the wrong
// reason or failed to exist at all. The suite was green at 1551 tests while all
// three bugs were live in production, so each fix gets a test written from the
// LIVE REPRODUCTION rather than from the code.
// ─────────────────────────────────────────────────────────────────────────────

describe("AUDIT P1-A — WPA and pro-share are never compared as one scale", () => {
  // Live WPA runs about -3.94 .. +1.35 and is frequently NEGATIVE; a pro share
  // is a proportion in 0..1. The old unionPool kept the MAX raw weight across
  // the two, so both directions of nonsense were reachable.

  /** A champ whose own build carries a mix of high and NEGATIVE WPA, with two
   *  higher-WPA alternates so the WPA ordering is genuinely a different build
   *  from the core one (otherwise the block is correctly deduped away and there
   *  is nothing to assert on). */
  function mixedScaleBuild() {
    const items = baseItems({
      starter: pick(1054),
      boots: pick(3006, 0.05),
      first: pick(3031, 1.2), // best WPA
      second: pick(3036, 0.4),
      third: pick(3095, -2.5), // ACTIVELY HARMFUL by its own measurement
      fourthPlus: [pick(3072, 0.3), pick(3046, 0.1)],
      alts: { first: [pick(9001, 0.9), pick(9999, 0.8)] },
    });
    return baseBuild(items);
  }

  it("a 0.95 pro share does NOT lift a NEGATIVE-WPA item into the block titled 'Highest WPA'", () => {
    // The exact live shape: Jinx Bot's 3rd 'Highest WPA' entry was there on a
    // 0.67 pro pick-rate alone. Under the old max-raw-weight union, 3095's
    // share of 0.95 beat every WPA below 0.95 — two numbers with no common
    // meaning — and it climbed to the top of the block. Its own measurement
    // (-2.5) says the item is actively harmful; whatever else it earns, it
    // cannot earn a place in a list sorted by that measurement.
    const pro = {
      items: [
        { itemId: 3095, share: 0.95 }, // the -2.5 WPA item, adored by pros
        { itemId: 3200, share: 0.9 }, // pro-ONLY: no measured WPA at all
      ],
      boots: [{ itemId: 3006, share: 0.5 }],
    };
    const sets = buildItemSets(CHAMP, "Bot", mixedScaleBuild(), pro, baseItemMetaMap());
    const nonBoots = findBlock(sets, "Highest WPA")!.items.map((i) => i.id).filter((id) => id !== "3006");
    // Strict WPA order: 3031 (1.2) > 9001 (0.9) > 9999 (0.8) > 3036 (0.4) > 3072 (0.3).
    expect(nonBoots).toEqual(["3031", "9001", "9999", "3036", "3072"]);
    expect(nonBoots).not.toContain("3095"); // 0.95 share buys nothing here
    expect(nonBoots).not.toContain("3200"); // and neither does 0.90
  });

  it("an item with NO measured WPA is FILL — appended after every WPA-bearing item, never interleaved above one", () => {
    // 3200 exists only in the pro sample, so it has no WPA at all. The old code
    // gave it weight 0.9 (its share) and ranked it above every item whose
    // measured WPA happened to be below 0.9 — which, live, is most of them.
    // (alts.boots 3157 carries a higher WPA than the core boots, which is what
    // makes this block a different build from Core build and keeps it emitted.)
    const pro = {
      items: [
        { itemId: 3200, share: 0.9 },
        { itemId: 8888, share: 0.85 },
      ],
      boots: [],
    };
    const build = baseBuild(
      baseItems({
        boots: pick(3006, 0.05),
        first: pick(3031, 0.5),
        second: pick(3036, 0.4),
        third: pick(3095, 0.3),
        fourthPlus: [pick(3072, 0.2)], // only FOUR measured non-boots -> the 5th slot is fill
        alts: { boots: [pick(3157, 0.6)] },
      })
    );
    const sets = buildItemSets(CHAMP, "Bot", build, pro, baseItemMetaMap());
    const block = findBlock(sets, "Highest WPA")!;
    const bootsIds: string[] = ["3006", "3157"];
    const bootsSeen = block.items.map((i) => i.id).filter((id) => bootsIds.includes(id));
    expect(bootsSeen).toEqual(["3157"]); // the highest-WPA boots, exactly one
    const nonBoots = block.items.map((i) => i.id).filter((id) => !bootsIds.includes(id));
    expect(nonBoots).toEqual(["3031", "3036", "3095", "3072", "3200"]);
  });

  it("'Highest WPA' is ordered by WPA for EVERY fixture in this sweep — the title is a checkable claim, not a label", () => {
    // The generalised form of the two cases above: whatever the pools, the
    // block either honours its own title or must not carry that title.
    const cases: { build: BuildResponse; pro: Parameters<typeof buildItemSets>[3] }[] = [
      { build: mixedScaleBuild(), pro: null },
      { build: mixedScaleBuild(), pro: { items: [{ itemId: 3095, share: 0.99 }], boots: [] } },
      { build: mixedScaleBuild(), pro: { items: [{ itemId: 3200, share: 0.99 }, { itemId: 8888, share: 0.98 }], boots: [{ itemId: 3111, share: 0.97 }] } },
      {
        build: baseBuild(baseItems({ alts: { first: [pick(9001, 3.0), pick(9999, -1.0)] } })),
        pro: { items: [{ itemId: 8888, share: 0.8 }], boots: [{ itemId: 3111, share: 0.7 }] },
      },
    ];
    for (const { build, pro } of cases) {
      const sets = buildItemSets(CHAMP, "Bot", build, pro, baseItemMetaMap());
      const block = findBlock(sets, "Highest WPA");
      if (!block) continue; // collapsed into a higher-priority block — fine
      const wpaOf = new Map<number, number>();
      const it = build.items;
      const all = [
        it.first, it.second, it.third, it.boots, ...it.fourthPlus,
        ...(it.optimizedPath ?? []),
        ...(it.alts?.first ?? []), ...(it.alts?.second ?? []),
        ...(it.alts?.third ?? []), ...(it.alts?.boots ?? []), ...(it.alts?.fourthPlus ?? []),
      ].filter(Boolean) as Pick[];
      for (const p of all) {
        const prev = wpaOf.get(p.id);
        if (prev === undefined || p.wpa > prev) wpaOf.set(p.id, p.wpa); // MAX within one scale — legal
      }
      const bootsIds = new Set([it.boots.id, ...(it.alts?.boots ?? []).map((b) => b.id), ...(pro?.boots ?? []).map((b) => b.itemId)]);
      const seq = block.items.map((i) => Number(i.id)).filter((id) => !bootsIds.has(id));
      const bearing = seq.filter((id) => wpaOf.has(id));
      const fillStart = seq.findIndex((id) => !wpaOf.has(id));
      // 1. no FILL above a metric-bearing item
      if (fillStart >= 0) expect(seq.slice(fillStart).every((id) => !wpaOf.has(id))).toBe(true);
      // 2. metric-bearing items are non-increasing in WPA
      for (let k = 1; k < bearing.length; k++) {
        expect(wpaOf.get(bearing[k])!).toBeLessThanOrEqual(wpaOf.get(bearing[k - 1])!);
      }
    }
  });
});

describe("AUDIT P1-B — de-dup spans block FAMILIES, not just archetype-vs-archetype", () => {
  it("Highest WPA that is the core build under another name is DROPPED; Core build survives", () => {
    // Ornn Top live: `Highest WPA` and `Tank` were byte-identical. The general
    // shape is any block whose item SET already appeared in a higher-priority
    // block.
    const sets = buildItemSets(CHAMP, "Bot", baseBuild(baseItems()), null, baseItemMetaMap());
    const types = blockTypes(sets);
    expect(types).toContain("Core build");
    expect(types).not.toContain("Highest WPA");
  });

  it("the duplicate test is ORDER-INSENSITIVE — a merely REORDERED copy is still a duplicate (the Garen 'Pro build == Highest WPA' case)", () => {
    // Garen Top shipped Pro build and Highest WPA with the same five items in a
    // different order. Reading them as different builds is exactly the mistake:
    // the shop panel shows the user two identical shopping lists.
    // Here the pro sample is the champ's own core, so the Pro line resolves to
    // the same ids in share order rather than build order.
    const pro = {
      items: [
        { itemId: 3046, share: 0.9 },
        { itemId: 3072, share: 0.8 },
        { itemId: 3095, share: 0.7 },
        { itemId: 3036, share: 0.6 },
        { itemId: 3031, share: 0.5 },
      ],
      boots: [{ itemId: 3006, share: 0.95 }],
    };
    const sets = buildItemSets(CHAMP, "Bot", baseBuild(baseItems()), pro, baseItemMetaMap());
    const lineTypes = blockTypes(sets).filter((t) => t !== "Starting" && t !== "Situational swaps");
    expect(lineTypes).toEqual(["Core build"]);
  });

  it("Core build vs Buy order is the ONE order-SENSITIVE pair: same ids in a different order keeps BOTH", () => {
    const sets = buildItemSets(
      CHAMP,
      "Bot",
      baseBuild(baseItems({ optimizedPath: [pick(3046), pick(3072)] })),
      null,
      baseItemMetaMap()
    );
    const core = findBlock(sets, "Core build")!.items.map((i) => i.id);
    const buy = findBlock(sets, "Buy order")!.items.map((i) => i.id);
    expect([...core].sort()).toEqual([...buy].sort()); // same SET
    expect(core).not.toEqual(buy); // different ORDER — which is Buy order's whole point
  });

  it("keep-priority follows canonical emission order: the block a user reads FIRST is the survivor", () => {
    // 9001 (wpa 3.0) makes Highest WPA a distinct build from Core; the Tank-ish
    // archetype line that would mirror it is the one dropped, never Core build.
    const build = baseBuild(baseItems({ alts: { first: [pick(9001, 3.0)] } }));
    const sets = buildItemSets(CHAMP, "Bot", build, null, baseItemMetaMap());
    const types = blockTypes(sets);
    expect(types.indexOf("Core build")).toBeLessThan(types.indexOf("Highest WPA"));
    // and no two build-line blocks carry the same item set
    const lineBlocks = sets[0].blocks.filter((b) => b.type !== "Starting" && b.type !== "Situational swaps");
    const sigs = lineBlocks.map((b) => b.items.map((i) => i.id).sort().join(","));
    expect(new Set(sigs).size).toBe(sigs.length);
  });

  it("no two build-line blocks EVER share an item set, across every fixture in this file", () => {
    const fixtures: { build: BuildResponse; pro: Parameters<typeof buildItemSets>[3]; meta: Map<number, ItemDetail> }[] = [
      { build: baseBuild(baseItems()), pro: null, meta: baseItemMetaMap() },
      { build: baseBuild(baseItems({ optimizedPath: [pick(3046), pick(3072)] })), pro: null, meta: baseItemMetaMap() },
      {
        build: baseBuild(baseItems({ alts: { first: [pick(9001, 0.5), pick(9999, 0.4)] } })),
        pro: { items: [{ itemId: 8888, share: 0.9 }], boots: [{ itemId: 3111, share: 0.8 }] },
        meta: baseItemMetaMap(),
      },
      { build: apRichBurstBuild({ id: 112, key: "Viktor", name: "Viktor", icon: "v.png", tags: ["Mage"] }), pro: null, meta: apRichMeta() },
    ];
    for (const f of fixtures) {
      const sets = buildItemSets(f.build.champion, "Bot", f.build, f.pro, f.meta);
      const lines = sets[0].blocks.filter((b) => b.type !== "Starting" && b.type !== "Situational swaps");
      const sigs = lines.map((b) => b.items.map((i) => i.id).slice().sort().join(","));
      const dupes = sigs.filter((s, i) => sigs.indexOf(s) !== i);
      // Core build / Buy order may legitimately share a SET (never an order).
      for (const d of dupes) {
        const sharing = lines.filter((b) => b.items.map((i) => i.id).slice().sort().join(",") === d).map((b) => b.type);
        expect(sharing.slice().sort()).toEqual(["Buy order", "Core build"]);
      }
    }
  });

  it("de-dup is deterministic across the WHOLE set, not just the archetype lines", () => {
    const build = baseBuild(baseItems({ alts: { first: [pick(9001, 0.5), pick(9999, 0.4)] } }));
    const pro = { items: [{ itemId: 8888, share: 0.9 }], boots: [{ itemId: 3111, share: 0.8 }] };
    const a = buildItemSets(CHAMP, "Bot", build, pro, baseItemMetaMap());
    const b = buildItemSets(CHAMP, "Bot", build, pro, baseItemMetaMap());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe("AUDIT P1-C — the honesty label follows the EVIDENCE, for curated and data-first alike", () => {
  const ORNN: ChampionRef = { id: 516, key: "Ornn", name: "Ornn", icon: "o.png", tags: ["Tank", "Fighter"] };

  it("a CURATED variant with ZERO measured non-boots items is '(suggested)', not a bare title", () => {
    // The live repro: Ornn Top's `Bruiser (AD)` was the BRUISER_AD.pool array
    // verbatim in declaration order — zero measured items — sitting directly
    // above `On-hit (low data)`, which is equally fabricated and WAS labelled.
    // A bare title beside a labelled one reads as the better-evidenced of the
    // two, inverting the truth (HARD RULE 4).
    const build = famBuild(ORNN, [STARTER, BOOTS, TK1, TK2, TK3], { first: [pick(TK4, 0.06)] });
    const richMeta = metaMap(
      ...Array.from(damageMeta().values()),
      // Curated Bruiser (AD) pool so the line resolves to a full build.
      meta(6631, { tags: ["Damage", "Health"] }),
      meta(3071, { tags: ["Damage", "ArmorPenetration", "Health"] }),
      meta(6610, { tags: ["Damage", "Health"] }),
      meta(6333, { tags: ["Damage", "Health"] }),
      meta(3053, { tags: ["Damage", "Health"] })
    );
    const sets = buildItemSets(ORNN, "Top", build, null, richMeta);
    const bruiser = sets[0].blocks.find((b) => b.type.startsWith("Bruiser (AD)"));
    expect(bruiser).toBeDefined();
    expect(bruiser!.type).toBe("Bruiser (AD) (suggested)");
    // And every id in it really is judgment fill — none of the champ's own data.
    const own = new Set([TK1, TK2, TK3, TK4].map(String));
    expect(bruiser!.items.filter((i) => own.has(i.id))).toHaveLength(0);
  });

  it("a DATA-FIRST archetype with zero measured non-boots items is ALSO '(suggested)' — the label follows evidence, not arch.curated", () => {
    // On-hit is data-first. Ornn has no attack-speed/on-hit item at all, so the
    // whole line is curated/catalog fill and reads exactly like the curated
    // variant above. Two fabricated lines must be labelled the same way.
    const build = famBuild(ORNN, [STARTER, BOOTS, TK1, TK2, TK3], { first: [pick(TK4, 0.06)] });
    const richMeta = metaMap(
      ...Array.from(damageMeta().values()),
      meta(3153, { tags: ["AttackSpeed", "OnHit"] }),
      meta(3091, { tags: ["AttackSpeed", "OnHit"] }),
      meta(3124, { tags: ["AttackSpeed", "OnHit"] }),
      meta(6672, { tags: ["AttackSpeed", "OnHit"] }),
      meta(3085, { tags: ["AttackSpeed"] })
    );
    const sets = buildItemSets(ORNN, "Top", build, null, richMeta);
    const onHit = sets[0].blocks.find((b) => b.type.startsWith("On-hit"));
    expect(onHit).toBeDefined();
    expect(onHit!.type).toBe("On-hit (suggested)");
  });

  it("SOME measured but below the threshold stays '(low data)' — the middle state is not swallowed by the new one", () => {
    const build = famBuild(ORNN, [STARTER, BOOTS, TK1, TK2, TK3], { first: [pick(TK4, 0.06)] });
    const sets = buildItemSets(ORNN, "Top", build, null, damageMeta());
    const tank = sets[0].blocks.find((b) => b.type.startsWith("Tank") && !b.type.startsWith("Tank Mage"))!;
    expect(tank.type).toBe("Tank (low data)"); // 4 measured, threshold 5
  });

  it("the three states are exhaustive and mutually exclusive — every archetype block carries exactly one of them", () => {
    const build = famBuild(ORNN, [STARTER, BOOTS, TK1, TK2, TK3], { first: [pick(TK4, 0.06)] });
    const sets = buildItemSets(ORNN, "Top", build, null, damageMeta());
    for (const b of sets[0].blocks) {
      if (!ARCHETYPE_TITLE_RE.test(b.type)) continue;
      const suffixes = [" (low data)", " (suggested)"].filter((s) => b.type.endsWith(s));
      expect(suffixes.length).toBeLessThanOrEqual(1);
      expect(ARCHETYPE_TITLE_RE.test(b.type)).toBe(true);
    }
  });

  it("a '(suggested)' suffix does not break the set's own wire-contract title (Test-ItemSetsPayload) or the 4096 B LCU budget", () => {
    // Block `type` is free text on the wire — the companion validates the SET
    // title only — but a new suffix still has to keep the payload legal.
    const build = famBuild(ORNN, [STARTER, BOOTS, TK1, TK2, TK3], { first: [pick(TK4, 0.06)] });
    const sets = buildItemSets(ORNN, "Top", build, null, damageMeta());
    expect(sets[0].title.startsWith("CoachBuild")).toBe(true);
    expect(JSON.stringify(sets[0]).length).toBeLessThan(4096);
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
const ARCHETYPE_TITLE_RE = /^(Tank Mage|Tank|AP\/Mage|AP Burst|Bruiser \(AD\)|Lethality\/Assassin|Crit\/Marksman|On-hit)( \(low data\)| \(suggested\))?$/;

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
    // The build must CONTAIN durable-AP items (the brief's wording) — it is a
    // genuinely durable build, not a glass-cannon one. A coherent tank-mage
    // build legitimately also carries a Rabadon's-class damage cap, so we
    // assert the durable-AP CORE is present, not that literally every slot is
    // durable.
    const durableApCount = nonBoots.filter((id) => {
      const m = viktorMeta().get(id)!;
      return m.tags.includes("SpellDamage") && m.tags.some((t) => ["Health", "Armor", "SpellBlock"].includes(t));
    }).length;
    expect(durableApCount).toBeGreaterThanOrEqual(3);
    // Every non-boots item is at least AP-flavoured (SpellDamage) or a known
    // durable-AP staple — never a glass-cannon-only pick that would make this
    // just the AP build.
    for (const id of nonBoots) {
      const m = viktorMeta().get(id)!;
      expect(m.tags.includes("SpellDamage") || m.tags.some((t) => ["Health", "Armor", "SpellBlock"].includes(t))).toBe(true);
    }
    // Tank Mage must NOT be identical to the standard AP build.
    const apBuild = set.blocks.find((b) => b.type.startsWith("AP/Mage") || b.type.startsWith("AP Burst"));
    if (apBuild) {
      const sig = (ids: number[]) => [...ids].sort((a, b) => a - b).join(",");
      const tmIds = nonBoots;
      const apIds = apBuild.items.map((i) => Number(i.id)).filter((id) => id !== 3020);
      expect(sig(tmIds)).not.toBe(sig(apIds));
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
