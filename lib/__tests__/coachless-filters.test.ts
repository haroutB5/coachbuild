/**
 * Feature 1/2/3 request-body composition (cache-key composition): the coachless
 * client must thread matchupChampionIds + leagueTiers into commonFilters and
 * firstLegendaryId/secondLegendaryId into the item body. Because the Next fetch
 * cache is keyed on (url + body bytes), getting these into the body IS what
 * makes each conditioned/rank/matchup query its own cache entry. Mocks fetch —
 * no network.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  getKeystoneData,
  getGlobalItemStatistics,
  DIAMOND_PLUS_TIERS,
} from "../coachless";
import { DIAMOND_PLUS_BRACKET } from "../rankBrackets";

const PATCH = { major: 16, patch: 13, patchAdditions: 0 };

function mockFetchOnce(): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async () => ({
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => [],
  })) as unknown as ReturnType<typeof vi.fn>;
  vi.stubGlobal("fetch", fn);
  return fn;
}

function lastBody(fn: ReturnType<typeof vi.fn>): any {
  const call = fn.mock.calls[fn.mock.calls.length - 1];
  return JSON.parse((call[1] as RequestInit).body as string);
}

afterEach(() => vi.unstubAllGlobals());

describe("commonFilters defaults", () => {
  // The fallback constant in coachless.ts and the bracket the UI resolves are
  // two separate literals. They MUST agree: recommend.ts now pins leagueTiers
  // explicitly on every call, but heroStats.ts still has callers that pass no
  // opts at all and land on this fallback. A drift between them would query one
  // tier set while labelling it as the other — exactly the off-by-one this
  // change removed.
  it("DIAMOND_PLUS_TIERS equals the Diamond+ bracket apiValue — no second source of truth", () => {
    expect(DIAMOND_PLUS_TIERS).toEqual(DIAMOND_PLUS_BRACKET.apiValue);
    expect(DIAMOND_PLUS_TIERS).toEqual([6, 7, 8, 9]);
  });

  it("no opts → matchupChampionIds:null, leagueTiers:DIAMOND_PLUS", async () => {
    const fn = mockFetchOnce();
    await getKeystoneData(112, 2, PATCH);
    const cf = lastBody(fn).commonFilters;
    expect(cf.matchupChampionIds).toBeNull();
    expect(cf.leagueTiers).toEqual(DIAMOND_PLUS_TIERS);
    expect(cf.championIds).toEqual([112]);
    expect(cf.role).toBe(2);
  });
});

describe("Feature 3 — leagueTiers override", () => {
  it("threads a rank-bracket tier set into commonFilters", async () => {
    const fn = mockFetchOnce();
    await getKeystoneData(112, 2, PATCH, undefined, { leagueTiers: [8] });
    expect(lastBody(fn).commonFilters.leagueTiers).toEqual([8]);
  });
});

describe("Feature 1 — matchupChampionIds override", () => {
  it("threads the enemy id into commonFilters", async () => {
    const fn = mockFetchOnce();
    await getKeystoneData(112, 2, PATCH, undefined, { matchupChampionIds: [103] });
    expect(lastBody(fn).commonFilters.matchupChampionIds).toEqual([103]);
  });
  it("combines matchup + tiers in one body (distinct cache key)", async () => {
    const fn = mockFetchOnce();
    await getGlobalItemStatistics(112, 2, PATCH, [1], 1, {}, {
      matchupChampionIds: [103],
      leagueTiers: [8],
    });
    const cf = lastBody(fn).commonFilters;
    expect(cf.matchupChampionIds).toEqual([103]);
    expect(cf.leagueTiers).toEqual([8]);
  });
});

describe("Feature 2 — item conditioning via extras", () => {
  it("firstLegendaryId / secondLegendaryId ride the item body", async () => {
    const fn = mockFetchOnce();
    await getGlobalItemStatistics(112, 2, PATCH, [3], 1, {
      firstLegendaryId: 2503,
      secondLegendaryId: 3152,
    });
    const body = lastBody(fn);
    expect(body.firstLegendaryId).toBe(2503);
    expect(body.secondLegendaryId).toBe(3152);
    expect(body.itemSlots).toEqual([3]);
  });
});
