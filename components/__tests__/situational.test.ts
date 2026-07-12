import { describe, it, expect } from "vitest";
import { flattenSituational } from "../hextech/situational";
import type { ItemsBlock, Pick } from "@/lib/types";

function pick(id: number, wpa: number): Pick {
  return { id, name: `Item ${id}`, icon: `icon-${id}`, wpa, winrate: null, occurrence: 1000 };
}

function baseItems(alts?: ItemsBlock["alts"]): ItemsBlock {
  return {
    starter: pick(1, 0),
    boots: pick(2, 0),
    first: pick(3, 0),
    second: pick(4, 0),
    third: pick(5, 0),
    fourthPlus: [],
    alts,
  };
}

describe("flattenSituational", () => {
  it("returns [] when items.alts is absent", () => {
    expect(flattenSituational(baseItems(undefined))).toEqual([]);
  });

  it("returns [] when items.alts is an empty object", () => {
    expect(flattenSituational(baseItems({}))).toEqual([]);
  });

  it("flattens picks across every slot", () => {
    const alts = {
      second: [pick(10, 0.01)],
      third: [pick(11, 0.02)],
    };
    const out = flattenSituational(baseItems(alts));
    expect(out.map((p) => p.id).sort()).toEqual([10, 11]);
  });

  it("dedupes by id across slots, keeping the first occurrence", () => {
    const alts = {
      second: [pick(10, 0.05)],
      third: [pick(10, 0.05), pick(11, 0.01)],
    };
    const out = flattenSituational(baseItems(alts));
    expect(out.filter((p) => p.id === 10)).toHaveLength(1);
    expect(out).toHaveLength(2);
  });

  it("sorts descending by wpa", () => {
    const alts = {
      first: [pick(20, -0.02), pick(21, 0.03), pick(22, 0.01)],
    };
    const out = flattenSituational(baseItems(alts));
    expect(out.map((p) => p.id)).toEqual([21, 22, 20]);
  });
});
