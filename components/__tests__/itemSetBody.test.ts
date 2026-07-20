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
  // Core build. Tanky/Burst need their OWN ≥4 tag-matched items (see the
  // dedicated "themed lines" describe block) and are absent here.

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

  it("all resolvable blocks appear together, in order: Starting, Core, Buy order, Pro, Highest WPA, Tanky, Burst, Situational", () => {
    const build = baseBuild(
      baseItems({
        optimizedPath: [pick(3046), pick(3072)],
        alts: {
          first: [
            pick(5001, 0.09), // Tanky (Health+Armor)
            pick(5002, 0.08), // Tanky (Armor)
            pick(5003, 0.07), // Tanky (Health+SpellBlock)
            pick(5004, 0.065), // Tanky (Health) -- 4th, clears the ≥4 threshold
            pick(6001, 0.06), // Burst (SpellDamage)
            pick(6002, 0.05), // Burst (Damage+ArmorPenetration)
            pick(6003, 0.04), // Burst (SpellDamage)
            pick(6004, 0.035), // Burst (MagicPenetration) -- 4th, clears the ≥4 threshold
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
      meta(6002, { tags: ["Damage", "ArmorPenetration"] }),
      meta(6003, { tags: ["SpellDamage"] }),
      meta(6004, { tags: ["MagicPenetration"] })
    );
    const sets = buildItemSets(CHAMP, "Bot", build, pro, richMeta);
    expect(blockTypes(sets)).toEqual([
      "Starting",
      "Core build",
      "Buy order",
      "Pro build",
      "Highest WPA",
      "Tanky",
      "Burst",
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

    for (const type of ["Core build", "Buy order", "Pro build", "Highest WPA", "Tanky", "Burst"]) {
      const block = findBlock(sets, type);
      if (block) expect(block.items.map((i) => i.id)).not.toContain("1082"); // never in a build line
    }
  });
});

describe("buildItemSets — themed lines (Highest WPA / Tanky / Burst)", () => {
  function richBuild(): BuildResponse {
    return baseBuild(
      baseItems({
        alts: {
          first: [
            pick(5001, 0.09), // Tanky (Health+Armor)
            pick(5002, 0.08), // Tanky (Armor)
            pick(5003, 0.07), // Tanky (Health+SpellBlock)
            pick(6001, 0.06), // Burst (SpellDamage)
            pick(6002, 0.05), // Burst (Damage+ArmorPenetration)
            pick(6003, 0.04), // Burst (SpellDamage)
            pick(6004, 0.025), // Burst (MagicPenetration)
          ],
          boots: [pick(3111, 0.03)], // Tanky-tagged boots (SpellBlock) -- themed-boots preference case
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

  it("Highest WPA: top-6 by weight across the WHOLE pool (core + situational), one boots (the best boots available, itself ranked by weight)", () => {
    const sets = buildItemSets(CHAMP, "Bot", richBuild(), null, richMeta());
    const line = findBlock(sets, "Highest WPA")!;
    expect(line.items).toHaveLength(6);
    expect(line.items.map((i) => i.id)).toEqual(["5001", "5002", "5003", "3111", "6001", "6002"]);
  });

  it("Tanky: only Health/Armor/SpellBlock-tagged full items, boots preferred from WITHIN the theme when one exists", () => {
    const sets = buildItemSets(CHAMP, "Bot", richBuild(), null, richMeta());
    const line = findBlock(sets, "Tanky")!;
    // 5001/5002/5003 (tanky, non-boots) + 3111 (tanky-tagged boots) -- only
    // 4 qualify, so the line ships all 4 rather than padding to 6.
    expect(line.items.map((i) => i.id)).toEqual(["5001", "5002", "5003", "3111"]);
    expect(line.items.filter((i) => i.id === "3111")).toHaveLength(1);
  });

  it("Burst: only SpellDamage/Damage/ArmorPenetration/MagicPenetration-tagged full items; falls back to the OVERALL best boots when no themed boots exist", () => {
    const sets = buildItemSets(CHAMP, "Bot", richBuild(), null, richMeta());
    const line = findBlock(sets, "Burst")!;
    const ids = line.items.map((i) => i.id);
    expect(ids).toEqual(expect.arrayContaining(["6001", "6002", "6003", "6004"]));
    // No burst-tagged boots exist -- 3111 (tanky-tagged, but still the best
    // available boots overall) is used instead of shipping zero boots.
    expect(ids).toContain("3111");
    expect(line.items).toHaveLength(5); // 4 qualifying + the boots fallback
  });

  it("omits a themed line entirely when fewer than 4 qualifying items exist (no junk padding)", () => {
    // Only 3 Tanky-tagged items -- one short of the ≥4 threshold.
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
    expect(findBlock(sets, "Tanky")).toBeUndefined();
    expect(findBlock(sets, "Burst")).toBeUndefined(); // zero burst-tagged items here
    expect(findBlock(sets, "Highest WPA")).toBeDefined(); // core alone (6 items) already clears the pool-size threshold
  });

  it("a themed line's candidates are also full-items-only (Dark Seal never reaches Tanky even though it's Health-tagged)", () => {
    const darkSeal = meta(1082, { tags: ["Health", "SpellDamage", "Lane"], into: ["3041"] });
    // 4 REAL tanky items (5001-5004) so the ≥4 threshold is met by qualifying
    // (full-item) candidates alone -- Dark Seal (also Health-tagged, but
    // NOT full) must never count toward that threshold or appear in the
    // resulting line.
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
    const tanky = findBlock(sets, "Tanky");
    expect(tanky).toBeDefined();
    expect(tanky!.items.map((i) => i.id)).not.toContain("1082");
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
