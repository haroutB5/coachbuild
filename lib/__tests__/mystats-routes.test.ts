/**
 * Route tests: param validation, CRON_SECRET auth (ingest route), and
 * no-store cache discipline (per-user private data — see CLAUDE.md gotcha
 * (b) and each route's own doc comment). Engine functions mocked.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockRunMyStatsIngest = vi.fn();
vi.mock("@/lib/mystats/ingest", () => ({ runMyStatsIngest: (...args: unknown[]) => mockRunMyStatsIngest(...args) }));

const mockSql = vi.fn();
vi.mock("@/lib/pro/db", () => ({ getSql: vi.fn(() => mockSql) }));

const mockGetMyAccount = vi.fn();
vi.mock("@/lib/mystats/account", () => ({ getMyAccount: (...args: unknown[]) => mockGetMyAccount(...args) }));

import { GET as ingestGET } from "@/app/api/ingest/mystats/route";
import { GET as summaryGET } from "@/app/api/mystats/summary/route";
import { GET as matchupsGET } from "@/app/api/mystats/matchups/route";
import { getSql } from "@/lib/pro/db";

function req(url: string, headers: Record<string, string> = {}) {
  return {
    url,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
  } as unknown as Parameters<typeof ingestGET>[0];
}

describe("GET /api/ingest/mystats", () => {
  beforeEach(() => {
    mockRunMyStatsIngest.mockReset();
    process.env.CRON_SECRET = "s3cret";
  });

  it("401 without a valid bearer token", async () => {
    const res = await ingestGET(req("http://localhost/api/ingest/mystats"));
    expect(res.status).toBe(401);
    expect(mockRunMyStatsIngest).not.toHaveBeenCalled();
  });

  it("401 with the wrong token", async () => {
    const res = await ingestGET(req("http://localhost/api/ingest/mystats", { authorization: "Bearer wrong" }));
    expect(res.status).toBe(401);
  });

  it("defaults to incremental mode with no query params", async () => {
    mockRunMyStatsIngest.mockResolvedValueOnce({ accountUnresolved: false, matchesSeen: 0, matchesUpserted: 0, nextStart: null, errors: [] });
    const res = await ingestGET(req("http://localhost/api/ingest/mystats", { authorization: "Bearer s3cret" }));
    expect(res.status).toBe(200);
    expect(mockRunMyStatsIngest).toHaveBeenCalledWith({ mode: "incremental", start: undefined, pageSize: undefined });
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("mode=backfill with explicit start/pageSize passes through", async () => {
    mockRunMyStatsIngest.mockResolvedValueOnce({ accountUnresolved: false, matchesSeen: 0, matchesUpserted: 0, nextStart: null, errors: [] });
    await ingestGET(req("http://localhost/api/ingest/mystats?mode=backfill&start=200&pageSize=50", { authorization: "Bearer s3cret" }));
    expect(mockRunMyStatsIngest).toHaveBeenCalledWith({ mode: "backfill", start: 200, pageSize: 50 });
  });

  it("400 on a non-numeric start", async () => {
    const res = await ingestGET(req("http://localhost/api/ingest/mystats?start=abc", { authorization: "Bearer s3cret" }));
    expect(res.status).toBe(400);
  });
});

describe("GET /api/mystats/summary", () => {
  beforeEach(() => {
    mockGetMyAccount.mockReset();
    mockSql.mockReset();
    vi.mocked(getSql).mockReturnValue(mockSql as never);
    mockSql.mockImplementation(() => Promise.resolve([]));
  });

  it("accountUnresolved -> 200, empty records, ALWAYS no-store", async () => {
    mockGetMyAccount.mockResolvedValueOnce(null);
    const res = await summaryGET(req("http://localhost/api/mystats/summary"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = await res.json();
    expect(body.accountUnresolved).toBe(true);
    expect(body.records).toEqual([]);
    expect(body.riotId).toBeNull();
  });

  it("400 on a non-numeric role/championId/oppChampionId", async () => {
    expect((await summaryGET(req("http://localhost/api/mystats/summary?role=abc"))).status).toBe(400);
    expect((await summaryGET(req("http://localhost/api/mystats/summary?championId=abc"))).status).toBe(400);
    expect((await summaryGET(req("http://localhost/api/mystats/summary?oppChampionId=abc"))).status).toBe(400);
  });

  it("populated response is STILL no-store (private per-user data, never CDN-cached)", async () => {
    mockGetMyAccount.mockResolvedValueOnce({ puuid: "p", riotId: "X#EUW", region: "EUW", routing: {} });
    mockSql.mockImplementation(() =>
      Promise.resolve([{ champion_id: 1, role: 2, opp_champion_id: 99, win: true, game_creation: "2026-01-01T00:00:00.000Z" }])
    );
    const res = await summaryGET(req("http://localhost/api/mystats/summary?championId=1"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = await res.json();
    expect(body.records).toHaveLength(1);
    expect(body.records[0]).toMatchObject({ championId: 1, games: 1, wins: 1 });
    expect(body.riotId).toBe("X#EUW");
  });

  it("matchup is null unless BOTH championId and oppChampionId are given", async () => {
    mockGetMyAccount.mockResolvedValueOnce({ puuid: "p", riotId: "X#EUW", region: "EUW", routing: {} });
    mockSql.mockImplementation(() => Promise.resolve([]));
    const res1 = await summaryGET(req("http://localhost/api/mystats/summary?oppChampionId=99")); // no championId
    expect((await res1.json()).matchup).toBeNull();
  });
});

describe("GET /api/mystats/matchups", () => {
  beforeEach(() => {
    mockGetMyAccount.mockReset();
    mockSql.mockReset();
    vi.mocked(getSql).mockReturnValue(mockSql as never);
  });

  it("400 when championId is missing", async () => {
    const res = await matchupsGET(req("http://localhost/api/mystats/matchups"));
    expect(res.status).toBe(400);
  });

  it("accountUnresolved -> 200, empty matchups, no-store", async () => {
    mockGetMyAccount.mockResolvedValueOnce(null);
    const res = await matchupsGET(req("http://localhost/api/mystats/matchups?championId=1"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = await res.json();
    expect(body.accountUnresolved).toBe(true);
    expect(body.matchups).toEqual([]);
  });

  it("groups by opponent and excludes null-opponent (unresolved-role) rows", async () => {
    mockGetMyAccount.mockResolvedValueOnce({ puuid: "p", riotId: "X#EUW", region: "EUW", routing: {} });
    mockSql.mockImplementation(() =>
      Promise.resolve([
        { role: 2, opp_champion_id: 99, win: true, game_creation: "2026-01-01T00:00:00.000Z" },
        { role: -1, opp_champion_id: null, win: false, game_creation: "2026-01-02T00:00:00.000Z" }, // ARAM row -- excluded
      ])
    );
    const res = await matchupsGET(req("http://localhost/api/mystats/matchups?championId=1"));
    const body = await res.json();
    expect(body.matchups).toEqual([{ oppChampionId: 99, games: 1, wins: 1, winrate: 1 }]);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });
});
