/**
 * Feature 4 route (v0.51 rewrite): GET /api/patch-movers — no `role` param
 * anymore (the response covers every lane in one shot; a stale `?role=`
 * query is accepted-but-ignored). Cache discipline unchanged: never
 * CDN-cache unsupported/degraded, hard-cache real results. Engine mocked.
 *
 * 2026-07-26 security fix (audit P2, "/api/patch-movers amplification"):
 * added a canonical-URL redirect (defeats the CDN cache-key bypass) and a
 * short-lived module-level compute cache + single-flight guard (bounds how
 * often a degraded/outage sweep can re-run). Both new describe blocks below
 * FAIL against pre-fix HEAD — the redirect and the cache/dedup didn't exist.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/patchMovers", () => ({ computePatchMovers: vi.fn() }));

import { GET } from "@/app/api/patch-movers/route";
import { __resetPatchMoversCacheForTests } from "@/lib/patchMoversCache";
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

function req(url = "http://localhost/api/patch-movers"): NextRequest {
  return new NextRequest(url);
}

describe("GET /api/patch-movers", () => {
  beforeEach(() => {
    vi.mocked(computePatchMovers).mockReset();
    __resetPatchMoversCacheForTests();
  });

  it("unsupported → 200 + no-store (never CDN-cache a hidden page)", async () => {
    vi.mocked(computePatchMovers).mockResolvedValueOnce({ unsupported: true });
    const res = await GET(req());
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
    const res = await GET(req());
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("real movers → hard 24h SWR cache", async () => {
    vi.mocked(computePatchMovers).mockResolvedValueOnce({
      patch: "16.13",
      prevPatch: "16.12",
      movers: [mover],
    });
    const res = await GET(req());
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
    await GET(req());
    expect(vi.mocked(computePatchMovers).mock.calls[0]).toEqual([]);
  });
});

describe("GET /api/patch-movers — cache-key-bypass redirect (FAILS against pre-fix HEAD)", () => {
  beforeEach(() => {
    vi.mocked(computePatchMovers).mockReset();
    __resetPatchMoversCacheForTests();
  });

  it("a request carrying ANY query string is redirected to the bare canonical path, without computing", async () => {
    const res = await GET(req("http://localhost/api/patch-movers?cachebust=" + Math.random()));
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe("http://localhost/api/patch-movers");
    // The whole point: a junk-param request must never reach the ~400-call
    // compute path — this is what makes the CDN-cache bypass free before.
    expect(computePatchMovers).not.toHaveBeenCalled();
  });

  it("a legacy `?role=2` bookmark is also redirected (still ends up a 200 via one hop, per the doc comment)", async () => {
    const res = await GET(req("http://localhost/api/patch-movers?role=2"));
    expect(res.status).toBe(308);
    expect(computePatchMovers).not.toHaveBeenCalled();
  });

  it("the bare canonical URL is NOT redirected", async () => {
    vi.mocked(computePatchMovers).mockResolvedValueOnce({ unsupported: true });
    const res = await GET(req());
    expect(res.status).toBe(200);
  });
});

describe("GET /api/patch-movers — outage-amplification bound (FAILS against pre-fix HEAD)", () => {
  beforeEach(() => {
    vi.mocked(computePatchMovers).mockReset();
    __resetPatchMoversCacheForTests();
  });

  it("a burst of concurrent requests during an outage collapses to ONE compute (single-flight)", async () => {
    let resolveCompute!: (v: { unsupported: true }) => void;
    vi.mocked(computePatchMovers).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveCompute = resolve;
      })
    );

    const p1 = GET(req());
    const p2 = GET(req());
    const p3 = GET(req());
    resolveCompute({ unsupported: true });
    await Promise.all([p1, p2, p3]);

    expect(computePatchMovers).toHaveBeenCalledTimes(1);
  });

  it("a degraded (empty movers) result is reused for subsequent requests instead of re-computing immediately", async () => {
    vi.mocked(computePatchMovers).mockResolvedValueOnce({
      patch: "16.13",
      prevPatch: "16.12",
      movers: [],
    });
    await GET(req());
    // Second request, immediately after — an outage that hasn't recovered
    // yet must not re-trigger the full ~400-call sweep on every page view.
    await GET(req());
    expect(computePatchMovers).toHaveBeenCalledTimes(1);
  });

  it("a successful result is also reused across immediately-subsequent requests", async () => {
    vi.mocked(computePatchMovers).mockResolvedValueOnce({
      patch: "16.13",
      prevPatch: "16.12",
      movers: [mover],
    });
    await GET(req());
    await GET(req());
    expect(computePatchMovers).toHaveBeenCalledTimes(1);
  });

  it("a rejected compute is NOT cached — the next request retries rather than looping on a poisoned entry", async () => {
    vi.mocked(computePatchMovers).mockRejectedValueOnce(new Error("boom"));
    const res1 = await GET(req());
    expect(res1.status).toBe(500);

    vi.mocked(computePatchMovers).mockResolvedValueOnce({
      patch: "16.13",
      prevPatch: "16.12",
      movers: [mover],
    });
    const res2 = await GET(req());
    expect(res2.status).toBe(200);
    expect(computePatchMovers).toHaveBeenCalledTimes(2);
  });
});
