import { describe, it, expect } from "vitest";
import { flattenSituational, orderSituationalForComp } from "../hextech/situational";
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

  it("breaks equal-WPA ties by item id, independent of alternative order", () => {
    const alts = {
      first: [pick(22, 0.02), pick(21, 0.02)],
    };
    const out = flattenSituational(baseItems(alts));
    expect(out.map((p) => p.id)).toEqual([21, 22]);
  });
});

describe("orderSituationalForComp", () => {
  const picks = [pick(10, 0.5), pick(11, 0.3), pick(12, 0.1), pick(13, -0.2)];

  it("returns a copy in the original order when nothing is promoted", () => {
    const out = orderSituationalForComp(picks, []);
    expect(out.map((p) => p.id)).toEqual([10, 11, 12, 13]);
    expect(out).not.toBe(picks);
  });

  it("moves a promoted pick to the front", () => {
    expect(orderSituationalForComp(picks, [12]).map((p) => p.id)).toEqual([12, 10, 11, 13]);
  });

  it("can lift a pick from outside the display window into it", () => {
    // The reason this runs BEFORE the top-6 slice. A comp-relevant pick at
    // position 7 on raw WPA has to be able to reach the visible six.
    const seven = [...picks, pick(14, -0.4), pick(15, -0.5), pick(16, -0.9)];
    const out = orderSituationalForComp(seven, [16]).slice(0, 6);
    expect(out.map((p) => p.id)).toContain(16);
  });

  it("is content-preserving: a permutation, never a re-selection", () => {
    // The structural form of RC-5b's rule. Same members, same length, for
    // every subset of ids that could be promoted.
    const before = picks.map((p) => p.id).sort();
    for (const promoted of [[], [10], [13], [11, 13], [10, 11, 12, 13]]) {
      const out = orderSituationalForComp(picks, promoted);
      expect(out.map((p) => p.id).sort()).toEqual(before);
    }
  });

  it("ignores an id that is not in the list, because it cannot add one", () => {
    expect(orderSituationalForComp(picks, [999]).map((p) => p.id)).toEqual([10, 11, 12, 13]);
  });

  it("preserves relative order inside both groups", () => {
    expect(orderSituationalForComp(picks, [13, 11]).map((p) => p.id)).toEqual([11, 13, 10, 12]);
  });

  it("does not mutate its input", () => {
    const snapshot = picks.map((p) => p.id);
    orderSituationalForComp(picks, [13]);
    expect(picks.map((p) => p.id)).toEqual(snapshot);
  });
});
