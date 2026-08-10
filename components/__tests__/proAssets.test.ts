/**
 * Tests for proAssets.ts's live icon-version threading (Fable review
 * 2026-07-17, P3): `versionFromPatch` used to fall straight to a hardcoded
 * `ICON_VERSION_FALLBACK = "16.11.1"` for any versionless row — real for
 * EVERY prostage row, permanently, since Leaguepedia's Cargo tables never
 * carry a `patch` field (see CLAUDE.md gotcha (h)). Any item/rune/champion
 * added after 16.11 would glyph-fallback on prostage surfaces forever, no
 * matter how far the live patch advanced. Fixed by deriving a best-effort
 * live version from the champion icon map (`getChampionIconMap()`,
 * `/api/champions`) this module already fetches — every icon URL that
 * endpoint returns embeds the resolved CDN version folder, so no new
 * network call or backend field is needed.
 *
 * No jsdom/RTL in this repo's harness — `getChampionIconMap`/
 * `versionFromPatch` only touch the global `fetch` (no DOM), so they're
 * directly testable by stubbing it. Fresh module instance per test
 * (`vi.resetModules` + dynamic import, same pattern prostageTimeline.test.ts
 * already uses) since the champion-icon-map cache and the derived
 * live-version cache are both module-level singletons that would otherwise
 * leak across tests.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

function championsResponse(entries: { id: number; name: string; icon: string }[], ok = true) {
  return { ok, json: async () => entries };
}

describe("versionFromPatch / getCachedLiveIconVersion", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("parses a real patch normally — unaffected by the live-version machinery", async () => {
    const { versionFromPatch } = await import("../proAssets");
    expect(versionFromPatch("16.13")).toBe("16.13.1");
    expect(versionFromPatch("16.7")).toBe("16.7.1");
  });

  it("falls back to the hardcoded constant when patch is missing and nothing live has resolved yet", async () => {
    // Never-resolving fetch — simulates "the champion map fetch is still
    // in flight" (or was never triggered at all): getCachedLiveIconVersion()
    // must return null immediately rather than blocking on it.
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    const { versionFromPatch } = await import("../proAssets");
    expect(versionFromPatch(undefined)).toBe("16.11.1");
  });

  it("falls back to the hardcoded constant when patch is unparseable", async () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    const { versionFromPatch } = await import("../proAssets");
    expect(versionFromPatch("not-a-patch")).toBe("16.11.1");
  });

  it("threads the live-resolved version into versionless (prostage-shaped) calls once the champion map has fetched", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      championsResponse([
        { id: 112, name: "Viktor", icon: "https://cdn.coachless.gg/static-files/16.13.1/16.13.1/img/champion/Viktor.webp" },
      ])
    );
    vi.stubGlobal("fetch", fetchMock);

    const { versionFromPatch, getCachedLiveIconVersion } = await import("../proAssets");

    // First call kicks off the champion-map fetch but can't wait on it —
    // the fetch hasn't resolved in this same microtask, so still the
    // hardcoded fallback here.
    expect(getCachedLiveIconVersion()).toBeNull();
    expect(versionFromPatch(undefined)).toBe("16.11.1");

    // Let the fetch + its .then chain settle.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(getCachedLiveIconVersion()).toBe("16.13.1");
    // Versionless row (prostage) now resolves against the LIVE version, not
    // the frozen 16.11.1 constant.
    expect(versionFromPatch(undefined)).toBe("16.13.1");
    expect(versionFromPatch("not-a-patch")).toBe("16.13.1");
    // A real patch (soloq row) is completely unaffected — still parses
    // directly, never touches the live-version fallback tier.
    expect(versionFromPatch("16.9")).toBe("16.9.1");
    // Only ONE /api/champions fetch for all of this — the champion icon map
    // is a shared module-level cache, not re-fetched per call.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("degrades to the hardcoded fallback (never throws) when the champion-map fetch fails outright", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    const { versionFromPatch, getCachedLiveIconVersion } = await import("../proAssets");

    expect(() => getCachedLiveIconVersion()).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(getCachedLiveIconVersion()).toBeNull();
    expect(versionFromPatch(undefined)).toBe("16.11.1");
  });

  it("degrades to the hardcoded fallback when the champion map resolves but no entry's icon URL matches the expected CDN shape", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      championsResponse([{ id: 1, name: "Weird", icon: "https://example.com/not-the-cdn-shape.png" }])
    );
    vi.stubGlobal("fetch", fetchMock);
    const { versionFromPatch, getCachedLiveIconVersion } = await import("../proAssets");

    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(getCachedLiveIconVersion()).toBeNull();
    expect(versionFromPatch(undefined)).toBe("16.11.1");
  });

  it("uses the live static-data version for an old-patch spell while preserving current-patch bytes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        championsResponse([
          {
            id: 112,
            name: "Viktor",
            icon: "https://cdn.coachless.gg/static-files/16.13.1/16.13.1/img/champion/Viktor.webp",
          },
        ])
      )
    );

    const { getChampionIconMap, spellIconUrl } = await import("../proAssets");
    await getChampionIconMap();

    // 16.11.1 is the stored game patch in the regression: the folder is no
    // longer available, but the spell art itself is unchanged.
    expect(spellIconUrl(4, "16.11.1")).toBe(
      "https://cdn.coachless.gg/static-files/16.13.1/16.13.1/img/spell/SummonerFlash.webp"
    );
    // A game already on the current version remains byte-identical.
    expect(spellIconUrl(4, "16.13.1")).toBe(
      "https://cdn.coachless.gg/static-files/16.13.1/16.13.1/img/spell/SummonerFlash.webp"
    );
  });
});

/**
 * Draft redesign plan §2.1 (additive, v0.42.0) — getChampionIconMap() now
 * surfaces ChampionRef's new difficulty/tags fields as difficulty/
 * difficultyBand/tags on ChampionIconEntry, pre-banded via
 * lib/draft/difficulty.ts's difficultyBand() at map-build time.
 */
describe("getChampionIconMap — difficulty/tags surface (draft redesign plan §2.1)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("carries difficulty/difficultyBand/tags through from /api/champions", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [
          { id: 238, name: "Zed", icon: "https://cdn.example/zed.webp", difficulty: 7, tags: ["Assassin"] },
        ],
      })
    );
    const { getChampionIconMap } = await import("../proAssets");
    const map = await getChampionIconMap();
    expect(map.get(238)).toEqual({
      name: "Zed",
      icon: "https://cdn.example/zed.webp",
      difficulty: 7,
      difficultyBand: "High",
      tags: ["Assassin"],
    });
  });

  it("difficulty/tags absent on the wire -> null/[] (never fabricated), difficultyBand null", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [{ id: 1, name: "Annie", icon: "https://cdn.example/annie.webp" }],
      })
    );
    const { getChampionIconMap } = await import("../proAssets");
    const map = await getChampionIconMap();
    expect(map.get(1)).toEqual({
      name: "Annie",
      icon: "https://cdn.example/annie.webp",
      difficulty: null,
      difficultyBand: null,
      tags: [],
    });
  });
});

/**
 * Stat-shard icon filenames. The id -> filename table is DUPLICATED in
 * lib/staticData.ts (that module is the server-side data layer and this one is
 * deliberately standalone from it, so neither can import the other without
 * dragging the wrong half into the wrong bundle). Magic Resist (5003) was
 * "magicresist.png" in BOTH copies and 403s on the CDN — it rendered as a bare
 * fallback glyph "M", worst on the inline OTP rune card which draws shards with
 * no labels. The equality test below turns any future drift between the two
 * copies into a failing test rather than a broken image.
 */
describe("shardIconUrl", () => {
  it("maps Magic Resist (5003) to the CDN's short filename, not the 403ing long one", async () => {
    const { shardIconUrl } = await import("../proAssets");
    expect(shardIconUrl(5003)).toBe("https://cdn.coachless.gg/stat-icons/mr.png");
  });

  it("agrees with lib/staticData.ts's copy of the shard table for every id", async () => {
    const { shardIconUrl } = await import("../proAssets");
    const { SHARD_ICON } = await import("@/lib/staticData");
    const ids = Object.keys(SHARD_ICON).map(Number);
    expect(ids.length).toBe(9);
    for (const id of ids) {
      expect(shardIconUrl(id)).toBe(`https://cdn.coachless.gg/stat-icons/${SHARD_ICON[id]}`);
    }
  });
});
