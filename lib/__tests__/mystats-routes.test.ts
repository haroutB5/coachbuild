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

const mockRunMyStatsRefresh = vi.fn();
vi.mock("@/lib/mystats/refresh", () => ({ runMyStatsRefresh: (...args: unknown[]) => mockRunMyStatsRefresh(...args) }));

import { GET as ingestGET } from "@/app/api/ingest/mystats/route";
import { GET as summaryGET } from "@/app/api/mystats/summary/route";
import { GET as matchupsGET } from "@/app/api/mystats/matchups/route";
import { POST as refreshPOST } from "@/app/api/mystats/refresh/route";
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
    expect(body.role).toBeNull(); // no role param -> champion-wide, echoed as null
  });

  it("400 on a non-numeric role", async () => {
    const res = await matchupsGET(req("http://localhost/api/mystats/matchups?championId=1&role=abc"));
    expect(res.status).toBe(400);
  });

  // ── Reported bug repro: /mystats "Matchup History" row header (per
  // champion+ROLE) vs its own expanded matchups (champion-wide, no role)
  // contradicted each other -- a Galio MID row read "3g" while its expanded
  // list summed to 5 games because the fetch didn't scope by role. This test
  // pins the fix's actual acceptance criterion: sum(expanded matchup games)
  // === the header's (champion, role) game count. A single-role fixture
  // would pass even with the old bug, so this uses a champion played in TWO
  // roles with DIFFERENT opponents per role -- the exact shape that broke. ──
  it("scoping invariant: role-scoped matchups sum to exactly that role's games, never leaking a champion's other-role games (Galio Mid vs Top repro)", async () => {
    // mockResolvedValue (not -Once): this test drives the route 3 times
    // (Mid-scoped, Top-scoped, champion-wide) and needs the account resolved
    // on every call, not just the first.
    mockGetMyAccount.mockResolvedValue({ puuid: "p", riotId: "X#EUW", region: "EUW", routing: {} });
    const GALIO = 3;
    const MID = 2;
    const TOP = 0;
    const allRows = [
      // Galio MID: 3 games, 3W-0L against 3 distinct opponents (matches the report's header: "3g · 3W-0L · 100.0%")
      { champion_id: GALIO, role: MID, opp_champion_id: 9, win: true, game_creation: "2026-01-01T00:00:00.000Z" }, // vs Fiddlesticks
      { champion_id: GALIO, role: MID, opp_champion_id: 35, win: true, game_creation: "2026-01-02T00:00:00.000Z" }, // vs Shaco
      { champion_id: GALIO, role: MID, opp_champion_id: 84, win: true, game_creation: "2026-01-03T00:00:00.000Z" }, // vs Akali
      // Same champion, played TOP too -- different opponents, must never bleed into the Mid-scoped result
      { champion_id: GALIO, role: TOP, opp_champion_id: 24, win: false, game_creation: "2026-01-04T00:00:00.000Z" },
      { champion_id: GALIO, role: TOP, opp_champion_id: 82, win: true, game_creation: "2026-01-05T00:00:00.000Z" },
    ];
    // Emulates the real WHERE clause: filters by champion_id, and by role only
    // when the route actually passed one (mirroring Postgres's real behavior
    // for the two SQL branches in app/api/mystats/matchups/route.ts).
    mockSql.mockImplementation((_strings: TemplateStringsArray, ...values: unknown[]) => {
      const [championId, role] = values as [number, number | undefined];
      const filtered = allRows.filter((r) => r.champion_id === championId && (role === undefined || r.role === role));
      return Promise.resolve(filtered);
    });

    const midRes = await matchupsGET(req(`http://localhost/api/mystats/matchups?championId=${GALIO}&role=${MID}`));
    const midBody = await midRes.json();
    const midTotalGames = midBody.matchups.reduce((sum: number, m: { games: number }) => sum + m.games, 0);
    expect(midTotalGames).toBe(3); // NOT 5 -- the pre-fix bug summed all 5 champion-wide games under the Mid header
    expect(midBody.matchups.map((m: { oppChampionId: number }) => m.oppChampionId).sort((a: number, b: number) => a - b)).toEqual([
      9, 35, 84,
    ]);
    expect(midBody.role).toBe(MID);

    // The Top-scoped request for the SAME champion is disjoint from Mid's --
    // proves role, not something else, is what separates the two headers.
    const topRes = await matchupsGET(req(`http://localhost/api/mystats/matchups?championId=${GALIO}&role=${TOP}`));
    const topBody = await topRes.json();
    const topTotalGames = topBody.matchups.reduce((sum: number, m: { games: number }) => sum + m.games, 0);
    expect(topTotalGames).toBe(2);
    expect(topBody.matchups.map((m: { oppChampionId: number }) => m.oppChampionId).sort((a: number, b: number) => a - b)).toEqual([
      24, 82,
    ]);

    // Backward compatibility: omitting role still returns the champion-wide
    // total (5) -- a legitimate, different question from either role scope.
    const wideRes = await matchupsGET(req(`http://localhost/api/mystats/matchups?championId=${GALIO}`));
    const wideBody = await wideRes.json();
    const wideTotalGames = wideBody.matchups.reduce((sum: number, m: { games: number }) => sum + m.games, 0);
    expect(wideTotalGames).toBe(5);
    expect(wideBody.role).toBeNull();
  });
});

describe("POST /api/mystats/refresh", () => {
  beforeEach(() => {
    mockRunMyStatsRefresh.mockReset();
    mockSql.mockReset();
    vi.mocked(getSql).mockReturnValue(mockSql as never);
  });

  it("503 with no-store when DATABASE_URL isn't configured, never calls runMyStatsRefresh", async () => {
    vi.mocked(getSql).mockReturnValueOnce(null);
    const res = await refreshPOST();
    expect(res.status).toBe(503);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(mockRunMyStatsRefresh).not.toHaveBeenCalled();
  });

  it("accountUnresolved passes through as-is, no-store", async () => {
    mockRunMyStatsRefresh.mockResolvedValueOnce({ accountUnresolved: true });
    const res = await refreshPOST();
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toEqual({ accountUnresolved: true });
  });

  it("skipped:cooldown passes through as-is", async () => {
    mockRunMyStatsRefresh.mockResolvedValueOnce({ refreshed: false, skipped: true, reason: "cooldown" });
    const res = await refreshPOST();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ refreshed: false, skipped: true, reason: "cooldown" });
  });

  it("refreshed:true with newGames/latest passes through as-is", async () => {
    mockRunMyStatsRefresh.mockResolvedValueOnce({ refreshed: true, skipped: false, newGames: 3, latest: "2026-07-24T11:00:00.000Z" });
    const res = await refreshPOST();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ refreshed: true, skipped: false, newGames: 3, latest: "2026-07-24T11:00:00.000Z" });
  });

  it("fail-soft error:true is still a 200, never a 500", async () => {
    mockRunMyStatsRefresh.mockResolvedValueOnce({ refreshed: false, skipped: false, error: true });
    const res = await refreshPOST();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ refreshed: false, skipped: false, error: true });
  });
});
