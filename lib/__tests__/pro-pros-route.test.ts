/**
 * Route-level tests for GET /api/pros — param validation + response shape.
 * lib/pro/db.ts is mocked (a fake tagged-template `sql`) — no network/DB.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSql = vi.fn();

vi.mock("@/lib/pro/db", () => ({
  getSql: vi.fn(() => mockSql),
}));

import { GET } from "@/app/api/pros/route";
import { getSql } from "@/lib/pro/db";

const req = (qs: string) =>
  ({ url: `http://localhost/api/pros${qs}` }) as unknown as Parameters<typeof GET>[0];

const ROW = {
  match_id: "EUW1_1",
  champion_id: 112,
  champion_name: "Viktor",
  role: 2,
  patch: "16.13",
  win: true,
  kills: 5,
  deaths: 2,
  assists: 7,
  game_creation: "2026-07-01T00:00:00.000Z",
  game_duration_sec: 1800,
  spells: [4, 14],
  final_items: [6655, 4645, 3020],
  trinket: 3364,
  purchase_order: [{ itemId: 1054, ts: 65 }],
  skill_order: ["Q", "W", "E"],
  runes: { primaryTree: 8200, keystone: 8210, primary: [8226, 8210, 8237], secondaryTree: 8300, secondary: [8345, 8347], shards: [5008, 5008, 5001] },
  pro_name: "SomePro",
  pro_team: "Some Team",
  pro_role: 2,
  pro_country: "DE",
  riot_id: "SomePro#EUW1",
  region: "EUW",
};

describe("GET /api/pros validation", () => {
  beforeEach(() => {
    mockSql.mockReset();
    vi.mocked(getSql).mockReturnValue(mockSql as never);
  });

  it("400 on missing params", async () => {
    expect((await GET(req(""))).status).toBe(400);
  });

  it("400 on non-integer championId/role", async () => {
    expect((await GET(req("?championId=abc&role=2"))).status).toBe(400);
    expect((await GET(req("?championId=112&role=2x"))).status).toBe(400);
  });

  it("400 on out-of-range role (must be 0-5)", async () => {
    expect((await GET(req("?championId=112&role=6"))).status).toBe(400);
    expect((await GET(req("?championId=112&role=-1"))).status).toBe(400);
  });

  it("role=5 (auto) is accepted and means all lanes", async () => {
    mockSql.mockResolvedValue([ROW]);
    const res = await GET(req("?championId=112&role=5"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.games).toHaveLength(1);
  });

  it("400 on invalid limit", async () => {
    expect((await GET(req("?championId=112&role=2&limit=0"))).status).toBe(400);
    expect((await GET(req("?championId=112&role=2&limit=abc"))).status).toBe(400);
  });

  it("200 with empty games when DB isn't configured", async () => {
    vi.mocked(getSql).mockReturnValueOnce(null);
    const res = await GET(req("?championId=112&role=2"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ games: [] });
  });

  it("200 with mapped ProGame shape on success", async () => {
    mockSql.mockResolvedValueOnce([ROW]);
    const res = await GET(req("?championId=112&role=2"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.games).toHaveLength(1);
    expect(body.games[0]).toEqual({
      id: "EUW1_1",
      source: "soloq",
      player: { name: "SomePro", team: "Some Team", role: 2, country: "DE" },
      account: { riotId: "SomePro#EUW1", region: "EUW" },
      championId: 112,
      championName: "Viktor",
      role: 2,
      patch: "16.13",
      win: true,
      kills: 5,
      deaths: 2,
      assists: 7,
      gameCreation: "2026-07-01T00:00:00.000Z",
      gameDurationSec: 1800,
      spells: [4, 14],
      finalItems: [6655, 4645, 3020],
      trinket: 3364,
      purchaseOrder: [{ itemId: 1054, ts: 65 }],
      skillOrder: ["Q", "W", "E"],
      runes: { primaryTree: 8200, keystone: 8210, primary: [8226, 8210, 8237], secondaryTree: 8300, secondary: [8345, 8347], shards: [5008, 5008, 5001] },
    });
  });

  it("empty array when the query returns no rows", async () => {
    mockSql.mockResolvedValueOnce([]);
    const res = await GET(req("?championId=999&role=0"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ games: [] });
  });

  it("500 (no detail leak) on an unexpected DB error", async () => {
    mockSql.mockRejectedValueOnce(new Error("secret connection string"));
    const res = await GET(req("?championId=112&role=2"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Internal server error");
    expect(JSON.stringify(body)).not.toContain("secret");
  });
});

const PRO_ID = "a1b2c3d4-e5f6-4890-abcd-ef1234567890";

describe("GET /api/pros proId matrix", () => {
  beforeEach(() => {
    mockSql.mockReset();
    vi.mocked(getSql).mockReturnValue(mockSql as never);
  });

  it("400 when both championId and proId are given", async () => {
    const res = await GET(req(`?championId=112&role=2&proId=${PRO_ID}`));
    expect(res.status).toBe(400);
  });

  it("400 when neither championId nor proId are given", async () => {
    const res = await GET(req("?role=2"));
    expect(res.status).toBe(400);
  });

  it("400 on malformed proId", async () => {
    const res = await GET(req("?proId=not-a-uuid"));
    expect(res.status).toBe(400);
  });

  it("proId happy path — role optional, defaults to all lanes", async () => {
    mockSql.mockResolvedValueOnce([ROW]);
    const res = await GET(req(`?proId=${PRO_ID}`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.games).toHaveLength(1);
    const [strings] = mockSql.mock.calls[0];
    expect(strings.join("")).toContain("pm.pro_id");
    expect(strings.join("")).not.toContain("pm.champion_id =");
  });

  it("proId + role filters by lane", async () => {
    mockSql.mockResolvedValueOnce([ROW]);
    const res = await GET(req(`?proId=${PRO_ID}&role=2`));
    expect(res.status).toBe(200);
    const values = mockSql.mock.calls[0].slice(1);
    expect(values).toContain(2);
  });

  it("400 on invalid role alongside proId", async () => {
    const res = await GET(req(`?proId=${PRO_ID}&role=9`));
    expect(res.status).toBe(400);
  });
});
