import { beforeEach, describe, expect, it, vi } from "vitest";

const mockSql = vi.fn();
vi.mock("@/lib/pro/db", () => ({ getSql: vi.fn(() => mockSql) }));

import { GET } from "@/app/api/draft/blind-pick/route";
import { getSql } from "@/lib/pro/db";

const req = (qs: string) =>
  ({ url: `http://localhost/api/draft/blind-pick${qs}` }) as unknown as Parameters<typeof GET>[0];

describe("GET /api/draft/blind-pick", () => {
  beforeEach(() => {
    mockSql.mockReset();
    vi.mocked(getSql).mockReturnValue(mockSql as never);
  });

  it("mirrors recommend lane validation, including rejecting auto lane 5", async () => {
    expect((await GET(req(""))).status).toBe(400);
    expect((await GET(req("?lane=x"))).status).toBe(400);
    expect((await GET(req("?lane=-1"))).status).toBe(400);
    expect((await GET(req("?lane=5"))).status).toBe(400);
  });

  it("returns the same error shape for an unavailable database", async () => {
    vi.mocked(getSql).mockReturnValue(null);
    const res = await GET(req("?lane=2"));

    expect(res.status).toBe(503);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toEqual({ error: "DATABASE_URL not configured" });
  });

  it("publishes populated output with matchup-row freshness and an edge cache", async () => {
    mockSql.mockImplementation((strings: TemplateStringsArray) => {
      const text = strings.join("|");
      if (text.includes("GROUP BY patch")) return Promise.resolve([{ patch: "16.13", champs: 173, latest: "old" }]);
      if (text.includes("FROM coachbuild.draft_matchup")) {
        return Promise.resolve([
          { champ_id: 1, opp_id: 10, wins: 3000, games: 6000, latest_ingested_at: "2026-07-31T12:00:00.000Z" },
          { champ_id: 2, opp_id: 10, wins: 3000, games: 6000, latest_ingested_at: "2026-07-31T12:00:00.000Z" },
        ]);
      }
      return Promise.resolve([]);
    });

    const res = await GET(req("?lane=2"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toContain("s-maxage=300");
    expect(res.headers.get("Cache-Control")).toContain("stale-while-revalidate=600");
    expect(body.meta.patch).toBe("16.13");
    expect(body.meta.fetchedAt).toBe("2026-07-31T12:00:00.000Z");
    expect(body.meta.lane).toBe(2);
    expect(body.picks.map((pick: { champId: number }) => pick.champId)).toEqual([1, 2]);
  });

  it("keeps an empty lane response honest and uncached", async () => {
    mockSql.mockImplementation((strings: TemplateStringsArray) => {
      const text = strings.join("|");
      if (text.includes("GROUP BY patch")) return Promise.resolve([{ patch: "16.13", champs: 173, latest: "old" }]);
      return Promise.resolve([]);
    });

    const res = await GET(req("?lane=2"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(body.pending).toBe(true);
    expect(body.meta.fetchedAt).toBeNull();
  });

  it("returns a 500/no-store for an unexpected database failure", async () => {
    mockSql.mockRejectedValue(new Error("boom"));
    const res = await GET(req("?lane=2"));

    expect(res.status).toBe(500);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toEqual({ error: "Internal server error" });
  });
});
