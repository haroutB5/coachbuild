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
    Jade_Ahri: { key: "60103", id: "Jade_Ahri", name: "Ahri" },
    Jade_Jax: { key: "60024", id: "Jade_Jax", name: "Jax" },
    Jax: { key: "24", id: "Jax", name: "Jax" },
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
    SummonerCherryFlash: { key: "2202", name: "Flash" },
    SummonerFlash: { key: "4", name: "Flash" },
    SummonerFlash_Jade: { key: "74", name: "Flash" },
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
      expect(maps.championByName.get("jax")).toBe(24);
      expect(maps.championByName.get("wukong")).toBe(62); // ddragon `name` is "Wukong" though internal key is MonkeyKing
      expect(maps.championNameById.get(103)).toBe("Ahri");
    });
  });

  it("keeps the lowest numeric id for duplicate champions and summoner spells regardless of entry order", async () => {
    const maps = await getDdragonMaps();

    // Ahri is canonical-first while Jax is alt-mode-first in the fixture.
    expect(maps.championByName.get("ahri")).toBe(103);
    expect(maps.championByName.get("jax")).toBe(24);
    expect(maps.collisionFixes.champion.get(60103)).toBe(103);
    expect(maps.collisionFixes.champion.get(60024)).toBe(24);

    // Cherry Flash precedes Flash while Jade Flash follows it; both collide
    // on the same real display name and both must resolve to Flash (4).
    expect(maps.summonerByName.get("flash")).toBe(4);
    expect(maps.collisionFixes.summoner.get(2202)).toBe(4);
    expect(maps.collisionFixes.summoner.get(74)).toBe(4);
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

  it("2026-07-25 P2-1 fix: a rejected fetch is NOT memoized — a later call gets a fresh attempt, not the same rejection forever", async () => {
    // Regression for the audit finding: getDdragonMaps used to assign the
    // pending (eventually-rejecting) promise to cachedMaps with no .catch, so
    // one ddragon blip poisoned every later call on the same warm lambda —
    // getLeagues (lib/prostage/lolesports.ts) and getChampionKeyByInternalId
    // (lib/prostage/tournaments.ts) already self-clear on failure for this
    // exact reason.
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("network blip")))
    );

    await expect(getDdragonMaps()).rejects.toThrow("network blip");

    // A second call after the rejection must attempt a FRESH fetch (proving
    // the cache was cleared), not resolve/reject instantly off a memoized
    // rejected promise.
    mockFetchSequence();
    await expect(getDdragonMaps()).resolves.toMatchObject({ version: "16.13.1" });
  });
});
