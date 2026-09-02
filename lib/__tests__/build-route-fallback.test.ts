/**
 * GET /api/build with the 0.122.0 fallback: the route's status codes, cache
 * headers and body shape for each resolution. Engine mocked; the runtime
 * cache replaced with an in-memory store so a "cold function" is a fresh
 * store and a "warm one" is the same store reused.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LastGoodStore } from "@/lib/lastGood";

vi.mock("@/lib/recommend", () => {
  class NotPlayedInRoleError extends Error {}
  return { NotPlayedInRoleError, buildRecommendations: vi.fn() };
});

// vi.mock is hoisted above every import, so the shared store has to be built
// inside the factory and parked on a hoisted holder.
const holder = vi.hoisted(() => ({ store: null as LastGoodStore | null }));
vi.mock("@/lib/lastGood", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/lastGood")>();
  holder.store ??= real.memoryLastGoodStore();
  return { ...real, runtimeLastGoodStore: () => holder.store! };
});

import { GET } from "@/app/api/build/route";
import { buildRecommendations, NotPlayedInRoleError } from "@/lib/recommend";

const req = (qs: string) =>
  ({ url: `http://localhost/api/build${qs}` }) as unknown as Parameters<typeof GET>[0];

const FRESH = [{ rank: 1, patch: "16.17" }, { rank: 2, patch: "16.17" }];

beforeEach(() => {
  vi.mocked(buildRecommendations).mockReset();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("GET /api/build — degrade instead of empty", () => {
  it("fresh: 200, no stale fields, the long CDN header now carries stale-if-error", async () => {
    vi.mocked(buildRecommendations).mockResolvedValue(FRESH as never);
    const res = await GET(req("?champ=112&role=2"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe(
      "s-maxage=21600, stale-while-revalidate=86400, stale-if-error=604800"
    );
    const body = await res.json();
    expect(body).toHaveLength(2);
    expect(body[0]).not.toHaveProperty("stale");
  });

  it("upstream 403 after a fresh answer: 200, every build stale:true + asOf, SHORT cache header", async () => {
    vi.mocked(buildRecommendations).mockResolvedValue(FRESH as never);
    await GET(req("?champ=112&role=2"));

    vi.mocked(buildRecommendations).mockRejectedValue(new Error("coachless Rune/GetKeystoneData → 403 Forbidden"));
    const res = await GET(req("?champ=112&role=2"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("s-maxage=300, stale-while-revalidate=300");
    const body = await res.json();
    expect(body).toHaveLength(2);
    for (const b of body) {
      expect(b.stale).toBe(true);
      expect(typeof b.asOf).toBe("string");
      expect(Number.isFinite(Date.parse(b.asOf))).toBe(true);
    }
    expect(console.warn).toHaveBeenCalledWith(expect.stringMatching(/served last known-good copy for champ=112 role=2/));
  });

  it("the copy is keyed by the FULL request: a different role or bracket does not borrow it", async () => {
    vi.mocked(buildRecommendations).mockResolvedValue(FRESH as never);
    await GET(req("?champ=112&role=2"));
    vi.mocked(buildRecommendations).mockRejectedValue(new Error("403"));
    expect((await GET(req("?champ=112&role=3"))).status).toBe(500);
    expect((await GET(req("?champ=112&role=2&enemyChampionId=103"))).status).toBe(500);
    expect((await GET(req("?champ=112&role=2"))).status).toBe(200);
  });

  it("a real 404 stays a 404 even when a copy exists", async () => {
    vi.mocked(buildRecommendations).mockResolvedValue(FRESH as never);
    await GET(req("?champ=112&role=2"));
    vi.mocked(buildRecommendations).mockRejectedValue(new NotPlayedInRoleError("gone this patch"));
    const res = await GET(req("?champ=112&role=2"));
    expect(res.status).toBe(404);
    expect((await res.json()).detail).toBe("gone this patch");
  });

  it("upstream failure with nothing cached is still a 500", async () => {
    vi.mocked(buildRecommendations).mockRejectedValue(new Error("503"));
    const res = await GET(req("?champ=999&role=4"));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Internal server error" });
  });
});
