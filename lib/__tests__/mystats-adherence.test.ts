import { describe, it, expect } from "vitest";
import { computeAdherence, ADHERENCE_MIN_CORE_ITEM_HITS, type AdherenceInput } from "@/lib/mystats/adherence";

function input(over: Partial<AdherenceInput> = {}): AdherenceInput {
  return {
    matchItemIds: [3078, 3072, 3053, 3006, 3025, 0],
    matchKeystone: 8005,
    recommendedCoreItemIds: [3078, 3072, 3053],
    recommendedKeystoneId: 8005,
    ...over,
  };
}

describe("ADHERENCE_MIN_CORE_ITEM_HITS", () => {
  it("is 2 (of the 3 recommended core items)", () => {
    expect(ADHERENCE_MIN_CORE_ITEM_HITS).toBe(2);
  });
});

describe("computeAdherence", () => {
  it("null when no recommendation was available (no keystone)", () => {
    expect(computeAdherence(input({ recommendedKeystoneId: null }))).toBeNull();
  });

  it("null when no recommendation was available (empty core items)", () => {
    expect(computeAdherence(input({ recommendedCoreItemIds: [] }))).toBeNull();
  });

  it("true: keystone matches AND all 3 core items present", () => {
    expect(computeAdherence(input())).toBe(true);
  });

  it("true: keystone matches AND exactly 2 of 3 core items present (the floor)", () => {
    expect(
      computeAdherence(
        input({ matchItemIds: [3078, 3072, 9999, 1001, 0, 0] })
      )
    ).toBe(true);
  });

  it("false: keystone matches but only 1 of 3 core items present (below the floor)", () => {
    expect(
      computeAdherence(input({ matchItemIds: [3078, 9999, 8888, 1001, 0, 0] }))
    ).toBe(false);
  });

  it("false: all 3 core items present but keystone does NOT match", () => {
    expect(computeAdherence(input({ matchKeystone: 8021 }))).toBe(false);
  });

  it("false when the match's keystone is unresolved (null) even with a real recommendation", () => {
    expect(computeAdherence(input({ matchKeystone: null }))).toBe(false);
  });

  it("all-empty item slots (Riot's 0 sentinel) never satisfy a real recommended item id", () => {
    expect(
      computeAdherence(input({ matchItemIds: [0, 0, 0, 0, 0, 0] }))
    ).toBe(false);
  });
});
