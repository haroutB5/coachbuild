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

    await runMatchIngest({ batch: 5, cursor: 0 });

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
    const result = await runMatchIngest({ batch: 5, cursor: 0 });
    expect(result.accountsProcessed).toBe(0);
    expect(result.nextCursor).toBeNull();
    expect(mockSql).toHaveBeenCalledTimes(1);
  });
});
