/**
 * Tests for lib/mystats/refresh.ts — the on-demand incremental-refresh
 * orchestration behind POST /api/mystats/refresh (v0.49.3). Covers the pure
 * `shouldRunIncremental` cooldown decision plus `runMyStatsRefresh`'s four
 * response-shape branches (accountUnresolved / cooldown-skipped / refreshed
 * / fail-soft error). account.ts + ingest.ts are mocked — no network/DB.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGetMyAccount = vi.fn();
// getActiveAccount is the post-migration-0020 name (getMyAccount survives as an
// alias); both are provided so this mock matches the real module's surface.
vi.mock("@/lib/mystats/account", () => ({
  getActiveAccount: (...args: unknown[]) => mockGetMyAccount(...args),
  getMyAccount: (...args: unknown[]) => mockGetMyAccount(...args),
}));

const mockRunMyStatsIngest = vi.fn();
vi.mock("@/lib/mystats/ingest", () => ({ runMyStatsIngest: (...args: unknown[]) => mockRunMyStatsIngest(...args) }));

import { runMyStatsRefresh, shouldRunIncremental, REFRESH_COOLDOWN_MS } from "@/lib/mystats/refresh";

const ACCOUNT = {
  id: 1,
  puuid: "my-puuid",
  riotId: "MunsterHunter#EUW",
  gameName: "MunsterHunter",
  tagLine: "EUW",
  region: "EUW",
  routing: { platform: "euw1", regional: "europe" },
};

describe("shouldRunIncremental", () => {
  it("true when never run before (lastAt null)", () => {
    expect(shouldRunIncremental(null, new Date(), REFRESH_COOLDOWN_MS)).toBe(true);
  });

  it("false when within the cooldown window", () => {
    const now = new Date("2026-07-24T12:03:00.000Z");
    const lastAt = new Date("2026-07-24T12:01:00.000Z"); // 2 min ago, cooldown is 3 min
    expect(shouldRunIncremental(lastAt, now, REFRESH_COOLDOWN_MS)).toBe(false);
  });

  it("true once the cooldown has fully elapsed", () => {
    const now = new Date("2026-07-24T12:03:00.000Z");
    const lastAt = new Date("2026-07-24T12:00:00.000Z"); // exactly 3 min ago
    expect(shouldRunIncremental(lastAt, now, REFRESH_COOLDOWN_MS)).toBe(true);
  });
});

describe("runMyStatsRefresh", () => {
  let mockSql: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockGetMyAccount.mockReset();
    mockRunMyStatsIngest.mockReset();
    mockSql = vi.fn();
  });

  it("accountUnresolved short-circuits before any cooldown check or ingest call", async () => {
    mockGetMyAccount.mockResolvedValueOnce(null);
    const result = await runMyStatsRefresh(mockSql as never);
    expect(result).toEqual({ accountUnresolved: true });
    expect(mockRunMyStatsIngest).not.toHaveBeenCalled();
    // Only the account lookup ran -- no last_incremental_at query attempted.
    expect(mockSql).not.toHaveBeenCalled();
  });

  it("skips with reason:cooldown when called again inside the window, never calling Riot", async () => {
    mockGetMyAccount.mockResolvedValueOnce(ACCOUNT);
    const recentlyRun = new Date(Date.now() - 60_000).toISOString(); // 1 min ago, cooldown is 3 min
    mockSql.mockResolvedValueOnce([{ last_incremental_at: recentlyRun }]);
    const result = await runMyStatsRefresh(mockSql as never);
    expect(result).toEqual({ refreshed: false, skipped: true, reason: "cooldown" });
    expect(mockRunMyStatsIngest).not.toHaveBeenCalled();
  });

  it("runs incremental ingest once the cooldown has elapsed, stamps the timestamp, returns newGames+latest", async () => {
    mockGetMyAccount.mockResolvedValueOnce(ACCOUNT);
    const staleRun = new Date(Date.now() - 10 * 60_000).toISOString(); // 10 min ago
    mockSql
      .mockResolvedValueOnce([{ last_incremental_at: staleRun }]) // getLastIncrementalAt
      .mockResolvedValueOnce([]) // stampLastIncrementalAt (INSERT ... ON CONFLICT, ignored return)
      .mockResolvedValueOnce([{ latest: "2026-07-24T11:00:00.000Z" }]); // latest game_creation query
    mockRunMyStatsIngest.mockResolvedValueOnce({
      accountUnresolved: false,
      matchesSeen: 5,
      matchesUpserted: 2,
      nextStart: null,
      historyComplete: true,
      truncatedBy: null,
      pagesWalked: 1,
      errors: [],
    });

    const result = await runMyStatsRefresh(mockSql as never);
    expect(mockRunMyStatsIngest).toHaveBeenCalledWith({ mode: "incremental" });
    expect(result).toEqual({
      refreshed: true,
      skipped: false,
      newGames: 2,
      latest: "2026-07-24T11:00:00.000Z",
      historyComplete: true,
      truncatedBy: null,
    });
  });

  it("passes an INCOMPLETE sync straight through -- a truncated walk must not reach the client as a finished one", async () => {
    // The plumbing test for the 2026-07-30 fix. `toEqual` treats a missing key and
    // an `undefined` one as equal, so a dropped field here would pass silently in
    // the tests above -- which is exactly how a truncation would become invisible
    // again one layer up.
    mockGetMyAccount.mockResolvedValueOnce(ACCOUNT);
    mockSql
      .mockResolvedValueOnce([{ last_incremental_at: new Date(Date.now() - 10 * 60_000).toISOString() }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ latest: "2026-07-29T19:14:32.349Z" }]);
    mockRunMyStatsIngest.mockResolvedValueOnce({
      accountUnresolved: false,
      matchesSeen: 100,
      matchesUpserted: 29,
      nextStart: null,
      historyComplete: false,
      truncatedBy: "per-run Riot call budget spent (30 calls)",
      pagesWalked: 1,
      errors: [],
    });

    const result = await runMyStatsRefresh(mockSql as never);
    expect(result).toEqual({
      refreshed: true,
      skipped: false,
      newGames: 29,
      latest: "2026-07-29T19:14:32.349Z",
      historyComplete: false,
      truncatedBy: "per-run Riot call budget spent (30 calls)",
    });
  });

  it("never run before (lastAt null) still runs and reports newGames:0/latest:null when nothing new", async () => {
    mockGetMyAccount.mockResolvedValueOnce(ACCOUNT);
    mockSql
      .mockResolvedValueOnce([]) // no cursor row at all yet
      .mockResolvedValueOnce([]) // stamp
      .mockResolvedValueOnce([{ latest: null }]); // no matches ever ingested
    mockRunMyStatsIngest.mockResolvedValueOnce({
      accountUnresolved: false,
      matchesSeen: 0,
      matchesUpserted: 0,
      nextStart: null,
      historyComplete: true,
      truncatedBy: null,
      pagesWalked: 1,
      errors: [],
    });

    const result = await runMyStatsRefresh(mockSql as never);
    expect(result).toEqual({
      refreshed: true,
      skipped: false,
      newGames: 0,
      latest: null,
      historyComplete: true,
      truncatedBy: null,
    });
  });

  it("fail-soft: a thrown error from the ingest call never propagates, returns error:true", async () => {
    mockGetMyAccount.mockResolvedValueOnce(ACCOUNT);
    const staleRun = new Date(Date.now() - 10 * 60_000).toISOString();
    mockSql.mockResolvedValueOnce([{ last_incremental_at: staleRun }]);
    mockRunMyStatsIngest.mockRejectedValueOnce(new Error("riot 503"));

    const result = await runMyStatsRefresh(mockSql as never);
    expect(result).toEqual({ refreshed: false, skipped: false, error: true });
  });

  it("ingest reporting accountUnresolved mid-call surfaces the same accountUnresolved shape", async () => {
    mockGetMyAccount.mockResolvedValueOnce(ACCOUNT);
    const staleRun = new Date(Date.now() - 10 * 60_000).toISOString();
    mockSql.mockResolvedValueOnce([{ last_incremental_at: staleRun }]);
    mockRunMyStatsIngest.mockResolvedValueOnce({
      accountUnresolved: true,
      matchesSeen: 0,
      matchesUpserted: 0,
      nextStart: null,
      errors: [],
    });

    const result = await runMyStatsRefresh(mockSql as never);
    expect(result).toEqual({ accountUnresolved: true });
  });
});
