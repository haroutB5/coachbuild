/**
 * Route-level tests for GET /api/build — status-code mapping.
 * These guard the regression that shipped: not-played/unknown-champ must be 404,
 * not 500. The engine is mocked so no network is touched.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/recommend", () => {
  class NotPlayedInRoleError extends Error {}
  return { NotPlayedInRoleError, buildRecommendations: vi.fn() };
});

import { GET } from "@/app/api/build/route";
import { buildRecommendations, NotPlayedInRoleError } from "@/lib/recommend";

// Minimal NextRequest stand-in: the handler only reads req.url.
const req = (qs: string) =>
  ({ url: `http://localhost/api/build${qs}` }) as unknown as Parameters<typeof GET>[0];

describe("GET /api/build status mapping", () => {
  beforeEach(() => vi.mocked(buildRecommendations).mockReset());

  it("400 on missing params", async () => {
    expect((await GET(req(""))).status).toBe(400);
  });

  it("400 on non-integer params (2x, 86.5, abc)", async () => {
    expect((await GET(req("?champ=86&role=2x"))).status).toBe(400);
    expect((await GET(req("?champ=86.5&role=2"))).status).toBe(400);
    expect((await GET(req("?champ=abc&role=2"))).status).toBe(400);
  });

  it("400 on out-of-range role", async () => {
    expect((await GET(req("?champ=86&role=9"))).status).toBe(400);
  });

  it("404 when champion not played in role", async () => {
    vi.mocked(buildRecommendations).mockRejectedValueOnce(
      new NotPlayedInRoleError("nope")
    );
    expect((await GET(req("?champ=86&role=4"))).status).toBe(404);
  });

  it("404 when the engine returns an empty list", async () => {
    vi.mocked(buildRecommendations).mockResolvedValueOnce([]);
    expect((await GET(req("?champ=86&role=4"))).status).toBe(404);
  });

  it("500 (no detail leak) on an unexpected error", async () => {
    vi.mocked(buildRecommendations).mockRejectedValueOnce(new Error("secret"));
    const res = await GET(req("?champ=112&role=2"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Internal server error");
    expect(JSON.stringify(body)).not.toContain("secret");
  });

  it("200 with the builds array on success", async () => {
    vi.mocked(buildRecommendations).mockResolvedValueOnce([
      { rank: 1 },
    ] as never);
    const res = await GET(req("?champ=112&role=2"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body[0].rank).toBe(1);
  });
});
