/**
 * Tests for the ddragon champion gap-fill (lib/staticData.ts).
 *
 * Bug: coachless's static-files champion.json bundle is pinned to whatever
 * data patch got resolved for stats and can be missing a brand-new champion
 * that's already live in real games (verified live: Locke, id 805, shipped
 * 16.13.1, missing from coachless's 16.12.1-pinned 172-champion bundle —
 * Bwipo's Locke games rendered a grey "Champion #805" tile). Fix: after
 * loading coachless's list, fetch ddragon's OWN latest champion.json and
 * fill in any id coachless is missing. Coachless stays primary/authoritative
 * for every id it already has.
 *
 * getKeystoneData (patch-resolution probe) and fetch (ddragon + coachless
 * CDN calls) are both mocked — no network.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../coachless", () => ({
  getKeystoneData: vi.fn(),
}));

import { getKeystoneData } from "../coachless";
import {
  getAllChampions,
  getChampionById,
  getChampionMeta,
  findChampionGaps,
  __resetPatchCacheForTests,
  __resetChampsCacheForTests,
} from "../staticData";

// Same shape as staticData.patch.test.ts's fixture — walks 16.13 (empty,
// probe-wise) then 16.12 (populated) -> resolved icon/data version "16.12.1".
const DDRAGON_VERSIONS = ["16.13.1", "16.13.1", "16.12.1", "16.12.1", "16.11.1"];

const COACHLESS_CHAMPIONS = {
  // info/tags added (draft redesign plan §2.1) -- mirrors ddragon's own
  // summary champion.json shape (coachless's bundle is a mirror of it).
  Viktor: {
    id: "Viktor",
    key: "112",
    name: "Viktor",
    info: { attack: 2, defense: 4, magic: 10, difficulty: 9 },
    tags: ["Mage"],
  },
};

// Deliberately includes a DUPLICATE of an id coachless already has (with a
// different name, to prove coachless wins) plus one genuinely new id (Locke,
// 805) that coachless doesn't have yet.
const DDRAGON_CHAMPIONS = {
  Viktor: { id: "Viktor", key: "112", name: "Viktor (should never surface)" },
  Locke: {
    id: "Locke",
    key: "805",
    name: "Locke",
    info: { attack: 6, defense: 4, magic: 2, difficulty: 5 },
    tags: ["Assassin", "Mage"],
  },
};

function mockFetch(opts: { ddragonFail?: boolean; champJsonFail?: boolean } = {}) {
  global.fetch = vi.fn(async (url: unknown) => {
    const u = String(url);
    if (u.includes("ddragon.leagueoflegends.com/api/versions.json")) {
      if (opts.ddragonFail) throw new Error("ddragon versions.json unreachable");
      return { ok: true, json: async () => DDRAGON_VERSIONS } as unknown as Response;
    }
    if (u.includes("cdn.coachless.gg") && u.includes("champion.json")) {
      return { ok: true, json: async () => ({ data: COACHLESS_CHAMPIONS }) } as unknown as Response;
    }
    if (u.includes("ddragon.leagueoflegends.com/cdn") && u.includes("champion.json")) {
      if (opts.ddragonFail || opts.champJsonFail) throw new Error("ddragon champion.json unreachable");
      return { ok: true, json: async () => ({ data: DDRAGON_CHAMPIONS }) } as unknown as Response;
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;
}

const row = () => [{ rune: 1, runeType: 0, wpaOverall: 0.1, occurrence: 1000 }];
// Only 16.12 is "populated" for the coachless stats probe (matches the
// versions fixture: 16.13 empty, 16.12 populated -> resolves to 16.12.1).
const only16_12HasData = async (_c: number, _r: number, patch: { patch: number }) =>
  patch.patch === 12 ? row() : [];

beforeEach(() => {
  vi.mocked(getKeystoneData).mockReset();
  vi.mocked(getKeystoneData).mockImplementation(only16_12HasData);
  __resetPatchCacheForTests();
  __resetChampsCacheForTests();
});

describe("findChampionGaps — pure merge logic", () => {
  it("returns only ids missing from existingIds", () => {
    const gaps = findChampionGaps(
      new Set([112]),
      "16.13.1",
      {
        Viktor: { id: "Viktor", key: "112", name: "Viktor (ignored — already exists)" },
        Locke: { id: "Locke", key: "805", name: "Locke" },
      }
    );
    expect(gaps).toEqual([
      {
        id: "Locke",
        key: "805",
        name: "Locke",
        ddragonIconUrl: "https://ddragon.leagueoflegends.com/cdn/16.13.1/img/champion/Locke.png",
      },
    ]);
  });

  it("skips entries with a non-numeric key", () => {
    const gaps = findChampionGaps(new Set(), "16.13.1", {
      Bad: { id: "Bad", key: "not-a-number", name: "Bad" },
    });
    expect(gaps).toEqual([]);
  });

  it("returns [] when every ddragon id already exists", () => {
    const gaps = findChampionGaps(new Set([112]), "16.13.1", {
      Viktor: { id: "Viktor", key: "112", name: "Viktor" },
    });
    expect(gaps).toEqual([]);
  });
});

describe("getAllChampions — coachless + ddragon gap-fill merge", () => {
  it("gap-fills a champion missing from coachless (Locke, 805) with a ddragon icon URL", async () => {
    mockFetch();
    const champs = await getAllChampions();
    const locke = champs.find((c) => c.id === 805);
    expect(locke).toEqual({
      id: 805,
      key: "Locke",
      name: "Locke",
      icon: "https://ddragon.leagueoflegends.com/cdn/16.13.1/img/champion/Locke.png",
      // Draft redesign plan §2.1: gap-filled entries carry difficulty/tags too.
      difficulty: 5,
      tags: ["Assassin", "Mage"],
    });
  });

  it("coachless is primary — an id present in BOTH sources keeps the coachless name/icon", async () => {
    mockFetch();
    const champs = await getAllChampions();
    const viktor = champs.find((c) => c.id === 112);
    expect(viktor).toEqual({
      id: 112,
      key: "Viktor",
      name: "Viktor", // NOT ddragon's "Viktor (should never surface)"
      icon: "https://cdn.coachless.gg/static-files/16.12.1/16.12.1/img/champion/Viktor.webp",
      difficulty: 9,
      tags: ["Mage"],
    });
  });

  it("degrades to coachless-only (today's exact prior behavior) when ddragon fails", async () => {
    // ddragon's versions.json also feeds getLatestPatch's OWN probe walk, so
    // a ddragon outage here additionally falls the icon/data version back to
    // the static default (16.11.1) — a pre-existing, unrelated fallback this
    // test isn't re-asserting, just accounting for in the expected icon URL.
    mockFetch({ ddragonFail: true });
    const champs = await getAllChampions();
    expect(champs).toEqual([
      {
        id: 112,
        key: "Viktor",
        name: "Viktor",
        icon: "https://cdn.coachless.gg/static-files/16.11.1/16.11.1/img/champion/Viktor.webp",
        difficulty: 9,
        tags: ["Mage"],
      },
    ]);
  });

  it("degrades to coachless-only when JUST ddragon's champion.json fails (versions.json + patch resolution succeed)", async () => {
    mockFetch({ champJsonFail: true });
    const champs = await getAllChampions();
    // Icon version resolves normally (16.12.1) — only the gap-fill itself
    // came back empty, isolating that this degrade path doesn't also break
    // patch/version resolution.
    expect(champs).toEqual([
      {
        id: 112,
        key: "Viktor",
        name: "Viktor",
        icon: "https://cdn.coachless.gg/static-files/16.12.1/16.12.1/img/champion/Viktor.webp",
        difficulty: 9,
        tags: ["Mage"],
      },
    ]);
  });

  it("difficulty/tags degrade to null/[] when the source entry has no info/tags block at all", async () => {
    // A minimal coachless fixture with no info/tags -- e.g. an upstream
    // shape the site hasn't populated yet. Never a fabricated difficulty.
    global.fetch = vi.fn(async (url: unknown) => {
      const u = String(url);
      if (u.includes("ddragon.leagueoflegends.com/api/versions.json")) return { ok: true, json: async () => DDRAGON_VERSIONS } as unknown as Response;
      if (u.includes("cdn.coachless.gg") && u.includes("champion.json")) {
        return { ok: true, json: async () => ({ data: { Ashe: { id: "Ashe", key: "22", name: "Ashe" } } }) } as unknown as Response;
      }
      if (u.includes("ddragon.leagueoflegends.com/cdn") && u.includes("champion.json")) {
        return { ok: true, json: async () => ({ data: {} }) } as unknown as Response;
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;
    const champs = await getAllChampions();
    expect(champs[0].difficulty).toBeNull();
    expect(champs[0].tags).toEqual([]);
  });
});

describe("getChampionById — resolves a gap-filled champion", () => {
  it("finds Locke (805) via the ddragon gap-fill", async () => {
    mockFetch();
    const locke = await getChampionById(805);
    expect(locke).toEqual({
      id: 805,
      key: "Locke",
      name: "Locke",
      icon: "https://ddragon.leagueoflegends.com/cdn/16.13.1/img/champion/Locke.png",
      difficulty: 5,
      tags: ["Assassin", "Mage"],
    });
  });

  it("returns null for an id neither source has", async () => {
    mockFetch();
    const nope = await getChampionById(999999);
    expect(nope).toBeNull();
  });
});

describe("getChampionMeta — server-side-only accessor for suggestedDefense (draft redesign plan §2.3)", () => {
  it("resolves tags/difficulty/info for a champion with a full info block", async () => {
    mockFetch();
    const meta = await getChampionMeta(112); // Viktor
    expect(meta).toEqual({
      tags: ["Mage"],
      difficulty: 9,
      info: { attack: 2, defense: 4, magic: 10 },
    });
  });

  it("resolves a gap-filled champion's meta too (Locke, 805)", async () => {
    mockFetch();
    const meta = await getChampionMeta(805);
    expect(meta).toEqual({
      tags: ["Assassin", "Mage"],
      difficulty: 5,
      info: { attack: 6, defense: 4, magic: 2 },
    });
  });

  it("returns null for an unknown id", async () => {
    mockFetch();
    const meta = await getChampionMeta(999999);
    expect(meta).toBeNull();
  });
});
