/**
 * Tests for lib/laneDefaults.ts. coachless.getKeystoneData and
 * staticData.getAllChampions/getLatestPatch are all mocked — no network.
 * Live-verified separately (see HANDOFF-engo.md) against a representative
 * per-lane candidate shortlist, not the full ~172-champion sweep (documented
 * cost tradeoff, see the module's own COST NOTE).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../coachless", () => ({
  getKeystoneData: vi.fn(),
}));
vi.mock("../staticData", () => ({
  getAllChampions: vi.fn(),
  getLatestPatch: vi.fn(),
}));

import { getKeystoneData } from "../coachless";
import { getAllChampions, getLatestPatch } from "../staticData";
import {
  getLaneDefaults,
  pickMostPlayed,
  __resetLaneDefaultsCacheForTests,
} from "../laneDefaults";
import type { ChampionRef } from "../types";

const PATCH = { major: 16, patch: 12, patchAdditions: 0, label: "16.12" };

const CHAMPS: ChampionRef[] = [
  { id: 122, key: "Darius", name: "Darius", icon: "" },
  { id: 86, key: "Garen", name: "Garen", icon: "" },
  { id: 64, key: "LeeSin", name: "Lee Sin", icon: "" },
];

beforeEach(() => {
  vi.mocked(getKeystoneData).mockReset();
  vi.mocked(getAllChampions).mockReset();
  vi.mocked(getLatestPatch).mockReset();
  __resetLaneDefaultsCacheForTests();
});

describe("pickMostPlayed (pure)", () => {
  it("picks the champion with the highest occurrence", () => {
    const occ = new Map([
      [122, 500000],
      [86, 300000],
      [64, 10],
    ]);
    expect(pickMostPlayed(CHAMPS, occ)).toEqual({
      championId: 122,
      championName: "Darius",
    });
  });

  it("returns null when every candidate has zero/unknown occurrence", () => {
    expect(pickMostPlayed(CHAMPS, new Map())).toBeNull();
  });

  it("ignores a candidate with occurrence explicitly 0", () => {
    const occ = new Map([
      [122, 0],
      [86, 42],
    ]);
    expect(pickMostPlayed(CHAMPS, occ)).toEqual({
      championId: 86,
      championName: "Garen",
    });
  });
});

describe("getLaneDefaults — integration (mocked network)", () => {
  it("computes each lane's winner from summed keystone occurrence, per role", async () => {
    vi.mocked(getAllChampions).mockResolvedValue(CHAMPS);
    vi.mocked(getLatestPatch).mockResolvedValue(PATCH);
    // Darius dominates top (role 0); Lee Sin dominates jungle (role 1); no
    // one has mid/bot/support data in this fixture (falls to static fallback).
    vi.mocked(getKeystoneData).mockImplementation(async (champId, role) => {
      if (role === 0 && champId === 122) return [{ rune: 1, runeType: 0, wpaOverall: 0, occurrence: 400000 }];
      if (role === 0 && champId === 86) return [{ rune: 1, runeType: 0, wpaOverall: 0, occurrence: 100000 }];
      if (role === 1 && champId === 64) return [{ rune: 1, runeType: 0, wpaOverall: 0, occurrence: 300000 }];
      return [];
    });

    const result = await getLaneDefaults(() => 0);
    expect(result.top).toEqual({ championId: 122, championName: "Darius" });
    expect(result.jungle).toEqual({ championId: 64, championName: "Lee Sin" });
    // No data for mid/bot/support in this fixture -> static fallback.
    expect(result.mid).toEqual({ championId: 112, championName: "Viktor" });
    expect(result.bot).toEqual({ championId: 222, championName: "Jinx" });
    expect(result.support).toEqual({ championId: 412, championName: "Thresh" });
  });

  it("falls back to the full static map when getAllChampions itself fails", async () => {
    vi.mocked(getAllChampions).mockRejectedValue(new Error("coachless CDN down"));
    vi.mocked(getLatestPatch).mockResolvedValue(PATCH);

    const result = await getLaneDefaults(() => 0);
    expect(result).toEqual({
      top: { championId: 122, championName: "Darius" },
      jungle: { championId: 64, championName: "Lee Sin" },
      mid: { championId: 112, championName: "Viktor" },
      bot: { championId: 222, championName: "Jinx" },
      support: { championId: 412, championName: "Thresh" },
    });
    expect(getKeystoneData).not.toHaveBeenCalled();
  });

  it("respects the success TTL — a second call within the window doesn't re-sweep", async () => {
    vi.mocked(getAllChampions).mockResolvedValue(CHAMPS);
    vi.mocked(getLatestPatch).mockResolvedValue(PATCH);
    vi.mocked(getKeystoneData).mockResolvedValue([
      { rune: 1, runeType: 0, wpaOverall: 0, occurrence: 1000 },
    ]);

    await getLaneDefaults(() => 0);
    const callsAfterFirst = vi.mocked(getKeystoneData).mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);

    vi.mocked(getKeystoneData).mockClear();
    // 1 hour later, well inside the 6h TTL -> cache hit, zero new calls.
    await getLaneDefaults(() => 60 * 60 * 1000);
    expect(getKeystoneData).not.toHaveBeenCalled();
  });

  it("dedupes concurrent cold callers into a single sweep (single-flight)", async () => {
    vi.mocked(getAllChampions).mockResolvedValue(CHAMPS);
    vi.mocked(getLatestPatch).mockResolvedValue(PATCH);
    let calls = 0;
    vi.mocked(getKeystoneData).mockImplementation(async () => {
      calls++;
      return [{ rune: 1, runeType: 0, wpaOverall: 0, occurrence: 1000 }];
    });

    const [a, b] = await Promise.all([
      getLaneDefaults(() => 0),
      getLaneDefaults(() => 0),
    ]);
    expect(a).toEqual(b);
    // getAllChampions is only called once too — proof it's one shared walk.
    expect(vi.mocked(getAllChampions).mock.calls.length).toBe(1);
    const callsAfterBoth = calls;
    expect(callsAfterBoth).toBeGreaterThan(0);
  });
});
