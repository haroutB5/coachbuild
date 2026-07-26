/**
 * lib/supportFinalGroup.ts — the mutually-exclusive support-quest final family.
 *
 * Two layers here:
 *  1. `collapseSupportFinalPools` as a pure function.
 *  2. An END-TO-END proof that `buildRecommendations` actually applies it.
 *     That second layer is the point: a passing unit test for a guard that was
 *     never wired in would be exactly the "can't happen" claim this work exists
 *     to disprove. coachless + staticData are mocked; no network.
 *
 * Live context (probed 2026-07-26, patch 16.13.0, 6 support champs): the five
 * finals are coachless ItemType 3 and NOTHING in lib/ requests type 3, so this
 * scenario cannot occur against today's API. The fixtures below simulate the
 * day it can — an added type-3 fetch or an upstream reclassification — using
 * the real measured occurrences from that probe (Thresh Support: Solstice
 * Sleigh 282,980 / Celestial Opposition 233,952).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../coachless", () => ({
  getKeystoneData: vi.fn(),
  getRunesForKeystoneAndTree: vi.fn(),
  getShardsForKeystoneAndTree: vi.fn(),
  getGlobalItemStatistics: vi.fn(),
  getGlobalSummonerSpellStatistics: vi.fn(),
}));
vi.mock("../staticData", () => ({
  getLatestPatch: vi.fn(),
  getChampionById: vi.fn(),
  resolveRune: vi.fn(),
  resolveItem: vi.fn(),
  resolveSpell: vi.fn(),
  resolveShardSync: vi.fn(),
  treeIcon: vi.fn(),
  treeName: vi.fn(),
  treeIdFromIconPath: vi.fn(),
  loadRuneMap: vi.fn(),
}));

import {
  SUPPORT_FINAL_ITEMS,
  SUPPORT_FINAL_ITEM_IDS,
  isSupportFinalItem,
  collapseSupportFinalPools,
} from "../supportFinalGroup";
import {
  getKeystoneData,
  getRunesForKeystoneAndTree,
  getShardsForKeystoneAndTree,
  getGlobalItemStatistics,
  getGlobalSummonerSpellStatistics,
  type ItemEntry,
} from "../coachless";
import {
  getLatestPatch,
  getChampionById,
  resolveRune,
  resolveItem,
  resolveSpell,
  resolveShardSync,
  treeIcon,
  treeName,
  treeIdFromIconPath,
  loadRuneMap,
} from "../staticData";
import { buildRecommendations } from "../recommend";

const SOLSTICE = SUPPORT_FINAL_ITEMS.solsticeSleigh.id; // 3876
const CELESTIAL = SUPPORT_FINAL_ITEMS.celestialOpposition.id; // 3869
const BLOODSONG = SUPPORT_FINAL_ITEMS.bloodsong.id; // 3877

/** A coachless ItemEntry with only the fields anything here reads varied. */
function entry(itemId: number, wpaOverall: number, occurrence: number): ItemEntry {
  return {
    itemId,
    wpaOverall,
    wpaStandalone: wpaOverall,
    occurrence,
    occurrenceRelative: 0.1,
    winrateExpected: 0.5,
    winrateObserved: 0.52,
    averagePurchaseTime: 900,
    bias: 0,
  };
}

// ── Layer 1: the pure collapse ──────────────────────────────────────────────

describe("collapseSupportFinalPools", () => {
  it("is an identity transform when no pool holds a family member (the live case today)", () => {
    const pools = [[entry(3157, 2, 50000)], [entry(3089, 1.5, 40000), entry(3135, 1, 30000)]];
    expect(collapseSupportFinalPools(pools)).toEqual(pools);
  });

  it("leaves a lone family member alone — one final is a legitimate build", () => {
    const pools = [[entry(SOLSTICE, 3, 282980), entry(3089, 1, 40000)]];
    expect(collapseSupportFinalPools(pools)).toEqual(pools);
  });

  it("keeps only the most-built final when two land in DIFFERENT pools", () => {
    const pools = [
      [entry(SOLSTICE, 1.0, 282980), entry(3089, 5.0, 40000)],
      [entry(CELESTIAL, 9.9, 233952), entry(3135, 1.0, 30000)],
    ];
    const out = collapseSupportFinalPools(pools);
    expect(out[0].map((e) => e.itemId)).toEqual([SOLSTICE, 3089]);
    // Dropped despite having by far the highest WPA in its pool: the two are
    // mutually exclusive and the SAMPLE, not the score, decides which one the
    // champion actually builds.
    expect(out[1].map((e) => e.itemId)).toEqual([3135]);
  });

  it("keeps only the most-built final when several land in the SAME pool", () => {
    const pools = [[entry(CELESTIAL, 1, 233952), entry(SOLSTICE, 1, 282980), entry(BLOODSONG, 1, 4741)]];
    expect(collapseSupportFinalPools(pools)[0].map((e) => e.itemId)).toEqual([SOLSTICE]);
  });

  it("keeps the winner in EVERY pool it appears in — which slot to buy it in stays the engine's call", () => {
    const pools = [[entry(SOLSTICE, 1, 282980)], [entry(SOLSTICE, 2, 100)], [entry(CELESTIAL, 3, 233952)]];
    const out = collapseSupportFinalPools(pools);
    expect(out.map((p) => p.map((e) => e.itemId))).toEqual([[SOLSTICE], [SOLSTICE], []]);
  });

  it("ranks on each id's BEST occurrence in any single pool, not a cross-pool sum", () => {
    // Summing would make CELESTIAL (90+90=180) beat SOLSTICE (100+70=170) —
    // and would let the SHAPE of the pool list decide the winner. Max does not.
    const pools = [
      [entry(SOLSTICE, 1, 100), entry(CELESTIAL, 1, 90)],
      [entry(SOLSTICE, 1, 70), entry(CELESTIAL, 1, 90)],
    ];
    const out = collapseSupportFinalPools(pools);
    expect(out.flat().map((e) => e.itemId)).toEqual([SOLSTICE, SOLSTICE]);
  });

  it("breaks an exact occurrence tie deterministically by lowest itemId", () => {
    const a = collapseSupportFinalPools([[entry(SOLSTICE, 1, 1000), entry(CELESTIAL, 1, 1000)]]);
    const b = collapseSupportFinalPools([[entry(CELESTIAL, 1, 1000), entry(SOLSTICE, 1, 1000)]]);
    expect(a[0].map((e) => e.itemId)).toEqual([CELESTIAL]); // 3869 < 3876
    expect(b[0].map((e) => e.itemId)).toEqual([CELESTIAL]);
  });

  it("never mutates the pools it was handed", () => {
    const p0 = [entry(SOLSTICE, 1, 282980)];
    const p1 = [entry(CELESTIAL, 1, 233952)];
    collapseSupportFinalPools([p0, p1]);
    expect(p0).toHaveLength(1);
    expect(p1).toHaveLength(1);
  });

  it("tolerates empty pools and an empty pool list", () => {
    expect(collapseSupportFinalPools([])).toEqual([]);
    expect(collapseSupportFinalPools([[], []])).toEqual([[], []]);
  });

  it("agrees with the family membership set it guards", () => {
    expect(SUPPORT_FINAL_ITEM_IDS.size).toBe(5);
    SUPPORT_FINAL_ITEM_IDS.forEach((id) => expect(isSupportFinalItem(id)).toBe(true));
    expect(isSupportFinalItem(3867)).toBe(false); // Bounty of Worlds — the hub, not a final
    expect(isSupportFinalItem(3865)).toBe(false); // World Atlas — the starter
  });
});

// ── Layer 2: the guard is actually WIRED into the engine ────────────────────

const PATCH = { major: 16, patch: 13, patchAdditions: 0, label: "16.13" };
const SUPPORT_ROLE = 4;

/** One rune row shaped so `secondariesFor` always finds 2 displayable runes. */
const RUNE_ROWS = {
  rowOnes: [{ rune: 8100, runeType: 1, wpaOverall: 1, occurrence: 60000 }],
  rowTwos: [{ rune: 8200, runeType: 1, wpaOverall: 1, occurrence: 55000 }],
  rowThrees: [{ rune: 8300, runeType: 1, wpaOverall: 1, occurrence: 50000 }],
};

function setupEngineMocks(itemPools: {
  starter: ItemEntry[];
  boots: ItemEntry[];
  leg1: ItemEntry[];
  leg2: ItemEntry[];
  leg3: ItemEntry[];
  leg456: ItemEntry[];
}) {
  vi.mocked(getLatestPatch).mockResolvedValue(PATCH);
  vi.mocked(getChampionById).mockResolvedValue({
    id: 412,
    key: "Thresh",
    name: "Thresh",
    icon: "thresh.png",
    tags: ["Support", "Fighter"],
  });
  vi.mocked(loadRuneMap).mockResolvedValue({
    "8005": { Name: "Press the Attack", Icon: "perk-images/Styles/Precision/x.png" },
  });
  vi.mocked(treeIdFromIconPath).mockReturnValue(8000);
  vi.mocked(treeName).mockImplementation((t: number) => `Tree${t}`);
  vi.mocked(treeIcon).mockImplementation((t: number) => `tree${t}.png`);
  vi.mocked(resolveRune).mockImplementation(async (id: number) => ({ id, name: `Rune${id}`, icon: `r${id}.png` }));
  vi.mocked(resolveItem).mockImplementation(async (id: number) => ({ id, name: `Item${id}`, icon: `i${id}.png` }));
  vi.mocked(resolveSpell).mockImplementation(async (id: number) => ({ id, name: `Spell${id}`, icon: `s${id}.png` }));
  vi.mocked(resolveShardSync).mockImplementation((id: number) => ({ name: `Shard${id}`, icon: `sh${id}.png` }));

  vi.mocked(getKeystoneData).mockResolvedValue([
    { rune: 8005, runeType: 0, wpaOverall: 1.2, occurrence: 100000 },
  ]);
  vi.mocked(getShardsForKeystoneAndTree).mockResolvedValue({
    offense: [{ rune: 5008, runeType: 2, wpaOverall: 1, occurrence: 90000 }],
    flex: [{ rune: 5008, runeType: 2, wpaOverall: 1, occurrence: 90000 }],
    defense: [{ rune: 5001, runeType: 2, wpaOverall: 1, occurrence: 90000 }],
  });
  vi.mocked(getRunesForKeystoneAndTree).mockResolvedValue(RUNE_ROWS);
  vi.mocked(getGlobalSummonerSpellStatistics).mockResolvedValue([
    { summonerSpell: 4, wpaOverall: 1, occurrence: 95000, occurrenceRelative: 0.9, winrateExpected: 0.5, winrateObserved: 0.51, averageCasts: 5 },
    { summonerSpell: 14, wpaOverall: 0.8, occurrence: 60000, occurrenceRelative: 0.6, winrateExpected: 0.5, winrateObserved: 0.51, averageCasts: 4 },
  ]);

  vi.mocked(getGlobalItemStatistics).mockImplementation(
    async (_c, _r, _p, itemSlots, itemType, extras) => {
      // The sequential optimizer's conditioned fetches — truncate immediately so
      // this fixture exercises the core/situational path only.
      if (extras && "firstLegendaryId" in extras) return [];
      if (itemType === 6) return itemPools.starter;
      if (itemType === 2) return itemPools.boots;
      const slots = itemSlots ?? [];
      if (slots.includes(4)) return itemPools.leg456;
      if (slots[0] === 1) return itemPools.leg1;
      if (slots[0] === 2) return itemPools.leg2;
      if (slots[0] === 3) return itemPools.leg3;
      return [];
    }
  );
}

/** Every item id the /api/build contract can carry, across every slot. */
function allBuildItemIds(build: Awaited<ReturnType<typeof buildRecommendations>>[number]): number[] {
  const it = build.items;
  const ids = [it.starter.id, it.boots.id, it.first.id, it.second.id, it.third.id, ...it.fourthPlus.map((p) => p.id)];
  if (it.optimizedPath) ids.push(...it.optimizedPath.map((p) => p.id));
  if (it.alts) for (const arr of Object.values(it.alts)) ids.push(...arr.map((p) => p.id));
  return ids;
}

describe("buildRecommendations — the support-final guard is wired, not just written", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("seats AT MOST ONE support-quest final when two arrive in different slot pools", async () => {
    // Simulates a type-3 pool merged into the legendary slots. Real measured
    // occurrences; both clear the adoption bar (max(500, 100000*0.05) = 5000)
    // by two orders of magnitude, and the LOSER carries the higher WPA — so
    // nothing but the family collapse can keep it out.
    setupEngineMocks({
      starter: [entry(3865, 1.0, 95000)],
      boots: [entry(3047, 1.0, 80000), entry(3111, 0.5, 40000)],
      leg1: [entry(3157, 2.0, 50000)],
      leg2: [entry(SOLSTICE, 3.0, 282980), entry(3089, 1.0, 40000)],
      leg3: [entry(CELESTIAL, 9.9, 233952), entry(3135, 1.0, 40000)],
      leg456: [entry(3115, 1.0, 35000), entry(3116, 0.9, 30000)],
    });

    const [top] = await buildRecommendations(412, SUPPORT_ROLE);
    const finals = allBuildItemIds(top).filter(isSupportFinalItem);

    // Without the collapse this is [3876, 3869] — items.second and items.third
    // are two items the player can only ever own one of.
    expect(finals).toEqual([SOLSTICE]);
    expect(top.items.second.id).toBe(SOLSTICE);
    expect(top.items.third.id).toBe(3135);
  });

  it("never offers a situational SWAP between two mutually-exclusive finals", async () => {
    // The loser sits below the core pick in its own pool, so it is never chosen
    // for the build line — it goes to `alts`, i.e. the Situational swaps chip
    // row, which has no family filter of its own and dedupes by exact id only.
    setupEngineMocks({
      starter: [entry(3865, 1.0, 95000)],
      boots: [entry(3047, 1.0, 80000)],
      leg1: [entry(3157, 2.0, 50000)],
      leg2: [entry(SOLSTICE, 3.0, 282980), entry(CELESTIAL, 2.5, 233952), entry(3089, 1.0, 40000)],
      leg3: [entry(3135, 1.5, 40000)],
      leg456: [entry(3115, 1.0, 35000)],
    });

    const [top] = await buildRecommendations(412, SUPPORT_ROLE);
    const altIds = Object.values(top.items.alts ?? {}).flat().map((p) => p.id);

    expect(altIds).not.toContain(CELESTIAL);
    expect(allBuildItemIds(top).filter(isSupportFinalItem)).toEqual([SOLSTICE]);
  });

  it("leaves a build with ONE final untouched — the guard removes duplicates, never the item", async () => {
    setupEngineMocks({
      starter: [entry(3865, 1.0, 95000)],
      boots: [entry(3047, 1.0, 80000)],
      leg1: [entry(3157, 2.0, 50000)],
      leg2: [entry(SOLSTICE, 3.0, 282980), entry(3089, 1.0, 40000)],
      leg3: [entry(3135, 1.5, 40000)],
      leg456: [entry(3115, 1.0, 35000)],
    });

    const [top] = await buildRecommendations(412, SUPPORT_ROLE);
    expect(allBuildItemIds(top).filter(isSupportFinalItem)).toEqual([SOLSTICE]);
  });

  it("is a no-op for the data the API actually returns today (no family member anywhere)", async () => {
    setupEngineMocks({
      starter: [entry(3865, 1.0, 95000)],
      boots: [entry(3047, 1.0, 80000)],
      leg1: [entry(3157, 2.0, 50000)],
      leg2: [entry(3089, 1.8, 45000)],
      leg3: [entry(3135, 1.5, 40000)],
      leg456: [entry(3115, 1.0, 35000)],
    });

    const [top] = await buildRecommendations(412, SUPPORT_ROLE);
    expect(allBuildItemIds(top).filter(isSupportFinalItem)).toEqual([]);
    expect([top.items.first.id, top.items.second.id, top.items.third.id]).toEqual([3157, 3089, 3135]);
  });
});
