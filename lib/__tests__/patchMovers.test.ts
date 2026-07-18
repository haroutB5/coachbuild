/**
 * Feature 4: patch movers — pure delta computation + orchestrator (injected deps,
 * no network). Covers: keystone/item mover extraction, both-patch presence guard,
 * ranking + cap, and the unsupported (no previous patch) path.
 */
import { describe, it, expect } from "vitest";
import {
  computeMoversForChamp,
  computeRankedMovers,
  computePatchMovers,
  type ChampPatchData,
  type PatchMoversDeps,
} from "../patchMovers";
import type { RuneEntry, ItemEntry } from "../coachless";
import type { ResolvedPatch } from "../staticData";

const rune = (r: number, occ: number, wpa: number): RuneEntry => ({
  rune: r,
  runeType: 0,
  occurrence: occ,
  wpaOverall: wpa,
});
const it0 = (id: number, occ: number, wpa: number): ItemEntry => ({
  itemId: id,
  occurrence: occ,
  wpaOverall: wpa,
  wpaStandalone: 0,
  occurrenceRelative: 0,
  winrateExpected: 50,
  winrateObserved: 50,
  averagePurchaseTime: 0,
  bias: 0,
});

const champ = (over: Partial<ChampPatchData>): ChampPatchData => ({
  championId: 112,
  lane: 2,
  currGames: 10000,
  keystoneCur: [],
  keystonePrev: [],
  item1Cur: [],
  item1Prev: [],
  ...over,
});

describe("computeMoversForChamp", () => {
  it("emits a keystone mover for the headline keystone present in BOTH patches", () => {
    const m = computeMoversForChamp(
      champ({
        keystoneCur: [rune(8992, 300000, 0.5), rune(8214, 1000, -0.3)],
        keystonePrev: [rune(8992, 280000, 0.1)],
      })
    );
    const ks = m.find((x) => x.kind === "keystone")!;
    expect(ks.entityId).toBe(8992);
    expect(ks.currWpa).toBe(0.5);
    expect(ks.prevWpa).toBe(0.1);
    expect(ks.delta).toBeCloseTo(0.4, 5);
    expect(ks.gamesCount).toBe(300000);
  });

  it("skips the keystone mover when the headline keystone is absent in the prev patch", () => {
    const m = computeMoversForChamp(
      champ({ keystoneCur: [rune(8992, 300000, 0.5)], keystonePrev: [rune(8000, 100, 0.1)] })
    );
    expect(m.some((x) => x.kind === "keystone")).toBe(false);
  });

  it("emits an item mover (headline first legendary present in both)", () => {
    const m = computeMoversForChamp(
      champ({
        item1Cur: [it0(2503, 240000, 0.9)],
        item1Prev: [it0(2503, 200000, -0.2)],
      })
    );
    const item = m.find((x) => x.kind === "item")!;
    expect(item.entityId).toBe(2503);
    expect(item.delta).toBeCloseTo(1.1, 5);
  });

  it("emits nothing for a champ with no data", () => {
    expect(computeMoversForChamp(champ({}))).toEqual([]);
  });
});

describe("computeRankedMovers", () => {
  it("filters below minGames, ranks pool by current games, sorts by |delta|, caps rows", () => {
    const champs: ChampPatchData[] = [
      champ({
        championId: 1,
        currGames: 100, // below minGames → dropped
        keystoneCur: [rune(1, 100, 5)],
        keystonePrev: [rune(1, 100, 0)],
      }),
      champ({
        championId: 2,
        currGames: 50000,
        keystoneCur: [rune(2, 50000, 0.2)],
        keystonePrev: [rune(2, 40000, 0.1)], // delta 0.1
      }),
      champ({
        championId: 3,
        currGames: 30000,
        keystoneCur: [rune(3, 30000, 2.0)],
        keystonePrev: [rune(3, 25000, 0.0)], // delta 2.0 (biggest)
      }),
    ];
    const ranked = computeRankedMovers(champs, { topChamps: 25, maxRows: 5, minGames: 500 });
    expect(ranked.map((m) => m.championId)).toEqual([3, 2]); // |2.0| before |0.1|, champ1 dropped
  });

  it("respects maxRows", () => {
    const champs = Array.from({ length: 10 }, (_, i) =>
      champ({
        championId: i + 1,
        currGames: 10000 + i,
        keystoneCur: [rune(i + 1, 10000, i)],
        keystonePrev: [rune(i + 1, 9000, 0)],
      })
    );
    expect(computeRankedMovers(champs, { topChamps: 25, maxRows: 3, minGames: 500 })).toHaveLength(3);
  });
});

// ── Orchestrator (injected deps) ─────────────────────────────────────────────

const P = (major: number, patch: number): ResolvedPatch => ({
  major,
  patch,
  patchAdditions: 0,
  label: `${major}.${patch}`,
});

function makeDeps(over: Partial<PatchMoversDeps> = {}): PatchMoversDeps {
  return {
    getCurrentPatch: async () => P(16, 13),
    getPrevPatch: async () => P(16, 12),
    fetchKeystone: async (champId, _role, patch) =>
      patch.patch === 13 ? [rune(8992, 300000, 0.6)] : [rune(8992, 280000, 0.1)],
    fetchItem1: async (champId, _role, patch) =>
      patch.patch === 13 ? [it0(2503, 240000, 0.9)] : [it0(2503, 200000, 0.2)],
    championNames: async () => new Map([[112, "Viktor"]]),
    resolveRuneMeta: async (id) => ({ name: `Rune ${id}`, icon: `rune-${id}.png` }),
    resolveItemMeta: async (id) => ({ name: `Item ${id}`, icon: `item-${id}.png` }),
    pool: [112],
    ...over,
  };
}

describe("computePatchMovers orchestrator", () => {
  it("returns { unsupported: true } when there is no previous populated patch", async () => {
    const res = await computePatchMovers(2, makeDeps({ getPrevPatch: async () => null }));
    expect(res).toEqual({ unsupported: true });
  });

  it("computes enriched movers with resolved names/icons + patch labels", async () => {
    const res = await computePatchMovers(2, makeDeps());
    if ("unsupported" in res) throw new Error("should be supported");
    expect(res.patch).toBe("16.13");
    expect(res.prevPatch).toBe("16.12");
    // keystone delta 0.5, item delta 0.7 → item first
    expect(res.movers.map((m) => m.kind)).toEqual(["item", "keystone"]);
    const ks = res.movers.find((m) => m.kind === "keystone")!;
    expect(ks.championName).toBe("Viktor");
    expect(ks.name).toBe("Rune 8992");
    expect(ks.iconHint).toBe("rune-8992.png");
    expect(ks.delta).toBeCloseTo(0.5, 5);
  });

  it("swallows a single champ's fetch failure without sinking the report", async () => {
    const res = await computePatchMovers(
      2,
      makeDeps({
        pool: [112, 999],
        fetchKeystone: async (champId, _role, patch) => {
          if (champId === 999) throw new Error("boom");
          return patch.patch === 13 ? [rune(8992, 300000, 0.6)] : [rune(8992, 280000, 0.1)];
        },
      })
    );
    if ("unsupported" in res) throw new Error("should be supported");
    // 999 contributed nothing; 112 still produced movers.
    expect(res.movers.length).toBeGreaterThan(0);
  });
});
