/**
 * The /api/mystats/summary CONTRACT test — pins the exact response shape
 * fronty builds against (HANDOFF-engy.md §1).
 *
 * Separate from mystats-routes.test.ts, which owns param validation and
 * cache discipline. This file owns SHAPE: a field silently renamed or dropped
 * here renders nothing on the page while every other test in the repo still
 * passes, which is the specific failure this repo has banked before.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockReadHistoryComplete = vi.fn(async () => true);
vi.mock("@/lib/mystats/ingest", () => ({
  runMyStatsIngest: vi.fn(),
  readHistoryComplete: (...args: unknown[]) => mockReadHistoryComplete(...(args as [])),
}));

const mockSql = vi.fn();
vi.mock("@/lib/pro/db", () => ({ getSql: vi.fn(() => mockSql) }));

const mockGetMyAccount = vi.fn();
const mockListAccounts = vi.fn(async () => []);
vi.mock("@/lib/mystats/account", () => ({
  getActiveAccount: (...args: unknown[]) => mockGetMyAccount(...args),
  getMyAccount: (...args: unknown[]) => mockGetMyAccount(...args),
  listAccounts: (...args: unknown[]) => mockListAccounts(...(args as [])),
}));

// The rank refresh spends Riot calls; stubbed to a no-op so this file tests
// SHAPE, not network behaviour (lib/__tests__/mystats-rank.test.ts owns that).
const mockRefreshStaleRanks = vi.fn(async () => 0);
vi.mock("@/lib/mystats/rank", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, refreshStaleRanks: (...a: unknown[]) => mockRefreshStaleRanks(...(a as [])) };
});

// The summary route now resolves the populated patch (2026-07-31 audit P2,
// #4 — "waiting for patch data" vs "build not recorded") to classify a null
// on_wpa_build honestly. Mocked here so this SHAPE-focused file never makes a
// real network call; the exact label doesn't matter to any assertion below.
vi.mock("@/lib/staticData", () => ({
  getLatestPatch: vi.fn(async () => ({ major: 16, patch: 13, patchAdditions: 0, label: "16.13" })),
}));

import { GET as summaryGET } from "@/app/api/mystats/summary/route";

function req(url: string) {
  return { url, headers: { get: () => null } } as unknown as Parameters<typeof summaryGET>[0];
}

const RANK_KEYS = ["tier", "division", "lp", "rankWins", "rankLosses", "rankUnknown", "rankCheckedAt"];

/** One my_matches row as the route's SELECTs return it. */
const row = (over: Record<string, unknown> = {}) => ({
  champion_id: 1,
  role: 2,
  opp_champion_id: null,
  win: true,
  game_creation: "2026-07-01T00:00:00.000Z",
  cs: 240,
  game_duration_sec: 1800,
  kills: 3,
  deaths: 1,
  assists: 5,
  on_wpa_build: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  mockReadHistoryComplete.mockResolvedValue(true);
  mockListAccounts.mockResolvedValue([]);
});

describe("records / championPool are ONE array under two names", () => {
  it("emits both, deep-equal, with the CS fields on each entry", async () => {
    mockGetMyAccount.mockResolvedValue({ id: 1, puuid: "p", riotId: "X#EUW", region: "EUW", routing: {} });
    mockSql.mockImplementation(() => Promise.resolve([row(), row({ cs: 100, game_duration_sec: 1200 })]));

    const body = await (await summaryGET(req("http://localhost/api/mystats/summary"))).json();

    expect(body.championPool).toEqual(body.records);
    expect(body.records).toHaveLength(1);
    // 340 CS over 50 minutes = 6.8/min, time-weighted across a 30- and a
    // 20-minute game. Mean-of-rates would be (8.0 + 5.0)/2 = 6.5.
    expect(body.records[0]).toMatchObject({ championId: 1, games: 2, csPerMin: 6.8, csGames: 2 });
    expect(body.records[0].csPerMin).not.toBe(6.5);
  });

  it("both names survive an empty result", async () => {
    mockGetMyAccount.mockResolvedValue({ id: 1, puuid: "p", riotId: "X#EUW", region: "EUW", routing: {} });
    mockSql.mockImplementation(() => Promise.resolve([]));
    const body = await (await summaryGET(req("http://localhost/api/mystats/summary"))).json();
    expect(body.records).toEqual([]);
    expect(body.championPool).toEqual([]);
  });
});

describe("CS headline", () => {
  it("ships csPerMin + csGames at the top level", async () => {
    mockGetMyAccount.mockResolvedValue({ id: 1, puuid: "p", riotId: "X#EUW", region: "EUW", routing: {} });
    mockSql.mockImplementation(() => Promise.resolve([row(), row({ champion_id: 7, cs: 100, game_duration_sec: 1200 })]));
    const body = await (await summaryGET(req("http://localhost/api/mystats/summary"))).json();
    expect(body.csPerMin).toBe(6.8); // 340 / 50 min, across TWO different champions
    expect(body.csGames).toBe(2);
  });

  it("is null-with-zero-games, never 0.0, when nothing is measured", async () => {
    mockGetMyAccount.mockResolvedValue({ id: 1, puuid: "p", riotId: "X#EUW", region: "EUW", routing: {} });
    mockSql.mockImplementation(() => Promise.resolve([row({ cs: null, game_duration_sec: null })]));
    const body = await (await summaryGET(req("http://localhost/api/mystats/summary"))).json();
    expect(body.csPerMin).toBeNull();
    expect(body.csGames).toBe(0);
    expect(body.records[0].csPerMin).toBeNull();
  });
});

describe("recentGames CS fields", () => {
  it("carries cs, gameDurationSec and csPerMin", async () => {
    mockGetMyAccount.mockResolvedValue({ id: 1, puuid: "p", riotId: "X#EUW", region: "EUW", routing: {} });
    mockSql.mockImplementation(() => Promise.resolve([row()]));
    const body = await (await summaryGET(req("http://localhost/api/mystats/summary"))).json();
    expect(body.recentGames[0]).toMatchObject({ cs: 240, gameDurationSec: 1800, csPerMin: 8.0 });
  });

  it("withholds the RATE on a remake but keeps the raw values", async () => {
    mockGetMyAccount.mockResolvedValue({ id: 1, puuid: "p", riotId: "X#EUW", region: "EUW", routing: {} });
    mockSql.mockImplementation(() => Promise.resolve([row({ cs: 12, game_duration_sec: 221 })]));
    const body = await (await summaryGET(req("http://localhost/api/mystats/summary"))).json();
    expect(body.recentGames[0]).toMatchObject({ cs: 12, gameDurationSec: 221, csPerMin: null });
  });
});

describe("rank fields", () => {
  it("mirrors the ACTIVE account's rank to the top level", async () => {
    mockGetMyAccount.mockResolvedValue({ id: 1, puuid: "p", riotId: "X#EUW", region: "EUW", routing: {} });
    mockSql.mockImplementation(() => Promise.resolve([row()]));
    mockListAccounts.mockResolvedValue([
      {
        id: 1, riotId: "X#EUW", gameName: "X", tagLine: "EUW", region: "EUW", active: true,
        lastSeenAt: null, games: 3, tier: "PLATINUM", division: "IV", lp: 89,
        rankWins: 65, rankLosses: 66, rankUnknown: false, rankCheckedAt: "2026-07-30T12:00:00.000Z",
      },
      {
        id: 6, riotId: "Y#swift", gameName: "Y", tagLine: "swift", region: "EUW", active: false,
        lastSeenAt: null, games: 1, tier: null, division: null, lp: null,
        rankWins: null, rankLosses: null, rankUnknown: true, rankCheckedAt: null,
      },
    ] as never);

    const body = await (await summaryGET(req("http://localhost/api/mystats/summary"))).json();
    expect(body).toMatchObject({
      tier: "PLATINUM", division: "IV", lp: 89, rankWins: 65, rankLosses: 66, rankUnknown: false,
    });
    // The inactive account keeps its OWN (unknown) rank -- the top-level mirror
    // must not overwrite or leak into the array.
    expect(body.accounts[1]).toMatchObject({ tier: null, rankUnknown: true });
  });

  it("every rank key is present on the accountUnresolved response too", async () => {
    // A consumer must not have to branch on which response shape it got.
    mockGetMyAccount.mockResolvedValue(null);
    const body = await (await summaryGET(req("http://localhost/api/mystats/summary"))).json();
    expect(body.accountUnresolved).toBe(true);
    for (const k of RANK_KEYS) expect(body).toHaveProperty(k);
    expect(body.rankUnknown).toBe(true);
    expect(body.tier).toBeNull();
    expect(body.csPerMin).toBeNull();
    expect(body.csGames).toBe(0);
    expect(body.championPool).toEqual([]);
  });

  it("does NOT invent any of the fields the brief forbade", async () => {
    mockGetMyAccount.mockResolvedValue({ id: 1, puuid: "p", riotId: "X#EUW", region: "EUW", routing: {} });
    mockSql.mockImplementation(() => Promise.resolve([row()]));
    const body = await (await summaryGET(req("http://localhost/api/mystats/summary"))).json();
    // Avg Score / MVP / ACE / placement / Avg Game ELO are not derivable from
    // data we hold. Pinned so a later pass cannot quietly add a plausible
    // composite -- see HANDOFF-engy.md §4.
    for (const forbidden of ["avgScore", "score", "mvp", "ace", "placement", "avgGameElo", "elo"]) {
      expect(body).not.toHaveProperty(forbidden);
      expect(body.records[0]).not.toHaveProperty(forbidden);
      expect(body.recentGames[0]).not.toHaveProperty(forbidden);
    }
  });
});

describe("existing fields are unchanged (additive-only)", () => {
  it("keeps every pre-existing top-level key", async () => {
    mockGetMyAccount.mockResolvedValue({ id: 1, puuid: "p", riotId: "X#EUW", region: "EUW", routing: {} });
    mockSql.mockImplementation(() => Promise.resolve([row()]));
    const body = await (await summaryGET(req("http://localhost/api/mystats/summary"))).json();
    for (const k of [
      "accountUnresolved", "season", "riotId", "accountId", "accounts", "historyComplete",
      "records", "matchup", "buildAdherencePct", "winrateOnBuild", "winrateOffBuild",
      "nOnBuild", "nOffBuild", "priorSplitWinrate", "recentGames",
    ]) {
      expect(body).toHaveProperty(k);
    }
    // and the champion-pool entry's original fields still mean what they did
    expect(body.records[0]).toMatchObject({ championId: 1, role: 2, games: 1, wins: 1, winrate: 1 });
    expect(body.records[0].lastPlayed).toBe("2026-07-01T00:00:00.000Z");
  });
});
