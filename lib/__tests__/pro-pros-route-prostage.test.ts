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

  it("source=prostage issues the prostage query plus one pros name-index query plus one batched team-comps query", async () => {
    // Phase 3 (team comps): a non-empty prostage result triggers exactly one
    // extra grouped query (batched over distinct game_ids), never a per-row
    // N+1 — see app/api/pros/route.ts's compsForGame/lib/prostage/teamComps.ts's
    // buildProstageCompsMap. The pros (id, name) name-index query (proId
    // fallback matching) rides in the TOP-level Promise.all alongside
    // prostageRows (2026-07-11 P2 perf fix: it doesn't depend on gameIds, so
    // it no longer waits for a second sequential round-trip) — call order is
    // now prostageRows, prosNameRows, THEN the gameIds-dependent comps query.
    mockSql.mockResolvedValueOnce([PROSTAGE_ROW]).mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    const res = await GET(req("?championId=103&role=2&source=prostage"));
    expect(res.status).toBe(200);
    expect(mockSql).toHaveBeenCalledTimes(3);
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
    expect(body.games[0].player.name).toBe("Faker"); // falls back to CLEANED player_link when pro_name is null (unlinked); "Faker" has no trailing parenthetical to strip
  });

  it("default (no source param) merges both sources, newest first", async () => {
    // call order: soloqRows, prostageRows, prosNameRows (all three in the
    // top-level Promise.all), then the gameIds-dependent comps query
    // (sequential, 2026-07-11 P2 fix — see app/api/pros/route.ts).
    mockSql
      .mockResolvedValueOnce([SOLOQ_ROW])
      .mockResolvedValueOnce([PROSTAGE_ROW])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    const res = await GET(req("?championId=103&role=2"));
    expect(res.status).toBe(200);
    expect(mockSql).toHaveBeenCalledTimes(4);
    const body = await res.json();
    expect(body.games).toHaveLength(2);
    // PROSTAGE_ROW's game_datetime (2026-07-08) is newer than SOLOQ_ROW's
    // game_creation (2026-07-05) -> prostage row sorts first.
    expect(body.games[0].source).toBe("prostage");
    expect(body.games[1].source).toBe("soloq");
  });

  it("400s on a non-numeric proMin", async () => {
    const res = await GET(req("?championId=103&role=2&proMin=lots"));
    expect(res.status).toBe(400);
  });

  it("proMin reserves result slots for pro play instead of letting soloq recency win", async () => {
    // The starvation shape from the 2026-07-28 report, miniaturised: every
    // soloq row is newer than every prostage row, so a plain recency merge
    // with limit=3 returns 3 soloq rows and zero pro play. proMin=2 must land
    // both prostage rows and only the single newest soloq row.
    const soloq = [0, 1, 2, 3].map((i) => ({
      ...SOLOQ_ROW,
      match_id: `EUW1_${i}`,
      game_creation: `2026-07-2${5 - i}T00:00:00.000Z`,
    }));
    const prostage = [0, 1].map((i) => ({
      ...PROSTAGE_ROW,
      game_id: `LEC_2026_Summer_1_${i}`,
      game_datetime: `2026-07-1${5 - i}T00:00:00.000Z`,
    }));
    mockSql
      .mockResolvedValueOnce(soloq)
      .mockResolvedValueOnce(prostage)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    const res = await GET(req("?championId=103&role=2&limit=3&proMin=2"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.games).toHaveLength(3);
    expect(body.games.filter((g: { source: string }) => g.source === "prostage")).toHaveLength(2);
    expect(body.games.filter((g: { source: string }) => g.source === "soloq")).toHaveLength(1);
    // Still recency-ordered overall.
    expect(body.games[0].source).toBe("soloq");
  });

  it("omitting proMin leaves the plain recency merge untouched", async () => {
    const soloq = [0, 1, 2].map((i) => ({
      ...SOLOQ_ROW,
      match_id: `EUW1_${i}`,
      game_creation: `2026-07-2${5 - i}T00:00:00.000Z`,
    }));
    mockSql
      .mockResolvedValueOnce(soloq)
      .mockResolvedValueOnce([{ ...PROSTAGE_ROW, game_datetime: "2026-07-10T00:00:00.000Z" }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    const res = await GET(req("?championId=103&role=2&limit=3"));
    const body = await res.json();
    expect(body.games).toHaveLength(3);
    expect(body.games.every((g: { source: string }) => g.source === "soloq")).toBe(true);
  });

  it("source=all is equivalent to the default (explicit form)", async () => {
    mockSql
      .mockResolvedValueOnce([SOLOQ_ROW])
      .mockResolvedValueOnce([PROSTAGE_ROW])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    const res = await GET(req("?championId=103&role=2&source=all"));
    expect(mockSql).toHaveBeenCalledTimes(4);
    const body = await res.json();
    expect(body.games).toHaveLength(2);
  });

  it("respects limit AFTER merging (not per-source)", async () => {
    mockSql
      .mockResolvedValueOnce([SOLOQ_ROW])
      .mockResolvedValueOnce([PROSTAGE_ROW])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
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
      .mockResolvedValueOnce([])
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
      .mockResolvedValueOnce([]) // role=2 filter means the DB query itself would never return the null-role row
      .mockResolvedValueOnce([]); // pros name-index — fires unconditionally when wantProstage (2026-07-11 P2 perf fix), regardless of whether any prostage row came back
    const res = await GET(req("?championId=103&role=2"));
    const body = await res.json();
    expect(body.games).toHaveLength(1);
    expect(body.games[0].source).toBe("soloq");
    // No prostage rows -> no game_ids -> the gameIds-dependent team-comps
    // query never fires. The pros name-index query DOES still fire (it rides
    // in the top-level Promise.all alongside soloq/prostage, gated only on
    // wantProstage, not on gameIds) -> 3 calls total, not 2.
    expect(mockSql).toHaveBeenCalledTimes(3);
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
    // call order: prostageRows, pros name-index (rides alongside it in the
    // top-level Promise.all — 2026-07-11 P2 fix), then the gameIds-dependent
    // comps query (sequential, needs prostageRows' game_ids).
    mockSql.mockResolvedValueOnce([PROSTAGE_ROW]).mockResolvedValueOnce([]).mockResolvedValueOnce(CLEAN_GAME_ROWS);
    const res = await GET(req("?championId=103&role=2&source=prostage"));
    const body = await res.json();
    expect(body.games).toHaveLength(1);
    expect(body.games[0].allyChampionIds).toEqual([103, 1, 2, 3, 4]);
    expect(body.games[0].enemyChampionIds).toEqual([5, 6, 7, 8, 9]);
  });

  it("omits both fields when the game doesn't have a clean 5/5 split (e.g. a row missing)", async () => {
    const incompleteGame = CLEAN_GAME_ROWS.slice(0, 9); // only 4 on GEN
    mockSql.mockResolvedValueOnce([PROSTAGE_ROW]).mockResolvedValueOnce([]).mockResolvedValueOnce(incompleteGame);
    const res = await GET(req("?championId=103&role=2&source=prostage"));
    const body = await res.json();
    expect(body.games[0].allyChampionIds).toBeUndefined();
    expect(body.games[0].enemyChampionIds).toBeUndefined();
  });

  it("omits both fields when the row's own team is null", async () => {
    mockSql
      .mockResolvedValueOnce([{ ...PROSTAGE_ROW, team: null }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(CLEAN_GAME_ROWS);
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
    mockSql.mockResolvedValueOnce([PROSTAGE_ROW]).mockResolvedValueOnce([]).mockResolvedValueOnce(roleOrderedGame);
    const res = await GET(req("?championId=103&role=2&source=prostage"));
    const body = await res.json();
    expect(body.games[0].allyChampionIds).toEqual([1, 2, 103, 3, 4]); // top, jungle, MID (Faker) at index 2, bot, support
    expect(body.games[0].allyChampionIds[2]).toBe(103);
    expect(body.games[0].enemyChampionIds).toEqual([5, 6, 7, 8, 9]); // top, jungle, mid, bot, support
  });

  it("falls back to the query's row order when a side's roles don't resolve to 5 distinct known roles", async () => {
    const noRoleGame = CLEAN_GAME_ROWS.map((r) => ({ ...r, role: null, pro_role: null }));
    mockSql.mockResolvedValueOnce([PROSTAGE_ROW]).mockResolvedValueOnce([]).mockResolvedValueOnce(noRoleGame);
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
    mockSql.mockResolvedValueOnce([PROSTAGE_ROW]).mockResolvedValueOnce([]).mockResolvedValueOnce(threeTeamGame);
    const res = await GET(req("?championId=103&role=2&source=prostage"));
    const body = await res.json();
    expect(body.games[0].allyChampionIds).toBeUndefined();
    expect(body.games[0].enemyChampionIds).toBeUndefined();
  });
});

describe("GET /api/pros prostage cleaned display names + proId (2026-07-11)", () => {
  beforeEach(() => {
    mockSql.mockReset();
    vi.mocked(getSql).mockReturnValue(mockSql as never);
  });

  // Mirrors the real LYON-vs-HLE MSI 2026 game this fix shipped for: a
  // wiki-disambiguated team name on one side, and player_links carrying a
  // real-name disambiguator for two of the five HLE players.
  const LYON_HLE_GAME_ROW = {
    ...PROSTAGE_ROW,
    game_id: "MSI_2026_Bracket_Round_4_2_3",
    player_link: "Zeka (Kim Geon-woo)",
    team: "Hanwha Life Esports",
  };

  const LYON_HLE_COMPS = [
    { game_id: "MSI_2026_Bracket_Round_4_2_3", team: "Hanwha Life Esports", champion_id: 68, player_link: "Zeus", pro_id: "pro-zeus", pro_name: "Zeus" },
    { game_id: "MSI_2026_Bracket_Round_4_2_3", team: "Hanwha Life Esports", champion_id: 254, player_link: "Kanavi", pro_id: "pro-kanavi", pro_name: "Kanavi" },
    { game_id: "MSI_2026_Bracket_Round_4_2_3", team: "Hanwha Life Esports", champion_id: 777, player_link: "Zeka (Kim Geon-woo)", pro_id: null, pro_name: null },
    { game_id: "MSI_2026_Bracket_Round_4_2_3", team: "Hanwha Life Esports", champion_id: 96, player_link: "Gumayusi", pro_id: "pro-gumayusi", pro_name: "Gumayusi" },
    { game_id: "MSI_2026_Bracket_Round_4_2_3", team: "Hanwha Life Esports", champion_id: 117, player_link: "Delight", pro_id: "pro-delight", pro_name: "Delight" },
    { game_id: "MSI_2026_Bracket_Round_4_2_3", team: "LYON (2024 American Team)", champion_id: 112, player_link: "Saint (Kang Sung-in)", pro_id: null, pro_name: null },
    { game_id: "MSI_2026_Bracket_Round_4_2_3", team: "LYON (2024 American Team)", champion_id: 887, player_link: "Dhokla", pro_id: null, pro_name: null },
    { game_id: "MSI_2026_Bracket_Round_4_2_3", team: "LYON (2024 American Team)", champion_id: 72, player_link: "Inspired", pro_id: null, pro_name: null },
    { game_id: "MSI_2026_Bracket_Round_4_2_3", team: "LYON (2024 American Team)", champion_id: 902, player_link: "Isles", pro_id: null, pro_name: null },
    { game_id: "MSI_2026_Bracket_Round_4_2_3", team: "LYON (2024 American Team)", champion_id: 236, player_link: "Berserker (Kim Min-cheol)", pro_id: null, pro_name: null },
  ];

  // NOTE: allyPlayers/enemyPlayers (the full per-player sheet, incl. the
  // name-cleaning + proId-fallback coverage this LYON/HLE fixture was built
  // for) moved off this route's response to GET /api/pros/team-players
  // (2026-07-11 P1 perf fix) — that coverage now lives in
  // lib/__tests__/pro-pros-route-team-players.test.ts, exercised against the
  // new endpoint via lib/prostage/teamComps.ts's shared buildProstageCompsMap.
  // This describe block keeps only what GET /api/pros itself still emits:
  // allyTeamName/enemyTeamName + the top-level player.name cleaning.

  it("emits cleaned allyTeamName/enemyTeamName (RAW player.team stays untouched)", async () => {
    // call order: prostageRows, pros name-index (top-level Promise.all),
    // then the gameIds-dependent comps query (sequential) — 2026-07-11 P2 fix.
    mockSql.mockResolvedValueOnce([LYON_HLE_GAME_ROW]).mockResolvedValueOnce([]).mockResolvedValueOnce(LYON_HLE_COMPS);
    const res = await GET(req("?championId=103&role=2&source=prostage"));
    const body = await res.json();
    expect(body.games[0].allyTeamName).toBe("Hanwha Life Esports"); // no trailing group to strip
    expect(body.games[0].enemyTeamName).toBe("LYON"); // "(2024 American Team)" stripped
    expect(body.games[0].player.team).toBe("Hanwha Life Esports"); // raw field untouched
  });

  it("player.name (top-level, not just comps) is cleaned when pro_name is null", async () => {
    mockSql
      .mockResolvedValueOnce([{ ...LYON_HLE_GAME_ROW, pro_name: null, pro_team: null, pro_role: null, pro_country: null }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    const res = await GET(req("?championId=103&role=2&source=prostage"));
    const body = await res.json();
    expect(body.games[0].player.name).toBe("Zeka"); // cleaned from "Zeka (Kim Geon-woo)"
    expect(body.games[0].playerLink).toBe("Zeka (Kim Geon-woo)"); // RAW stays on playerLink (the timeline API key)
  });

  it("omits allyTeamName/enemyTeamName when a third team is present (same ambiguity guard as champion comps)", async () => {
    const threeTeamComps = [
      ...LYON_HLE_COMPS,
      { game_id: "MSI_2026_Bracket_Round_4_2_3", team: "A Third Team", champion_id: 1, player_link: "X", pro_id: null, pro_name: null },
    ];
    mockSql.mockResolvedValueOnce([LYON_HLE_GAME_ROW]).mockResolvedValueOnce([]).mockResolvedValueOnce(threeTeamComps);
    const res = await GET(req("?championId=103&role=2&source=prostage"));
    const body = await res.json();
    expect(body.games[0].allyTeamName).toBeUndefined();
    expect(body.games[0].enemyTeamName).toBeUndefined();
  });
});

const PLAYER_PRO_ID = "b2c3d4e5-f6a7-4901-bcde-f12345678901";

// An UNTRACKED prostage player row — same shape as the real LYON players
// (Dhokla/Inspired/Isles) this feature ships for: prostage_matches has the
// row, but there's no coachbuild.pros row (pro_name/pro_team/pro_role/
// pro_country all null, LEFT JOIN just doesn't match).
const UNTRACKED_PROSTAGE_ROW = {
  ...PROSTAGE_ROW,
  game_id: "MSI_2026_Bracket_1",
  player_link: "Dhokla",
  team: "LYON (2024 American Team)",
  pro_name: null,
  pro_team: null,
  pro_role: null,
  pro_country: null,
};

describe("GET /api/pros player param (untracked prostage player lookup, 2026-07-11)", () => {
  beforeEach(() => {
    mockSql.mockReset();
    vi.mocked(getSql).mockReturnValue(mockSql as never);
  });

  // ── param validation matrix ────────────────────────────────────────────
  it("400 when player and proId are both given", async () => {
    const res = await GET(req(`?player=Dhokla&proId=${PLAYER_PRO_ID}`));
    expect(res.status).toBe(400);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it("400 when player and championId are both given", async () => {
    const res = await GET(req("?player=Dhokla&championId=103&role=2"));
    expect(res.status).toBe(400);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it("400 when all three (player, proId, championId) are given", async () => {
    const res = await GET(req(`?player=Dhokla&proId=${PLAYER_PRO_ID}&championId=103&role=2`));
    expect(res.status).toBe(400);
  });

  it("400 on an empty player value", async () => {
    expect((await GET(req("?player="))).status).toBe(400);
  });

  it("400 on a player value over the length cap", async () => {
    const long = "x".repeat(65);
    expect((await GET(req(`?player=${long}`))).status).toBe(400);
  });

  it("a player value exactly at the length cap (64) is accepted", async () => {
    const exact = "x".repeat(64);
    mockSql.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    const res = await GET(req(`?player=${exact}`));
    expect(res.status).toBe(200);
  });

  it("400 on a player value containing a % wildcard (exact match only, never a LIKE search)", async () => {
    const res = await GET(req(`?player=${encodeURIComponent("Dho%kla")}`));
    expect(res.status).toBe(400);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it("400 on invalid role alongside player", async () => {
    expect((await GET(req("?player=Dhokla&role=9"))).status).toBe(400);
  });

  // ── happy path: prostage-only, filtered by player_link ─────────────────
  it("200: looks up by pm.player_link, prostage-only (no soloq query at all), role optional (defaults to all lanes)", async () => {
    // call order: prostageRows, prosNameRows (top-level Promise.all), then
    // the gameIds-dependent comps query (sequential) — same shape as every
    // other prostage-only path in this file.
    mockSql.mockResolvedValueOnce([UNTRACKED_PROSTAGE_ROW]).mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    const res = await GET(req("?player=Dhokla"));
    expect(res.status).toBe(200);
    expect(mockSql).toHaveBeenCalledTimes(3);

    const [strings, ...values] = mockSql.mock.calls[0];
    expect(strings.join("")).toContain("pm.player_link =");
    expect(strings.join("")).toContain("prostage_matches");
    expect(strings.join("")).toContain("make_interval(days =>"); // same FRESH_WINDOW_DAYS freshness gate as every other path
    expect(values).toContain("Dhokla");

    const body = await res.json();
    expect(body.games).toHaveLength(1);
    expect(body.games[0].source).toBe("prostage");
    expect(body.games[0].playerLink).toBe("Dhokla");
    expect(body.games[0].player.name).toBe("Dhokla"); // no pro_name -> cleaned player_link fallback; "Dhokla" has no parenthetical to strip
  });

  it("player + role filters by lane", async () => {
    mockSql.mockResolvedValueOnce([UNTRACKED_PROSTAGE_ROW]).mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    const res = await GET(req("?player=Dhokla&role=1"));
    expect(res.status).toBe(200);
    const values = mockSql.mock.calls[0].slice(1);
    expect(values).toContain(1);
  });

  it("empty array when the player_link matches no rows", async () => {
    mockSql.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    const res = await GET(req("?player=NobodyEverHeardOf"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ games: [] });
  });

  // ── documented cross-param behavior ─────────────────────────────────────
  it("source=soloq combined with player returns empty games (documented: player lookups are prostage-only, soloq is skipped entirely)", async () => {
    const res = await GET(req("?player=Dhokla&source=soloq"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ games: [] });
    expect(mockSql).not.toHaveBeenCalled(); // wantSoloq false (player set) AND wantProstage false (source=soloq) -> zero queries
  });

  it("source=prostage combined with player behaves the same as no source param (both are prostage-only here)", async () => {
    mockSql.mockResolvedValueOnce([UNTRACKED_PROSTAGE_ROW]).mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    const res = await GET(req("?player=Dhokla&source=prostage"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.games).toHaveLength(1);
  });

  it("source=all combined with player is still prostage-only (soloq skipped regardless of source)", async () => {
    mockSql.mockResolvedValueOnce([UNTRACKED_PROSTAGE_ROW]).mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    const res = await GET(req("?player=Dhokla&source=all"));
    expect(res.status).toBe(200);
    expect(mockSql).toHaveBeenCalledTimes(3); // never 4 — soloq never queried on this path
    const body = await res.json();
    expect(body.games).toHaveLength(1);
    expect(body.games[0].source).toBe("prostage");
  });
});
