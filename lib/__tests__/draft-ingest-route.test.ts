/**
 * Tests for GET /api/ingest/draft — auth guard, in-process multi-batch loop
 * (bounded by WALL_CLOCK_BUDGET_MS, see the route's header comment for why
 * this replaces the plan's self-chain-via-internal-fetch design), aggregate
 * totals, error surfacing, and the audit P1-2 cursor-persistence fix (an
 * explicit ?cursor= overrides and never touches persisted state; a
 * cursorless — the real cron path — request reads/advances/wraps it).
 * lib/draft/ingest.ts, lib/pro/db.ts, and lib/pro/auth.ts mocked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockSql = vi.fn();
vi.mock("@/lib/pro/db", () => ({ getSql: vi.fn(() => mockSql) }));
vi.mock("@/lib/draft/ingest", () => ({
  runDraftIngest: vi.fn(),
  getPersistedCursor: vi.fn(),
  setPersistedCursor: vi.fn(),
}));
vi.mock("@/lib/pro/auth", () => ({ isAuthorized: vi.fn(() => true) }));

import { GET } from "@/app/api/ingest/draft/route";
import { getSql } from "@/lib/pro/db";
import { runDraftIngest, getPersistedCursor, setPersistedCursor } from "@/lib/draft/ingest";
import { isAuthorized } from "@/lib/pro/auth";
import { DbUnavailableError } from "@/lib/pro/errors";

const req = (qs = "") => ({ url: `http://localhost/api/ingest/draft${qs}` }) as unknown as Parameters<typeof GET>[0];

function batchResult(overrides: Partial<Awaited<ReturnType<typeof runDraftIngest>>> = {}) {
  return {
    patch: "16.14",
    champStart: 0,
    champCount: 9,
    rowsUpserted: 100,
    statsUpserted: 40,
    skippedRows: 0,
    nextCursor: null,
    errors: [],
    retentionRan: false,
    ...overrides,
  };
}

describe("GET /api/ingest/draft", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.mocked(getSql).mockReturnValue(mockSql as never);
    vi.mocked(runDraftIngest).mockReset();
    vi.mocked(getPersistedCursor).mockReset().mockResolvedValue(0);
    vi.mocked(setPersistedCursor).mockReset().mockResolvedValue(undefined);
    vi.mocked(isAuthorized).mockReset().mockReturnValue(true);
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => errorSpy.mockRestore());

  it("401 when unauthorized", async () => {
    vi.mocked(isAuthorized).mockReturnValue(false);
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(runDraftIngest).not.toHaveBeenCalled();
  });

  it("400 on an invalid cursor param", async () => {
    const res = await GET(req("?cursor=abc"));
    expect(res.status).toBe(400);
  });

  it("stops looping once nextCursor is null (single batch, walk finished)", async () => {
    vi.mocked(runDraftIngest).mockResolvedValueOnce(batchResult({ nextCursor: null }));
    const res = await GET(req());
    const json = await res.json();
    expect(runDraftIngest).toHaveBeenCalledTimes(1);
    expect(json.batchesRun).toBe(1);
    expect(json.nextCursor).toBeNull();
  });

  it("loops multiple batches in-process while nextCursor keeps advancing", async () => {
    vi.mocked(runDraftIngest)
      .mockResolvedValueOnce(batchResult({ nextCursor: 9, rowsUpserted: 50 }))
      .mockResolvedValueOnce(batchResult({ nextCursor: 18, rowsUpserted: 60 }))
      .mockResolvedValueOnce(batchResult({ nextCursor: null, rowsUpserted: 70 }));

    const res = await GET(req());
    const json = await res.json();
    expect(runDraftIngest).toHaveBeenCalledTimes(3);
    expect(json.batchesRun).toBe(3);
    expect(json.rowsUpserted).toBe(180);
    expect(json.nextCursor).toBeNull();
  });

  it("threads fastFailOnRatelimit:true on every call (route budget constrained)", async () => {
    vi.mocked(runDraftIngest).mockResolvedValueOnce(batchResult({ nextCursor: null }));
    await GET(req());
    expect(vi.mocked(runDraftIngest).mock.calls[0][0]).toMatchObject({ fastFailOnRatelimit: true });
  });

  it("passes the parsed cursor through on the first call", async () => {
    vi.mocked(runDraftIngest).mockResolvedValueOnce(batchResult({ nextCursor: null }));
    await GET(req("?cursor=45"));
    expect(vi.mocked(runDraftIngest).mock.calls[0][0]).toMatchObject({ cursor: 45 });
  });

  it("aggregates errors across batches and logs them", async () => {
    vi.mocked(runDraftIngest)
      .mockResolvedValueOnce(batchResult({ nextCursor: 9, errors: ["champ 1: boom"] }))
      .mockResolvedValueOnce(batchResult({ nextCursor: null, errors: ["champ 10: also boom"] }));
    const res = await GET(req());
    const json = await res.json();
    expect(json.errorCount).toBe(2);
    expect(errorSpy).toHaveBeenCalledWith("[draft-ingest-cron] ingest errors:", [
      "champ 1: boom",
      "champ 10: also boom",
    ]);
  });

  it("retentionRan true if ANY batch ran retention", async () => {
    vi.mocked(runDraftIngest)
      .mockResolvedValueOnce(batchResult({ nextCursor: 9, retentionRan: false }))
      .mockResolvedValueOnce(batchResult({ nextCursor: null, retentionRan: true }));
    const res = await GET(req());
    const json = await res.json();
    expect(json.retentionRan).toBe(true);
  });

  it("DbUnavailableError from getSql() -> 503, never calls runDraftIngest", async () => {
    vi.mocked(getSql).mockReturnValueOnce(null as never);
    const res = await GET(req());
    expect(res.status).toBe(503);
    expect(runDraftIngest).not.toHaveBeenCalled();
  });

  it("unexpected error -> 500", async () => {
    vi.mocked(runDraftIngest).mockRejectedValueOnce(new Error("boom"));
    const res = await GET(req());
    expect(res.status).toBe(500);
  });

  describe("cursor persistence (audit P1-2)", () => {
    it("cursorless request reads the persisted cursor as the starting point", async () => {
      vi.mocked(getPersistedCursor).mockResolvedValueOnce(63);
      vi.mocked(runDraftIngest).mockResolvedValueOnce(batchResult({ nextCursor: null }));
      await GET(req());
      expect(getPersistedCursor).toHaveBeenCalledWith(mockSql);
      expect(vi.mocked(runDraftIngest).mock.calls[0][0]).toMatchObject({ cursor: 63 });
    });

    it("cursorless request persists wherever the loop ended (mid-walk, budget exhausted)", async () => {
      vi.mocked(getPersistedCursor).mockResolvedValueOnce(0);
      vi.mocked(runDraftIngest).mockResolvedValueOnce(batchResult({ nextCursor: 9 }));
      // Force the wall-clock budget check to fail after exactly ONE batch,
      // so the loop stops with a non-null nextCursor (mid-walk) rather than
      // needing a second (unmocked) runDraftIngest call.
      const nowSpy = vi
        .spyOn(Date, "now")
        .mockReturnValueOnce(1_000) // `started`
        .mockReturnValueOnce(1_000 + 46_000); // while-check -- past WALL_CLOCK_BUDGET_MS (45s)
      const res = await GET(req());
      const json = await res.json();
      nowSpy.mockRestore();
      expect(runDraftIngest).toHaveBeenCalledTimes(1);
      expect(setPersistedCursor).toHaveBeenCalledWith(mockSql, 9);
      expect(json.persistedCursor).toBe(true);
      expect(json.nextCursor).toBe(9);
    });

    it("cursorless request wraps to 0 when the walk completes (next patch starts fresh)", async () => {
      vi.mocked(getPersistedCursor).mockResolvedValueOnce(162);
      vi.mocked(runDraftIngest).mockResolvedValueOnce(batchResult({ nextCursor: null }));
      await GET(req());
      expect(setPersistedCursor).toHaveBeenCalledWith(mockSql, 0);
    });

    it("explicit ?cursor= overrides the persisted value and NEVER writes it back", async () => {
      vi.mocked(runDraftIngest).mockResolvedValueOnce(batchResult({ nextCursor: null }));
      const res = await GET(req("?cursor=45"));
      const json = await res.json();
      expect(getPersistedCursor).not.toHaveBeenCalled();
      expect(setPersistedCursor).not.toHaveBeenCalled();
      expect(json.persistedCursor).toBe(false);
      expect(vi.mocked(runDraftIngest).mock.calls[0][0]).toMatchObject({ cursor: 45 });
    });
  });
});
