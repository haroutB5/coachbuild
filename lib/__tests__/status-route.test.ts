/**
 * GET /api/status — status code follows the overall verdict, and BOTH branches
 * carry the 60 s CDN cache (a failing status page re-collected on every poll
 * would be the load source it exists not to be). Collector mocked.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/status/collect", () => ({ collectStatus: vi.fn() }));

import { GET } from "@/app/api/status/route";
import { collectStatus } from "@/lib/status/collect";
import type { StatusReport } from "@/lib/status/collect";

const report = (overall: StatusReport["overall"]): StatusReport => ({
  generatedAt: "2026-09-02T12:00:00.000Z",
  version: "0.121.0",
  overall,
  checks: [{ id: "neon", label: "Neon reachable", verdict: overall, detail: "x", at: null }],
});

beforeEach(() => vi.mocked(collectStatus).mockReset());

describe("GET /api/status", () => {
  it("200 + s-maxage=60 on pass", async () => {
    vi.mocked(collectStatus).mockResolvedValue(report("pass"));
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("s-maxage=60, stale-while-revalidate=60");
    expect((await res.json()).overall).toBe("pass");
  });

  it("200 on warn (nothing users see is broken)", async () => {
    vi.mocked(collectStatus).mockResolvedValue(report("warn"));
    expect((await GET()).status).toBe(200);
  });

  it("503 on fail, still cached 60 s", async () => {
    vi.mocked(collectStatus).mockResolvedValue(report("fail"));
    const res = await GET();
    expect(res.status).toBe(503);
    expect(res.headers.get("Cache-Control")).toBe("s-maxage=60, stale-while-revalidate=60");
    expect((await res.json()).checks[0].id).toBe("neon");
  });
});
