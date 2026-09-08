/**
 * GET /api/draft/counters: request validation, the full cache key, 24-hour
 * successful-result TTL, cache reuse, and typed parser-failure propagation.
 * The lolalytics transport/parser itself is fixture-tested separately.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LastGoodStore } from "@/lib/lastGood";

const holder = vi.hoisted(() => ({
  store: null as LastGoodStore | null,
}));

vi.mock("@/lib/lastGood", () => ({
  runtimeLastGoodStore: () => holder.store!,
}));
vi.mock("@/lib/staticData", () => ({
  getChampionById: vi.fn(),
  getAllChampions: vi.fn(),
}));
vi.mock("@/lib/draft/patch", () => ({
  resolveDraftPatchLabel: vi.fn(),
}));
vi.mock("@/lib/lolalytics/counters", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/lolalytics/counters")>();
  return { ...real, resolveCountersForEnemy: vi.fn() };
});

import { GET, countersCacheKey } from "@/app/api/draft/counters/route";
import { resolveDraftPatchLabel } from "@/lib/draft/patch";
import {
  LOLALYTICS_COUNTERS_CACHE_TTL_SECONDS,
  LolalyticsCountersError,
  resolveCountersForEnemy,
  type ResolvedCounters,
} from "@/lib/lolalytics/counters";
import { getAllChampions, getChampionById } from "@/lib/staticData";

const req = (qs: string) =>
  ({ url: `http://localhost/api/draft/counters${qs}` }) as unknown as Parameters<typeof GET>[0];

const RESOLVED: ResolvedCounters = {
  enemyChampId: 112,
  enemyName: "Viktor",
  enemySlug: "viktor",
  lane: "middle",
  tier: "emerald_plus",
  patch: "16.17",
  fetchedAt: "2026-09-08T12:00:00.000Z",
  suggestions: [{ champId: 161, name: "Vel'Koz", winRate: 0.5137, delta1pp: -0.9, delta2pp: 3, games: 1530 }],
  parsedRows: 101,
  skippedCards: 0,
  gatedRows: 12,
  unmappedRows: 0,
  directionAgreements: 101,
};

beforeEach(() => {
  holder.store = {
    get: vi.fn(async () => null),
    set: vi.fn(async () => {}),
  };
  vi.mocked(getChampionById).mockReset().mockResolvedValue({ id: 112, name: "Viktor" } as never);
  vi.mocked(getAllChampions).mockReset().mockResolvedValue([{ id: 112, name: "Viktor" }] as never);
  vi.mocked(resolveDraftPatchLabel).mockReset().mockResolvedValue("16.17");
  vi.mocked(resolveCountersForEnemy).mockReset().mockResolvedValue(RESOLVED);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("GET /api/draft/counters", () => {
  it("keys by enemy slug + lane + tier + patch and caches a successful parse for 24 hours", async () => {
    expect(countersCacheKey("viktor", "middle", "emerald_plus", "16.17")).toBe(
      "lola:counters:v1:viktor:middle:emerald_plus:16.17"
    );

    const res = await GET(req("?enemy=112&lane=2"));
    expect(res.status).toBe(200);
    expect(resolveCountersForEnemy).toHaveBeenCalledWith(
      { id: 112, name: "Viktor" },
      "middle",
      "16.17",
      { champions: [{ id: 112, name: "Viktor" }] }
    );
    expect(holder.store!.set).toHaveBeenCalledWith(
      "lola:counters:v1:viktor:middle:emerald_plus:16.17",
      RESOLVED,
      LOLALYTICS_COUNTERS_CACHE_TTL_SECONDS
    );
    expect(LOLALYTICS_COUNTERS_CACHE_TTL_SECONDS).toBe(86_400);
  });

  it("serves a cached result without another lolalytics fetch/parse", async () => {
    vi.mocked(holder.store!.get).mockResolvedValue(RESOLVED);
    const res = await GET(req("?enemy=112&lane=2"));
    expect(res.status).toBe(200);
    expect(resolveCountersForEnemy).not.toHaveBeenCalled();
    expect(holder.store!.set).not.toHaveBeenCalled();
    expect((await res.json()).suggestions[0].champId).toBe(161);
  });

  it("returns a machine-readable 502 for a typed parser drift failure and does not cache it", async () => {
    vi.mocked(resolveCountersForEnemy).mockRejectedValue(
      new LolalyticsCountersError("direction-unproven", "tooltip direction changed")
    );
    const res = await GET(req("?enemy=112&lane=2"));
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: "Counter-pick data unavailable", reason: "direction-unproven" });
    expect(holder.store!.set).not.toHaveBeenCalled();
  });

  it("rejects non-concrete lanes before any upstream work", async () => {
    const res = await GET(req("?enemy=112&lane=5"));
    expect(res.status).toBe(400);
    expect(getChampionById).not.toHaveBeenCalled();
    expect(resolveCountersForEnemy).not.toHaveBeenCalled();
  });
});
