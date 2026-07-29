/**
 * Tests for how lib/pro/ingestMatches.ts reacts to a Riot 429 (2026-07-29).
 *
 * Two decisions are pinned here, and they are ONE decision in two halves:
 *
 *   1. A 429 ABORTS the walk. By the time one reaches this layer, lib/pro/riot.ts
 *      has already honoured Riot's own Retry-After and retried — still being
 *      limited means a second process is spending the shared key right now, and
 *      grinding through the remaining ~1,400 accounts is how a transient 429
 *      becomes a suspended key that blanks every surface in the app.
 *   2. A 429 does NOT bump `last_fetched_at`. The bump is a termination guard
 *      for account-SPECIFIC errors; a 429 says nothing about the account, and
 *      stamping it would hide an unexamined account from the walk for a whole
 *      cycle. That is only safe because of (1) — an un-bumped account still
 *      satisfies the walk predicate and sorts to the front, so continuing would
 *      re-select it forever.
 *
 * db and riot are both mocked — no network, no DB.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSql = vi.fn();
vi.mock("@/lib/pro/db", () => ({ getSql: vi.fn(() => mockSql) }));

vi.mock("@/lib/pro/riot", async () => {
  const actual = await vi.importActual<typeof import("@/lib/pro/riot")>("@/lib/pro/riot");
  return {
    ...actual,
    getMatchIdsByPuuid: vi.fn(),
    getMatch: vi.fn(),
    getMatchTimeline: vi.fn(),
  };
});

import { runMatchIngest } from "@/lib/pro/ingestMatches";
import { getSql } from "@/lib/pro/db";
import { getMatch, getMatchIdsByPuuid, getMatchTimeline, RiotRequestError } from "@/lib/pro/riot";

const ACCOUNTS = [
  { puuid: "p1", pro_id: "pro1", region: "EUW", riot_id: "A#EUW" },
  { puuid: "p2", pro_id: "pro2", region: "EUW", riot_id: "B#EUW" },
];

/** Every `sql` call after the account SELECT, as flat query text. */
function queriesAfterSelect(): string[] {
  return mockSql.mock.calls
    .slice(1)
    .map((call) => (call[0] as TemplateStringsArray).join("?"));
}

beforeEach(() => {
  mockSql.mockReset();
  vi.mocked(getSql).mockReturnValue(mockSql as never);
  vi.mocked(getMatchIdsByPuuid).mockReset();
  vi.mocked(getMatch).mockReset();
  vi.mocked(getMatchTimeline).mockReset();
  process.env.RIOT_API_KEY = "test-key";
});

describe("a 429 on the id-list call", () => {
  beforeEach(() => {
    mockSql.mockResolvedValueOnce(ACCOUNTS); // account SELECT
    vi.mocked(getMatchIdsByPuuid).mockRejectedValue(
      new RiotRequestError("url", 429, "Too Many Requests", { retryAfterSec: 5 })
    );
  });

  it("aborts the walk instead of burning the rest of the batch on the same limit", async () => {
    const result = await runMatchIngest({ batch: 2 });

    expect(result.rateLimited).toBe(true);
    expect(result.nextCursor).toBeNull();
    expect(result.accountsProcessed).toBe(1); // stopped at the first, never reached p2
    expect(vi.mocked(getMatchIdsByPuuid)).toHaveBeenCalledTimes(1);
  });

  it("does NOT stamp last_fetched_at on the account it never examined", async () => {
    await runMatchIngest({ batch: 2 });
    const writes = queriesAfterSelect().filter((q) => q.includes("last_fetched_at = now()"));
    expect(writes).toEqual([]);
  });

  it("still records the account in errors so the log names what failed", async () => {
    const result = await runMatchIngest({ batch: 2 });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("A#EUW");
    expect(result.errors[0]).toContain("429");
  });
});

describe("a non-429 error keeps the OLD behaviour exactly", () => {
  it("stamps the account and carries on to the next one", async () => {
    mockSql.mockResolvedValueOnce(ACCOUNTS);
    mockSql.mockResolvedValue([]); // every write / follow-up query
    vi.mocked(getMatchIdsByPuuid)
      .mockRejectedValueOnce(new RiotRequestError("url", 404, "Not Found"))
      .mockResolvedValueOnce([]);

    const result = await runMatchIngest({ batch: 2 });

    expect(result.rateLimited).toBe(false);
    expect(result.accountsProcessed).toBe(2);
    expect(result.errors).toHaveLength(1);
    const stamps = queriesAfterSelect().filter((q) => q.includes("last_fetched_at = now()"));
    expect(stamps.length).toBeGreaterThanOrEqual(1);
  });

  it("a non-Riot throw (DB blip mid-account) also stamps and continues", async () => {
    mockSql.mockResolvedValueOnce(ACCOUNTS);
    mockSql.mockResolvedValue([]);
    vi.mocked(getMatchIdsByPuuid)
      .mockRejectedValueOnce(new Error("connection reset"))
      .mockResolvedValueOnce([]);

    const result = await runMatchIngest({ batch: 2 });
    expect(result.rateLimited).toBe(false);
    expect(result.accountsProcessed).toBe(2);
  });
});

describe("a 429 INSIDE the per-match loop", () => {
  it("propagates instead of being skipped as if the match were the problem", async () => {
    mockSql.mockResolvedValueOnce(ACCOUNTS);
    mockSql.mockResolvedValue([]); // `existing` lookup returns no rows
    vi.mocked(getMatchIdsByPuuid).mockResolvedValue(["EUW1_1", "EUW1_2"]);
    vi.mocked(getMatch).mockRejectedValue(
      new RiotRequestError("url", 429, "Too Many Requests", { retryAfterSec: 5 })
    );

    const result = await runMatchIngest({ batch: 2 });

    expect(result.rateLimited).toBe(true);
    expect(result.accountsProcessed).toBe(1);
    // The second match id must never have been attempted — the pre-fix code
    // logged "riot 429, skipping" and moved straight on to it.
    expect(vi.mocked(getMatch)).toHaveBeenCalledTimes(1);
  });

  it("a 404 on one match is still skipped, and the account still completes", async () => {
    mockSql.mockResolvedValueOnce([ACCOUNTS[0]]);
    mockSql.mockResolvedValue([]);
    vi.mocked(getMatchIdsByPuuid).mockResolvedValue(["EUW1_1"]);
    vi.mocked(getMatch).mockRejectedValue(new RiotRequestError("url", 404, "Not Found"));

    const result = await runMatchIngest({ batch: 2 });

    expect(result.rateLimited).toBe(false);
    expect(result.errors).toEqual([]);
    expect(vi.mocked(getMatchTimeline)).not.toHaveBeenCalled();
    const stamps = queriesAfterSelect().filter((q) => q.includes("last_fetched_at = now()"));
    expect(stamps.length).toBe(1); // the normal end-of-account stamp
  });
});

describe("the healthy path is untouched", () => {
  it("reports rateLimited:false when nothing goes wrong", async () => {
    mockSql.mockResolvedValueOnce([ACCOUNTS[0]]);
    mockSql.mockResolvedValue([]);
    vi.mocked(getMatchIdsByPuuid).mockResolvedValue([]);

    const result = await runMatchIngest({ batch: 2 });
    expect(result.rateLimited).toBe(false);
    expect(result.errors).toEqual([]);
    expect(result.nextCursor).toBeNull();
  });
});
