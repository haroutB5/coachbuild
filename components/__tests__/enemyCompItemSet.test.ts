import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { buildItemSets } from "../hextech/itemSetBody";
import { situationalShortlist, SITUATIONAL_DISPLAY_LIMIT } from "../hextech/situational";
import { resolveCompSignal } from "@/lib/enemyComp/compSignal";
import { ANTI_HEAL } from "@/lib/enemyComp/counterItems";
import type { BuildResponse, ChampionRef, ItemsBlock } from "@/lib/types";

// Real production captures at patch 16.17, the same fixtures the signal's own
// tests use. `buildItemSets` reads only `build.items` off the response, so the
// rest of the object is the fixture's own recorded metadata rather than
// invented filler.
function load(slug: string): { champ: ChampionRef; roleLabel: string; build: BuildResponse } {
  const f = JSON.parse(readFileSync(`fixtures/enemycomp/${slug}.json`, "utf8"));
  return {
    champ: f.champion as ChampionRef,
    roleLabel: f.roleLabel as string,
    build: { champion: f.champion, role: f.role, roleLabel: f.roleLabel, patch: f.patch, items: f.items } as BuildResponse,
  };
}

const VIKTOR = load("viktor-mid");
const URGOT = load("urgot-top");
const THRESH = load("thresh-sup");
const LUX = load("lux-sup");
const MALPHITE = load("malphite-top");

const THREE_AD = [6, 122, 157]; // Urgot, Darius, Yasuo
const TWO_HEALERS = [16, 350, 8]; // Soraka, Yuumi, Vladimir
const CC_HEAVY = [89, 54, 113, 127]; // Leona, Malphite, Sejuani, Lissandra
const PARTIAL = [89, 54]; // two enemies, below the minimum

const CASES = { VIKTOR, URGOT, THRESH, LUX, MALPHITE };
const COMPS = { THREE_AD, TWO_HEALERS, CC_HEAVY, PARTIAL };

function exportWith(c: typeof VIKTOR, enemies: readonly number[]) {
  const signal = resolveCompSignal(enemies, c.build.items);
  const out = buildItemSets(c.champ, c.roleLabel, c.build, null, undefined, null, signal);
  return { signal, ...out };
}
function situationalBlock(sets: ReturnType<typeof exportWith>["sets"]) {
  return sets[0].blocks.find((b) => b.type.startsWith("Situational")) ?? null;
}

describe("page and shop agree, in the same champ select", () => {
  it("the shop block is the page's window minus the WPA build, in the same order", () => {
    // THE invariant this phase exists to establish. Both surfaces order the
    // row from ONE helper before slicing, so the shop block can only ever be a
    // contiguous-order subset of what the page shows. Before this phase the
    // page reordered and the shop did not, which would have shown a player two
    // different "Situational" rows for one champion at the same moment.
    for (const [name, c] of Object.entries(CASES)) {
      for (const [cname, enemies] of Object.entries(COMPS)) {
        const { signal, sets } = exportWith(c, enemies);
        const pageWindow = situationalShortlist(c.build.items, signal?.promotedIds ?? []);
        const block = situationalBlock(sets);
        const shopIds = block ? block.items.map((i) => Number(i.id)) : [];
        const wpaBlock = sets[0].blocks.find((b) => b.type === "WPA build");
        const wpaIds = new Set((wpaBlock?.items ?? []).map((i) => Number(i.id)));
        const expected = pageWindow.map((p) => p.id).filter((id) => !wpaIds.has(id));
        expect(shopIds, `${name} / ${cname}`).toEqual(expected);
      }
    }
  });

  it("the page window itself never exceeds the shared display limit", () => {
    for (const c of Object.values(CASES)) {
      for (const enemies of Object.values(COMPS)) {
        const signal = resolveCompSignal(enemies, c.build.items);
        expect(
          situationalShortlist(c.build.items, signal?.promotedIds ?? []).length
        ).toBeLessThanOrEqual(SITUATIONAL_DISPLAY_LIMIT);
      }
    }
  });
});

describe("a signal may permute the row and title it, and may do nothing else", () => {
  it("block CONTENTS are identical with and without a signal, on every fixture", () => {
    // The content freeze. Order and one title may move; membership may not.
    for (const [name, c] of Object.entries(CASES)) {
      const base = buildItemSets(c.champ, c.roleLabel, c.build, null, undefined, null, null);
      for (const [cname, enemies] of Object.entries(COMPS)) {
        const { sets } = exportWith(c, enemies);
        expect(sets[0].blocks.length, `${name}/${cname} block count`).toBe(base.sets[0].blocks.length);
        for (let i = 0; i < base.sets[0].blocks.length; i++) {
          const a = base.sets[0].blocks[i];
          const b = sets[0].blocks[i];
          expect(
            b.items.map((x) => Number(x.id)).sort((x, y) => x - y),
            `${name}/${cname} block ${i} (${a.type}) contents`
          ).toEqual(a.items.map((x) => Number(x.id)).sort((x, y) => x - y));
        }
      }
    }
  });

  it("no block other than Situational changes at all, not even its order", () => {
    for (const [name, c] of Object.entries(CASES)) {
      const base = buildItemSets(c.champ, c.roleLabel, c.build, null, undefined, null, null);
      for (const enemies of Object.values(COMPS)) {
        const { sets } = exportWith(c, enemies);
        const strip = (blocks: typeof sets[0]["blocks"]) =>
          JSON.stringify(blocks.filter((b) => !b.type.startsWith("Situational")));
        expect(strip(sets[0].blocks), name).toBe(strip(base.sets[0].blocks));
      }
    }
  });

  it("the item-set ENVELOPE is untouched, so no desktop release is needed", () => {
    for (const c of Object.values(CASES)) {
      const base = buildItemSets(c.champ, c.roleLabel, c.build, null, undefined, null, null);
      const { sets } = exportWith(c, CC_HEAVY);
      expect(sets).toHaveLength(1);
      expect(sets[0].uid).toBe(base.sets[0].uid);
      expect(sets[0].title).toBe(base.sets[0].title);
      expect(sets[0].associatedChampions).toEqual(base.sets[0].associatedChampions);
    }
  });
});

describe("the title is a claim, and it only appears when it is true", () => {
  it("Thresh vs a CC comp ships `Situational vs CC` with Mercury's first", () => {
    const { signal, sets } = exportWith(THRESH, CC_HEAVY);
    expect(signal!.rule).toBe("cc");
    const block = situationalBlock(sets)!;
    expect(block.type).toBe("Situational vs CC");
    expect(Number(block.items[0].id)).toBe(3111);
  });

  it("Urgot vs an AP comp ships `Situational vs AP`", () => {
    const block = situationalBlock(exportWith(URGOT, TWO_HEALERS).sets)!;
    expect(block.type).toBe("Situational vs AP");
    expect(Number(block.items[0].id)).toBe(3111);
  });

  it("Malphite vs 3 AD ships `Situational vs AD`", () => {
    const block = situationalBlock(exportWith(MALPHITE, THREE_AD).sets)!;
    expect(block.type).toBe("Situational vs AD");
    expect(Number(block.items[0].id)).toBe(3047);
  });

  it("keeps the bare title whenever no rule fired", () => {
    // Viktor has no armour boot and cannot afford Mercury's; Lux has neither
    // boot; a two-enemy comp is below the minimum. All three must read plain
    // `Situational`, because a suffix that is always there says nothing.
    for (const [name, c, enemies] of [
      ["viktor vs 3 AD", VIKTOR, THREE_AD],
      ["viktor vs CC", VIKTOR, CC_HEAVY],
      ["lux vs CC", LUX, CC_HEAVY],
      ["thresh partial", THRESH, PARTIAL],
    ] as const) {
      const { signal, sets } = exportWith(c, enemies);
      expect(signal, name).toBeNull();
      const block = situationalBlock(sets);
      if (block) expect(block.type, name).toBe("Situational");
    }
  });
});

describe("guarantees that must survive the export path, not just the signal", () => {
  it("no anti-heal item is ever added to any block by a comp", () => {
    for (const [name, c] of Object.entries(CASES)) {
      const base = buildItemSets(c.champ, c.roleLabel, c.build, null, undefined, null, null);
      const baseIds = new Set(base.sets[0].blocks.flatMap((b) => b.items.map((i) => Number(i.id))));
      for (const enemies of Object.values(COMPS)) {
        const { sets } = exportWith(c, enemies);
        for (const id of sets[0].blocks.flatMap((b) => b.items.map((i) => Number(i.id)))) {
          // Anything anti-heal in the set was already there without a comp.
          if (ANTI_HEAL.has(id)) expect(baseIds.has(id), `${name} added ${id}`).toBe(true);
        }
      }
    }
  });

  it("the overlay wire still pairs index-by-index with the reordered block", () => {
    // The reorder is exactly where a second derivation would misalign the
    // deltas, and both lists would still be the same LENGTH, so no size check
    // would notice. Assert the pairing itself.
    const { sets, situational } = exportWith(THRESH, CC_HEAVY);
    const block = situationalBlock(sets)!;
    expect(situational).toBeDefined();
    expect(situational!).toHaveLength(block.items.length);
    for (let i = 0; i < block.items.length; i++) {
      expect(situational![i].id, `wire[${i}]`).toBe(Number(block.items[i].id));
    }
  });

  it("degrades to the unchanged export when the champion has no alternatives", () => {
    const bare: ItemsBlock = { ...THRESH.build.items, alts: undefined };
    const build = { ...THRESH.build, items: bare } as BuildResponse;
    const signal = resolveCompSignal(CC_HEAVY, bare);
    expect(signal).toBeNull();
    const out = buildItemSets(THRESH.champ, THRESH.roleLabel, build, null, undefined, null, signal);
    expect(situationalBlock(out.sets)).toBeNull();
    expect(out.situational).toBeUndefined();
  });
});
