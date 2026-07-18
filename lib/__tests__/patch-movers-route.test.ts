/**
 * Feature 4 route: GET /api/patch-movers — role validation + cache discipline
 * (never CDN-cache unsupported/degraded; hard-cache real results). Engine mocked.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/patchMovers", () => ({ computePatchMovers: vi.fn() }));

import { GET } from "@/app/api/patch-movers/route";
import { computePatchMovers, type PatchMover } from "@/lib/patchMovers";

const req = (qs: string) =>
  ({ url: `http://localhost/api/patch-movers${qs}` }) as unknown as Parameters<typeof GET>[0];

const mover: PatchMover = {
  championId: 112, championName: "Viktor", lane: 2, kind: "keystone",
  name: "Electrocute", iconHint: "x.png", prevWpa: 0.1, currWpa: 0.6, delta: 0.5, gamesCount: 300000,
};

describe("GET /api/patch-movers", () => {
  beforeEach(() => vi.mocked(computePatchMovers).mockReset());

  it("400 on missing / non-integer / out-of-range role (5 is auto, not a lane)", async () => {
    expect((await GET(req(""))).status).toBe(400);
    expect((await GET(req("?role=x"))).status).toBe(400);
    expect((await GET(req("?role=5"))).status).toBe(400);
    expect((await GET(req("?role=9"))).status).toBe(400);
  });

  it("unsupported → 200 + no-store (never CDN-cache a hidden page)", async () => {
    vi.mocked(computePatchMovers).mockResolvedValueOnce({ unsupported: true });
    const res = await GET(req("?role=2"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ unsupported: true });
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("empty movers → no-store (degraded, per repo Gotcha (b))", async () => {
    vi.mocked(computePatchMovers).mockResolvedValueOnce({
      patch: "16.13", prevPatch: "16.12", movers: [],
    });
    const res = await GET(req("?role=2"));
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("real movers → hard 24h SWR cache", async () => {
    vi.mocked(computePatchMovers).mockResolvedValueOnce({
      patch: "16.13", prevPatch: "16.12", movers: [mover],
    });
    const res = await GET(req("?role=2"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.movers).toHaveLength(1);
    expect(res.headers.get("Cache-Control")).toContain("s-maxage=86400");
  });

  it("passes the parsed lane to the engine", async () => {
    vi.mocked(computePatchMovers).mockResolvedValueOnce({
      patch: "16.13", prevPatch: "16.12", movers: [mover],
    });
    await GET(req("?role=3"));
    expect(vi.mocked(computePatchMovers).mock.calls[0][0]).toBe(3);
  });
});
