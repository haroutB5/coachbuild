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

import { GET } from "@/app/api/ingest/prostage/route";
import { runProstageIngest } from "@/lib/prostage/ingest";

const req = (qs = "") =>
  ({
    url: `http://localhost/api/ingest/prostage${qs}`,
    headers: { get: () => "Bearer test" },
  }) as unknown as Parameters<typeof GET>[0];

describe("GET /api/ingest/prostage diagnosability", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.mocked(runProstageIngest).mockReset();
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
});
