/**
 * Tests for lib/mystats/refresh.ts — the on-demand incremental-refresh
 * orchestration behind POST /api/mystats/refresh (v0.49.3). Covers
 * `runMyStatsRefresh`'s four
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

import { runMyStatsRefresh } from "@/lib/mystats/refresh";
import { COUNTED_QUEUE_IDS } from "@/lib/mystats/queues";

const ACCOUNT = {
  id: 1,
  puuid: "my-puuid",
  riotId: "MunsterHunter#EUW",
  gameName: "MunsterHunter",
  tagLine: "EUW",
  region: "EUW",
  routing: { platform: "euw1", regional: "europe" },
};

function expectOwnLeaseRelease(mockSql: ReturnType<typeof vi.fn>) {
  expect(mockSql).toHaveBeenCalledTimes(2);
  const releaseCall = mockSql.mock.calls[1] as unknown[];
  const releaseSql = (releaseCall[0] as readonly string[]).join(" ");
  expect(releaseSql).toContain("UPDATE coachbuild.my_ingest_cursor");
  expect(releaseSql).toContain("SET last_incremental_at = NULL");
  expect(releaseSql).toContain("WHERE puuid =");
  expect(releaseSql).toContain("AND last_incremental_at =");
  const releaseValues = releaseCall.slice(1);
  expect(releaseValues).toHaveLength(2);
  expect(releaseValues[0]).toBe(ACCOUNT.puuid);
  expect(releaseValues[1]).toEqual(expect.stringMatching(/Z$/));
}

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

  it("fail-softs an account lookup failure instead of rejecting the refresh request", async () => {
    mockGetMyAccount.mockRejectedValueOnce(new Error("database unavailable"));
    const result = await runMyStatsRefresh(mockSql as never);
    expect(result).toEqual({ refreshed: false, skipped: false, error: true });
    expect(mockRunMyStatsIngest).not.toHaveBeenCalled();
  });

  it("fail-softs an atomic claim failure instead of rejecting the refresh request", async () => {
    mockGetMyAccount.mockResolvedValueOnce(ACCOUNT);
    mockSql.mockRejectedValueOnce(new Error("database unavailable"));
    const result = await runMyStatsRefresh(mockSql as never);
    expect(result).toEqual({ refreshed: false, skipped: false, error: true });
    expect(mockRunMyStatsIngest).not.toHaveBeenCalled();
  });

  it("skips with reason:cooldown when called again inside the window, never calling Riot", async () => {
    mockGetMyAccount.mockResolvedValueOnce(ACCOUNT);
    // The atomic claim returns no row while the existing cursor is inside the
    // cooldown window.
    mockSql.mockResolvedValueOnce([]);
    const result = await runMyStatsRefresh(mockSql as never);
    expect(result).toEqual({ refreshed: false, skipped: true, reason: "cooldown" });
    expect(mockRunMyStatsIngest).not.toHaveBeenCalled();
  });

  it("treats a lost atomic cooldown claim as a cooldown skip", async () => {
    mockGetMyAccount.mockResolvedValueOnce(ACCOUNT);
    // The database claim returns no row when another request won the race.
    mockSql.mockResolvedValueOnce([]);

    const result = await runMyStatsRefresh(mockSql as never);

    expect(result).toEqual({ refreshed: false, skipped: true, reason: "cooldown" });
    expect(mockRunMyStatsIngest).not.toHaveBeenCalled();
    const claimSql = (mockSql.mock.calls[0][0] as readonly string[]).join(" ");
    expect(claimSql).toContain("ON CONFLICT (puuid)");
    expect(claimSql).toContain("RETURNING puuid");
  });

  it("runs incremental ingest after claiming the cooldown lease, returns newGames+latest", async () => {
    mockGetMyAccount.mockResolvedValueOnce(ACCOUNT);
    mockSql
      .mockResolvedValueOnce([{ puuid: ACCOUNT.puuid }]) // atomic claim
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

  it("scopes the reported latest game to counted queues", async () => {
    mockGetMyAccount.mockResolvedValueOnce(ACCOUNT);
    mockSql
      .mockResolvedValueOnce([{ puuid: ACCOUNT.puuid }])
      .mockResolvedValueOnce([{ latest: "2026-07-24T11:00:00.000Z" }]);
    mockRunMyStatsIngest.mockResolvedValueOnce({
      accountUnresolved: false,
      matchesSeen: 1,
      matchesUpserted: 1,
      nextStart: null,
      historyComplete: true,
      truncatedBy: null,
      pagesWalked: 1,
      errors: [],
    });

    await runMyStatsRefresh(mockSql as never);

    const latestCall = mockSql.mock.calls[1] as unknown[];
    const latestSql = (latestCall[0] as readonly string[]).join(" ");
    expect(latestSql).toContain("queue_id = ANY(");
    expect(latestCall).toContain(COUNTED_QUEUE_IDS);
  });

  it("passes an INCOMPLETE sync straight through -- a truncated walk must not reach the client as a finished one", async () => {
    // The plumbing test for the 2026-07-30 fix. `toEqual` treats a missing key and
    // an `undefined` one as equal, so a dropped field here would pass silently in
    // the tests above -- which is exactly how a truncation would become invisible
    // again one layer up.
    mockGetMyAccount.mockResolvedValueOnce(ACCOUNT);
    mockSql
      .mockResolvedValueOnce([{ puuid: ACCOUNT.puuid }])
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
      .mockResolvedValueOnce([{ puuid: ACCOUNT.puuid }]) // first atomic claim inserts the cursor row
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
    mockSql.mockResolvedValueOnce([{ puuid: ACCOUNT.puuid }]);
    mockRunMyStatsIngest.mockRejectedValueOnce(new Error("riot 503"));

    const result = await runMyStatsRefresh(mockSql as never);
    expect(result).toEqual({ refreshed: false, skipped: false, error: true });
    expectOwnLeaseRelease(mockSql);
  });

  it("ingest reporting accountUnresolved mid-call surfaces the same accountUnresolved shape", async () => {
    mockGetMyAccount.mockResolvedValueOnce(ACCOUNT);
    mockSql.mockResolvedValueOnce([{ puuid: ACCOUNT.puuid }]);
    mockRunMyStatsIngest.mockResolvedValueOnce({
      accountUnresolved: true,
      matchesSeen: 0,
      matchesUpserted: 0,
      nextStart: null,
      errors: [],
    });

    const result = await runMyStatsRefresh(mockSql as never);
    expect(result).toEqual({ accountUnresolved: true });
    expectOwnLeaseRelease(mockSql);
  });
});
