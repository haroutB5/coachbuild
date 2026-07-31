import { describe, it, expect } from "vitest";
import {
  computeAdherence,
  ADHERENCE_MIN_CORE_ITEM_HITS,
  comparePatchLabels,
  isWaitingForPatchData,
  type AdherenceInput,
} from "@/lib/mystats/adherence";

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

describe("comparePatchLabels", () => {
  it("numeric major.minor comparison, not lexical -- 16.9 < 16.14", () => {
    expect(comparePatchLabels("16.14", "16.9")).toBe(1);
    expect(comparePatchLabels("16.9", "16.14")).toBe(-1);
  });

  it("equal patches -> 0", () => {
    expect(comparePatchLabels("16.15", "16.15")).toBe(0);
  });

  it("different major versions compare on major first", () => {
    expect(comparePatchLabels("17.1", "16.20")).toBe(1);
  });

  it("unparseable labels -> 0 (can't tell, never a false claim either way)", () => {
    expect(comparePatchLabels("garbage", "16.15")).toBe(0);
    expect(comparePatchLabels("16.15", "")).toBe(0);
  });
});

describe("isWaitingForPatchData (2026-07-31 audit P2, #4)", () => {
  const base = { onWpaBuild: null as boolean | null, role: 2, matchPatch: "16.15", populatedPatch: "16.13" };

  it("true: null on_wpa_build, valid role, match patch NEWER than the populated patch (upstream lag)", () => {
    expect(isWaitingForPatchData(base)).toBe(true);
  });

  it("false when onWpaBuild is a real boolean -- a comparison WAS made, nothing to reclassify", () => {
    expect(isWaitingForPatchData({ ...base, onWpaBuild: true })).toBe(false);
    expect(isWaitingForPatchData({ ...base, onWpaBuild: false })).toBe(false);
  });

  it("false when role is unresolved (ARAM/remake) -- genuinely unresolvable, not a patch-lag question", () => {
    expect(isWaitingForPatchData({ ...base, role: -1 })).toBe(false);
    expect(isWaitingForPatchData({ ...base, role: 5 })).toBe(false);
  });

  it("false when the match patch is OLDER than the populated patch -- a real historical patch, stays 'not-recorded'", () => {
    expect(isWaitingForPatchData({ ...base, matchPatch: "16.10", populatedPatch: "16.13" })).toBe(false);
  });

  it("false when the match patch EQUALS the populated patch -- would have resolved if it could", () => {
    expect(isWaitingForPatchData({ ...base, matchPatch: "16.13", populatedPatch: "16.13" })).toBe(false);
  });

  it("false when either patch is null/unresolvable -- nothing to compare, stays honestly 'not-recorded'", () => {
    expect(isWaitingForPatchData({ ...base, matchPatch: null })).toBe(false);
    expect(isWaitingForPatchData({ ...base, populatedPatch: null })).toBe(false);
  });

  it("live-probed real-world case (2026-07-31): ddragon 16.15 vs coachless's populated 16.13", () => {
    expect(isWaitingForPatchData({ onWpaBuild: null, role: 0, matchPatch: "16.15", populatedPatch: "16.13" })).toBe(true);
  });
});
