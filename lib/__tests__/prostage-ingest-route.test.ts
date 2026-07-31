/**
 * Tests for GET /api/ingest/prostage — P3(g) fix (2026-07-17 Fable review):
 * the never-landing prostage cron (CLAUDE.md gotcha (o)) has a plausible-but-
 * UNVERIFIED root cause (Vercel egress IPs Cloudflare-blocked at
 * lol.fandom.com), which would surface as an HTTP 200 with a populated
 * `errors` array — previously invisible (no logging, no response signal).
 * This route now logs the errors array and surfaces an explicit
 * `errorCount` in the JSON response, diagnostic-only (no behavior change).
 * lib/prostage/ingest.ts and lib/pro/auth.ts are mocked — no network/DB.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/prostage/ingest", () => ({
  runProstageIngest: vi.fn(),
}));
vi.mock("@/lib/pro/auth", () => ({
  isAuthorized: vi.fn(() => true),
}));
const mockSql = vi.fn();
vi.mock("@/lib/pro/db", () => ({ getSql: vi.fn(() => mockSql) }));
const mockGetIngestHealth = vi.fn();
vi.mock("@/lib/ingestHealth", () => ({ getIngestHealth: (...a: unknown[]) => mockGetIngestHealth(...a) }));

import { GET } from "@/app/api/ingest/prostage/route";
import { runProstageIngest } from "@/lib/prostage/ingest";
import { getSql } from "@/lib/pro/db";

const req = (qs = "") =>
  ({
    url: `http://localhost/api/ingest/prostage${qs}`,
    headers: { get: () => "Bearer test" },
  }) as unknown as Parameters<typeof GET>[0];

describe("GET /api/ingest/prostage diagnosability", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.mocked(runProstageIngest).mockReset();
    vi.mocked(getSql).mockReturnValue(mockSql as never);
    mockGetIngestHealth.mockReset().mockResolvedValue(null);
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it("surfaces errorCount:0 and logs nothing when the ingest pass has no errors", async () => {
    vi.mocked(runProstageIngest).mockResolvedValueOnce({
      tournament: "LEC 2026 Summer",
      rowsSeen: 10,
      rowsUpserted: 10,
      nextCursor: 1,
      errors: [],
    });
    const res = await GET(req());
    const json = await res.json();
    expect(json.errorCount).toBe(0);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("surfaces a non-zero errorCount AND logs the errors array when the ingest pass has errors", async () => {
    vi.mocked(runProstageIngest).mockResolvedValueOnce({
      tournament: "LEC 2026 Summer",
      rowsSeen: 5,
      rowsUpserted: 2,
      nextCursor: 1,
      errors: ["game g1 player P1: ratelimited", "tournament LEC 2026 Summer: MWException"],
    });
    const res = await GET(req());
    const json = await res.json();
    expect(json.errorCount).toBe(2);
    expect(json.errors).toEqual([
      "game g1 player P1: ratelimited",
      "tournament LEC 2026 Summer: MWException",
    ]);
    expect(errorSpy).toHaveBeenCalledWith(
      "[prostage-cron] ingest errors:",
      ["game g1 player P1: ratelimited", "tournament LEC 2026 Summer: MWException"]
    );
  });

  it("preserves every existing field on the result (diagnostic-only change, no behavior change)", async () => {
    vi.mocked(runProstageIngest).mockResolvedValueOnce({
      tournament: "LCK 2026 Summer",
      rowsSeen: 3,
      rowsUpserted: 3,
      nextCursor: null,
      errors: [],
    });
    const res = await GET(req());
    const json = await res.json();
    expect(json).toMatchObject({
      tournament: "LCK 2026 Summer",
      rowsSeen: 3,
      rowsUpserted: 3,
      nextCursor: null,
      errors: [],
      errorCount: 0,
    });
  });

  describe("lastScheduledRun (2026-07-31 audit P2, #2)", () => {
    it("surfaces the persisted health of the REAL (locally-scheduled) ingest run", async () => {
      vi.mocked(runProstageIngest).mockResolvedValueOnce({
        tournament: "LEC 2026 Summer", rowsSeen: 1, rowsUpserted: 1, nextCursor: null, errors: [],
      });
      mockGetIngestHealth.mockResolvedValueOnce({
        ingest: "prostage", lastRunAt: "x", lastSuccessAt: null, ok: false, lastError: "Cloudflare 403", lastErrorAt: "x",
      });
      const res = await GET(req());
      const json = await res.json();
      expect(mockGetIngestHealth).toHaveBeenCalledWith(mockSql, "prostage");
      expect(json.lastScheduledRun).toMatchObject({ ok: false, lastError: "Cloudflare 403" });
    });

    it("null (never fabricated healthy) when DATABASE_URL is unset", async () => {
      vi.mocked(getSql).mockReturnValueOnce(null as never);
      vi.mocked(runProstageIngest).mockResolvedValueOnce({
        tournament: "LEC 2026 Summer", rowsSeen: 1, rowsUpserted: 1, nextCursor: null, errors: [],
      });
      const res = await GET(req());
      const json = await res.json();
      expect(json.lastScheduledRun).toBeNull();
      expect(mockGetIngestHealth).not.toHaveBeenCalled();
    });
  });
});
