/**
 * Tests for lib/prostage/ddragon.ts — name->id resolution map building.
 * fetch is mocked; ddragon has no rate limit so no pacer/fake-timer dance.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getDdragonMaps, normalizeName, __resetDdragonCacheForTests } from "../prostage/ddragon";

const VERSIONS = ["16.13.1"];
const CHAMPIONS = {
  data: {
    Ahri: { key: "103", id: "Ahri", name: "Ahri" },
    MonkeyKing: { key: "62", id: "MonkeyKing", name: "Wukong" },
  },
};
const ITEMS = {
  data: {
    "6653": { name: "Riftmaker" },
    "3020": { name: "Sorcerer's Shoes" },
  },
};
const SUMMONERS = {
  data: {
    SummonerFlash: { key: "4", name: "Flash" },
    SummonerDot: { key: "14", name: "Ignite" },
  },
};
const RUNES = [
  {
    id: 8100,
    name: "Domination",
    slots: [{ runes: [{ id: 8112, name: "Electrocute" }] }],
  },
  {
    id: 8200,
    name: "Sorcery",
    slots: [{ runes: [{ id: 8226, name: "Manaflow Band" }] }],
  },
];

function mockFetchSequence() {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      if (url.endsWith("versions.json")) return Promise.resolve({ ok: true, json: async () => VERSIONS });
      if (url.includes("champion.json")) return Promise.resolve({ ok: true, json: async () => CHAMPIONS });
      if (url.includes("item.json")) return Promise.resolve({ ok: true, json: async () => ITEMS });
      if (url.includes("summoner.json")) return Promise.resolve({ ok: true, json: async () => SUMMONERS });
      if (url.includes("runesReforged.json")) return Promise.resolve({ ok: true, json: async () => RUNES });
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    })
  );
}

describe("normalizeName", () => {
  it("lowercases and strips punctuation/spaces", () => {
    expect(normalizeName("Dr. Mundo")).toBe("drmundo");
    expect(normalizeName("Kai'Sa")).toBe("kaisa");
    expect(normalizeName("Renata Glasc")).toBe("renataglasc");
  });
});

describe("getDdragonMaps", () => {
  beforeEach(() => {
    __resetDdragonCacheForTests();
    mockFetchSequence();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("resolves champion names to ids, keyed by display name not internal id", () => {
    return getDdragonMaps().then((maps) => {
      expect(maps.championByName.get("ahri")).toBe(103);
      expect(maps.championByName.get("wukong")).toBe(62); // ddragon `name` is "Wukong" though internal key is MonkeyKing
      expect(maps.championNameById.get(103)).toBe("Ahri");
    });
  });

  it("resolves item and summoner spell names to ids", async () => {
    const maps = await getDdragonMaps();
    expect(maps.itemByName.get("riftmaker")).toBe(6653);
    expect(maps.itemByName.get(normalizeName("Sorcerer's Shoes"))).toBe(3020);
    expect(maps.summonerByName.get("flash")).toBe(4);
    expect(maps.summonerByName.get("ignite")).toBe(14);
  });

  it("resolves rune names to {id, parentStyleId} and style names to style ids", async () => {
    const maps = await getDdragonMaps();
    expect(maps.runeByName.get("electrocute")).toEqual({ id: 8112, parentStyleId: 8100 });
    expect(maps.runeByName.get(normalizeName("Manaflow Band"))).toEqual({ id: 8226, parentStyleId: 8200 });
    expect(maps.styleByName.get("domination")).toBe(8100);
    expect(maps.styleByName.get("sorcery")).toBe(8200);
  });

  it("memoizes across calls (only fetches once)", async () => {
    await getDdragonMaps();
    await getDdragonMaps();
    // 1 versions + 4 data files = 5 fetches total for the whole memoized lifetime
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(5);
  });
});
