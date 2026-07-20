// v0.34.1 rewrite (user feedback after confirming item sets work in-game):
// buildItemSets now returns ONE set per champ+role (Core/Optimized/Pro/
// Situational as BLOCKS, not separate sets) and every build line (Core,
// Optimized, Pro) is run through the 6-items/1-boots invariant. See
// components/hextech/itemSetBody.ts's header for the two live bugs this
// closes (a line with 2 boots; an Optimized line with only 3 items).
import { describe, it, expect } from "vitest";
import { buildItemSets, champScopedReplacePrefix } from "../hextech/itemSetBody";
import type { ChampionRef, BuildResponse, ItemsBlock, Pick, RunesBlock } from "@/lib/types";

function pick(id: number, wpa = 0.02): Pick {
  return { id, name: `Item ${id}`, icon: `icon-${id}`, wpa, winrate: 52, occurrence: 500 };
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
    const sets = buildItemSets(CHAMP, "Bot", build);
    expect(sets).toHaveLength(1);
  });

  it("title is 'CoachBuild <champ> <role>' with NO variant suffix", () => {
    const build = baseBuild(baseItems());
    const sets = buildItemSets(CHAMP, "Bot", build);
    expect(sets[0].title).toBe("CoachBuild Jinx Bot");
  });

  it("uid is a slug of champ+role with NO variant suffix", () => {
    const build = baseBuild(baseItems());
    const sets = buildItemSets(CHAMP, "Bot", build);
    expect(sets[0].uid).toBe("coachbuild-jinx-bot");
  });

  it("handles a multi-word/apostrophe champion name in the slug", () => {
    const champ: ChampionRef = { id: 145, key: "Kaisa", name: "Kai'Sa", icon: "k.png" };
    const build = baseBuild(baseItems());
    build.champion = champ;
    const sets = buildItemSets(champ, "Bot", build);
    expect(sets[0].uid).toBe("coachbuild-kai-sa-bot");
    expect(sets[0].title).toBe("CoachBuild Kai'Sa Bot");
  });

  it("associatedChampions carries exactly the champion's id", () => {
    const build = baseBuild(baseItems());
    const sets = buildItemSets(CHAMP, "Bot", build);
    expect(sets[0].associatedChampions).toEqual([222]);
  });

  it("every item id in every block is a string with count 1 (wire contract)", () => {
    const build = baseBuild(
      baseItems({ optimizedPath: [pick(3095, 0.09), pick(3036, 0.08), pick(3031, 0.07)] })
    );
    const pro = { items: [{ itemId: 42, share: 0.5 }], boots: [] };
    const sets = buildItemSets(CHAMP, "Bot", build, pro);
    for (const block of sets[0].blocks) {
      for (const item of block.items) {
        expect(typeof item.id).toBe("string");
        expect(item.count).toBe(1);
      }
    }
  });
});

describe("buildItemSets — block presence", () => {
  it("Starting + Core build only when there's no optimizedPath, no pro data, no alts", () => {
    const build = baseBuild(baseItems());
    const sets = buildItemSets(CHAMP, "Bot", build);
    expect(blockTypes(sets)).toEqual(["Starting", "Core build"]);
  });

  it("adds Optimized order when optimizedPath genuinely differs from the core prefix", () => {
    const build = baseBuild(baseItems({ optimizedPath: [pick(3046), pick(3072)] })); // reversed vs fourthPlus
    const sets = buildItemSets(CHAMP, "Bot", build);
    expect(blockTypes(sets)).toEqual(["Starting", "Core build", "Optimized order"]);
  });

  it("excludes Optimized order when optimizedPath is IDENTICAL to the core prefix", () => {
    const build = baseBuild(baseItems({ optimizedPath: [pick(3031), pick(3036)] })); // == [first, second]
    const sets = buildItemSets(CHAMP, "Bot", build);
    expect(blockTypes(sets)).toEqual(["Starting", "Core build"]);
  });

  it("excludes Optimized order when optimizedPath is empty", () => {
    const build = baseBuild(baseItems({ optimizedPath: [] }));
    const sets = buildItemSets(CHAMP, "Bot", build);
    expect(blockTypes(sets)).toEqual(["Starting", "Core build"]);
  });

  it("adds Pro build when pro-consensus data is supplied and non-empty", () => {
    const build = baseBuild(baseItems());
    const pro = { items: [{ itemId: 3020, share: 0.6 }], boots: [{ itemId: 3006, share: 0.4 }] };
    const sets = buildItemSets(CHAMP, "Bot", build, pro);
    expect(blockTypes(sets)).toEqual(["Starting", "Core build", "Pro build"]);
  });

  it("omits Pro build when pro-consensus data is null/absent", () => {
    const build = baseBuild(baseItems());
    expect(blockTypes(buildItemSets(CHAMP, "Bot", build, null))).toEqual(["Starting", "Core build"]);
    expect(blockTypes(buildItemSets(CHAMP, "Bot", build, undefined))).toEqual(["Starting", "Core build"]);
  });

  it("omits Pro build when pro-consensus items AND boots are both empty (never an empty block)", () => {
    const build = baseBuild(baseItems());
    const sets = buildItemSets(CHAMP, "Bot", build, { items: [], boots: [] });
    expect(blockTypes(sets)).toEqual(["Starting", "Core build"]);
  });

  it("adds Situational swaps only when alts exist; omits entirely otherwise", () => {
    const withAlts = buildItemSets(CHAMP, "Bot", baseBuild(baseItems({ alts: { first: [pick(9001, 0.05)] } })));
    expect(blockTypes(withAlts)).toEqual(["Starting", "Core build", "Situational swaps"]);

    const withoutAlts = buildItemSets(CHAMP, "Bot", baseBuild(baseItems()));
    expect(blockTypes(withoutAlts)).toEqual(["Starting", "Core build"]);
  });

  it("all four blocks resolve together, in order: Starting, Core, Optimized, Pro, Situational", () => {
    const build = baseBuild(
      baseItems({
        optimizedPath: [pick(3046), pick(3072)],
        alts: { first: [pick(9001, 0.05)] },
      })
    );
    const pro = { items: [{ itemId: 3020, share: 0.6 }], boots: [{ itemId: 3006, share: 0.4 }] };
    const sets = buildItemSets(CHAMP, "Bot", build, pro);
    expect(blockTypes(sets)).toEqual([
      "Starting",
      "Core build",
      "Optimized order",
      "Pro build",
      "Situational swaps",
    ]);
  });
});

describe("buildItemSets — Starting block", () => {
  it("carries exactly the starter item, exempt from the 6-item rule", () => {
    const build = baseBuild(baseItems());
    const sets = buildItemSets(CHAMP, "Bot", build);
    const starting = findBlock(sets, "Starting")!;
    expect(starting.items).toEqual([{ id: "1054", count: 1 }]);
  });
});

describe("buildItemSets — Core build: 6 items, exactly 1 boots, no dupes", () => {
  it("standard fixture: first/second/third/boots/fourthPlus(2) => 6 items, boots in the historical slot", () => {
    const build = baseBuild(baseItems());
    const sets = buildItemSets(CHAMP, "Bot", build);
    const core = findBlock(sets, "Core build")!;
    expect(core.items.map((i) => i.id)).toEqual(["3031", "3036", "3095", "3006", "3072", "3046"]);
  });

  it("fourthPlus with 3 items (7 raw candidates) trims to exactly 6, still exactly 1 boots", () => {
    const build = baseBuild(baseItems({ fourthPlus: [pick(3072), pick(3046), pick(3153)] }));
    const sets = buildItemSets(CHAMP, "Bot", build);
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
    const sets = buildItemSets(CHAMP, "Bot", build);
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
    const sets = buildItemSets(CHAMP, "Bot", build);
    const core = findBlock(sets, "Core build")!;
    expect(core.items).toHaveLength(4); // ships what exists, not padded with invented ids
    expect(core.items.filter((i) => i.id === "3006")).toHaveLength(1);
  });
});

describe("buildItemSets — Optimized order: 6 items, exactly 1 boots, no dupes, padded from the CORE remainder", () => {
  it("REGRESSION (live bug: 'optimized line with only 3 items') -- a 3-item optimizedPath is padded to exactly 6", () => {
    const build = baseBuild(
      baseItems({ optimizedPath: [pick(3095, 0.09), pick(3036, 0.08), pick(3072, 0.07)] })
    );
    const sets = buildItemSets(CHAMP, "Bot", build);
    const optimized = findBlock(sets, "Optimized order")!;
    expect(optimized.items).toHaveLength(6);
    expect(optimized.items.filter((i) => i.id === "3006")).toHaveLength(1); // exactly one boots, inserted from core
    const ids = optimized.items.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length); // no dupes even though 3036/3072 also live in core
  });

  it("preserves the optimizedPath's own item order at the front of the line", () => {
    const build = baseBuild(baseItems({ optimizedPath: [pick(3020, 0.09), pick(3157, 0.08)] }));
    const sets = buildItemSets(CHAMP, "Bot", build);
    const optimized = findBlock(sets, "Optimized order")!;
    expect(optimized.items.slice(0, 2).map((i) => i.id)).toEqual(["3020", "3157"]);
  });

  it("pads using the core remainder, not situational/pro pools", () => {
    const build = baseBuild(
      baseItems({
        optimizedPath: [pick(3046), pick(3072)], // 2-item path
        alts: { first: [pick(9999, 0.5)] }, // a high-wpa situational alt that must NOT leak in
      })
    );
    const pro = { items: [{ itemId: 8888, share: 0.99 }], boots: [] }; // must NOT leak in either
    const sets = buildItemSets(CHAMP, "Bot", build, pro);
    const optimized = findBlock(sets, "Optimized order")!;
    const ids = optimized.items.map((i) => i.id);
    expect(ids).not.toContain("9999");
    expect(ids).not.toContain("8888");
    expect(ids).toHaveLength(6);
  });
});

describe("buildItemSets — Pro build: 6 items, exactly 1 boots, no dupes", () => {
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
    const sets = buildItemSets(CHAMP, "Bot", build, pro);
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
    const sets = buildItemSets(CHAMP, "Bot", build, pro);
    const proBlock = findBlock(sets, "Pro build")!;
    const bootsPresent = proBlock.items.filter((i) => i.id === "3006" || i.id === "3111");
    expect(bootsPresent).toHaveLength(1);
    expect(bootsPresent[0].id).toBe("3111");
    expect(proBlock.items.map((i) => i.id)).toContain("9001"); // padded in from situational
  });
});

describe("buildItemSets — Situational swaps: cap 6, exempt from the one-boots rule", () => {
  it("caps at 6 even with more alternates available", () => {
    const alts = { first: Array.from({ length: 10 }, (_, i) => pick(9000 + i, 0.1 - i * 0.001)) };
    const build = baseBuild(baseItems({ alts }));
    const sets = buildItemSets(CHAMP, "Bot", build);
    const situational = findBlock(sets, "Situational swaps")!;
    expect(situational.items).toHaveLength(6);
  });

  it("may legitimately carry more than one boots option (swap suggestions, not a worn loadout)", () => {
    const alts = { boots: [pick(3111, 0.09), pick(3158, 0.08)] };
    const build = baseBuild(baseItems({ alts }));
    const sets = buildItemSets(CHAMP, "Bot", build);
    const situational = findBlock(sets, "Situational swaps")!;
    expect(situational.items.map((i) => i.id)).toEqual(expect.arrayContaining(["3111", "3158"]));
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
    const sets = buildItemSets(CHAMP, "Bot", build);
    expect(psPrefixOf(sets[0].title)).toBe(sets[0].title);
  });

  it("old suffixed titles from the pre-restructure shape still start with the new prefix (auto-cleaned on next export)", () => {
    const build = baseBuild(baseItems());
    const sets = buildItemSets(CHAMP, "Bot", build);
    const prefix = psPrefixOf(sets[0].title);
    for (const suffix of ["Core", "Optimized", "Pro"]) {
      const oldTitle = `${sets[0].title} — ${suffix}`;
      expect(oldTitle.startsWith(prefix)).toBe(true);
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

describe("buildItemSets — single-set payload satisfies the wire contract (1-3 sets, companion.ps1 Test-ItemSetsPayload)", () => {
  it("sets array has exactly 1 entry, well within the 1-3 bound", () => {
    const build = baseBuild(baseItems());
    const sets = buildItemSets(CHAMP, "Bot", build);
    expect(sets.length).toBeGreaterThanOrEqual(1);
    expect(sets.length).toBeLessThanOrEqual(3);
    expect(sets).toHaveLength(1);
  });

  it("the set's title starts with 'CoachBuild' (companion bridge validation)", () => {
    const build = baseBuild(baseItems());
    const sets = buildItemSets(CHAMP, "Bot", build);
    expect(sets[0].title.startsWith("CoachBuild")).toBe(true);
  });
});
