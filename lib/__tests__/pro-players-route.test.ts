/**
 * Route-level tests for GET /api/players — q validation, ILIKE escaping,
 * response shape. lib/pro/db.ts is mocked (a fake tagged-template `sql`) —
 * no network/DB.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSql = vi.fn();

vi.mock("@/lib/pro/db", () => ({
  getSql: vi.fn(() => mockSql),
}));

import { GET } from "@/app/api/players/route";
import { getSql } from "@/lib/pro/db";

const req = (qs: string) =>
  ({ url: `http://localhost/api/players${qs}` }) as unknown as Parameters<typeof GET>[0];

const ROW = {
  id: "a1b2c3d4-e5f6-4890-abcd-ef1234567890",
  name: "SomePro",
  slug: "somepro",
  team: "Some Team",
  role: 2,
  country: "DE",
  game_count: 14,
};

describe("GET /api/players validation", () => {
  beforeEach(() => {
    mockSql.mockReset();
    vi.mocked(getSql).mockReturnValue(mockSql as never);
  });

  it("400 on missing q", async () => {
    expect((await GET(req(""))).status).toBe(400);
  });

  it("400 on empty q", async () => {
    expect((await GET(req("?q="))).status).toBe(400);
  });

  it("400 on whitespace-only q", async () => {
    expect((await GET(req("?q=%20%20"))).status).toBe(400);
  });

  it("400 on q longer than 40 chars", async () => {
    const long = "a".repeat(41);
    expect((await GET(req(`?q=${long}`))).status).toBe(400);
  });

  it("200 on q at the 40-char boundary", async () => {
    mockSql.mockResolvedValueOnce([]);
    const exact = "a".repeat(40);
    const res = await GET(req(`?q=${exact}`));
    expect(res.status).toBe(200);
  });

  it("escapes % and _ so they match literally", async () => {
    mockSql.mockResolvedValueOnce([]);
    await GET(req("?q=100%25_win"));
    const values = mockSql.mock.calls[0].slice(1);
    expect(values).toContain("%100\\%\\_win%");
  });

  it("200 with mapped Player shape on success", async () => {
    mockSql.mockResolvedValueOnce([ROW]);
    const res = await GET(req("?q=some"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.players).toEqual([
      {
        id: "a1b2c3d4-e5f6-4890-abcd-ef1234567890",
        name: "SomePro",
        slug: "somepro",
        team: "Some Team",
        role: 2,
        country: "DE",
        gameCount: 14,
      },
    ]);
  });

  it("200 with empty players array when no rows match", async () => {
    mockSql.mockResolvedValueOnce([]);
    const res = await GET(req("?q=nobody"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ players: [] });
  });

  it("returns gameCount 0 players (not filtered out)", async () => {
    mockSql.mockResolvedValueOnce([{ ...ROW, game_count: 0 }]);
    const res = await GET(req("?q=some"));
    const body = await res.json();
    expect(body.players[0].gameCount).toBe(0);
  });

  it("200 with empty players when DB isn't configured", async () => {
    vi.mocked(getSql).mockReturnValueOnce(null);
    const res = await GET(req("?q=some"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ players: [] });
  });

  it("500 (no detail leak) on an unexpected DB error", async () => {
    mockSql.mockRejectedValueOnce(new Error("secret connection string"));
    const res = await GET(req("?q=some"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Internal server error");
    expect(JSON.stringify(body)).not.toContain("secret");
  });
});
