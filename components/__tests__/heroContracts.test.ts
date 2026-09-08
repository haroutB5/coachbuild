import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

beforeEach(() => { vi.resetModules(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe("draft champion data", () => {
  it("loads the current CDN roster and threads its version into fallback icons", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ["16.13.1"] })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: {
        Viktor: { key: "112", id: "Viktor", name: "Viktor", info: { difficulty: 9 }, tags: ["Mage"] },
      } }) });
    vi.stubGlobal("fetch", fetchMock);
    const { getChampionMap, liveVersionFromChampMap, withLiveIconVersion } = await import("../hextech/heroContracts");
    const map = await getChampionMap();
    expect(map.get(112)).toEqual({ id: 112, key: "Viktor", name: "Viktor", difficulty: 9, tags: ["Mage"],
      icon: "https://ddragon.leagueoflegends.com/cdn/16.13.1/img/champion/Viktor.png" });
    expect(liveVersionFromChampMap(map)).toBe("16.13.1");
    expect(withLiveIconVersion({ id: 103, key: "Ahri", name: "Ahri", icon: "" }, liveVersionFromChampMap(map)).icon)
      .toBe("https://ddragon.leagueoflegends.com/cdn/16.13.1/img/champion/Ahri.png");
    expect(await getChampionMap()).toBe(map);
    expect(fetchMock.mock.calls.map(call => call[0])).toEqual([
      "https://ddragon.leagueoflegends.com/api/versions.json",
      "https://ddragon.leagueoflegends.com/cdn/16.13.1/data/en_US/champion.json",
    ]);
  });

  it("does not latch a failed roster request", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("offline"));
    vi.stubGlobal("fetch", fetchMock);
    const { getChampionMap, liveVersionFromChampMap } = await import("../hextech/heroContracts");
    expect(liveVersionFromChampMap(await getChampionMap())).toBeNull();
    await getChampionMap();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
