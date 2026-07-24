/**
 * Tests for lib/mystats/ingest.ts's persisted BACKFILL cursor (mirrors
 * lib/draft/ingest.ts's getPersistedCursor/setPersistedCursor pattern —
 * see draft-ingest.test.ts for the analogous coverage on that file) and the
 * incremental-mode "always start=0" contract. sql + riot client + account
 * resolution are all mocked — no network/DB.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSql = vi.fn();
vi.mock("@/lib/pro/db", () => ({ getSql: vi.fn(() => mockSql) }));

const mockGetMatchIdsByPuuid = vi.fn();
const mockGetMatch = vi.fn();
vi.mock("@/lib/pro/riot", async () => {
  const actual = await vi.importActual<typeof import("@/lib/pro/riot")>("@/lib/pro/riot");
  return {
    ...actual,
    getMatchIdsByPuuid: (...args: unknown[]) => mockGetMatchIdsByPuuid(...args),
    getMatch: (...args: unknown[]) => mockGetMatch(...args),
  };
});

const mockEnsureMyAccount = vi.fn();
vi.mock("@/lib/mystats/account", () => ({ ensureMyAccount: (...args: unknown[]) => mockEnsureMyAccount(...args) }));

// v0.51 additions: ingest.ts now resolves a build-adherence recommendation
// (lib/recommend.ts) gated on the CURRENT live patch (lib/staticData.ts's
// getLatestPatch) -- mocked here so these tests never make a real network
// call. Every existing fixture below plays out on patch "16.13" or an
// explicitly pre-season/older patch, so defaulting getLatestPatch to "16.13"
// keeps every pre-existing assertion (none of which check on_wpa_build)
// unaffected -- see mystats-adherence.test.ts / lib/__tests__/patchMovers.test.ts
// for dedicated coverage of the adherence/recommend-resolution logic itself.
vi.mock("@/lib/staticData", () => ({
  getLatestPatch: vi.fn(async () => ({ major: 16, patch: 13, patchAdditions: 0, label: "16.13" })),
}));
vi.mock("@/lib/recommend", () => {
  class NotPlayedInRoleError extends Error {}
  return { buildRecommendations: vi.fn(async () => []), NotPlayedInRoleError };
});

import { getSql } from "@/lib/pro/db";
import { runMyStatsIngest, PAGE_SIZE } from "@/lib/mystats/ingest";
import { seasonStartEpochSec } from "@/lib/mystats/season";

const ACCOUNT = {
  puuid: "my-puuid",
  riotId: "MunsterHunter#EUW",
  region: "EUW",
  routing: { platform: "euw1", regional: "europe" },
};

function sqlText(strings: TemplateStringsArray): string {
  return strings.join("|");
}

describe("runMyStatsIngest", () => {
  beforeEach(() => {
    mockSql.mockReset();
    mockGetMatchIdsByPuuid.mockReset();
    mockGetMatch.mockReset();
    mockEnsureMyAccount.mockReset();
    vi.mocked(getSql).mockReturnValue(mockSql as never);
    process.env.RIOT_API_KEY = "test-key";
    process.env.DATABASE_URL = "postgres://test";
  });

  it("accountUnresolved short-circuits before any Riot call", async () => {
    mockEnsureMyAccount.mockResolvedValueOnce(null);
    const result = await runMyStatsIngest({ mode: "incremental" });
    expect(result.accountUnresolved).toBe(true);
    expect(mockGetMatchIdsByPuuid).not.toHaveBeenCalled();
  });

  it("incremental mode always fetches start=0, never touches the persisted cursor table", async () => {
    mockEnsureMyAccount.mockResolvedValueOnce(ACCOUNT);
    mockGetMatchIdsByPuuid.mockResolvedValueOnce(["M1", "M2"]);
    mockSql.mockImplementation((strings: TemplateStringsArray) => {
      const text = sqlText(strings);
      if (text.includes("FROM coachbuild.my_matches WHERE match_id")) return Promise.resolve([{ match_id: "M1" }]); // M1 already known
      return Promise.resolve([]);
    });
    mockGetMatch.mockResolvedValueOnce({
      metadata: { matchId: "M2" },
      info: {
        gameCreation: Date.UTC(2026, 1, 1), // in-season (2026-02-01)
        gameVersion: "16.13.1.1",
        queueId: 420,
        participants: [{ puuid: "my-puuid", teamId: 100, championId: 1, teamPosition: "TOP", win: true }],
      },
    });

    const result = await runMyStatsIngest({ mode: "incremental" });

    expect(mockGetMatchIdsByPuuid).toHaveBeenCalledWith("europe", "my-puuid", {
      start: 0,
      count: expect.any(Number),
      startTime: seasonStartEpochSec(),
    });
    expect(result.matchesSeen).toBe(2);
    expect(result.matchesUpserted).toBe(1); // M1 skipped (already known), M2 new
    expect(result.nextStart).toBeNull();
    const cursorWrite = mockSql.mock.calls.find(([s]) => sqlText(s as TemplateStringsArray).includes("my_ingest_cursor"));
    expect(cursorWrite).toBeUndefined();
  });

  it("backfill mode reads the persisted cursor when no explicit start is given", async () => {
    mockEnsureMyAccount.mockResolvedValueOnce(ACCOUNT);
    mockSql.mockImplementation((strings: TemplateStringsArray) => {
      const text = sqlText(strings);
      if (text.includes("SELECT next_start, backfill_done")) {
        return Promise.resolve([{ next_start: 200, backfill_done: false }]);
      }
      if (text.includes("FROM coachbuild.my_matches WHERE match_id")) return Promise.resolve([]);
      return Promise.resolve([]);
    });
    mockGetMatchIdsByPuuid.mockResolvedValueOnce([]); // empty page -> exhausted history

    await runMyStatsIngest({ mode: "backfill" });

    expect(mockGetMatchIdsByPuuid).toHaveBeenCalledWith("europe", "my-puuid", {
      start: 200,
      count: PAGE_SIZE,
      startTime: seasonStartEpochSec(),
    });
  });

  it("an explicit start overrides the persisted cursor AND is never persisted back", async () => {
    mockEnsureMyAccount.mockResolvedValueOnce(ACCOUNT);
    let cursorTableTouched = false;
    mockSql.mockImplementation((strings: TemplateStringsArray) => {
      const text = sqlText(strings);
      if (text.includes("my_ingest_cursor")) cursorTableTouched = true;
      if (text.includes("FROM coachbuild.my_matches WHERE match_id")) return Promise.resolve([]);
      return Promise.resolve([]);
    });
    mockGetMatchIdsByPuuid.mockResolvedValueOnce([]); // empty page -> exhausted

    const result = await runMyStatsIngest({ mode: "backfill", start: 999 });

    expect(mockGetMatchIdsByPuuid).toHaveBeenCalledWith("europe", "my-puuid", {
      start: 999,
      count: PAGE_SIZE,
      startTime: seasonStartEpochSec(),
    });
    expect(cursorTableTouched).toBe(false); // manual/debug driving never reads OR writes persisted state
    expect(result.nextStart).toBeNull();
  });

  it("a short page (fewer than pageSize) ends the backfill walk and persists next_start=0, backfill_done=true", async () => {
    mockEnsureMyAccount.mockResolvedValueOnce(ACCOUNT);
    let persisted: { next_start: number; backfill_done: boolean } | null = null;
    mockSql.mockImplementation((strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = sqlText(strings);
      if (text.includes("SELECT next_start, backfill_done")) return Promise.resolve([{ next_start: 0, backfill_done: false }]);
      if (text.includes("INSERT INTO coachbuild.my_ingest_cursor")) {
        persisted = { next_start: values[0] as number, backfill_done: values[1] as boolean };
        return Promise.resolve([]);
      }
      if (text.includes("FROM coachbuild.my_matches WHERE match_id")) return Promise.resolve([]);
      return Promise.resolve([]);
    });
    mockGetMatchIdsByPuuid.mockResolvedValueOnce(["M1", "M2"]); // short page (< pageSize)
    mockGetMatch.mockResolvedValue({
      metadata: { matchId: "X" },
      info: {
        gameCreation: Date.UTC(2026, 1, 1),
        gameVersion: "16.13.1.1",
        queueId: 420,
        participants: [{ puuid: "my-puuid", teamId: 100, championId: 1, teamPosition: "TOP", win: true }],
      },
    });

    const result = await runMyStatsIngest({ mode: "backfill", pageSize: 50 });

    expect(result.nextStart).toBeNull();
    expect(persisted).toEqual({ next_start: 0, backfill_done: true });
  });

  it("hitting BACKFILL_CAP ends the walk even if more history remains (full pages every time)", async () => {
    mockEnsureMyAccount.mockResolvedValueOnce(ACCOUNT);
    mockSql.mockImplementation((strings: TemplateStringsArray) => {
      const text = sqlText(strings);
      if (text.includes("SELECT next_start, backfill_done")) return Promise.resolve([{ next_start: 0, backfill_done: false }]);
      if (text.includes("FROM coachbuild.my_matches WHERE match_id")) return Promise.resolve([]);
      return Promise.resolve([]);
    });
    // Every page comes back FULL (100 ids) -- would never naturally stop.
    mockGetMatchIdsByPuuid.mockImplementation((_r: string, _p: string, opts: { count: number }) =>
      Promise.resolve(Array.from({ length: opts.count }, (_, i) => `M${i}`))
    );
    mockGetMatch.mockResolvedValue({
      metadata: { matchId: "X" },
      info: {
        gameCreation: Date.UTC(2026, 1, 1),
        gameVersion: "16.13.1.1",
        queueId: 420,
        participants: [{ puuid: "my-puuid", teamId: 100, championId: 1, teamPosition: "TOP", win: true }],
      },
    });

    const result = await runMyStatsIngest({ mode: "backfill" });

    expect(result.matchesSeen).toBe(400); // BACKFILL_CAP
    expect(result.nextStart).toBeNull();
  });

  it("does nothing (fast no-op) when backfill_done is already true and no explicit start is given", async () => {
    mockEnsureMyAccount.mockResolvedValueOnce(ACCOUNT);
    mockSql.mockImplementation((strings: TemplateStringsArray) => {
      const text = sqlText(strings);
      if (text.includes("SELECT next_start, backfill_done")) return Promise.resolve([{ next_start: 0, backfill_done: true }]);
      return Promise.resolve([]);
    });

    const result = await runMyStatsIngest({ mode: "backfill" });

    expect(mockGetMatchIdsByPuuid).not.toHaveBeenCalled();
    expect(result.matchesSeen).toBe(0);
    expect(result.nextStart).toBeNull();
  });

  it("a match already in coachbuild.my_matches is never re-fetched from Riot (ON CONFLICT idempotency at the id-check level)", async () => {
    mockEnsureMyAccount.mockResolvedValueOnce(ACCOUNT);
    mockSql.mockImplementation((strings: TemplateStringsArray) => {
      const text = sqlText(strings);
      if (text.includes("FROM coachbuild.my_matches WHERE match_id")) return Promise.resolve([{ match_id: "M1" }, { match_id: "M2" }]);
      return Promise.resolve([]);
    });
    mockGetMatchIdsByPuuid.mockResolvedValueOnce(["M1", "M2"]);

    const result = await runMyStatsIngest({ mode: "incremental" });

    expect(mockGetMatch).not.toHaveBeenCalled();
    expect(result.matchesUpserted).toBe(0);
    expect(result.matchesSeen).toBe(2);
  });

  describe("season row-level guard (belt-and-braces, 2026-07-21)", () => {
    it("a pre-season match that slips through the startTime list filter is fetched but NEVER inserted", async () => {
      mockEnsureMyAccount.mockResolvedValueOnce(ACCOUNT);
      let insertCalled = false;
      mockSql.mockImplementation((strings: TemplateStringsArray) => {
        const text = sqlText(strings);
        if (text.includes("FROM coachbuild.my_matches WHERE match_id")) return Promise.resolve([]);
        if (text.includes("INSERT INTO coachbuild.my_matches")) {
          insertCalled = true;
          return Promise.resolve([]);
        }
        return Promise.resolve([]);
      });
      mockGetMatchIdsByPuuid.mockResolvedValueOnce(["PRESEASON1"]);
      mockGetMatch.mockResolvedValueOnce({
        metadata: { matchId: "PRESEASON1" },
        info: {
          gameCreation: Date.UTC(2025, 11, 1), // 2025-12-01 -- before the season boundary
          gameVersion: "15.24.1.1",
          queueId: 420,
          participants: [{ puuid: "my-puuid", teamId: 100, championId: 1, teamPosition: "TOP", win: true }],
        },
      });

      const result = await runMyStatsIngest({ mode: "incremental" });

      expect(insertCalled).toBe(false);
      expect(result.matchesUpserted).toBe(0);
      expect(result.matchesSeen).toBe(1); // still counted as "seen" -- only the insert is skipped
    });

    it("an in-season match (just after the boundary) IS inserted", async () => {
      mockEnsureMyAccount.mockResolvedValueOnce(ACCOUNT);
      let insertCalled = false;
      mockSql.mockImplementation((strings: TemplateStringsArray) => {
        const text = sqlText(strings);
        if (text.includes("FROM coachbuild.my_matches WHERE match_id")) return Promise.resolve([]);
        if (text.includes("INSERT INTO coachbuild.my_matches")) {
          insertCalled = true;
          return Promise.resolve([]);
        }
        return Promise.resolve([]);
      });
      mockGetMatchIdsByPuuid.mockResolvedValueOnce(["INSEASON1"]);
      mockGetMatch.mockResolvedValueOnce({
        metadata: { matchId: "INSEASON1" },
        info: {
          gameCreation: Date.UTC(2026, 0, 8, 0, 0, 1), // 1s after the season boundary
          gameVersion: "16.1.1.1",
          queueId: 420,
          participants: [{ puuid: "my-puuid", teamId: 100, championId: 1, teamPosition: "TOP", win: true }],
        },
      });

      const result = await runMyStatsIngest({ mode: "incremental" });

      expect(insertCalled).toBe(true);
      expect(result.matchesUpserted).toBe(1);
    });
  });
});
