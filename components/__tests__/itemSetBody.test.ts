import { describe, it, expect } from "vitest";
import { buildItemSets } from "../hextech/itemSetBody";
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

describe("buildItemSets — set count logic", () => {
  it("Core-only when there's no optimizedPath and no pro data", () => {
    const build = baseBuild(baseItems());
    const sets = buildItemSets(CHAMP, "Bot", build);
    expect(sets).toHaveLength(1);
    expect(sets[0].title).toBe("CoachBuild Jinx Bot — Core");
  });

  it("Core + Optimized when optimizedPath genuinely differs from core", () => {
    const build = baseBuild(baseItems({ optimizedPath: [pick(3046), pick(3072)] })); // reversed order from fourthPlus/core prefix
    const sets = buildItemSets(CHAMP, "Bot", build);
    expect(sets.map((s) => s.title)).toEqual(["CoachBuild Jinx Bot — Core", "CoachBuild Jinx Bot — Optimized"]);
  });

  it("excludes Optimized when optimizedPath is IDENTICAL to the core prefix (same rule as CoreBuildOrderCard's UI)", () => {
    const build = baseBuild(baseItems({ optimizedPath: [pick(3031), pick(3036)] })); // == [first, second]
    const sets = buildItemSets(CHAMP, "Bot", build);
    expect(sets).toHaveLength(1);
  });

  it("excludes Optimized when optimizedPath is empty", () => {
    const build = baseBuild(baseItems({ optimizedPath: [] }));
    const sets = buildItemSets(CHAMP, "Bot", build);
    expect(sets).toHaveLength(1);
  });

  it("adds Pro when pro-consensus data is supplied and non-empty", () => {
    const build = baseBuild(baseItems());
    const pro = { items: [{ itemId: 3031, share: 0.6 }], boots: [{ itemId: 3006, share: 0.4 }] };
    const sets = buildItemSets(CHAMP, "Bot", build, pro);
    expect(sets).toHaveLength(2);
    expect(sets[1].title).toBe("CoachBuild Jinx Bot — Pro");
  });

  it("omits Pro when pro-consensus data is null/absent", () => {
    const build = baseBuild(baseItems());
    expect(buildItemSets(CHAMP, "Bot", build, null)).toHaveLength(1);
    expect(buildItemSets(CHAMP, "Bot", build, undefined)).toHaveLength(1);
  });

  it("omits Pro when pro-consensus items AND boots are both empty (never an empty set)", () => {
    const build = baseBuild(baseItems());
    const sets = buildItemSets(CHAMP, "Bot", build, { items: [], boots: [] });
    expect(sets).toHaveLength(1);
  });

  it("caps at 3 sets even if all three variants resolve (top 3 if available, never more)", () => {
    const build = baseBuild(baseItems({ optimizedPath: [pick(9999)] }));
    const pro = { items: [{ itemId: 1, share: 0.5 }], boots: [] };
    const sets = buildItemSets(CHAMP, "Bot", build, pro);
    expect(sets).toHaveLength(3);
    expect(sets.map((s) => s.title)).toEqual([
      "CoachBuild Jinx Bot — Core",
      "CoachBuild Jinx Bot — Optimized",
      "CoachBuild Jinx Bot — Pro",
    ]);
  });
});

describe("buildItemSets — item ids are STRINGS (unlike rune perk ids)", () => {
  it("every item id in every block is a string, not a number", () => {
    const build = baseBuild(baseItems({ optimizedPath: [pick(9999)] }));
    const pro = { items: [{ itemId: 42, share: 0.5 }], boots: [] };
    const sets = buildItemSets(CHAMP, "Bot", build, pro);
    for (const set of sets) {
      for (const block of set.blocks) {
        for (const item of block.items) {
          expect(typeof item.id).toBe("string");
          expect(item.count).toBe(1);
        }
      }
    }
  });

  it("Core block's item ids match the numeric BuildResponse ids stringified", () => {
    const build = baseBuild(baseItems());
    const sets = buildItemSets(CHAMP, "Bot", build);
    const coreBlock = sets[0].blocks.find((b) => b.type === "Core build order")!;
    expect(coreBlock.items.map((i) => i.id)).toEqual(["3031", "3036", "3095", "3006", "3072", "3046"]);
  });
});

describe("buildItemSets — title/uid format", () => {
  it("title is 'CoachBuild <champ> <role> — <variant>'", () => {
    const build = baseBuild(baseItems());
    const sets = buildItemSets(CHAMP, "Bot", build);
    expect(sets[0].title).toBe("CoachBuild Jinx Bot — Core");
  });

  it("uid is a slug of champ+role+variant", () => {
    const build = baseBuild(baseItems());
    const sets = buildItemSets(CHAMP, "Bot", build);
    expect(sets[0].uid).toBe("coachbuild-jinx-bot-core");
  });

  it("handles a multi-word/apostrophe champion name in the slug", () => {
    const champ: ChampionRef = { id: 145, key: "Kaisa", name: "Kai'Sa", icon: "k.png" };
    const build = baseBuild(baseItems());
    build.champion = champ;
    const sets = buildItemSets(champ, "Bot", build);
    expect(sets[0].uid).toBe("coachbuild-kai-sa-bot-core");
    expect(sets[0].title).toBe("CoachBuild Kai'Sa Bot — Core");
  });

  it("associatedChampions carries exactly the champion's id", () => {
    const build = baseBuild(baseItems());
    const sets = buildItemSets(CHAMP, "Bot", build);
    expect(sets[0].associatedChampions).toEqual([222]);
  });
});

describe("buildItemSets — block shapes", () => {
  it("Core has Starting + Core build order (+ Situational when alts exist)", () => {
    const build = baseBuild(baseItems({ alts: { first: [pick(9001, 0.05)] } }));
    const sets = buildItemSets(CHAMP, "Bot", build);
    const blockTypes = sets[0].blocks.map((b) => b.type);
    expect(blockTypes).toEqual(["Starting", "Core build order", "Situational"]);
  });

  it("Core omits the Situational block entirely when there's nothing situational", () => {
    const build = baseBuild(baseItems());
    const sets = buildItemSets(CHAMP, "Bot", build);
    expect(sets[0].blocks.map((b) => b.type)).toEqual(["Starting", "Core build order"]);
  });

  it("Situational is capped at 6", () => {
    const alts = { first: Array.from({ length: 10 }, (_, i) => pick(9000 + i, 0.1 - i * 0.001)) };
    const build = baseBuild(baseItems({ alts }));
    const sets = buildItemSets(CHAMP, "Bot", build);
    const situational = sets[0].blocks.find((b) => b.type === "Situational")!;
    expect(situational.items).toHaveLength(6);
  });

  it("Pro block is capped at 8 and ordered by share desc (boots + items combined)", () => {
    const build = baseBuild(baseItems());
    const items = Array.from({ length: 8 }, (_, i) => ({ itemId: 100 + i, share: 0.9 - i * 0.05 }));
    const boots = [{ itemId: 3006, share: 0.99 }];
    const sets = buildItemSets(CHAMP, "Bot", build, { items, boots });
    const proBlock = sets.find((s) => s.title.endsWith("Pro"))!.blocks[0];
    expect(proBlock.type).toBe("Pro consensus");
    expect(proBlock.items).toHaveLength(8);
    expect(proBlock.items[0].id).toBe("3006"); // highest share (boots) first
  });

  it("Optimized block uses the exact optimizedPath order", () => {
    const build = baseBuild(baseItems({ optimizedPath: [pick(3020), pick(3157)] }));
    const sets = buildItemSets(CHAMP, "Bot", build);
    const optBlock = sets.find((s) => s.title.endsWith("Optimized"))!.blocks[0];
    expect(optBlock.type).toBe("Optimized order");
    expect(optBlock.items.map((i) => i.id)).toEqual(["3020", "3157"]);
  });
});
