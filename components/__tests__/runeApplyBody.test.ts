import { describe, it, expect } from "vitest";
import { buildRuneApplyBody } from "../hextech/runeApplyBody";
import type { RunesBlock, Pick, TreeRef } from "@/lib/types";

function pick(id: number): Pick {
  return { id, name: `Rune ${id}`, icon: `icon-${id}`, wpa: 0.01, winrate: 52, occurrence: 1000 };
}

function tree(id: TreeRef["id"], name: string): TreeRef {
  return { id, name, icon: `tree-${id}` };
}

function baseRunes(overrides: Partial<RunesBlock> = {}): RunesBlock {
  return {
    primaryTree: tree(8200, "Sorcery"),
    secondaryTree: tree(8100, "Domination"),
    keystone: pick(8214), // Summon Aery
    primary: [pick(8226), pick(8210), pick(8237)],
    secondary: [pick(8143), pick(8135)],
    shards: { offense: pick(5008), flex: pick(5008), defense: pick(5001) },
    ...overrides,
  };
}

describe("buildRuneApplyBody", () => {
  it("assembles the exact 9-id order: keystone, 3 primary, 2 secondary, shards offense->flex->defense", () => {
    const runes = baseRunes();
    const body = buildRuneApplyBody("Viktor", "Mid", runes);
    expect(body.selectedPerkIds).toEqual([8214, 8226, 8210, 8237, 8143, 8135, 5008, 5008, 5001]);
    expect(body.selectedPerkIds).toHaveLength(9);
  });

  it("carries raw Riot perk ids verbatim — no remapping (§0 RISK #4 resolved)", () => {
    const runes = baseRunes();
    const body = buildRuneApplyBody("Ahri", "Mid", runes);
    expect(body.selectedPerkIds[0]).toBe(runes.keystone.id);
    expect(body.selectedPerkIds[7]).toBe(runes.shards.flex.id);
  });

  it("sets primaryStyleId/subStyleId from the tree refs' own ids", () => {
    const runes = baseRunes();
    const body = buildRuneApplyBody("Viktor", "Mid", runes);
    expect(body.primaryStyleId).toBe(8200);
    expect(body.subStyleId).toBe(8100);
  });

  it("names the page 'CoachBuild <champion> <role>'", () => {
    const body = buildRuneApplyBody("Lee Sin", "Jungle", baseRunes());
    expect(body.name).toBe("CoachBuild Lee Sin Jungle");
  });

  it("always sets current: true", () => {
    expect(buildRuneApplyBody("Viktor", "Mid", baseRunes()).current).toBe(true);
  });

  it("throws when runes.primary isn't exactly 3 entries", () => {
    const runes = baseRunes({ primary: [pick(1), pick(2)] });
    expect(() => buildRuneApplyBody("Viktor", "Mid", runes)).toThrow(/expected 9 perk ids/);
  });

  it("throws when runes.secondary isn't exactly 2 entries", () => {
    const runes = baseRunes({ secondary: [pick(1)] });
    expect(() => buildRuneApplyBody("Viktor", "Mid", runes)).toThrow(/expected 9 perk ids/);
  });

  it("matches a realistic full fixture end to end", () => {
    const runes: RunesBlock = {
      primaryTree: tree(8000, "Precision"),
      secondaryTree: tree(8400, "Resolve"),
      keystone: pick(8005), // Press the Attack
      primary: [pick(9111), pick(9104), pick(8014)],
      secondary: [pick(8446), pick(8453)],
      shards: { offense: pick(5005), flex: pick(5008), defense: pick(5002) },
    };
    const body = buildRuneApplyBody("Jinx", "Bot", runes);
    expect(body).toEqual({
      name: "CoachBuild Jinx Bot",
      primaryStyleId: 8000,
      subStyleId: 8400,
      selectedPerkIds: [8005, 9111, 9104, 8014, 8446, 8453, 5005, 5008, 5002],
      current: true,
    });
  });
});
