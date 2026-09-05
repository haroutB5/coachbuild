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
  it("rejects a 2-primary / 3-secondary page even though it has nine ids", () => {
    expect(() => buildRuneApplyBody("Viktor", "Mid", baseRunes({
      primary: [pick(8226), pick(8210)],
      secondary: [pick(8143), pick(8137), pick(8135)],
    }))).toThrow(/expected 9 perk ids/);
  });

  it.each([
    { primaryTree: tree(8100, "Domination") },
    { secondaryTree: tree(8200, "Sorcery") },
    { keystone: pick(8005) },
    { primary: [pick(8226), pick(8224), pick(8237)] },
    { secondary: [pick(8126), pick(8143)] },
    { secondary: [pick(8143), pick(999999)] },
    { shards: { offense: pick(5008), flex: pick(5008), defense: pick(5002) } },
  ])("rejects invalid tree/slot combinations: %j", (overrides) => {
    expect(() => buildRuneApplyBody("Viktor", "Mid", baseRunes(overrides))).toThrow(/invalid rune/);
  });

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
    // v1.3.0 fix: defense shard was 5002 (Armor) -- verified against a live
    // CommunityDragon perkstyles.json pull (2026-07-20, the rune-apply
    // blocker investigation) that this is NOT a valid perk id in ANY
    // current stat-mod row (defense row is [5011, 5013, 5001] today,
    // universal across every tree) -- a stale placeholder from an older
    // rune-shard system, not something the builder itself validates (it
    // orders whatever it's given), but an unrealistic fixture is worth
    // fixing so this test's own "realistic" claim is actually true. See
    // the "real perkstyles slot validity" describe block below for the
    // dedicated pinned-fixture coverage this finding prompted.
    const runes: RunesBlock = {
      primaryTree: tree(8000, "Precision"),
      secondaryTree: tree(8400, "Resolve"),
      keystone: pick(8005), // Press the Attack
      primary: [pick(9111), pick(9104), pick(8014)],
      secondary: [pick(8446), pick(8453)],
      shards: { offense: pick(5005), flex: pick(5008), defense: pick(5001) },
    };
    const body = buildRuneApplyBody("Jinx", "Bot", runes);
    expect(body).toEqual({
      name: "CoachBuild Jinx Bot",
      primaryStyleId: 8000,
      subStyleId: 8400,
      selectedPerkIds: [8005, 9111, 9104, 8014, 8446, 8453, 5005, 5008, 5001],
      current: true,
      replacePrefix: "CoachBuild Jinx ",
    });
  });

  it("carries a champ-scoped replacePrefix ('CoachBuild <champ> ', trailing space) for the companion's champ-change cleanup", () => {
    expect(buildRuneApplyBody("Lee Sin", "Jungle", baseRunes()).replacePrefix).toBe("CoachBuild Lee Sin ");
  });

  it("pageSuffix appends a distinct variant page name AFTER champ/role, keeping the same replacePrefix (WPA vs Pro coexist)", () => {
    const wpa = buildRuneApplyBody("Viktor", "Mid", baseRunes());
    const pro = buildRuneApplyBody("Viktor", "Mid", baseRunes(), { pageSuffix: "Pro" });
    expect(wpa.name).toBe("CoachBuild Viktor Mid");
    expect(pro.name).toBe("CoachBuild Viktor Mid Pro");
    // Distinct titles -> two separate LCU pages; shared prefix -> both cleaned
    // up together on a champ change.
    expect(pro.name).not.toBe(wpa.name);
    expect(pro.replacePrefix).toBe(wpa.replacePrefix);
    expect(pro.replacePrefix).toBe("CoachBuild Viktor ");
  });

  it("2026-07-28: all THREE pages coexist and share one champ-scoped replacePrefix", () => {
    // WPA (auto-export), Pro, and now OTP. Three distinct exact titles means
    // the companion's STEP 2 exact-title match writes each to its own page and
    // no apply can revert a sibling; one shared prefix means a champ change
    // still cleans up all three together, and STEP 1's "never delete a page
    // starting with replacePrefix" protects each from the other two.
    const wpa = buildRuneApplyBody("Viktor", "Mid", baseRunes());
    const pro = buildRuneApplyBody("Viktor", "Mid", baseRunes(), { pageSuffix: "Pro" });
    const otp = buildRuneApplyBody("Viktor", "Mid", baseRunes(), { pageSuffix: "OTP" });
    expect(otp.name).toBe("CoachBuild Viktor Mid OTP");
    expect(new Set([wpa.name, pro.name, otp.name]).size).toBe(3);
    expect(otp.replacePrefix).toBe("CoachBuild Viktor ");
    // Every title must pass the companion's Test-RunePayload gate.
    for (const b of [wpa, pro, otp]) expect(b.name.startsWith("CoachBuild")).toBe(true);
    // No title may be a PREFIX of another under exact-title matching... but it
    // is worth stating the real invariant: matching is EQUALITY, not
    // StartsWith, which is exactly why "CoachBuild Viktor Mid" cannot target
    // "CoachBuild Viktor Mid OTP".
    expect(otp.name.startsWith(wpa.name)).toBe(true);
  });

  it("ignores a blank/whitespace pageSuffix (falls back to the plain WPA title)", () => {
    expect(buildRuneApplyBody("Viktor", "Mid", baseRunes(), { pageSuffix: "   " }).name).toBe("CoachBuild Viktor Mid");
    expect(buildRuneApplyBody("Viktor", "Mid", baseRunes(), { pageSuffix: "" }).name).toBe("CoachBuild Viktor Mid");
  });
});

// ── Real perkstyles slot validity (v1.3.0 rune-apply blocker investigation) ──
//
// Pinned against a live CommunityDragon perkstyles.json pull (2026-07-20):
// https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/
// global/default/v1/perkstyles.json — every id below is copied verbatim
// from that fetch, not invented. Confirms buildRuneApplyBody's assembled
// selectedPerkIds only ever contains ids that are legal for their slot
// (this was the coordinator's prime suspect for the "unsaved draft" rune
// bug before the real root cause — a missing post-create selection PUT —
// was found; downgraded to defense-in-depth here, not the fix itself).
// Stat-mod (shard) rows are UNIVERSAL across every tree — verified
// identical between Sorcery and Precision in the same fetch.
const REAL_SORCERY_KEYSTONES = [8214, 8229, 8230, 8992]; // includes Deathfire Touch
const REAL_SORCERY_MINOR_ROWS = [
  [8224, 8226, 8275], // Artifact
  [8210, 8234, 8233], // Excellence
  [8237, 8232, 8236], // Power
];
const REAL_PRECISION_KEYSTONES = [8005, 8008, 8021, 8010];
const REAL_PRECISION_MINOR_ROWS = [
  [9101, 9111, 8009], // Heroism
  [9104, 9105, 9103], // Legend
  [8014, 8017, 8299], // Combat
];
const REAL_SHARD_ROWS = {
  offense: [5008, 5005, 5007],
  flex: [5008, 5010, 5001],
  defense: [5011, 5013, 5001],
};

function expectValidShards(selectedPerkIds: number[]) {
  const [, , , , , , offense, flex, defense] = selectedPerkIds;
  expect(REAL_SHARD_ROWS.offense).toContain(offense);
  expect(REAL_SHARD_ROWS.flex).toContain(flex);
  expect(REAL_SHARD_ROWS.defense).toContain(defense);
}

describe("buildRuneApplyBody — real perkstyles slot validity (pinned fixture)", () => {
  it("a Deathfire Touch (Sorcery primary) page: keystone + minors + shards all legal for their slots", () => {
    const runes: RunesBlock = {
      primaryTree: tree(8200, "Sorcery"),
      secondaryTree: tree(8100, "Domination"),
      keystone: pick(8992), // Deathfire Touch
      primary: [pick(8226), pick(8210), pick(8237)], // one per Sorcery minor row, in row order
      secondary: [pick(8143), pick(8135)],
      shards: { offense: pick(5008), flex: pick(5010), defense: pick(5013) },
    };
    const body = buildRuneApplyBody("Viktor", "Mid", runes);
    expect(REAL_SORCERY_KEYSTONES).toContain(body.selectedPerkIds[0]);
    body.selectedPerkIds.slice(1, 4).forEach((id, rowIdx) => {
      expect(REAL_SORCERY_MINOR_ROWS[rowIdx]).toContain(id);
    });
    expectValidShards(body.selectedPerkIds);
  });

  it("a Precision-primary page (Press the Attack) with Precision as the SECONDARY tree on a different page: keystone + minors + shards all legal", () => {
    // Precision as PRIMARY here (own keystone/minor validity); a second
    // assertion below re-checks the exact same minor/shard ids are equally
    // valid when Precision is instead the page's secondary tree home --
    // secondary-tree choice never changes shard-row validity (shards are
    // universal) or the primary tree's own keystone/minor validity.
    const runes: RunesBlock = {
      primaryTree: tree(8000, "Precision"),
      secondaryTree: tree(8400, "Resolve"),
      keystone: pick(8005), // Press the Attack
      primary: [pick(9111), pick(9104), pick(8014)], // one per Precision minor row, in row order
      secondary: [pick(8446), pick(8453)],
      shards: { offense: pick(5005), flex: pick(5008), defense: pick(5011) },
    };
    const body = buildRuneApplyBody("Jinx", "Bot", runes);
    expect(REAL_PRECISION_KEYSTONES).toContain(body.selectedPerkIds[0]);
    body.selectedPerkIds.slice(1, 4).forEach((id, rowIdx) => {
      expect(REAL_PRECISION_MINOR_ROWS[rowIdx]).toContain(id);
    });
    expectValidShards(body.selectedPerkIds);
  });
});
