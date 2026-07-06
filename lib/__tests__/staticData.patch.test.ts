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

function mockDdragon(versions: string[] | "fail") {
  global.fetch = vi.fn(async (url: unknown) => {
    if (String(url).includes("versions.json")) {
      if (versions === "fail") throw new Error("ddragon unreachable");
      return { ok: true, json: async () => versions } as unknown as Response;
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;
}

const row = (occ = 1000) => [{ rune: 1, runeType: 0, wpaOverall: 0.1, occurrence: occ }];

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
