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
  findChampionGaps,
  __resetPatchCacheForTests,
  __resetChampsCacheForTests,
} from "../staticData";

// Same shape as staticData.patch.test.ts's fixture — walks 16.13 (empty,
// probe-wise) then 16.12 (populated) -> resolved icon/data version "16.12.1".
const DDRAGON_VERSIONS = ["16.13.1", "16.13.1", "16.12.1", "16.12.1", "16.11.1"];

const COACHLESS_CHAMPIONS = {
  Viktor: { id: "Viktor", key: "112", name: "Viktor" },
};

// Deliberately includes a DUPLICATE of an id coachless already has (with a
// different name, to prove coachless wins) plus one genuinely new id (Locke,
// 805) that coachless doesn't have yet.
const DDRAGON_CHAMPIONS = {
  Viktor: { id: "Viktor", key: "112", name: "Viktor (should never surface)" },
  Locke: { id: "Locke", key: "805", name: "Locke" },
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
      },
    ]);
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
    });
  });

  it("returns null for an id neither source has", async () => {
    mockFetch();
    const nope = await getChampionById(999999);
    expect(nope).toBeNull();
  });
});
