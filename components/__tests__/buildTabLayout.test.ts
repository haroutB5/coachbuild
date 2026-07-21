import { describe, it, expect } from "vitest";
import { BUILD_TAB_LAYOUT, type BuildCardId } from "../hextech/buildTabLayout";

describe("BUILD_TAB_LAYOUT", () => {
  it("left column is [runes, core]", () => {
    expect(BUILD_TAB_LAYOUT.left).toEqual(["runes", "core"]);
  });

  it("right column is [starting, proConsensus, situational]", () => {
    expect(BUILD_TAB_LAYOUT.right).toEqual(["starting", "proConsensus", "situational"]);
  });

  it("every card appears exactly once across both columns", () => {
    const all = [...BUILD_TAB_LAYOUT.left, ...BUILD_TAB_LAYOUT.right];
    const expected: BuildCardId[] = ["runes", "core", "starting", "proConsensus", "situational"];
    expect(all.sort()).toEqual([...expected].sort());
    expect(new Set(all).size).toBe(all.length);
  });

  it("no card is dropped or duplicated relative to the 5 known cards", () => {
    const all = [...BUILD_TAB_LAYOUT.left, ...BUILD_TAB_LAYOUT.right];
    expect(all).toHaveLength(5);
  });
});
