/**
 * itemSetBody — the LCU item-set builder.
 *
 * REWRITTEN 2026-07-28 for the FOUR-CATEGORY cut (user directive). The shop
 * panel used to carry up to nine blocks (Core build, Buy order, Pro build, OTP
 * build, Highest WPA, up to four damage archetypes, Situational swaps). It now
 * carries a Starting SLOT plus at most four SOURCE-named build blocks:
 *
 *   WPA build  — the app's own model (this is the old "Core build", renamed)
 *   Pro build  — what professionals built
 *   OTP build  — what the champion's one-tricks built
 *   Hidden gem — high winrate, low play rate (see selectHiddenGemPicks)
 *
 * Tests for the removed categories went with them. Everything below is either a
 * test of the new contract or a REGRESSION that predates it and still holds —
 * the 6-slot/one-boots invariant, the full-items-only rule (the live Dark Seal
 * bug), and the starter partition (HARD RULE 2). Those are marked where they
 * came from a real reported bug, because that is why they must not be dropped.
 */
import { describe, it, expect } from "vitest";
import { buildItemSets, champScopedReplacePrefix, selectHiddenGemPicks } from "../hextech/itemSetBody";
import type { ChampionRef, BuildResponse, ItemsBlock, Pick, RunesBlock } from "@/lib/types";
import type { ItemDetail } from "@/components/itemDetail";

function pick(id: number, wpa = 0.02, extra: Partial<Pick> = {}): Pick {
  return { id, name: `Item ${id}`, icon: `icon-${id}`, wpa, winrate: 52, occurrence: 5000, ...extra };
}

/** Full item by default (empty `into` = a genuine recipe-tree leaf, per
 *  isFullItem). `bootsMeta` mirrors a real tier-2 boot (Boots tag, built FROM
 *  something, own non-empty `into` for the tier-3 enchant) so the boots special
 *  case is genuinely proven rather than passing by accident on an empty `into`. */
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

function baseItemMetaMap(): Map<number, ItemDetail> {
  return metaMap(
    meta(1054),
    bootsMeta(3006),
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

const BOOTS_IDS = new Set([3006, 3111, 3157, 3158]);

// ── The four-category contract ──────────────────────────────────────────────

describe("buildItemSets — block set", () => {
  it("emits ONE set, Starting first, and never a removed category", () => {
    const sets = buildItemSets(CHAMP, "Bot", baseBuild(baseItems()), null, baseItemMetaMap());
    expect(sets).toHaveLength(1);
    const types = blockTypes(sets);
    expect(types[0]).toBe("Starting");
    for (const gone of ["Core build", "Buy order", "Situational swaps", "Highest WPA"]) {
      expect(types).not.toContain(gone);
    }
    // No damage-archetype block survives either (they were titled e.g.
    // "AP/Mage", "Tank Mage", "Crit/Marksman (low data)").
    expect(types.filter((t) => /Mage|Marksman|Lethality|On-hit|Bruiser|Tank/.test(t))).toEqual([]);
  });

  it("emits the WPA build unconditionally, even when every id is unknown", () => {
    // Not an oversight: a total itemMeta failure makes isFullItem exclude
    // everything, and an EMPTY WPA block is what tells the user the export ran
    // and found nothing — rather than silently shipping a lone Starting slot.
    const sets = buildItemSets(CHAMP, "Bot", baseBuild(baseItems()), null, new Map());
    expect(blockTypes(sets)).toContain("WPA build");
    expect(findBlock(sets, "WPA build")!.items).toEqual([]);
  });

  it("never exceeds Starting + four build blocks", () => {
    const consensus = (ids: number[]) => ({
      items: ids.map((itemId, i) => ({ itemId, share: 0.9 - i * 0.1 })),
      boots: [{ itemId: 3157, share: 0.7 }],
    });
    const items = baseItems({
      alts: { first: [pick(100, 0.01, { winrate: 60, occurrence: 800 })] },
    });
    const sets = buildItemSets(
      CHAMP,
      "Bot",
      baseBuild(items),
      consensus([8888, 9001, 3020]),
      metaMap(...Array.from(baseItemMetaMap().values())),
      consensus([3200, 3153, 42])
    );
    expect(blockTypes(sets).length).toBeLessThanOrEqual(5);
  });

  it("Starting stays its own slot and never leaks into a build line (HARD RULE 2)", () => {
    // Regression: Dark Seal (a stacking component) once reached a build line.
    const items = baseItems({ starter: pick(1082) });
    const m = metaMap(
      ...Array.from(baseItemMetaMap().values()),
      meta(1082, { name: "Dark Seal", goldTotal: 350, into: ["3041"], from: [], tags: ["Lane"] })
    );
    const sets = buildItemSets(CHAMP, "Bot", baseBuild(items), null, m);
    expect(findBlock(sets, "Starting")!.items.map((i) => Number(i.id))).toEqual([1082]);
    for (const b of sets[0].blocks) {
      if (b.type === "Starting") continue;
      expect(b.items.map((i) => Number(i.id))).not.toContain(1082);
    }
  });

  it("caps every build line at 6 slots with at most one boots", () => {
    // Regression (live bug: "a line with 2 boots") — a second boots id arriving
    // via alts must not produce two pairs of boots in one worn loadout.
    const items = baseItems({
      fourthPlus: [pick(3072), pick(3046), pick(3020)],
      alts: { boots: [pick(3111), pick(3158)] },
    });
    const sets = buildItemSets(CHAMP, "Bot", baseBuild(items), null, baseItemMetaMap());
    for (const b of sets[0].blocks) {
      if (b.type === "Starting") continue;
      const ids = b.items.map((i) => Number(i.id));
      expect(ids.length).toBeLessThanOrEqual(6);
      expect(ids.filter((id) => BOOTS_IDS.has(id)).length).toBeLessThanOrEqual(1);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it("collapses two blocks that resolve to the identical item set", () => {
    const same = {
      items: [3031, 3036, 3095, 3072, 3046].map((itemId, i) => ({ itemId, share: 0.9 - i * 0.1 })),
      boots: [{ itemId: 3006, share: 0.8 }],
    };
    const sets = buildItemSets(CHAMP, "Bot", baseBuild(baseItems()), same, baseItemMetaMap(), same);
    const lineBlocks = sets[0].blocks.filter((b) => b.type !== "Starting");
    const keys = lineBlocks.map((b) => b.items.map((i) => i.id).sort().join(","));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("keeps the champ-scoped replace prefix", () => {
    expect(champScopedReplacePrefix(CHAMP)).toBe("CoachBuild Jinx ");
  });
});

// ── Hidden gem ───────────────────────────────────────────────────────────────
//
// Occurrence values here mirror the REAL scale measured on patch 16.14 across
// 10 champion+role combinations: pools of 14-17 items, occurrence 483 to
// ~249,000, median play count 8k-44k. Fixtures using toy numbers (occurrence 5,
// 10) would not exercise the thresholds at all.

describe("selectHiddenGemPicks", () => {
  const M = metaMap(meta(100), meta(101), meta(102), meta(103), meta(104));
  const gemPool = () => [
    pick(100, 0.05, { winrate: 52.0, occurrence: 40000 }), // popular, baseline
    pick(101, 0.04, { winrate: 52.6, occurrence: 20000 }), // popular, baseline
    pick(102, 0.03, { winrate: 51.0, occurrence: 14000 }), // median play
    pick(103, 0.02, { winrate: 58.0, occurrence: 1500 }), // THE GEM
    pick(104, 0.01, { winrate: 52.2, occurrence: 900 }), // rare but not winning
  ];

  it("finds the rare, high-winrate pick and ignores the rare mediocre one", () => {
    const out = selectHiddenGemPicks(gemPool(), new Set(), M);
    expect(out.map((p) => p.id)).toEqual([103]);
  });

  it("refuses a SNOWBALL item however large its sample", () => {
    // The defect the first version shipped with, caught by looking at the
    // rendered card and not by any threshold test: Ahri's top "gem" came back
    // as Mejai's Soulstealer, 78.5% across 8,149 games. Huge sample, real
    // winrate, every other guard passed — and a terrible recommendation,
    // because Mejai's is bought BECAUSE you are already winning. A winrate that
    // far above the pool measures won games, not the item.
    const pool = [...gemPool(), pick(105, 0.01, { winrate: 78.5, occurrence: 8149 })];
    const out = selectHiddenGemPicks(pool, new Set(), metaMap(...Array.from(M.values()), meta(105)));
    expect(out.map((p) => p.id)).not.toContain(105);
    // ...and the legitimate gem still survives alongside it.
    expect(out.map((p) => p.id)).toEqual([103]);
  });

  it("refuses a winrate computed off too few games", () => {
    // The whole trap this block exists to avoid: 9 games, 78% winrate, noise.
    const pool = [...gemPool(), pick(105, 0.01, { winrate: 78, occurrence: 9 })];
    const out = selectHiddenGemPicks(pool, new Set(), metaMap(...Array.from(M.values()), meta(105)));
    expect(out.map((p) => p.id)).not.toContain(105);
  });

  it("excludes anything already emitted in another block", () => {
    // If pros build it, it is not hidden — it is just the build, and repeating
    // it under a "Hidden gem" title would make the label a lie.
    expect(selectHiddenGemPicks(gemPool(), new Set([103]), M)).toEqual([]);
  });

  it("ignores a pick with no winrate rather than assuming one", () => {
    const pool = [...gemPool(), pick(105, 0.01, { winrate: null, occurrence: 1200 })];
    const out = selectHiddenGemPicks(pool, new Set(), metaMap(...Array.from(M.values()), meta(105)));
    expect(out.map((p) => p.id)).not.toContain(105);
  });

  it("ignores a non-full item however well it performs", () => {
    const pool = [...gemPool(), pick(1082, 0.01, { winrate: 61, occurrence: 3000 })];
    const m = metaMap(...Array.from(M.values()), meta(1082, { into: ["3041"], from: [] }));
    expect(selectHiddenGemPicks(pool, new Set(), m).map((p) => p.id)).not.toContain(1082);
  });

  it("returns nothing when a champion simply has no under-played winner", () => {
    // Measured: this is the case for 2 of 9 sampled champions. A block that
    // appeared for everyone would not be a hidden gem.
    const flat = [100, 101, 102, 103].map((id, i) =>
      pick(id, 0.02, { winrate: 52 + i * 0.1, occurrence: 20000 })
    );
    expect(selectHiddenGemPicks(flat, new Set(), M)).toEqual([]);
  });

  it("orders by winrate, breaking ties on rarity", () => {
    const pool = [
      pick(100, 0.05, { winrate: 52.0, occurrence: 40000 }),
      pick(101, 0.05, { winrate: 52.0, occurrence: 30000 }),
      pick(102, 0.05, { winrate: 51.0, occurrence: 20000 }),
      pick(103, 0.02, { winrate: 57.0, occurrence: 3000 }),
      pick(104, 0.02, { winrate: 57.0, occurrence: 1000 }),
    ];
    expect(selectHiddenGemPicks(pool, new Set(), M).map((p) => p.id)).toEqual([104, 103]);
  });

  it("computes the baseline BEFORE exclusions", () => {
    // Excluding first would raise the bar exactly where the popular items were
    // removed, quietly promoting mid-tier picks into "gems".
    const withExclusion = selectHiddenGemPicks(gemPool(), new Set([100, 101]), M);
    expect(withExclusion.map((p) => p.id)).toEqual([103]);
  });
});

describe("buildItemSets — Hidden gem block", () => {
  it("emits the block with the gem LEADING, padded to a real build", () => {
    const items = baseItems({
      alts: { first: [pick(3200, 0.01, { winrate: 59, occurrence: 1500 })] },
    });
    const m = metaMap(...Array.from(baseItemMetaMap().values()));
    const sets = buildItemSets(CHAMP, "Bot", baseBuild(items), null, m);
    const gem = findBlock(sets, "Hidden gem");
    expect(gem).toBeDefined();
    expect(Number(gem!.items[0].id)).toBe(3200);
    // A two-item recommendation is not a build anyone can play.
    expect(gem!.items.length).toBeGreaterThan(1);
  });

  it("emits no block when nothing qualifies", () => {
    const sets = buildItemSets(CHAMP, "Bot", baseBuild(baseItems()), null, baseItemMetaMap());
    expect(blockTypes(sets)).not.toContain("Hidden gem");
  });
});
