/**
 * Snowball stacks never take a COMPLETED build slot on the WPA path.
 *
 * User directive, 2026-07-29, restated "in general for all builds": Mejai's
 * Soulstealer is not a build item. v0.76.0 applied `lib/snowballStacks.ts` on
 * the Pro and OTP consensus surfaces, which aggregate stored games client-side.
 * The WPA build does not route through either — it is assembled server-side in
 * `lib/recommend.ts` from coachless's own WPA-ranked pools — so Mejai's was
 * still live on the Build tab after that ship.
 *
 * MEASURED ON PROD before the fix (2026-07-29, patch 16.13.1), which is where
 * every number below comes from:
 *   Ahri Mid    alts.second  Mejai's  wpa 1.393  8,149 games  78.5% wr
 *               alts.third   Mejai's  wpa 0.827 13,948 games  78.4% wr
 *   Annie Mid   alts.second  Mejai's  wpa 3.543    915 games  82.0% wr
 *   Veigar Mid  alts.third   Mejai's  wpa 2.910    715 games  81.5% wr  (TOP of the row)
 * It reached the build as a per-slot situational SWAP, never as a core pick —
 * which is exactly why reading first/second/third could not see it.
 *
 * Both facts this file pins are things a unit test on `isSnowballStackItem`
 * alone would happily assert while the engine still shipped Mejai's:
 *   1. The filter is WIRED into `buildRecommendations`, on every slot the
 *      /api/build contract carries.
 *   2. Dark Seal — also in the snowball family — is UNTOUCHED in the starter
 *      slot. It is barred from completed slots and is a genuine opening
 *      purchase; a broader sweep deleting it from the opener is a regression
 *      that already happened once this round.
 *
 * coachless + staticData are mocked; no network. Harness mirrors
 * supportFinalGroup.test.ts's layer 2 — the same "a guard nobody wired in is
 * not a guard" argument.
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
import { isSnowballStackItem } from "../snowballStacks";

const MEJAIS = 3041;
const DARK_SEAL = 1082;
const DORANS_RING = 1056;
const SORCS = 3020;
const LUDENS = 6655;
const RABADONS = 3089;
const ZHONYAS = 3157;
const SHADOWFLAME = 4645;
const VOID_STAFF = 3135;
const CRYPTBLOOM = 3137;
const BANSHEES = 3102;

const PATCH = { major: 16, patch: 13, patchAdditions: 0, label: "16.13" };
const MID_ROLE = 2;

function entry(itemId: number, wpaOverall: number, occurrence: number): ItemEntry {
  return {
    itemId,
    wpaOverall,
    wpaStandalone: wpaOverall,
    occurrence,
    occurrenceRelative: 0.1,
    winrateExpected: 0.5,
    winrateObserved: 0.78,
    averagePurchaseTime: 900,
    bias: 0,
  };
}

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
  /** The sequential optimizer's own conditioned fetch. Defaults to empty, which
   *  truncates the chain; a test that cares about the optimizer supplies it. */
  conditioned?: ItemEntry[];
}) {
  vi.mocked(getLatestPatch).mockResolvedValue(PATCH);
  vi.mocked(getChampionById).mockResolvedValue({
    id: 103,
    key: "Ahri",
    name: "Ahri",
    icon: "ahri.png",
    tags: ["Mage", "Assassin"],
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
      if (extras && "firstLegendaryId" in extras) return itemPools.conditioned ?? [];
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

/** Every id the /api/build contract can carry, EXCEPT the starter — the starter
 *  is the one slot a snowball stack is legitimately allowed in (Dark Seal), so
 *  folding it in here would make the main assertion unable to tell the two rules
 *  apart. `starterIdOf` below is the counterpart. */
function completedSlotIds(build: Awaited<ReturnType<typeof buildRecommendations>>[number]): number[] {
  const it = build.items;
  const ids = [it.boots.id, it.first.id, it.second.id, it.third.id, ...it.fourthPlus.map((p) => p.id)];
  if (it.optimizedPath) ids.push(...it.optimizedPath.map((p) => p.id));
  if (it.alts) for (const arr of Object.values(it.alts)) ids.push(...arr.map((p) => p.id));
  return ids;
}

/** The Ahri Mid shape measured on prod: Mejai's sitting in the SITUATIONAL SWAP
 *  rows of slots 2 and 3, below the core pick in each, with a real WPA. */
function ahriMidPools(overrides: Partial<Parameters<typeof setupEngineMocks>[0]> = {}) {
  return {
    starter: [entry(DORANS_RING, 1.0, 95000), entry(DARK_SEAL, 0.9, 42000)],
    boots: [entry(SORCS, 1.0, 80000)],
    leg1: [entry(LUDENS, 2.0, 50000), entry(SHADOWFLAME, 1.0, 30000)],
    // Mejai's below the core pick, so it lands in `alts.second`, exactly as prod
    // returned it (wpa 1.393, 8,149 games).
    leg2: [entry(RABADONS, 2.5, 45000), entry(MEJAIS, 1.393, 8149), entry(BANSHEES, 1.0, 20000)],
    // ...and again in `alts.third`, the Veigar shape: at the TOP of the row.
    leg3: [entry(ZHONYAS, 2.2, 40000), entry(MEJAIS, 2.91, 13948), entry(CRYPTBLOOM, 1.0, 18000)],
    leg456: [entry(VOID_STAFF, 1.0, 35000), entry(MEJAIS, 0.9, 13948)],
    ...overrides,
  };
}

describe("the snowball-stack rule is WIRED into buildRecommendations, not just written", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("keeps Mejai's out of EVERY completed slot, including the situational swaps", async () => {
    setupEngineMocks(ahriMidPools());
    const [top] = await buildRecommendations(103, MID_ROLE);

    // Before the fix this array contains 3041 twice — once from alts.second and
    // once from alts.third — which is precisely what prod was serving.
    expect(completedSlotIds(top).filter(isSnowballStackItem)).toEqual([]);
    expect(completedSlotIds(top)).not.toContain(MEJAIS);
  });

  it("promotes the next real item into the freed swap slot instead of leaving it short", async () => {
    // The subtle half, and the same trap lib/snowballStacks.ts's header
    // documents: `itemAlts` slices to 3. Dropping Mejai's AFTER the slice would
    // leave a two-chip row with a hole; dropping it before promotes the item
    // behind it. Slot 3's row here is Mejai's / Cryptbloom / Banshee's / Rylai's
    // with Mejai's at the top, so a post-slice filter yields 2 chips and a
    // pre-slice filter yields 3.
    setupEngineMocks(
      ahriMidPools({
        leg3: [
          entry(ZHONYAS, 2.2, 40000),
          entry(MEJAIS, 2.91, 13948),
          entry(CRYPTBLOOM, 1.5, 18000),
          entry(BANSHEES, 1.2, 17000),
          entry(3116, 1.0, 16000),
        ],
      })
    );
    const [top] = await buildRecommendations(103, MID_ROLE);
    const thirdAlts = (top.items.alts?.third ?? []).map((p) => p.id);

    expect(thirdAlts).not.toContain(MEJAIS);
    expect(thirdAlts).toHaveLength(3);
    expect(thirdAlts).toEqual([CRYPTBLOOM, BANSHEES, 3116]);
  });

  it("keeps Mejai's out of a core slot even when it carries the pool's best WPA", async () => {
    // The Annie shape (wpa 3.543 on 915 games) pushed to its limit: if the
    // filter ran anywhere downstream of `bestItem` this would ship Mejai's as
    // items.second, the headline build.
    setupEngineMocks(
      ahriMidPools({
        leg2: [entry(MEJAIS, 9.9, 60000), entry(RABADONS, 2.5, 45000), entry(BANSHEES, 1.0, 20000)],
      })
    );
    const [top] = await buildRecommendations(103, MID_ROLE);

    expect(top.items.second.id).toBe(RABADONS);
    expect(completedSlotIds(top)).not.toContain(MEJAIS);
  });

  it("keeps Mejai's out of the sequential optimizer's conditioned chain too", async () => {
    // The optimizer performs its OWN getGlobalItemStatistics fetches, so it
    // never passes through the pool boundary the other slots share. An
    // unfiltered chain would put Mejai's straight into items.optimizedPath.
    setupEngineMocks(
      ahriMidPools({ conditioned: [entry(MEJAIS, 9.9, 60000), entry(SHADOWFLAME, 2.0, 30000)] })
    );
    const [top] = await buildRecommendations(103, MID_ROLE);

    expect(top.items.optimizedPath?.map((p) => p.id) ?? []).not.toContain(MEJAIS);
  });
});

describe("Dark Seal keeps its opener behaviour on the WPA path", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("is still eligible for the Starting slot, and wins it when the sample says so", async () => {
    // Dark Seal is in SNOWBALL_STACK_ITEM_IDS. The rule is about BUILD SLOTS,
    // not openers — lib/snowballStacks.ts says so in those words, and the
    // featured card shows a real one-trick opening Dark Seal in ~6 games of 10.
    // Filtering the starter pool alongside the legendary pools would delete it
    // from the Build tab's Starting slot: a regression, not extra safety.
    setupEngineMocks(
      ahriMidPools({ starter: [entry(DARK_SEAL, 2.0, 42000), entry(DORANS_RING, 1.0, 95000)] })
    );
    const [top] = await buildRecommendations(103, MID_ROLE);

    expect(top.items.starter.id).toBe(DARK_SEAL);
    expect(isSnowballStackItem(top.items.starter.id)).toBe(true);
    // ...and it is still nowhere near a completed slot.
    expect(completedSlotIds(top)).not.toContain(DARK_SEAL);
  });

  it("does not displace a better opener — the pool still decides", async () => {
    setupEngineMocks(ahriMidPools());
    const [top] = await buildRecommendations(103, MID_ROLE);
    expect(top.items.starter.id).toBe(DORANS_RING);
  });

  it("is excluded from a LEGENDARY pool it has no business being in", async () => {
    // The other direction of the same rule: Dark Seal is a completed-slot
    // exclusion everywhere, and the starter carve-out must not leak into the
    // legendary pools by making the family a no-op there.
    setupEngineMocks(
      ahriMidPools({ leg2: [entry(DARK_SEAL, 9.9, 60000), entry(RABADONS, 2.5, 45000), entry(BANSHEES, 1.0, 20000)] })
    );
    const [top] = await buildRecommendations(103, MID_ROLE);
    expect(top.items.second.id).toBe(RABADONS);
    expect(completedSlotIds(top)).not.toContain(DARK_SEAL);
  });
});
