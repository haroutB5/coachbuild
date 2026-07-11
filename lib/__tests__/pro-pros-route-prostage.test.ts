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

  it("source=prostage issues the prostage query plus one batched team-comps query", async () => {
    // Phase 3 (team comps): a non-empty prostage result triggers exactly one
    // extra grouped query (batched over distinct game_ids), never a per-row
    // N+1 — see app/api/pros/route.ts's compsForGame/buildProstageCompsMap.
    mockSql.mockResolvedValueOnce([PROSTAGE_ROW]).mockResolvedValueOnce([]);
    const res = await GET(req("?championId=103&role=2&source=prostage"));
    expect(res.status).toBe(200);
    expect(mockSql).toHaveBeenCalledTimes(2);
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
  });

  it("default (no source param) merges both sources, newest first", async () => {
    // soloq query resolves first, then prostage, then the team-comps query
    // (call order matches code: soloq then prostage then comps).
    mockSql.mockResolvedValueOnce([SOLOQ_ROW]).mockResolvedValueOnce([PROSTAGE_ROW]).mockResolvedValueOnce([]);
    const res = await GET(req("?championId=103&role=2"));
    expect(res.status).toBe(200);
    expect(mockSql).toHaveBeenCalledTimes(3);
    const body = await res.json();
    expect(body.games).toHaveLength(2);
    // PROSTAGE_ROW's game_datetime (2026-07-08) is newer than SOLOQ_ROW's
    // game_creation (2026-07-05) -> prostage row sorts first.
    expect(body.games[0].source).toBe("prostage");
    expect(body.games[1].source).toBe("soloq");
  });

  it("source=all is equivalent to the default (explicit form)", async () => {
    mockSql.mockResolvedValueOnce([SOLOQ_ROW]).mockResolvedValueOnce([PROSTAGE_ROW]).mockResolvedValueOnce([]);
    const res = await GET(req("?championId=103&role=2&source=all"));
    expect(mockSql).toHaveBeenCalledTimes(3);
    const body = await res.json();
    expect(body.games).toHaveLength(2);
  });

  it("respects limit AFTER merging (not per-source)", async () => {
    mockSql.mockResolvedValueOnce([SOLOQ_ROW]).mockResolvedValueOnce([PROSTAGE_ROW]).mockResolvedValueOnce([]);
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
      .mockResolvedValueOnce([{ ...PROSTAGE_ROW, role: null, pro_role: null }])
      .mockResolvedValueOnce([]);
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
    // No prostage rows -> no game_ids -> the team-comps query never fires.
    expect(mockSql).toHaveBeenCalledTimes(2);
  });
});

describe("GET /api/pros prostage team comps (Phase 3)", () => {
  beforeEach(() => {
    mockSql.mockReset();
    vi.mocked(getSql).mockReturnValue(mockSql as never);
  });

  // A clean 10-row game: 5 on the row's own team (T1, including the row's
  // own champion_id 103) + 5 on the one other team (GEN).
  const CLEAN_GAME_ROWS = [
    { game_id: "LEC_2026_Summer_1_1", team: "T1", champion_id: 103 },
    { game_id: "LEC_2026_Summer_1_1", team: "T1", champion_id: 1 },
    { game_id: "LEC_2026_Summer_1_1", team: "T1", champion_id: 2 },
    { game_id: "LEC_2026_Summer_1_1", team: "T1", champion_id: 3 },
    { game_id: "LEC_2026_Summer_1_1", team: "T1", champion_id: 4 },
    { game_id: "LEC_2026_Summer_1_1", team: "GEN", champion_id: 5 },
    { game_id: "LEC_2026_Summer_1_1", team: "GEN", champion_id: 6 },
    { game_id: "LEC_2026_Summer_1_1", team: "GEN", champion_id: 7 },
    { game_id: "LEC_2026_Summer_1_1", team: "GEN", champion_id: 8 },
    { game_id: "LEC_2026_Summer_1_1", team: "GEN", champion_id: 9 },
  ];

  it("emits allyChampionIds (incl. own champion) + enemyChampionIds for a clean 10-row 5v5 game", async () => {
    mockSql.mockResolvedValueOnce([PROSTAGE_ROW]).mockResolvedValueOnce(CLEAN_GAME_ROWS);
    const res = await GET(req("?championId=103&role=2&source=prostage"));
    const body = await res.json();
    expect(body.games).toHaveLength(1);
    expect(body.games[0].allyChampionIds).toEqual([103, 1, 2, 3, 4]);
    expect(body.games[0].enemyChampionIds).toEqual([5, 6, 7, 8, 9]);
  });

  it("omits both fields when the game doesn't have a clean 5/5 split (e.g. a row missing)", async () => {
    const incompleteGame = CLEAN_GAME_ROWS.slice(0, 9); // only 4 on GEN
    mockSql.mockResolvedValueOnce([PROSTAGE_ROW]).mockResolvedValueOnce(incompleteGame);
    const res = await GET(req("?championId=103&role=2&source=prostage"));
    const body = await res.json();
    expect(body.games[0].allyChampionIds).toBeUndefined();
    expect(body.games[0].enemyChampionIds).toBeUndefined();
  });

  it("omits both fields when the row's own team is null", async () => {
    mockSql.mockResolvedValueOnce([{ ...PROSTAGE_ROW, team: null }]).mockResolvedValueOnce(CLEAN_GAME_ROWS);
    const res = await GET(req("?championId=103&role=2&source=prostage"));
    const body = await res.json();
    expect(body.games[0].allyChampionIds).toBeUndefined();
    expect(body.games[0].enemyChampionIds).toBeUndefined();
  });

  it("role-orders each side (Top/Jungle/Mid/Bot/Support) when the comp rows carry a resolvable role", async () => {
    // T1: Faker (103, own champion) is MID(2); rest scrambled across roles.
    // GEN: also a clean 5-role set, scrambled.
    const roleOrderedGame = [
      { game_id: "LEC_2026_Summer_1_1", team: "T1", champion_id: 1, role: 0, pro_role: null }, // top
      { game_id: "LEC_2026_Summer_1_1", team: "T1", champion_id: 2, role: 1, pro_role: null }, // jungle
      { game_id: "LEC_2026_Summer_1_1", team: "T1", champion_id: 103, role: null, pro_role: 2 }, // Faker, mid, via pro_role fallback
      { game_id: "LEC_2026_Summer_1_1", team: "T1", champion_id: 3, role: 3, pro_role: null }, // bot
      { game_id: "LEC_2026_Summer_1_1", team: "T1", champion_id: 4, role: 4, pro_role: null }, // support
      { game_id: "LEC_2026_Summer_1_1", team: "GEN", champion_id: 9, role: 4, pro_role: null }, // support
      { game_id: "LEC_2026_Summer_1_1", team: "GEN", champion_id: 8, role: 3, pro_role: null }, // bot
      { game_id: "LEC_2026_Summer_1_1", team: "GEN", champion_id: 7, role: 2, pro_role: null }, // mid
      { game_id: "LEC_2026_Summer_1_1", team: "GEN", champion_id: 6, role: 1, pro_role: null }, // jungle
      { game_id: "LEC_2026_Summer_1_1", team: "GEN", champion_id: 5, role: 0, pro_role: null }, // top
    ];
    mockSql.mockResolvedValueOnce([PROSTAGE_ROW]).mockResolvedValueOnce(roleOrderedGame);
    const res = await GET(req("?championId=103&role=2&source=prostage"));
    const body = await res.json();
    expect(body.games[0].allyChampionIds).toEqual([1, 2, 103, 3, 4]); // top, jungle, MID (Faker) at index 2, bot, support
    expect(body.games[0].allyChampionIds[2]).toBe(103);
    expect(body.games[0].enemyChampionIds).toEqual([5, 6, 7, 8, 9]); // top, jungle, mid, bot, support
  });

  it("falls back to the query's row order when a side's roles don't resolve to 5 distinct known roles", async () => {
    const noRoleGame = CLEAN_GAME_ROWS.map((r) => ({ ...r, role: null, pro_role: null }));
    mockSql.mockResolvedValueOnce([PROSTAGE_ROW]).mockResolvedValueOnce(noRoleGame);
    const res = await GET(req("?championId=103&role=2&source=prostage"));
    const body = await res.json();
    // CLEAN_GAME_ROWS is already listed in (row) order [103,1,2,3,4] / [5,6,7,8,9] —
    // with no resolvable role, the fallback is that same source order.
    expect(body.games[0].allyChampionIds).toEqual([103, 1, 2, 3, 4]);
    expect(body.games[0].enemyChampionIds).toEqual([5, 6, 7, 8, 9]);
  });

  it("omits both fields when a third team is present (data too messy to call ally/enemy)", async () => {
    const threeTeamGame = [
      ...CLEAN_GAME_ROWS.slice(0, 5), // T1 x5 (incl. row's own champion 103)
      { game_id: "LEC_2026_Summer_1_1", team: "GEN", champion_id: 5 },
      { game_id: "LEC_2026_Summer_1_1", team: "GEN", champion_id: 6 },
      { game_id: "LEC_2026_Summer_1_1", team: "GEN", champion_id: 7 },
      { game_id: "LEC_2026_Summer_1_1", team: "FNC", champion_id: 8 },
      { game_id: "LEC_2026_Summer_1_1", team: "FNC", champion_id: 9 },
    ];
    mockSql.mockResolvedValueOnce([PROSTAGE_ROW]).mockResolvedValueOnce(threeTeamGame);
    const res = await GET(req("?championId=103&role=2&source=prostage"));
    const body = await res.json();
    expect(body.games[0].allyChampionIds).toBeUndefined();
    expect(body.games[0].enemyChampionIds).toBeUndefined();
  });
});
