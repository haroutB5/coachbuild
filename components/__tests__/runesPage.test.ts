/**
 * Pure-logic tests for buildRunesPageModel / buildShardRow — the rune-page
 * assembly that expands the Hextech BUILD tab's RunesSummonersCard from a
 * keystone-only summary into the full recommended rune page. No JSX
 * rendering, no network — plain functions over the RunesBlock wire shape.
 */
import { describe, it, expect } from "vitest";
import { buildRunesPageModel, buildShardRow } from "../hextech/runesPage";
import type { RunesBlock, Pick as PickType } from "@/lib/types";

function pick(id: number, overrides: Partial<PickType> = {}): PickType {
  return {
    id,
    name: `Pick #${id}`,
    icon: `https://cdn.example/${id}.webp`,
    wpa: 0.01,
    winrate: null,
    occurrence: 1000,
    ...overrides,
  };
}

function tree(id: RunesBlock["primaryTree"]["id"], name: string): RunesBlock["primaryTree"] {
  return { id, name, icon: `https://cdn.example/tree-${id}.png` };
}

function makeRunes(overrides: Partial<RunesBlock> = {}): RunesBlock {
  return {
    primaryTree: tree(8200, "Sorcery"),
    secondaryTree: tree(8300, "Inspiration"),
    keystone: pick(8229, { name: "Arcane Comet" }),
    primary: [pick(1), pick(2), pick(3)],
    secondary: [pick(4), pick(5)],
    shards: {
      offense: pick(5008, { name: "Adaptive Force" }),
      flex: pick(5008, { name: "Adaptive Force (flex)" }),
      defense: pick(5011, { name: "Health" }),
    },
    ...overrides,
  };
}

describe("buildRunesPageModel", () => {
  it("passes through primary/secondary trees unchanged", () => {
    const runes = makeRunes();
    const model = buildRunesPageModel(runes);
    expect(model.primaryTree).toEqual(runes.primaryTree);
    expect(model.secondaryTree).toEqual(runes.secondaryTree);
  });

  it("carries all 3 primary minors and 2 secondary picks", () => {
    const runes = makeRunes();
    const model = buildRunesPageModel(runes);
    expect(model.primaryMinors.map((p) => p.id)).toEqual([1, 2, 3]);
    expect(model.secondaryPicks.map((p) => p.id)).toEqual([4, 5]);
  });

  it("orders shards Offense -> Flex -> Defense with labels", () => {
    const runes = makeRunes();
    const model = buildRunesPageModel(runes);
    expect(model.shards.map((s) => s.label)).toEqual(["Offense", "Flex", "Defense"]);
    expect(model.shards[0].pick.id).toBe(runes.shards.offense.id);
    expect(model.shards[2].pick.name).toBe("Health");
  });

  it("defaults primary/secondary to an empty array instead of throwing when missing", () => {
    const runes = makeRunes();
    // @ts-expect-error — simulating a malformed payload the typed contract disallows
    runes.primary = undefined;
    // @ts-expect-error — same, for secondary
    runes.secondary = null;
    const model = buildRunesPageModel(runes);
    expect(model.primaryMinors).toEqual([]);
    expect(model.secondaryPicks).toEqual([]);
  });

  it("tolerates a short primary/secondary array rather than assuming a fixed length", () => {
    const runes = makeRunes({ primary: [pick(1)], secondary: [] });
    const model = buildRunesPageModel(runes);
    expect(model.primaryMinors).toHaveLength(1);
    expect(model.secondaryPicks).toHaveLength(0);
  });
});

describe("buildShardRow", () => {
  it("returns exactly 3 labeled entries in a fixed order", () => {
    const shards = makeRunes().shards;
    const row = buildShardRow(shards);
    expect(row).toHaveLength(3);
    expect(row.map((s) => s.label)).toEqual(["Offense", "Flex", "Defense"]);
  });
});
