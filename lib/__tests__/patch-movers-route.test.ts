/**
 * Feature 4 route (v0.51 rewrite): GET /api/patch-movers — no `role` param
 * anymore (the response covers every lane in one shot; a stale `?role=`
 * query is accepted-but-ignored). Cache discipline unchanged: never
 * CDN-cache unsupported/degraded, hard-cache real results. Engine mocked.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/patchMovers", () => ({ computePatchMovers: vi.fn() }));

import { GET } from "@/app/api/patch-movers/route";
import { computePatchMovers, type PatchMover } from "@/lib/patchMovers";

const mover: PatchMover = {
  championId: 112,
  championName: "Viktor",
  role: 2,
  wrNow: 52.4,
  wrPrev: 50.6,
  deltaPp: 1.8,
  games: 20000,
  note: "Buffed this patch",
};

describe("GET /api/patch-movers", () => {
  beforeEach(() => vi.mocked(computePatchMovers).mockReset());

  it("unsupported → 200 + no-store (never CDN-cache a hidden page)", async () => {
    vi.mocked(computePatchMovers).mockResolvedValueOnce({ unsupported: true });
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ unsupported: true });
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("empty movers → no-store (degraded, per repo Gotcha (b))", async () => {
    vi.mocked(computePatchMovers).mockResolvedValueOnce({
      patch: "16.13",
      prevPatch: "16.12",
      movers: [],
    });
    const res = await GET();
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("real movers → hard 24h SWR cache", async () => {
    vi.mocked(computePatchMovers).mockResolvedValueOnce({
      patch: "16.13",
      prevPatch: "16.12",
      movers: [mover],
    });
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.movers).toHaveLength(1);
    expect(body.movers[0].note).toBe("Buffed this patch");
    expect(res.headers.get("Cache-Control")).toContain("s-maxage=86400");
  });

  it("calls the engine with no arguments (role is no longer a lib-level input)", async () => {
    vi.mocked(computePatchMovers).mockResolvedValueOnce({
      patch: "16.13",
      prevPatch: "16.12",
      movers: [mover],
    });
    await GET();
    expect(vi.mocked(computePatchMovers).mock.calls[0]).toEqual([]);
  });
});
