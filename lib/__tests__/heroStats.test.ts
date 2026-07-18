/**
 * Tests for lib/heroStats.ts. coachless.getKeystoneData +
 * coachless.getGlobalItemStatistics and staticData.getLatestPatch are all
 * mocked — no network. Live-verified separately (see HANDOFF-engo.md) with
 * real Viktor-mid / Lee Sin-jungle / Locke-top numbers.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../coachless", () => ({
  getKeystoneData: vi.fn(),
  getGlobalItemStatistics: vi.fn(),
}));
vi.mock("../staticData", () => ({
  getLatestPatch: vi.fn(),
}));

import { getKeystoneData, getGlobalItemStatistics } from "../coachless";
import { getLatestPatch } from "../staticData";
import { getHeroStats } from "../heroStats";

const PATCH = { major: 16, patch: 12, patchAdditions: 0, label: "16.12" };

beforeEach(() => {
  vi.mocked(getKeystoneData).mockReset();
  vi.mocked(getGlobalItemStatistics).mockReset();
  vi.mocked(getLatestPatch).mockReset();
  vi.mocked(getLatestPatch).mockResolvedValue(PATCH);
});

describe("getHeroStats", () => {
  it("computes gamesCount from keystone occurrence + winRatePct as the occurrence-weighted starter winrate", async () => {
    vi.mocked(getKeystoneData).mockResolvedValue([
      { rune: 1, runeType: 0, wpaOverall: 0.1, occurrence: 200000 },
      { rune: 2, runeType: 0, wpaOverall: 0.2, occurrence: 46675 },
    ]); // sum 246675, mirrors the live Viktor-mid figure
    vi.mocked(getGlobalItemStatistics).mockResolvedValue([
      {
        itemId: 1056,
        wpaOverall: 0.01,
        wpaStandalone: 0,
        occurrence: 245368,
        occurrenceRelative: 0,
        winrateExpected: 50,
        winrateObserved: 50.3,
        averagePurchaseTime: 0,
        bias: 0,
      },
      {
        itemId: 1082,
        wpaOverall: 0.01,
        wpaStandalone: 0,
        occurrence: 255,
        occurrenceRelative: 0,
        winrateExpected: 50,
        winrateObserved: 54.1,
        averagePurchaseTime: 0,
        bias: 0,
      },
    ]);

    const stats = await getHeroStats(112, "mid");
    expect(stats.gamesCount).toBe(246675);
    // weighted: (245368*50.3 + 255*54.1) / 245623 ≈ 50.304
    expect(stats.winRatePct).toBeCloseTo(50.3, 1);
  });

  it("returns nulls when the champ+lane has zero keystone data (unreleased/ungapped champ)", async () => {
    vi.mocked(getKeystoneData).mockResolvedValue([]);
    vi.mocked(getGlobalItemStatistics).mockResolvedValue([]);

    const stats = await getHeroStats(805, "top"); // Locke, per live probe
    expect(stats).toEqual({ winRatePct: null, gamesCount: null });
  });

  it("returns gamesCount but null winRatePct when starter data is empty despite keystone data existing", async () => {
    vi.mocked(getKeystoneData).mockResolvedValue([
      { rune: 1, runeType: 0, wpaOverall: 0.1, occurrence: 5000 },
    ]);
    vi.mocked(getGlobalItemStatistics).mockResolvedValue([]);

    const stats = await getHeroStats(112, "mid");
    expect(stats).toEqual({ winRatePct: null, gamesCount: 5000 });
  });

  it("degrades to nulls for an unknown lane string without calling the network", async () => {
    const stats = await getHeroStats(112, "not-a-lane");
    expect(stats).toEqual({ winRatePct: null, gamesCount: null });
    expect(getKeystoneData).not.toHaveBeenCalled();
  });

  it("degrades to nulls (never throws) on an upstream failure, flagged `degraded: true` so the route knows never to CDN-cache it", async () => {
    vi.mocked(getKeystoneData).mockRejectedValue(new Error("coachless 500"));
    vi.mocked(getGlobalItemStatistics).mockResolvedValue([]);

    const stats = await getHeroStats(112, "mid");
    expect(stats).toEqual({ winRatePct: null, gamesCount: null, degraded: true });
  });

  it("passes the resolved patch + correct RoleId through to both coachless calls", async () => {
    vi.mocked(getKeystoneData).mockResolvedValue([
      { rune: 1, runeType: 0, wpaOverall: 0.1, occurrence: 1000 },
    ]);
    vi.mocked(getGlobalItemStatistics).mockResolvedValue([
      {
        itemId: 1,
        wpaOverall: 0,
        wpaStandalone: 0,
        occurrence: 1000,
        occurrenceRelative: 0,
        winrateExpected: 50,
        winrateObserved: 50,
        averagePurchaseTime: 0,
        bias: 0,
      },
    ]);

    await getHeroStats(412, "support");
    expect(getKeystoneData).toHaveBeenCalledWith(
      412,
      4,
      { major: 16, patch: 12, patchAdditions: 0 }
    );
    expect(getGlobalItemStatistics).toHaveBeenCalledWith(
      412,
      4,
      { major: 16, patch: 12, patchAdditions: 0 },
      null,
      6
    );
  });
});
