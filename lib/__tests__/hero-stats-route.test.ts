/**
 * Cache-Control contract for GET /api/hero-stats (2026-07-17 Fable review P1):
 * getHeroStats collapses an upstream FAILURE and genuine NO-DATA into the
 * same {winRatePct: null, gamesCount: null} shape — the route used to cache
 * both at s-maxage=21600 (6h), so a transient coachless blip pinned the
 * empty win-rate banner (and the 5-parallel most-played-lane sweep that also
 * reads this route) at the CDN edge for 6h per PoP. Only a fully-healthy,
 * non-degraded result may earn the long cache; every degraded/partial-null
 * result must be no-store. lib/heroStats.ts is mocked — no network.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/heroStats", () => ({
  getHeroStats: vi.fn(),
}));

import { GET } from "@/app/api/hero-stats/route";
import { getHeroStats } from "@/lib/heroStats";

const req = (qs: string) =>
  ({ url: `http://localhost/api/hero-stats${qs}` }) as unknown as Parameters<typeof GET>[0];

describe("GET /api/hero-stats Cache-Control policy", () => {
  beforeEach(() => {
    vi.mocked(getHeroStats).mockReset();
  });

  it("healthy (non-null, non-degraded) result gets the long s-maxage", async () => {
    vi.mocked(getHeroStats).mockResolvedValueOnce({ winRatePct: 52.4, gamesCount: 18402 });
    const res = await GET(req("?champ=112&lane=mid"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ winRatePct: 52.4, gamesCount: 18402 });
    expect(res.headers.get("Cache-Control")).toBe("s-maxage=21600, stale-while-revalidate=86400");
  });

  it("degraded (upstream failure) result is no-store, never pinned at the edge", async () => {
    vi.mocked(getHeroStats).mockResolvedValueOnce({ winRatePct: null, gamesCount: null, degraded: true });
    const res = await GET(req("?champ=112&lane=mid"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ winRatePct: null, gamesCount: null });
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("genuine no-data (both null, not degraded) is ALSO no-store — cheap to recompute", async () => {
    vi.mocked(getHeroStats).mockResolvedValueOnce({ winRatePct: null, gamesCount: null });
    const res = await GET(req("?champ=999999&lane=top"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("partial result (gamesCount known, winRatePct null) is no-store too", async () => {
    vi.mocked(getHeroStats).mockResolvedValueOnce({ winRatePct: null, gamesCount: 5000 });
    const res = await GET(req("?champ=112&lane=mid"));
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("never leaks the internal `degraded` flag onto the wire response", async () => {
    vi.mocked(getHeroStats).mockResolvedValueOnce({ winRatePct: null, gamesCount: null, degraded: true });
    const res = await GET(req("?champ=112&lane=mid"));
    const json = await res.json();
    expect("degraded" in json).toBe(false);
  });
});
