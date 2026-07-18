/**
 * Tests for lib/pro/ingestMatches.ts's account-selection query.
 * lib/pro/db.ts is mocked (a fake tagged-template `sql`) — no network/DB.
 *
 * Regression coverage for the 2026-07-13 audit finding: `ORDER BY
 * last_fetched_at ASC NULLS FIRST` with no tiebreaker leaves every
 * never-fetched (NULL) account in an unstable relative order, so an
 * OFFSET/LIMIT window can return an arbitrary subset of the NULL cohort per
 * call with no bounded-time guarantee every account is ever reached. The
 * fix adds `created_at ASC` as a deterministic tiebreaker.
 *
 * Regression coverage for the 2026-07-17 Fable review P2 finding: the
 * OFFSET/LIMIT walk itself skips ~`batch` accounts per page once a page's
 * own writes (bumping last_fetched_at to now()) reorder the underlying
 * `ORDER BY` out from under the next OFFSET window. The fix replaces OFFSET
 * with a stable `last_fetched_at < walkStart` predicate, where walkStart is
 * a fixed timestamp threaded through every call of one walk via the cursor.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSql = vi.fn();

vi.mock("@/lib/pro/db", () => ({
  getSql: vi.fn(() => mockSql),
}));

import { runMatchIngest } from "@/lib/pro/ingestMatches";
import { getSql } from "@/lib/pro/db";

describe("runMatchIngest account-selection ordering", () => {
  beforeEach(() => {
    mockSql.mockReset();
    vi.mocked(getSql).mockReturnValue(mockSql as never);
    process.env.RIOT_API_KEY = "test-key";
  });

  it("orders by last_fetched_at ASC NULLS FIRST with a created_at ASC tiebreaker", async () => {
    mockSql.mockResolvedValueOnce([]); // account SELECT returns nothing -> no further calls

    await runMatchIngest({ batch: 5 });

    expect(mockSql).toHaveBeenCalledTimes(1);
    const strings = mockSql.mock.calls[0][0] as TemplateStringsArray;
    const queryText = strings.join("?");

    expect(queryText).toContain("last_fetched_at ASC NULLS FIRST");
    expect(queryText).toContain("created_at ASC");
    // Tiebreaker must be part of the SAME ORDER BY clause, not some other
    // clause that happens to mention created_at.
    expect(queryText).toMatch(/ORDER BY\s+last_fetched_at ASC NULLS FIRST,\s*created_at ASC/);
  });

  it("returns nextCursor null (no accounts) without attempting any per-account work", async () => {
    mockSql.mockResolvedValueOnce([]);
    const result = await runMatchIngest({ batch: 5 });
    expect(result.accountsProcessed).toBe(0);
    expect(result.nextCursor).toBeNull();
    expect(mockSql).toHaveBeenCalledTimes(1);
  });

  it("filters on a stable last_fetched_at < walkStart predicate instead of OFFSET/LIMIT", async () => {
    mockSql.mockResolvedValueOnce([]);
    await runMatchIngest({ batch: 5, cursor: "2026-01-01T00:00:00.000Z" });
    const strings = mockSql.mock.calls[0][0] as TemplateStringsArray;
    const queryText = strings.join("?");
    expect(queryText).toContain("last_fetched_at IS NULL OR last_fetched_at < ?::timestamptz");
    expect(queryText).not.toMatch(/OFFSET/i);
  });

  it("cron path (no cursor) mints a fresh walkStart close to now(), same single-call behavior as before", async () => {
    mockSql.mockResolvedValueOnce([]);
    const before = Date.now();
    await runMatchIngest({ batch: 5 });
    const after = Date.now();
    const [, walkStartArg] = mockSql.mock.calls[0];
    const walkStartMs = Date.parse(walkStartArg as string);
    expect(walkStartMs).toBeGreaterThanOrEqual(before - 1000);
    expect(walkStartMs).toBeLessThanOrEqual(after + 1000);
  });

  it("echoes a caller-supplied cursor back VERBATIM as nextCursor on a full page (stable across a resumed walk)", async () => {
    // region "UNKNOWN" makes ingestOneAccount bail before any Riot/DB call
    // (routingForServer returns null), keeping this test scoped to the
    // account-selection query itself.
    mockSql.mockResolvedValueOnce([
      { puuid: "p1", pro_id: "pro1", region: "UNKNOWN", riot_id: "P1#EUW1" },
      { puuid: "p2", pro_id: "pro2", region: "UNKNOWN", riot_id: "P2#EUW1" },
    ]);
    const cursorIn = "2026-01-01T00:00:00.000Z";
    const result = await runMatchIngest({ batch: 2, cursor: cursorIn });
    expect(result.nextCursor).toBe(cursorIn); // NOT a fresh now() — the same walkStart, echoed back
    const [, walkStartArg] = mockSql.mock.calls[0];
    expect(walkStartArg).toBe(cursorIn);
  });

  it("full drain: a short page (fewer than batch) ends the walk, even mid-resume", async () => {
    mockSql.mockResolvedValueOnce([
      { puuid: "p1", pro_id: "pro1", region: "UNKNOWN", riot_id: "P1#EUW1" },
    ]);
    const result = await runMatchIngest({ batch: 2, cursor: "2026-01-01T00:00:00.000Z" });
    expect(result.accountsProcessed).toBe(1);
    expect(result.nextCursor).toBeNull();
  });

  it("full drain: the SAME walkStart threads through every call of a walk, immune to reordering from writes made mid-walk", async () => {
    // Call 1: fresh walk (no cursor), full page (2 == batch) -> walk continues.
    mockSql.mockResolvedValueOnce([
      { puuid: "p1", pro_id: "pro1", region: "UNKNOWN", riot_id: "P1#EUW1" },
      { puuid: "p2", pro_id: "pro2", region: "UNKNOWN", riot_id: "P2#EUW1" },
    ]);
    const first = await runMatchIngest({ batch: 2 });
    expect(first.nextCursor).not.toBeNull();
    expect(Number.isNaN(Date.parse(first.nextCursor as string))).toBe(false);

    // Call 2: resume with the cursor from call 1. Even though a REAL walk
    // would have just bumped p1/p2's last_fetched_at to now() (reordering
    // them under an OFFSET-based query), the bound predicate here is still
    // the ORIGINAL walkStart, not a fresh one — so this call would correctly
    // exclude p1/p2 in a real DB regardless of their new sort position.
    mockSql.mockReset();
    mockSql.mockResolvedValueOnce([
      { puuid: "p3", pro_id: "pro3", region: "UNKNOWN", riot_id: "P3#EUW1" },
    ]); // short page -> walk complete
    const second = await runMatchIngest({ batch: 2, cursor: first.nextCursor as string });
    const [, walkStartArg] = mockSql.mock.calls[0];
    expect(walkStartArg).toBe(first.nextCursor);
    expect(second.accountsProcessed).toBe(1);
    expect(second.nextCursor).toBeNull();
  });
});
