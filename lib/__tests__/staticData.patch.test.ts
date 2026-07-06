/**
 * Tests for dynamic patch resolution (lib/staticData.ts getLatestPatch).
 * coachless.getKeystoneData and the ddragon versions.json fetch are both
 * mocked — no network. Uses an injectable clock to exercise TTL behavior
 * without fake timers.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../coachless", () => ({
  getKeystoneData: vi.fn(),
}));

import { getKeystoneData } from "../coachless";
import {
  getLatestPatch,
  parseDdragonVersions,
  versionFolder,
  resolveItem,
  resolveRune,
  __resetPatchCacheForTests,
} from "../staticData";

const DDRAGON_VERSIONS = [
  "16.13.1",
  "16.13.1",
  "16.12.1",
  "16.12.1",
  "16.11.1",
  "16.10.1",
  "16.9.1",
  "16.8.1",
];

// Item/rune CDN fixtures shared by the icon-version integration tests below.
// itemsMap/runeMap are module-level memoized in staticData.ts (populated once
// per test *file*, not per test), so every test in this file that touches
// resolveItem/resolveRune must serve — and agree on — the SAME fixture content,
// regardless of which test happens to trigger the first real load.
const ITEM_FIXTURE = { "1001": { Name: "Boots" }, "9999": { Name: "Mystery Item" } };
const RUNE_FIXTURE = {
  "8226": {
    Name: "Manaflow Band",
    Icon: "perk-images/Styles/Sorcery/ManaflowBand/ManaflowBand.png",
  },
};

function mockDdragon(versions: string[] | "fail") {
  global.fetch = vi.fn(async (url: unknown) => {
    const u = String(url);
    if (u.includes("versions.json")) {
      if (versions === "fail") throw new Error("ddragon unreachable");
      return { ok: true, json: async () => versions } as unknown as Response;
    }
    // Only exercised by the icon-version tests below (resolveItem/resolveRune
    // pull these in); harmless no-op for every other test in this file.
    if (u.includes("item-base-v2")) {
      return { ok: true, json: async () => ITEM_FIXTURE } as unknown as Response;
    }
    if (u.includes("runes-bundled")) {
      return { ok: true, json: async () => RUNE_FIXTURE } as unknown as Response;
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;
}

const row = (occ = 1000) => [{ rune: 1, runeType: 0, wpaOverall: 0.1, occurrence: occ }];
// Mock implementation: only patch 12 (today's real resolved patch) is populated.
const only16_12HasData = async (_c: number, _r: number, patch: { patch: number }) =>
  patch.patch === 12 ? row() : [];

beforeEach(() => {
  vi.mocked(getKeystoneData).mockReset();
  __resetPatchCacheForTests();
});

describe("parseDdragonVersions", () => {
  it("dedupes hotfix versions down to distinct major.patch, newest first", () => {
    const out = parseDdragonVersions(DDRAGON_VERSIONS);
    expect(out.map((p) => p.label)).toEqual(["16.13", "16.12", "16.11", "16.10"]);
  });

  it("caps at 4 candidates even with a long version history", () => {
    const many = Array.from({ length: 50 }, (_, i) => `16.${20 - i}.1`);
    expect(parseDdragonVersions(many).length).toBe(4);
  });

  it("ignores malformed entries", () => {
    expect(parseDdragonVersions(["not-a-version", "16.12.1"])).toEqual([
      { major: 16, patch: 12, patchAdditions: 0, label: "16.12" },
    ]);
  });
});

describe("getLatestPatch — probe resolution", () => {
  it("picks the newest coachless-POPULATED patch, skipping empty newer ones", async () => {
    mockDdragon(DDRAGON_VERSIONS);
    vi.mocked(getKeystoneData).mockImplementation(async (_c, _r, patch) => {
      // 16.13/16.14/16.15-style empty patches; 16.12 is populated (today's real state).
      if (patch.patch === 12) return row();
      return [];
    });

    const result = await getLatestPatch(() => 0);
    expect(result.label).toBe("16.12");
    // Probed 16.13 (empty) then 16.12 (populated) — stopped there, never tried 16.11/16.10.
    expect(vi.mocked(getKeystoneData)).toHaveBeenCalledTimes(2);
  });

  it("falls back to the static 16.11 default when ddragon AND every probe fail", async () => {
    mockDdragon("fail");
    const result = await getLatestPatch(() => 0);
    expect(result.label).toBe("16.11");
  });

  it("falls back to the static default when ddragon works but no candidate has data", async () => {
    mockDdragon(DDRAGON_VERSIONS);
    vi.mocked(getKeystoneData).mockResolvedValue([]);
    const result = await getLatestPatch(() => 0);
    expect(result.label).toBe("16.11");
    expect(vi.mocked(getKeystoneData)).toHaveBeenCalledTimes(4); // walked all 4 candidates
  });

  it("falls back to the last-known-good patch (not the static default) if a later resolution fails", async () => {
    mockDdragon(DDRAGON_VERSIONS);
    vi.mocked(getKeystoneData).mockImplementation(async (_c, _r, patch) =>
      patch.patch === 12 ? row() : []
    );
    // First resolution succeeds at t=0 -> 16.12, cached.
    const first = await getLatestPatch(() => 0);
    expect(first.label).toBe("16.12");

    // Force the cache to expire (past the failure/success TTL) and make ddragon
    // die on the next attempt. Should fall back to 16.12 (last known good), not 16.11.
    mockDdragon("fail");
    const sevenHoursLater = 7 * 60 * 60 * 1000;
    const second = await getLatestPatch(() => sevenHoursLater);
    expect(second.label).toBe("16.12");
  });

  it("respects the success TTL — does not re-probe within the cache window", async () => {
    mockDdragon(DDRAGON_VERSIONS);
    vi.mocked(getKeystoneData).mockImplementation(async (_c, _r, patch) =>
      patch.patch === 12 ? row() : []
    );
    await getLatestPatch(() => 0);
    expect(vi.mocked(getKeystoneData)).toHaveBeenCalledTimes(2);

    vi.mocked(getKeystoneData).mockClear();
    // 1 hour later, well inside the 6h TTL -> cache hit, zero new probe calls.
    const result = await getLatestPatch(() => 60 * 60 * 1000);
    expect(result.label).toBe("16.12");
    expect(vi.mocked(getKeystoneData)).not.toHaveBeenCalled();
  });

  it("re-probes after the success TTL expires", async () => {
    mockDdragon(DDRAGON_VERSIONS);
    vi.mocked(getKeystoneData).mockImplementation(async (_c, _r, patch) =>
      patch.patch === 12 ? row() : []
    );
    await getLatestPatch(() => 0);
    vi.mocked(getKeystoneData).mockClear();

    // 7 hours later, past the 6h TTL -> re-probes.
    const sevenHoursLater = 7 * 60 * 60 * 1000;
    await getLatestPatch(() => sevenHoursLater);
    expect(vi.mocked(getKeystoneData)).toHaveBeenCalledTimes(2);
  });
});

// ── Icon CDN version derivation (follow-up P3, 2026-07-06) ──────────────────
// Curl evidence (see HANDOFF-engy.md / staticData.ts comment): coachless's
// static-files CDN serves icons/data for 16.11.1, 16.12.1, AND 16.13.1 alike
// (200 on all three) — it's NOT gated behind WPA-data availability the way
// the stats API is. So icon URLs key off the same resolved patch as the data
// patch, formatted "<major>.<patch>.1", instead of a second hardcoded pin.

describe("versionFolder", () => {
  it("formats a ResolvedPatch as <major>.<patch>.1", () => {
    expect(versionFolder({ major: 16, patch: 12, patchAdditions: 0, label: "16.12" })).toBe(
      "16.12.1"
    );
  });
});

describe("icon URLs derive from the resolved patch", () => {
  it("resolveItem's icon URL uses today's resolved patch (16.12 -> 16.12.1)", async () => {
    mockDdragon(DDRAGON_VERSIONS);
    vi.mocked(getKeystoneData).mockImplementation(only16_12HasData);

    const item = await resolveItem(1001);
    expect(item.icon).toBe(
      "https://cdn.coachless.gg/static-files/16.12.1/16.12.1/img/item/1001.webp"
    );
  });

  it("resolveRune's icon URL uses today's resolved patch (16.12 -> 16.12.1) — matches the live curl", async () => {
    mockDdragon(DDRAGON_VERSIONS);
    vi.mocked(getKeystoneData).mockImplementation(only16_12HasData);

    const rune = await resolveRune(8226);
    expect(rune.icon).toBe(
      "https://cdn.coachless.gg/static-files/16.12.1/img/perk-images/Styles/Sorcery/ManaflowBand/ManaflowBand.webp"
    );
  });

  it("icon URL falls back to 16.11.1 when patch resolution falls back to the static default", async () => {
    mockDdragon("fail");
    vi.mocked(getKeystoneData).mockResolvedValue([]);

    const item = await resolveItem(9999);
    expect(item.icon).toBe(
      "https://cdn.coachless.gg/static-files/16.11.1/16.11.1/img/item/9999.webp"
    );
  });
});

// ── Probe robustness (follow-up P3, 2026-07-06) ─────────────────────────────

describe("per-candidate probe timeout", () => {
  it("passes an AbortSignal (~4s timeout) to every candidate probe call", async () => {
    mockDdragon(DDRAGON_VERSIONS);
    vi.mocked(getKeystoneData).mockImplementation(only16_12HasData);

    await getLatestPatch(() => 0);

    const calls = vi.mocked(getKeystoneData).mock.calls;
    expect(calls.length).toBe(2); // 16.13 (empty), 16.12 (populated) -- stops there
    for (const call of calls) {
      expect(call[3]).toBeInstanceOf(AbortSignal);
    }
  });

  it("treats an aborted/timed-out probe as 'no data' and moves to the next candidate", async () => {
    mockDdragon(DDRAGON_VERSIONS);
    // Mirrors the live 2026-07-06 run: 16.13 errors (403 there, timeout here),
    // 16.12 is populated. Either way the walk must not abort entirely.
    vi.mocked(getKeystoneData).mockImplementation(async (_c, _r, patch) => {
      if (patch.patch === 13) throw new DOMException("The operation was aborted", "AbortError");
      if (patch.patch === 12) return row();
      return [];
    });

    const result = await getLatestPatch(() => 0);
    expect(result.label).toBe("16.12");
  });
});

describe("single-flight guard", () => {
  it("dedupes N concurrent cold requests into one probe walk", async () => {
    let ddragonFetches = 0;
    global.fetch = vi.fn(async (url: unknown) => {
      if (String(url).includes("versions.json")) {
        ddragonFetches++;
        return { ok: true, json: async () => DDRAGON_VERSIONS } as unknown as Response;
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;
    vi.mocked(getKeystoneData).mockImplementation(only16_12HasData);

    const [a, b, c] = await Promise.all([
      getLatestPatch(() => 0),
      getLatestPatch(() => 0),
      getLatestPatch(() => 0),
    ]);

    expect(a.label).toBe("16.12");
    expect(b.label).toBe("16.12");
    expect(c.label).toBe("16.12");
    expect(ddragonFetches).toBe(1); // single ddragon fetch shared across all 3 callers
    expect(vi.mocked(getKeystoneData)).toHaveBeenCalledTimes(2); // one probe walk, not 3x2
  });

  it("starts a fresh walk (not stuck reusing the finished in-flight promise) on the next cache miss", async () => {
    mockDdragon(DDRAGON_VERSIONS);
    vi.mocked(getKeystoneData).mockImplementation(only16_12HasData);

    await getLatestPatch(() => 0);
    vi.mocked(getKeystoneData).mockClear();

    // Past the success TTL -> genuinely new resolution, not a stale in-flight reuse.
    const sevenHoursLater = 7 * 60 * 60 * 1000;
    const result = await getLatestPatch(() => sevenHoursLater);
    expect(result.label).toBe("16.12");
    expect(vi.mocked(getKeystoneData)).toHaveBeenCalledTimes(2);
  });
});
