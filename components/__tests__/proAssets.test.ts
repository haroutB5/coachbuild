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
});
