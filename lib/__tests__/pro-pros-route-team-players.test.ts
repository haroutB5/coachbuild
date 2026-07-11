/**
 * Route-level tests for the Phase 4 per-player team data
 * (allyPlayers/enemyPlayers, lib/pro/types.ts's TeamCompPlayer) on
 * GET /api/pros — soloq (ally_players/enemy_players jsonb columns) and
 * prostage (built from the existing batched comps query, extended with
 * player_link/final_items/trinket/pro_name). Kept in its own file so the
 * baseline route.test.ts / route-prostage.test.ts suites (untouched) don't
 * need to grow unrelated assertions.
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

const SOLOQ_TEAM_COMP_PLAYER = (championId: number, role: number | null, name: string | null) => ({
  championId,
  name,
  items: [1001, 1002],
  trinket: 3364,
  role,
});

const SOLOQ_ROW_BASE = {
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

describe("GET /api/pros soloq allyPlayers/enemyPlayers", () => {
  beforeEach(() => {
    mockSql.mockReset();
    vi.mocked(getSql).mockReturnValue(mockSql as never);
  });

  it("emits allyPlayers/enemyPlayers when both columns hold exactly 5 entries", async () => {
    const allyPlayers = [0, 1, 2, 3, 4].map((r) => SOLOQ_TEAM_COMP_PLAYER(100 + r, r, `Ally${r}`));
    const enemyPlayers = [0, 1, 2, 3, 4].map((r) => SOLOQ_TEAM_COMP_PLAYER(200 + r, r, `Enemy${r}`));
    mockSql.mockResolvedValueOnce([{ ...SOLOQ_ROW_BASE, ally_players: allyPlayers, enemy_players: enemyPlayers }]);
    const res = await GET(req("?championId=112&role=2&source=soloq"));
    const body = await res.json();
    expect(body.games[0].allyPlayers).toEqual(allyPlayers);
    expect(body.games[0].enemyPlayers).toEqual(enemyPlayers);
  });

  it("omits both fields when ally_players/enemy_players are NULL (not yet backfilled)", async () => {
    mockSql.mockResolvedValueOnce([{ ...SOLOQ_ROW_BASE, ally_players: null, enemy_players: null }]);
    const res = await GET(req("?championId=112&role=2&source=soloq"));
    const body = await res.json();
    expect(body.games[0].allyPlayers).toBeUndefined();
    expect(body.games[0].enemyPlayers).toBeUndefined();
  });

  it("omits both fields when one side has fewer than 5 entries (never a partial side)", async () => {
    const allyPlayers = [0, 1, 2, 3].map((r) => SOLOQ_TEAM_COMP_PLAYER(100 + r, r, `Ally${r}`)); // only 4
    const enemyPlayers = [0, 1, 2, 3, 4].map((r) => SOLOQ_TEAM_COMP_PLAYER(200 + r, r, `Enemy${r}`));
    mockSql.mockResolvedValueOnce([{ ...SOLOQ_ROW_BASE, ally_players: allyPlayers, enemy_players: enemyPlayers }]);
    const res = await GET(req("?championId=112&role=2&source=soloq"));
    const body = await res.json();
    expect(body.games[0].allyPlayers).toBeUndefined();
    expect(body.games[0].enemyPlayers).toBeUndefined();
  });

  it("still emits allyChampionIds/enemyChampionIds independently even when allyPlayers/enemyPlayers are absent", async () => {
    // ally_champion_ids/enemy_champion_ids (migration 0006) backfilled, but
    // ally_players/enemy_players (migration 0007) not yet — the two pairs
    // check their own 5/5 guard independently (see soloqComps/soloqPlayers).
    mockSql.mockResolvedValueOnce([
      {
        ...SOLOQ_ROW_BASE,
        ally_champion_ids: [1, 2, 3, 4, 5],
        enemy_champion_ids: [6, 7, 8, 9, 10],
        ally_players: null,
        enemy_players: null,
      },
    ]);
    const res = await GET(req("?championId=112&role=2&source=soloq"));
    const body = await res.json();
    expect(body.games[0].allyChampionIds).toEqual([1, 2, 3, 4, 5]);
    expect(body.games[0].enemyChampionIds).toEqual([6, 7, 8, 9, 10]);
    expect(body.games[0].allyPlayers).toBeUndefined();
  });
});

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
  pro_name: "Faker",
  pro_team: "T1",
  pro_role: 2,
  pro_country: "KR",
};

describe("GET /api/pros prostage allyPlayers/enemyPlayers", () => {
  beforeEach(() => {
    mockSql.mockReset();
    vi.mocked(getSql).mockReturnValue(mockSql as never);
  });

  const CLEAN_GAME_ROWS_WITH_PLAYERS = [
    { game_id: "LEC_2026_Summer_1_1", team: "T1", champion_id: 103, player_link: "Faker", final_items: [6653, 0], trinket: 2055, pro_name: "Faker" },
    { game_id: "LEC_2026_Summer_1_1", team: "T1", champion_id: 1, player_link: "Zeus", final_items: [1001], trinket: 3340, pro_name: "Zeus" },
    { game_id: "LEC_2026_Summer_1_1", team: "T1", champion_id: 2, player_link: "Oner", final_items: [1002], trinket: 3340, pro_name: null },
    { game_id: "LEC_2026_Summer_1_1", team: "T1", champion_id: 3, player_link: "Gumayusi", final_items: [1003], trinket: 3340, pro_name: null },
    { game_id: "LEC_2026_Summer_1_1", team: "T1", champion_id: 4, player_link: "Keria", final_items: [1004], trinket: 3340, pro_name: null },
    { game_id: "LEC_2026_Summer_1_1", team: "GEN", champion_id: 5, player_link: "Kiin", final_items: [1005], trinket: 3340, pro_name: null },
    { game_id: "LEC_2026_Summer_1_1", team: "GEN", champion_id: 6, player_link: "Canyon", final_items: [1006], trinket: 3340, pro_name: null },
    { game_id: "LEC_2026_Summer_1_1", team: "GEN", champion_id: 7, player_link: "Chovy", final_items: [1007], trinket: 3340, pro_name: null },
    { game_id: "LEC_2026_Summer_1_1", team: "GEN", champion_id: 8, player_link: "Peyz", final_items: [1008], trinket: 3340, pro_name: null },
    { game_id: "LEC_2026_Summer_1_1", team: "GEN", champion_id: 9, player_link: "Duro", final_items: [1009], trinket: 3340, pro_name: null },
  ];

  it("emits allyPlayers/enemyPlayers with name preferring pros.name, 0s filtered from items", async () => {
    mockSql.mockResolvedValueOnce([PROSTAGE_ROW]).mockResolvedValueOnce(CLEAN_GAME_ROWS_WITH_PLAYERS);
    const res = await GET(req("?championId=103&role=2&source=prostage"));
    const body = await res.json();
    expect(body.games[0].allyPlayers).toHaveLength(5);
    expect(body.games[0].enemyPlayers).toHaveLength(5);
    const faker = body.games[0].allyPlayers.find((p: { championId: number }) => p.championId === 103);
    expect(faker.name).toBe("Faker"); // linked pro name
    expect(faker.items).toEqual([6653]); // 0 filtered out
    expect(faker.trinket).toBe(2055);
    const oner = body.games[0].allyPlayers.find((p: { championId: number }) => p.championId === 2);
    expect(oner.name).toBe("Oner"); // unlinked -> falls back to player_link
  });

  it("allyPlayers/allyChampionIds stay in lockstep (same slot order, derived from one ordering pass)", async () => {
    const roleOrderedGame = [
      { game_id: "LEC_2026_Summer_1_1", team: "T1", champion_id: 1, role: 0, pro_role: null, player_link: "p1", final_items: [1], trinket: null, pro_name: null },
      { game_id: "LEC_2026_Summer_1_1", team: "T1", champion_id: 2, role: 1, pro_role: null, player_link: "p2", final_items: [2], trinket: null, pro_name: null },
      { game_id: "LEC_2026_Summer_1_1", team: "T1", champion_id: 103, role: null, pro_role: 2, player_link: "Faker", final_items: [6653], trinket: 2055, pro_name: "Faker" },
      { game_id: "LEC_2026_Summer_1_1", team: "T1", champion_id: 3, role: 3, pro_role: null, player_link: "p3", final_items: [3], trinket: null, pro_name: null },
      { game_id: "LEC_2026_Summer_1_1", team: "T1", champion_id: 4, role: 4, pro_role: null, player_link: "p4", final_items: [4], trinket: null, pro_name: null },
      { game_id: "LEC_2026_Summer_1_1", team: "GEN", champion_id: 9, role: 4, pro_role: null, player_link: "p9", final_items: [9], trinket: null, pro_name: null },
      { game_id: "LEC_2026_Summer_1_1", team: "GEN", champion_id: 8, role: 3, pro_role: null, player_link: "p8", final_items: [8], trinket: null, pro_name: null },
      { game_id: "LEC_2026_Summer_1_1", team: "GEN", champion_id: 7, role: 2, pro_role: null, player_link: "p7", final_items: [7], trinket: null, pro_name: null },
      { game_id: "LEC_2026_Summer_1_1", team: "GEN", champion_id: 6, role: 1, pro_role: null, player_link: "p6", final_items: [6], trinket: null, pro_name: null },
      { game_id: "LEC_2026_Summer_1_1", team: "GEN", champion_id: 5, role: 0, pro_role: null, player_link: "p5", final_items: [5], trinket: null, pro_name: null },
    ];
    mockSql.mockResolvedValueOnce([PROSTAGE_ROW]).mockResolvedValueOnce(roleOrderedGame);
    const res = await GET(req("?championId=103&role=2&source=prostage"));
    const body = await res.json();
    expect(body.games[0].allyChampionIds).toEqual([1, 2, 103, 3, 4]);
    expect(body.games[0].allyPlayers.map((p: { championId: number }) => p.championId)).toEqual([1, 2, 103, 3, 4]);
    expect(body.games[0].allyPlayers[2].name).toBe("Faker");
    expect(body.games[0].enemyChampionIds).toEqual([5, 6, 7, 8, 9]);
    expect(body.games[0].enemyPlayers.map((p: { championId: number }) => p.championId)).toEqual([5, 6, 7, 8, 9]);
  });

  it("omits allyPlayers/enemyPlayers (and allyChampionIds/enemyChampionIds) together when the split isn't clean 5/5", async () => {
    const incompleteGame = CLEAN_GAME_ROWS_WITH_PLAYERS.slice(0, 9); // only 4 on GEN
    mockSql.mockResolvedValueOnce([PROSTAGE_ROW]).mockResolvedValueOnce(incompleteGame);
    const res = await GET(req("?championId=103&role=2&source=prostage"));
    const body = await res.json();
    expect(body.games[0].allyChampionIds).toBeUndefined();
    expect(body.games[0].enemyChampionIds).toBeUndefined();
    expect(body.games[0].allyPlayers).toBeUndefined();
    expect(body.games[0].enemyPlayers).toBeUndefined();
  });
});
