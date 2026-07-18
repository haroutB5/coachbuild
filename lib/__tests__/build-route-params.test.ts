/**
 * Feature 1/3 route wiring: GET /api/build must validate the new optional
 * enemyChampionId + rank params and pass resolved options to the engine.
 * Engine mocked (no network).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/recommend", () => {
  class NotPlayedInRoleError extends Error {}
  return { NotPlayedInRoleError, buildRecommendations: vi.fn() };
});

import { GET } from "@/app/api/build/route";
import { buildRecommendations } from "@/lib/recommend";

const req = (qs: string) =>
  ({ url: `http://localhost/api/build${qs}` }) as unknown as Parameters<typeof GET>[0];

describe("GET /api/build — enemyChampionId + rank validation", () => {
  beforeEach(() => {
    vi.mocked(buildRecommendations).mockReset();
    vi.mocked(buildRecommendations).mockResolvedValue([{ rank: 1 }] as never);
  });

  it("400 on non-integer enemyChampionId", async () => {
    expect((await GET(req("?champ=112&role=2&enemyChampionId=ah"))).status).toBe(400);
    expect((await GET(req("?champ=112&role=2&enemyChampionId=1.5"))).status).toBe(400);
  });

  it("400 on unknown rank bracket", async () => {
    expect((await GET(req("?champ=112&role=2&rank=bronze"))).status).toBe(400);
  });

  it("passes enemyChampionId + resolved bracket to the engine", async () => {
    const res = await GET(req("?champ=112&role=2&enemyChampionId=103&rank=challenger"));
    expect(res.status).toBe(200);
    const [, , opts] = vi.mocked(buildRecommendations).mock.calls[0];
    expect(opts?.enemyChampionId).toBe(103);
    expect(opts?.rankBracket?.id).toBe("challenger");
    expect(opts?.rankBracket?.apiValue).toEqual([8]);
  });

  it("defaults: no rank → 'all' bracket, no enemy → null", async () => {
    await GET(req("?champ=112&role=2"));
    const [, , opts] = vi.mocked(buildRecommendations).mock.calls[0];
    expect(opts?.enemyChampionId).toBeNull();
    expect(opts?.rankBracket?.id).toBe("all");
  });

  it("empty enemyChampionId param is treated as absent (null)", async () => {
    await GET(req("?champ=112&role=2&enemyChampionId="));
    const [, , opts] = vi.mocked(buildRecommendations).mock.calls[0];
    expect(opts?.enemyChampionId).toBeNull();
  });
});
