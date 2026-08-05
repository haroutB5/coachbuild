/**
 * Route tests: param validation, CRON_SECRET auth (ingest route), and
 * no-store cache discipline (per-user private data — see CLAUDE.md gotcha
 * (b) and each route's own doc comment). Engine functions mocked.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockRunMyStatsIngest = vi.fn();
// `readHistoryComplete` (2026-07-30) is the summary route's read of
// my_ingest_cursor.backfill_done -- whether the numbers it is about to serve sit
// on a whole season or a partial one. Defaults to true here so every
// pre-existing assertion below is untouched; the false case has its own coverage.
const mockReadHistoryComplete = vi.fn(async () => true);
vi.mock("@/lib/mystats/ingest", () => ({
  runMyStatsIngest: (...args: unknown[]) => mockRunMyStatsIngest(...args),
  readHistoryComplete: (...args: unknown[]) => mockReadHistoryComplete(...(args as [])),
}));

const mockSql = vi.fn();
vi.mock("@/lib/pro/db", () => ({ getSql: vi.fn(() => mockSql) }));

const mockGetMyAccount = vi.fn();
const mockListAccounts = vi.fn(async () => []);
// Post-migration-0020 surface. `listAccounts` is mocked (rather than left to
// hit mockSql) because the summary route now ships the picker's account list on
// its own response, and these tests are about scoping/validation -- the list
// itself has its own coverage in mystats-accounts.test.ts.
vi.mock("@/lib/mystats/account", () => ({
  getActiveAccount: (...args: unknown[]) => mockGetMyAccount(...args),
  getMyAccount: (...args: unknown[]) => mockGetMyAccount(...args),
  listAccounts: (...args: unknown[]) => mockListAccounts(...(args as [])),
}));

const mockRunMyStatsRefresh = vi.fn();
vi.mock("@/lib/mystats/refresh", () => ({ runMyStatsRefresh: (...args: unknown[]) => mockRunMyStatsRefresh(...args) }));

// The summary route now resolves the populated patch (2026-07-31 audit P2,
// #4 — "waiting for patch data" vs "build not recorded") to classify a null
// on_wpa_build honestly. Mocked here so these tests never make a real
// network call — same reason lib/__tests__/mystats-ingest.test.ts mocks this
// module. The exact label is irrelevant to every test in this file (none of
// them assert on patchDataPending); a stable value just keeps the route from
// reaching the network.
vi.mock("@/lib/staticData", () => ({
  getLatestPatch: vi.fn(async () => ({ major: 16, patch: 13, patchAdditions: 0, label: "16.13" })),
}));

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

  it("accountUnresolved response includes nOnBuild/nOffBuild as null (v0.74), not omitted", async () => {
    mockGetMyAccount.mockResolvedValueOnce(null);
    const res = await summaryGET(req("http://localhost/api/mystats/summary"));
    const body = await res.json();
    expect(body.nOnBuild).toBeNull();
    expect(body.nOffBuild).toBeNull();
  });

  it("v0.74: nOnBuild/nOffBuild are the real row counts behind winrateOnBuild/winrateOffBuild, distinct from buildAdherencePct's resolved-row-% denominator", async () => {
    mockGetMyAccount.mockResolvedValueOnce({ puuid: "p", riotId: "X#EUW", region: "EUW", routing: {} });
    // The route issues separate SQL calls for records, adherence rows, and the recent window --
    // key the mock off the query text so each returns its own fixture.
    mockSql.mockImplementation((strings: TemplateStringsArray) => {
      const sqlText = strings.join("");
      if (sqlText.includes("wpa_recommendation_patch")) {
        // 22 on-build rows, 14 off-build rows, 1 unresolved -- mirrors the
        // aggregate-layer fixture in mystats-aggregate.test.ts.
        const rows = [
          ...Array.from({ length: 22 }, (_, i) => ({
            on_wpa_build: true, win: i % 3 !== 0, patch: "16.15", wpa_recommendation_patch: "16.15",
          })),
          ...Array.from({ length: 14 }, (_, i) => ({
            on_wpa_build: false, win: i % 2 === 0, patch: "16.15", wpa_recommendation_patch: "16.15",
          })),
          { on_wpa_build: null, win: true, patch: "16.15", wpa_recommendation_patch: null },
        ];
        return Promise.resolve(rows);
      }
      return Promise.resolve([]);
    });
    const res = await summaryGET(req("http://localhost/api/mystats/summary"));
    const body = await res.json();
    expect(body.nOnBuild).toBe(22);
    expect(body.nOffBuild).toBe(14);
    expect(body.buildAdherencePct).toBeCloseTo((22 / 36) * 100, 1);
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
    mockGetMyAccount.mockResolvedValue({ id: 1, puuid: "p", riotId: "X#EUW", gameName: "X", tagLine: "EUW", region: "EUW", routing: {} });
    const GALIO = 3;
    const MID = 2;
    const TOP = 0;
    const allRows = [
      // Galio MID: 3 games, 3W-0L against 3 distinct opponents (matches the report's header: "3g · 3W-0L · 100.0%")
      { puuid: "p", champion_id: GALIO, role: MID, opp_champion_id: 9, win: true, game_creation: "2026-01-01T00:00:00.000Z" }, // vs Fiddlesticks
      { puuid: "p", champion_id: GALIO, role: MID, opp_champion_id: 35, win: true, game_creation: "2026-01-02T00:00:00.000Z" }, // vs Shaco
      { puuid: "p", champion_id: GALIO, role: MID, opp_champion_id: 84, win: true, game_creation: "2026-01-03T00:00:00.000Z" }, // vs Akali
      // Same champion, played TOP too -- different opponents, must never bleed into the Mid-scoped result
      { puuid: "p", champion_id: GALIO, role: TOP, opp_champion_id: 24, win: false, game_creation: "2026-01-04T00:00:00.000Z" },
      { puuid: "p", champion_id: GALIO, role: TOP, opp_champion_id: 82, win: true, game_creation: "2026-01-05T00:00:00.000Z" },
      // ── A SECOND ACCOUNT's Galio Mid games (migration 0020). Same champion,
      // same role, DIFFERENT player. If any of these ever appear in a result
      // below, the puuid filter has been dropped from that query and every
      // My Stats number has silently become two people added together. These
      // are deliberately wins-heavy so a leak would move the win rate too, not
      // just the game count.
      { puuid: "other", champion_id: GALIO, role: MID, opp_champion_id: 9, win: false, game_creation: "2026-02-01T00:00:00.000Z" },
      { puuid: "other", champion_id: GALIO, role: MID, opp_champion_id: 238, win: false, game_creation: "2026-02-02T00:00:00.000Z" },
      { puuid: "other", champion_id: GALIO, role: TOP, opp_champion_id: 24, win: false, game_creation: "2026-02-03T00:00:00.000Z" },
    ].map((r) => ({ ...r, queue_id: 420 })).concat([
      // ── 2026-07-30: MY OWN Galio Mid games in FLEX and normal draft. Same
      // account, same champion, same role, and they must not count toward the
      // Mid header or the champion-wide total either. The role bug and the
      // queue bug are the same shape (a scope the caller never asked to widen)
      // and this fixture now pins both at once.
      { puuid: "p", champion_id: GALIO, role: MID, opp_champion_id: 777, win: false, game_creation: "2026-03-01T00:00:00.000Z", queue_id: 440 },
      { puuid: "p", champion_id: GALIO, role: TOP, opp_champion_id: 888, win: false, game_creation: "2026-03-02T00:00:00.000Z", queue_id: 400 },
    ]);
    // Emulates the real WHERE clause: filters by puuid (migration 0020), by
    // queue (lib/mystats/queues.ts), by champion_id, and by role only when the
    // route actually passed one (mirroring Postgres's real behavior for the two
    // SQL branches in app/api/mystats/matchups/route.ts).
    //
    // Decoded BY TYPE, not by position. Positional decoding broke the moment the
    // queue array was bound ahead of championId — a test that reads its inputs
    // positionally fails on the next predicate added rather than on the bug it
    // was written to catch.
    mockSql.mockImplementation((_strings: TemplateStringsArray, ...values: unknown[]) => {
      const puuid = values.find((v) => typeof v === "string") as string;
      const queues = values.find((v) => Array.isArray(v)) as number[] | undefined;
      const [championId, role] = values.filter((v) => typeof v === "number") as number[];
      const filtered = allRows.filter(
        (r) =>
          r.puuid === puuid &&
          (queues ? queues.includes(r.queue_id) : true) &&
          r.champion_id === championId &&
          (role === undefined || r.role === role)
      );
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
    // Critically it is 5, NOT 8: the champion-wide question widens the ROLE
    // filter and nothing else. The account filter is not a scope the caller can
    // widen at all.
    const wideRes = await matchupsGET(req(`http://localhost/api/mystats/matchups?championId=${GALIO}`));
    const wideBody = await wideRes.json();
    const wideTotalGames = wideBody.matchups.reduce((sum: number, m: { games: number }) => sum + m.games, 0);
    expect(wideTotalGames).toBe(5);
    expect(wideBody.role).toBeNull();
    // The other account's exclusive opponent (Neeko, 238) must appear nowhere.
    expect(wideBody.matchups.map((m: { oppChampionId: number }) => m.oppChampionId)).not.toContain(238);
    // Nor may my OWN flex/normal-draft opponents (777, 888) — widening the role
    // filter does not widen the queue filter.
    expect(wideBody.matchups.map((m: { oppChampionId: number }) => m.oppChampionId)).not.toContain(777);
    expect(wideBody.matchups.map((m: { oppChampionId: number }) => m.oppChampionId)).not.toContain(888);
    expect(wideBody.accountId).toBe(1);
    expect(wideBody.riotId).toBe("X#EUW");
  });

  // ── Migration 0020: the SAME champion+role played by TWO linked accounts.
  // The pre-migration table had no account column at all, so this is the case
  // that would have produced a confident, unlabelled merge of two players. The
  // test above proves the leak does not happen via the champion-wide widening;
  // this one proves the ACTIVE ACCOUNT is what selects between two candidate
  // datasets -- switch the account, get the other one, never the union. ──
  it("switching the active account switches the dataset, and never returns the union", async () => {
    const GALIO = 3;
    const MID = 2;
    const allRows = [
      { puuid: "p1", champion_id: GALIO, role: MID, opp_champion_id: 9, win: true, game_creation: "2026-01-01T00:00:00.000Z", queue_id: 420 },
      { puuid: "p1", champion_id: GALIO, role: MID, opp_champion_id: 35, win: true, game_creation: "2026-01-02T00:00:00.000Z", queue_id: 420 },
      { puuid: "p2", champion_id: GALIO, role: MID, opp_champion_id: 238, win: false, game_creation: "2026-02-01T00:00:00.000Z", queue_id: 420 },
    ];
    // Decoded by type, not by position — see the sibling test above.
    mockSql.mockImplementation((_s: TemplateStringsArray, ...values: unknown[]) => {
      const puuid = values.find((v) => typeof v === "string") as string;
      const queues = values.find((v) => Array.isArray(v)) as number[] | undefined;
      const [championId, role] = values.filter((v) => typeof v === "number") as number[];
      return Promise.resolve(
        allRows.filter(
          (r) =>
            r.puuid === puuid &&
            (queues ? queues.includes(r.queue_id) : true) &&
            r.champion_id === championId &&
            (role === undefined || r.role === role)
        )
      );
    });

    mockGetMyAccount.mockResolvedValue({ id: 1, puuid: "p1", riotId: "MunsterHunter#EUW", gameName: "MunsterHunter", tagLine: "EUW", region: "EUW", routing: {} });
    const first = await (await matchupsGET(req(`http://localhost/api/mystats/matchups?championId=${GALIO}&role=${MID}`))).json();
    expect(first.matchups.reduce((s: number, m: { games: number }) => s + m.games, 0)).toBe(2);
    expect(first.riotId).toBe("MunsterHunter#EUW");

    mockGetMyAccount.mockResolvedValue({ id: 2, puuid: "p2", riotId: "K1ayer#swift", gameName: "K1ayer", tagLine: "swift", region: "EUW", routing: {} });
    const second = await (await matchupsGET(req(`http://localhost/api/mystats/matchups?championId=${GALIO}&role=${MID}`))).json();
    // ONE game, not three. A union would read 3 and look entirely plausible.
    expect(second.matchups.reduce((s: number, m: { games: number }) => s + m.games, 0)).toBe(1);
    expect(second.matchups.map((m: { oppChampionId: number }) => m.oppChampionId)).toEqual([238]);
    expect(second.riotId).toBe("K1ayer#swift");
    expect(second.accountId).toBe(2);
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
