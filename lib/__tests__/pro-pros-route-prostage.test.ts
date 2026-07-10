/**
 * Tests for the Phase 2 additions to GET /api/pros: the `source` param
 * matrix and soloq+prostage merge ordering. Kept in a separate file from
 * lib/__tests__/pro-pros-route.test.ts (untouched — its single-query mock
 * assumptions still hold because the route defensively coerces a
 * not-explicitly-mocked second call to [], see app/api/pros/route.ts's
 * asRows()) so the original suite needed zero edits.
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

const SOLOQ_ROW = {
  match_id: "EUW1_1",
  champion_id: 103,
  champion_name: "Ahri",
  role: 2,
  patch: "16.13",
  win: true,
  kills: 5,
  deaths: 2,
  assists: 7,
  game_creation: "2026-07-05T00:00:00.000Z",
  game_duration_sec: 1800,
  spells: [4, 14],
  final_items: [6655],
  trinket: 3364,
  purchase_order: [],
  skill_order: [],
  runes: { primaryTree: 8200, keystone: 8210, primary: [], secondaryTree: 8300, secondary: [], shards: [] },
  pro_name: "SomePro",
  pro_team: "Some Team",
  pro_role: 2,
  pro_country: "DE",
  riot_id: "SomePro#EUW1",
  region: "EUW",
};

const PROSTAGE_ROW = {
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
  game_datetime: "2026-07-08T00:00:00.000Z",
  patch: null,
  spells: [4, 14],
  final_items: [6653],
  trinket: 2055,
  runes: { primaryTree: 8100, keystone: 8112, primary: [], secondaryTree: 8200, secondary: [], shards: [] },
  tournament_display: "LEC 2026 Summer",
  pro_name: null,
  pro_team: null,
  pro_role: null,
  pro_country: null,
};

describe("GET /api/pros source param", () => {
  beforeEach(() => {
    mockSql.mockReset();
    vi.mocked(getSql).mockReturnValue(mockSql as never);
  });

  it("400 on an invalid source value", async () => {
    const res = await GET(req("?championId=103&role=2&source=bogus"));
    expect(res.status).toBe(400);
  });

  it("source=soloq issues exactly one query and never touches prostage_matches", async () => {
    mockSql.mockResolvedValueOnce([SOLOQ_ROW]);
    const res = await GET(req("?championId=103&role=2&source=soloq"));
    expect(res.status).toBe(200);
    expect(mockSql).toHaveBeenCalledTimes(1);
    const body = await res.json();
    expect(body.games).toHaveLength(1);
    expect(body.games[0].source).toBe("soloq");
  });

  it("source=prostage issues exactly one query against prostage_matches", async () => {
    mockSql.mockResolvedValueOnce([PROSTAGE_ROW]);
    const res = await GET(req("?championId=103&role=2&source=prostage"));
    expect(res.status).toBe(200);
    expect(mockSql).toHaveBeenCalledTimes(1);
    const [strings] = mockSql.mock.calls[0];
    expect(strings.join("")).toContain("prostage_matches");
    const body = await res.json();
    expect(body.games).toHaveLength(1);
    expect(body.games[0].source).toBe("prostage");
    expect(body.games[0].tournament).toBe("LEC 2026 Summer");
    expect(body.games[0].account).toEqual({ riotId: "", region: "LEC 2026 Summer" });
    expect(body.games[0].gameDurationSec).toBe(0);
    expect(body.games[0].purchaseOrder).toEqual([]);
    expect(body.games[0].skillOrder).toEqual([]);
    expect(body.games[0].player.name).toBe("Faker"); // falls back to player_link when pro_name is null (unlinked)
    // Post-audit fix (P1): prostage games carry NO score/grade — Leaguepedia
    // Cargo has no CS/team-kill data, so a prostage score would always be the
    // degraded KDA+win-only formula next to fully-backfilled soloq rows on
    // the full blended formula. Omitted (not null), matching the frontend's
    // hasScoreData() render-nothing guard.
    expect(body.games[0]).not.toHaveProperty("score");
    expect(body.games[0]).not.toHaveProperty("grade");
    expect(body.games[0].csPerMin).toBeNull();
    expect(body.games[0].kp).toBeNull();
  });

  it("default (no source param) merges both sources, newest first", async () => {
    // soloq query resolves first (call order matches code: soloq then prostage)
    mockSql.mockResolvedValueOnce([SOLOQ_ROW]).mockResolvedValueOnce([PROSTAGE_ROW]);
    const res = await GET(req("?championId=103&role=2"));
    expect(res.status).toBe(200);
    expect(mockSql).toHaveBeenCalledTimes(2);
    const body = await res.json();
    expect(body.games).toHaveLength(2);
    // PROSTAGE_ROW's game_datetime (2026-07-08) is newer than SOLOQ_ROW's
    // game_creation (2026-07-05) -> prostage row sorts first.
    expect(body.games[0].source).toBe("prostage");
    expect(body.games[1].source).toBe("soloq");
  });

  it("source=all is equivalent to the default (explicit form)", async () => {
    mockSql.mockResolvedValueOnce([SOLOQ_ROW]).mockResolvedValueOnce([PROSTAGE_ROW]);
    const res = await GET(req("?championId=103&role=2&source=all"));
    expect(mockSql).toHaveBeenCalledTimes(2);
    const body = await res.json();
    expect(body.games).toHaveLength(2);
  });

  it("respects limit AFTER merging (not per-source)", async () => {
    mockSql.mockResolvedValueOnce([SOLOQ_ROW]).mockResolvedValueOnce([PROSTAGE_ROW]);
    const res = await GET(req("?championId=103&role=2&limit=1"));
    const body = await res.json();
    expect(body.games).toHaveLength(1);
    expect(body.games[0].source).toBe("prostage"); // the newer of the two
  });

  it("a prostage row with no resolvable role (unlinked, Role field unmapped) is INCLUDED under role=5 with the -1 sentinel, not dropped", async () => {
    // Post-audit fix: dropping these silently blackholed every such row from
    // every query (including all-lanes), invisible behind a green ingest.
    mockSql
      .mockResolvedValueOnce([SOLOQ_ROW])
      .mockResolvedValueOnce([{ ...PROSTAGE_ROW, role: null, pro_role: null }]);
    const res = await GET(req("?championId=103&role=5")); // role=5 (all lanes) lets the null-role row past the SQL filter
    const body = await res.json();
    expect(body.games).toHaveLength(2);
    const prostageGame = body.games.find((g: { source: string }) => g.source === "prostage");
    expect(prostageGame.role).toBe(-1);
    expect(prostageGame.player.role).toBe(-1);
  });

  it("a concrete lane filter (role=0-4) still excludes a null-role prostage row (SQL-level, unaffected by the -1 mapping fix)", async () => {
    mockSql
      .mockResolvedValueOnce([SOLOQ_ROW])
      .mockResolvedValueOnce([]); // role=2 filter means the DB query itself would never return the null-role row
    const res = await GET(req("?championId=103&role=2"));
    const body = await res.json();
    expect(body.games).toHaveLength(1);
    expect(body.games[0].source).toBe("soloq");
  });
});
