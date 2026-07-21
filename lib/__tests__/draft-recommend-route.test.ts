/**
 * Route tests for GET /api/draft/recommend — param validation + cache
 * header discipline (populated vs pending/empty/degraded, both asserted per
 * the plan). Engine (lib/draft/recommend.ts) mocked — see draft-recommend.test.ts
 * for engine-level DB-query coverage.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/draft/recommend", () => ({ computeDraftRecommend: vi.fn() }));

import { GET } from "@/app/api/draft/recommend/route";
import { computeDraftRecommend } from "@/lib/draft/recommend";
import { DbUnavailableError } from "@/lib/pro/errors";

const req = (qs: string) =>
  ({ url: `http://localhost/api/draft/recommend${qs}` }) as unknown as Parameters<typeof GET>[0];

const baseMeta = { patch: "16.14", tier: 10, fetchedAt: "2026-07-21T00:00:00.000Z", laneOppInferred: null, currentPatch: "16.14" };

describe("GET /api/draft/recommend", () => {
  beforeEach(() => vi.mocked(computeDraftRecommend).mockReset());

  it("400 on missing/non-integer/out-of-range lane (5 is auto, not a lane)", async () => {
    expect((await GET(req(""))).status).toBe(400);
    expect((await GET(req("?lane=x"))).status).toBe(400);
    expect((await GET(req("?lane=5"))).status).toBe(400);
    expect((await GET(req("?lane=-1"))).status).toBe(400);
  });

  it("400 on a malformed enemies entry", async () => {
    const res = await GET(req("?lane=0&enemies=1,abc,3"));
    expect(res.status).toBe(400);
    expect(computeDraftRecommend).not.toHaveBeenCalled();
  });

  it("400 on a malformed laneOpp / hover", async () => {
    expect((await GET(req("?lane=0&laneOpp=abc"))).status).toBe(400);
    expect((await GET(req("?lane=0&hover=-5"))).status).toBe(400);
  });

  it("dedupes enemies and caps at 5", async () => {
    vi.mocked(computeDraftRecommend).mockResolvedValueOnce({ plays: [], potentialPlays: [], bans: null, enemyAnalysis: [], meta: baseMeta, pending: true });
    await GET(req("?lane=0&enemies=1,1,2,3,4,5,6,7"));
    const call = vi.mocked(computeDraftRecommend).mock.calls[0][0];
    expect(call.enemies).toEqual([1, 2, 3, 4, 5]);
  });

  it("passes lane/enemies/laneOpp/hover through to the engine", async () => {
    vi.mocked(computeDraftRecommend).mockResolvedValueOnce({ plays: [], potentialPlays: [], bans: null, enemyAnalysis: [], meta: baseMeta, pending: true });
    await GET(req("?lane=2&enemies=10,20&laneOpp=10&hover=99"));
    expect(computeDraftRecommend).toHaveBeenCalledWith({ lane: 2, enemies: [10, 20], laneOpp: 10, hover: 99 });
  });

  it("pending -> 200 + no-store", async () => {
    vi.mocked(computeDraftRecommend).mockResolvedValueOnce({ plays: [], potentialPlays: [], bans: null, enemyAnalysis: [], meta: baseMeta, pending: true });
    const res = await GET(req("?lane=0"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect((await res.json()).pending).toBe(true);
  });

  it("empty plays (no pending flag) -> no-store (degraded, per repo Gotcha (b))", async () => {
    vi.mocked(computeDraftRecommend).mockResolvedValueOnce({ plays: [], potentialPlays: [], bans: null, enemyAnalysis: [], meta: baseMeta });
    const res = await GET(req("?lane=0"));
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("populated plays -> hard s-maxage=300/swr=600 cache", async () => {
    vi.mocked(computeDraftRecommend).mockResolvedValueOnce({
      plays: [
        {
          champId: 1,
          score: 0.55,
          winVsLaneOpp: null,
          winVsLaneOppGames: null,
          confidence: "normal",
          minGames: 10000,
          personal: null,
          personalOverall: { games: 0, wins: 0 }, synergyDelta: 0,
        },
      ],
      potentialPlays: [],
      bans: null,
      enemyAnalysis: [],
      meta: baseMeta,
    });
    const res = await GET(req("?lane=0"));
    expect(res.status).toBe(200);
    const cc = res.headers.get("Cache-Control")!;
    expect(cc).toContain("s-maxage=300");
    expect(cc).toContain("stale-while-revalidate=600");
  });

  it("v0.37.4: potentialPlays is included in the passed-through response body", async () => {
    vi.mocked(computeDraftRecommend).mockResolvedValueOnce({
      plays: [],
      potentialPlays: [
        {
          champId: 2,
          score: 0.5,
          winVsLaneOpp: 0.48,
          winVsLaneOppGames: 500,
          confidence: "low",
          minGames: 500,
          personal: null,
          personalOverall: { games: 0, wins: 0 }, synergyDelta: 0,
        },
      ],
      bans: null,
      enemyAnalysis: [],
      meta: baseMeta,
    });
    const res = await GET(req("?lane=0"));
    const body = await res.json();
    expect(body.potentialPlays).toHaveLength(1);
    expect(body.potentialPlays[0].champId).toBe(2);
  });

  it("DbUnavailableError -> 503 no-store", async () => {
    vi.mocked(computeDraftRecommend).mockRejectedValueOnce(new DbUnavailableError());
    const res = await GET(req("?lane=0"));
    expect(res.status).toBe(503);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("unexpected error -> 500 no-store", async () => {
    vi.mocked(computeDraftRecommend).mockRejectedValueOnce(new Error("boom"));
    const res = await GET(req("?lane=0"));
    expect(res.status).toBe(500);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });
});
