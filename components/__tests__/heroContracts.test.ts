/**
 * Tests for heroContracts.ts's getLaneDefaultChampions() live-icon-version
 * threading (Fable review 2026-07-17, P3, same fix class as
 * components/proAssets.ts's versionFromPatch): the per-lane degraded path
 * (a lane's live championId isn't in the fetched champion map — shouldn't
 * happen in practice, but must never render a blank row) used to rebuild
 * STATIC_FALLBACK_LANE_CHAMPIONS' icon against a hardcoded, ever-staler
 * ICON_VER = "16.12.1" forever. It now threads the LIVE version derived from
 * champMap (already fetched at that call site) instead, falling back to the
 * hardcoded constant only when champMap itself has nothing usable.
 *
 * No jsdom/RTL in this repo's harness — getLaneDefaultChampions only touches
 * the global `fetch` (no DOM), so it's directly testable by stubbing it.
 * Fresh module instance per test (vi.resetModules + dynamic import, same
 * pattern proAssets.test.ts / prostageTimeline.test.ts use) since champMap
 * is a module-level singleton cache.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { isBuildForLane, LANE_TO_ROLE_ID, getHeroStats } from "../hextech/heroContracts";

function jsonResponse(body: unknown, ok = true) {
  return { ok, json: async () => body };
}

/** Routes a single stubbed fetch to different fixtures by URL, mirroring how
 *  getLaneDefaultChampions calls BOTH /api/lane-defaults and (via
 *  getChampionMap) /api/champions in the same Promise.all. */
function routedFetch(routes: Record<string, unknown>) {
  return vi.fn(async (url: string) => {
    for (const [prefix, body] of Object.entries(routes)) {
      if (url.startsWith(prefix)) return jsonResponse(body);
    }
    return jsonResponse({}, false);
  });
}

const LANE_DEFAULTS_ALL_MID = {
  top: { championId: 999999, championName: "Ghost Pick" }, // deliberately NOT in champMap below
  jungle: { championId: 999999, championName: "Ghost Pick" },
  mid: { championId: 999999, championName: "Ghost Pick" },
  bot: { championId: 999999, championName: "Ghost Pick" },
  support: { championId: 999999, championName: "Ghost Pick" },
};

describe("getLaneDefaultChampions — live icon-version threading", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("threads the live version from champMap into the per-lane fallback icon when a lane's live pick isn't in the champion map", async () => {
    vi.stubGlobal(
      "fetch",
      routedFetch({
        "/api/lane-defaults": LANE_DEFAULTS_ALL_MID,
        "/api/champions": [
          { id: 112, key: "Viktor", name: "Viktor", icon: "https://cdn.coachless.gg/static-files/16.13.1/16.13.1/img/champion/Viktor.webp" },
        ],
      })
    );

    const { getLaneDefaultChampions } = await import("../hextech/heroContracts");
    const result = await getLaneDefaultChampions();

    expect(result).not.toBeNull();
    // Every lane falls back (championId 999999 isn't in champMap) — id/key/
    // name stay the mockup's static pick, but the icon's version folder is
    // now the LIVE one (16.13.1), not the hardcoded 16.12.1.
    expect(result!.mid.key).toBe("Viktor"); // STATIC_FALLBACK_LANE_CHAMPIONS.mid's own pick
    expect(result!.mid.icon).toContain("/static-files/16.13.1/16.13.1/");
    expect(result!.mid.icon).not.toContain("16.12.1");
    expect(result!.top.icon).toContain("/static-files/16.13.1/16.13.1/");
  });

  it("uses the resolved live champion directly (no fallback, no version threading needed) when the lane's championId IS in champMap", async () => {
    vi.stubGlobal(
      "fetch",
      routedFetch({
        "/api/lane-defaults": { ...LANE_DEFAULTS_ALL_MID, mid: { championId: 112, championName: "Viktor" } },
        "/api/champions": [
          { id: 112, key: "Viktor", name: "Viktor", icon: "https://cdn.coachless.gg/static-files/16.13.1/16.13.1/img/champion/Viktor.webp" },
        ],
      })
    );

    const { getLaneDefaultChampions } = await import("../hextech/heroContracts");
    const result = await getLaneDefaultChampions();

    expect(result!.mid).toEqual({
      id: 112,
      key: "Viktor",
      name: "Viktor",
      icon: "https://cdn.coachless.gg/static-files/16.13.1/16.13.1/img/champion/Viktor.webp",
    });
  });

  it("falls back to the hardcoded ICON_VER when champMap has nothing usable (total /api/champions failure)", async () => {
    vi.stubGlobal(
      "fetch",
      routedFetch({
        "/api/lane-defaults": LANE_DEFAULTS_ALL_MID,
        // /api/champions deliberately not routed -> jsonResponse({}, false) -> getChampionMap degrades to an empty Map
      })
    );

    const { getLaneDefaultChampions } = await import("../hextech/heroContracts");
    const result = await getLaneDefaultChampions();

    expect(result).not.toBeNull();
    expect(result!.mid.icon).toContain("/static-files/16.12.1/16.12.1/"); // last-resort hardcoded constant, unchanged behavior
  });

  it("returns null on total /api/lane-defaults failure (unchanged behavior)", async () => {
    vi.stubGlobal(
      "fetch",
      routedFetch({
        "/api/champions": [],
        // /api/lane-defaults not routed -> ok:false -> getLaneDefaultChampions returns null
      })
    );

    const { getLaneDefaultChampions } = await import("../hextech/heroContracts");
    const result = await getLaneDefaultChampions();
    expect(result).toBeNull();
  });
});

// P1-1 fix (2026-07-25 audit): getHeroStats' client wrapper used to have no
// third argument at all, so ChampionHero's hero-banner fetch always hit
// /api/hero-stats un-bracketed regardless of the active elo pill. Pin the
// "only append &rank= when non-default" contract (same rule
// BuildTabContent's load() applies to /api/build?rank=) at the unit level.
describe("getHeroStats — rank-bracket query param threading", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("omits &rank= when no bracket is passed (getMostPlayedLane's contract — widest, un-bracketed sample)", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ winRatePct: 50, gamesCount: 100 }) }));
    vi.stubGlobal("fetch", fetchMock);

    await getHeroStats(112, "mid");
    expect(fetchMock).toHaveBeenCalledWith("/api/hero-stats?champ=112&lane=mid");
  });

  it("omits &rank= when the DEFAULT ('all'/High Elo) bracket is passed explicitly — byte-identical request", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ winRatePct: 50, gamesCount: 100 }) }));
    vi.stubGlobal("fetch", fetchMock);

    await getHeroStats(112, "mid", "all");
    expect(fetchMock).toHaveBeenCalledWith("/api/hero-stats?champ=112&lane=mid");
  });

  it("appends &rank= for a non-default bracket", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ winRatePct: 50, gamesCount: 100 }) }));
    vi.stubGlobal("fetch", fetchMock);

    await getHeroStats(112, "mid", "platinum");
    expect(fetchMock).toHaveBeenCalledWith("/api/hero-stats?champ=112&lane=mid&rank=platinum");
  });
});

// v0.36.0 — the pure guard behind the lane-flip auto-export fix (live bug:
// a lane flip's runes never updated the client). See its own doc comment
// in heroContracts.ts for the full stale-closure race this closes.
describe("isBuildForLane", () => {
  it("true when the build's role matches the lane's own RoleId", () => {
    for (const lane of Object.keys(LANE_TO_ROLE_ID) as (keyof typeof LANE_TO_ROLE_ID)[]) {
      expect(isBuildForLane(LANE_TO_ROLE_ID[lane], lane)).toBe(true);
    }
  });

  it("false when the build is for a DIFFERENT role than the current lane (the stale-render case)", () => {
    // A build resolved for Bot (role 3) but the page has already flipped to
    // Support — exactly the mismatched pair the fix must catch.
    expect(isBuildForLane(3, "support")).toBe(false);
  });

  it("false for the historical role 5 ('Auto') against any real lane — never matches, by design", () => {
    expect(isBuildForLane(5, "mid")).toBe(false);
  });
});
