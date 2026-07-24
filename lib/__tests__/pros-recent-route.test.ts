/**
 * GET /api/pros/recent — limit validation, no-DB degrade, and the
 * never-CDN-cache-an-empty-response gotcha (mirrors app/api/pros/route.ts's
 * own test conventions).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSql = vi.fn();
vi.mock("@/lib/pro/db", () => ({ getSql: vi.fn(() => mockSql) }));

import { GET } from "@/app/api/pros/recent/route";
import { getSql } from "@/lib/pro/db";

const req = (qs = "") =>
  ({ url: `http://localhost/api/pros/recent${qs}` }) as unknown as Parameters<typeof GET>[0];

const ROW = {
  game_id: "LEC_2026_Summer_1_1",
  player_link: "Faker",
  team: "T1",
  champion_id: 103,
  champion_name: "Ahri",
  role: 2,
  win: true,
  kills: 8,
  deaths: 1,
  assists: 10,
  tournament_display: "LEC 2026 Summer",
  pro_name: null,
  pro_team: null,
};

describe("GET /api/pros/recent", () => {
  beforeEach(() => {
    mockSql.mockReset();
    vi.mocked(getSql).mockReturnValue(mockSql as never);
  });

  it("400 on a non-numeric limit", async () => {
    const res = await GET(req("?limit=abc"));
    expect(res.status).toBe(400);
  });

  it("400 on a zero/negative limit", async () => {
    expect((await GET(req("?limit=0"))).status).toBe(400);
  });

  it("defaults to limit=20 when absent", async () => {
    mockSql.mockResolvedValueOnce([]);
    await GET(req());
    const [strings, ...values] = mockSql.mock.calls[0];
    expect(strings.join("")).toContain("ORDER BY pm.game_datetime DESC");
    expect(values).toContain(20);
  });

  it("caps an oversized limit at 50", async () => {
    mockSql.mockResolvedValueOnce([]);
    await GET(req("?limit=500"));
    const [, ...values] = mockSql.mock.calls[0];
    expect(values).toContain(50);
  });

  it("no DB configured -> empty games, no-store, never queries", async () => {
    vi.mocked(getSql).mockReturnValueOnce(null);
    const res = await GET(req());
    expect(await res.json()).toEqual({ games: [] });
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(mockSql).not.toHaveBeenCalled();
  });

  it("empty result -> no-store (repo Gotcha (b), never pin an empty feed at the edge)", async () => {
    mockSql.mockResolvedValueOnce([]);
    const res = await GET(req());
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect((await res.json()).games).toEqual([]);
  });

  it("non-empty result -> shaped via mapProRecentRow, s-maxage cached", async () => {
    mockSql.mockResolvedValueOnce([ROW]);
    const res = await GET(req());
    expect(res.headers.get("Cache-Control")).toContain("s-maxage=1800");
    const body = await res.json();
    expect(body.games).toHaveLength(1);
    expect(body.games[0]).toMatchObject({
      gameId: "LEC_2026_Summer_1_1",
      playerName: "Faker",
      team: "T1",
      championId: 103,
      event: "LEC 2026 Summer",
    });
  });

  it("500 on a query error", async () => {
    mockSql.mockRejectedValueOnce(new Error("boom"));
    const res = await GET(req());
    expect(res.status).toBe(500);
  });
});
