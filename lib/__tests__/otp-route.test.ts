/**
 * Tests for GET /api/otp — param validation, the ProGame projection, and the
 * `pending` vs `hidden` distinction the card's copy depends on.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSql = vi.fn();

vi.mock("@/lib/pro/db", () => ({
  getSql: vi.fn(() => mockSql),
}));

import { GET } from "@/app/api/otp/route";
import { getSql } from "@/lib/pro/db";

const req = (qs: string) =>
  ({ url: `http://localhost/api/otp${qs}` }) as unknown as Parameters<typeof GET>[0];

const GAME_ROW = {
  match_id: "EUW1_7932168433",
  puuid: "puuid-vork",
  champion_id: 112,
  champion_name: "Viktor",
  role: 2,
  patch: "16.14",
  win: true,
  kills: 2,
  deaths: 3,
  assists: 13,
  game_creation: "2026-07-28T05:52:41.142Z",
  game_duration_sec: 2018,
  spells: [4, 6],
  final_items: [3100, 2503, 3171, 6653, 3916],
  trinket: 3340,
  runes: { primaryTree: 8200, keystone: 8992, primary: [], secondaryTree: 8300, secondary: [], shards: [] },
  game_name: "Vork",
  tag_line: "135",
  region: "EUW",
  tier: "DIAMOND",
  champ_play: 661,
};

const ROSTER_ROW = { game_name: "Vork", region: "EUW", tier: "DIAMOND", champ_play: 661 };

describe("GET /api/otp", () => {
  beforeEach(() => {
    mockSql.mockReset();
    vi.mocked(getSql).mockReturnValue(mockSql as never);
  });

  it("400s without a championId", async () => {
    expect((await GET(req(""))).status).toBe(400);
    expect((await GET(req("?championId=abc"))).status).toBe(400);
  });

  it("400s on an out-of-range role", async () => {
    expect((await GET(req("?championId=112&role=9"))).status).toBe(400);
    expect((await GET(req("?championId=112&role=x"))).status).toBe(400);
  });

  it("accepts role=5 (the Builds page's default 'auto' state)", async () => {
    mockSql.mockResolvedValueOnce([GAME_ROW]).mockResolvedValueOnce([ROSTER_ROW]);
    expect((await GET(req("?championId=112&role=5"))).status).toBe(200);
  });

  it("400s on an invalid limit", async () => {
    expect((await GET(req("?championId=112&limit=0"))).status).toBe(400);
    expect((await GET(req("?championId=112&limit=-3"))).status).toBe(400);
  });

  it("projects a row into the ProGame shape with empty timeline fields", async () => {
    mockSql.mockResolvedValueOnce([GAME_ROW]).mockResolvedValueOnce([ROSTER_ROW]);
    const body = await (await GET(req("?championId=112&role=2"))).json();
    expect(body.games).toHaveLength(1);
    const g = body.games[0];
    // These ARE solo-queue Riot matches; the discriminant describes the game.
    expect(g.source).toBe("soloq");
    expect(g.player.name).toBe("Vork");
    expect(g.account).toEqual({ riotId: "Vork#135", region: "EUW" });
    expect(g.finalItems).toEqual([3100, 2503, 3171, 6653, 3916]);
    // The ingest skips the match-v5 timeline on purpose — these must be [],
    // never absent (consumers index into them).
    expect(g.purchaseOrder).toEqual([]);
    expect(g.skillOrder).toEqual([]);
  });

  it("counts per-player sample size from the RETURNED rows, not the roster", async () => {
    // A roster row's champ_play is a LIFETIME op.gg count. Reporting it as
    // "games in this sample" would inflate the card's own denominator story.
    mockSql
      .mockResolvedValueOnce([GAME_ROW, { ...GAME_ROW, match_id: "EUW1_2" }])
      .mockResolvedValueOnce([ROSTER_ROW, { ...ROSTER_ROW, game_name: "Love", champ_play: 729 }]);
    const body = await (await GET(req("?championId=112&role=2"))).json();
    expect(body.players).toEqual([
      { name: "Vork", region: "EUW", tier: "DIAMOND", championPlays: 661, gamesInSample: 2 },
      { name: "Love", region: "EUW", tier: "DIAMOND", championPlays: 729, gamesInSample: 0 },
    ]);
  });

  it("reports pending when one-tricks are tracked but no games are stored yet", async () => {
    mockSql.mockResolvedValueOnce([]).mockResolvedValueOnce([ROSTER_ROW]);
    const body = await (await GET(req("?championId=112&role=2"))).json();
    expect(body.games).toEqual([]);
    expect(body.pending).toBe(true);
  });

  it("does NOT report pending when no one-tricks are tracked at all", async () => {
    // "Still fetching" and "nobody one-tricks this champion" are different
    // facts — the card renders different copy for each.
    mockSql.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    const body = await (await GET(req("?championId=112&role=2"))).json();
    expect(body.pending).toBe(false);
  });

  it("never CDN-caches an empty result (repo gotcha (b))", async () => {
    mockSql.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    const res = await GET(req("?championId=112&role=2"));
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("caches a non-empty result", async () => {
    mockSql.mockResolvedValueOnce([GAME_ROW]).mockResolvedValueOnce([ROSTER_ROW]);
    const res = await GET(req("?championId=112&role=2"));
    expect(res.headers.get("Cache-Control")).toContain("s-maxage=1800");
  });

  it("degrades to an empty payload with no DB configured", async () => {
    vi.mocked(getSql).mockReturnValue(null as never);
    const body = await (await GET(req("?championId=112"))).json();
    expect(body).toEqual({ games: [], players: [], pending: false });
  });

  it("500s without leaking detail when a query throws", async () => {
    mockSql.mockRejectedValue(new Error("neon exploded"));
    const res = await GET(req("?championId=112&role=2"));
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("neon");
  });
});
