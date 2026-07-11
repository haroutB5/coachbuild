/**
 * Route-level tests for GET /api/pros/team-players — the on-demand
 * allyPlayers/enemyPlayers endpoint (2026-07-11 P1 perf fix: these fields
 * used to ride inline on every GET /api/pros list row; see
 * app/api/pros/team-players/route.ts's header comment). Covers both
 * sources (soloq: pro_matches.ally_players/enemy_players jsonb columns;
 * prostage: built from the batched comps query, same shared helpers as
 * app/api/pros/route.ts — see lib/prostage/teamComps.ts), param validation,
 * and the never-cache-empty Cache-Control contract.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSql = vi.fn();

vi.mock("@/lib/pro/db", () => ({
  getSql: vi.fn(() => mockSql),
}));

import { GET } from "@/app/api/pros/team-players/route";
import { getSql } from "@/lib/pro/db";

const req = (qs: string) =>
  ({ url: `http://localhost/api/pros/team-players${qs}` }) as unknown as Parameters<typeof GET>[0];

beforeEach(() => {
  mockSql.mockReset();
  vi.mocked(getSql).mockReturnValue(mockSql as never);
});

describe("GET /api/pros/team-players param validation", () => {
  it("400 on missing source", async () => {
    expect((await GET(req("?gameId=EUW1_1"))).status).toBe(400);
  });

  it("400 on invalid source", async () => {
    expect((await GET(req("?source=bogus&gameId=EUW1_1"))).status).toBe(400);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it("400 on missing gameId", async () => {
    expect((await GET(req("?source=soloq&championId=112"))).status).toBe(400);
  });

  it("400 on a gameId longer than the max param length", async () => {
    const long = "x".repeat(301);
    expect((await GET(req(`?source=soloq&gameId=${long}&championId=112`))).status).toBe(400);
  });

  it("400 on soloq with missing championId", async () => {
    expect((await GET(req("?source=soloq&gameId=EUW1_1"))).status).toBe(400);
  });

  it("400 on soloq with non-integer championId", async () => {
    expect((await GET(req("?source=soloq&gameId=EUW1_1&championId=abc"))).status).toBe(400);
  });

  it("400 on prostage with missing player", async () => {
    expect((await GET(req("?source=prostage&gameId=LEC_2026_1_1"))).status).toBe(400);
  });

  it("200 with null/null when DB isn't configured", async () => {
    vi.mocked(getSql).mockReturnValueOnce(null);
    const res = await GET(req("?source=soloq&gameId=EUW1_1&championId=112"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ allyPlayers: null, enemyPlayers: null });
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("500 (no detail leak) on an unexpected DB error", async () => {
    mockSql.mockRejectedValueOnce(new Error("secret connection string"));
    const res = await GET(req("?source=soloq&gameId=EUW1_1&championId=112"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Internal server error");
    expect(JSON.stringify(body)).not.toContain("secret");
  });
});

const SOLOQ_PLAYER = (championId: number, role: number | null, name: string | null) => ({
  championId,
  name,
  items: [1001, 1002],
  trinket: 3364,
  role,
});

describe("GET /api/pros/team-players source=soloq", () => {
  it("200 with allyPlayers/enemyPlayers + long cache when both columns hold exactly 5 entries", async () => {
    const allyPlayers = [0, 1, 2, 3, 4].map((r) => SOLOQ_PLAYER(100 + r, r, `Ally${r}`));
    const enemyPlayers = [0, 1, 2, 3, 4].map((r) => SOLOQ_PLAYER(200 + r, r, `Enemy${r}`));
    mockSql.mockResolvedValueOnce([{ ally_players: allyPlayers, enemy_players: enemyPlayers }]);
    const res = await GET(req("?source=soloq&gameId=EUW1_1&championId=112"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.allyPlayers).toEqual(allyPlayers);
    expect(body.enemyPlayers).toEqual(enemyPlayers);
    // soloq entries never carry playerLink (no player_link identity model at
    // all) — SOLOQ_PLAYER's fixture never sets it, and the route just
    // forwards the stored jsonb verbatim, so it stays absent (equivalent to
    // null for consumers, see lib/pro/types.ts's TeamCompPlayer.playerLink).
    expect(body.allyPlayers.every((p: { playerLink?: string | null }) => p.playerLink == null)).toBe(true);
    expect(res.headers.get("Cache-Control")).toBe("s-maxage=86400, stale-while-revalidate=604800");
    // Exactly one query: match_id + champion_id identify the row directly.
    expect(mockSql).toHaveBeenCalledTimes(1);
  });

  it("null/null + no-store when no row matches (match_id, champion_id)", async () => {
    mockSql.mockResolvedValueOnce([]);
    const res = await GET(req("?source=soloq&gameId=EUW1_1&championId=999"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ allyPlayers: null, enemyPlayers: null });
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("null/null when the columns are NULL (not yet backfilled)", async () => {
    mockSql.mockResolvedValueOnce([{ ally_players: null, enemy_players: null }]);
    const res = await GET(req("?source=soloq&gameId=EUW1_1&championId=112"));
    const body = await res.json();
    expect(body).toEqual({ allyPlayers: null, enemyPlayers: null });
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("null/null when one side has fewer than 5 entries (never a partial side)", async () => {
    const allyPlayers = [0, 1, 2, 3].map((r) => SOLOQ_PLAYER(100 + r, r, `Ally${r}`)); // only 4
    const enemyPlayers = [0, 1, 2, 3, 4].map((r) => SOLOQ_PLAYER(200 + r, r, `Enemy${r}`));
    mockSql.mockResolvedValueOnce([{ ally_players: allyPlayers, enemy_players: enemyPlayers }]);
    const res = await GET(req("?source=soloq&gameId=EUW1_1&championId=112"));
    const body = await res.json();
    expect(body).toEqual({ allyPlayers: null, enemyPlayers: null });
  });
});

const PROSTAGE_COMPS_5V5 = [
  { game_id: "LEC_2026_Summer_1_1", team: "T1", champion_id: 103, player_link: "Faker", final_items: [6653, 0], trinket: 2055, pro_name: "Faker", pro_id: "pro-faker" },
  { game_id: "LEC_2026_Summer_1_1", team: "T1", champion_id: 1, player_link: "Zeus", final_items: [1001], trinket: 3340, pro_name: "Zeus", pro_id: "pro-zeus" },
  { game_id: "LEC_2026_Summer_1_1", team: "T1", champion_id: 2, player_link: "Oner", final_items: [1002], trinket: 3340, pro_name: null, pro_id: null },
  { game_id: "LEC_2026_Summer_1_1", team: "T1", champion_id: 3, player_link: "Gumayusi", final_items: [1003], trinket: 3340, pro_name: null, pro_id: null },
  { game_id: "LEC_2026_Summer_1_1", team: "T1", champion_id: 4, player_link: "Keria", final_items: [1004], trinket: 3340, pro_name: null, pro_id: null },
  { game_id: "LEC_2026_Summer_1_1", team: "GEN", champion_id: 5, player_link: "Kiin", final_items: [1005], trinket: 3340, pro_name: null, pro_id: null },
  { game_id: "LEC_2026_Summer_1_1", team: "GEN", champion_id: 6, player_link: "Canyon", final_items: [1006], trinket: 3340, pro_name: null, pro_id: null },
  { game_id: "LEC_2026_Summer_1_1", team: "GEN", champion_id: 7, player_link: "Chovy", final_items: [1007], trinket: 3340, pro_name: null, pro_id: null },
  { game_id: "LEC_2026_Summer_1_1", team: "GEN", champion_id: 8, player_link: "Peyz", final_items: [1008], trinket: 3340, pro_name: null, pro_id: null },
  { game_id: "LEC_2026_Summer_1_1", team: "GEN", champion_id: 9, player_link: "Duro", final_items: [1009], trinket: 3340, pro_name: null, pro_id: null },
];

describe("GET /api/pros/team-players source=prostage", () => {
  it("200 with allyPlayers/enemyPlayers + long cache for a clean 10-row 5v5 game", async () => {
    // call order: own-team lookup, then Promise.all([comps, prosName]).
    mockSql
      .mockResolvedValueOnce([{ team: "T1" }])
      .mockResolvedValueOnce(PROSTAGE_COMPS_5V5)
      .mockResolvedValueOnce([]);
    const res = await GET(req("?source=prostage&gameId=LEC_2026_Summer_1_1&player=Faker"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.allyPlayers).toHaveLength(5);
    expect(body.enemyPlayers).toHaveLength(5);
    const faker = body.allyPlayers.find((p: { championId: number }) => p.championId === 103);
    expect(faker.name).toBe("Faker");
    expect(faker.items).toEqual([6653]); // 0 filtered
    expect(faker.proId).toBe("pro-faker");
    expect(faker.playerLink).toBe("Faker"); // 2026-07-11: RAW player_link, tracked pros get BOTH proId and playerLink
    expect(res.headers.get("Cache-Control")).toBe("s-maxage=86400, stale-while-revalidate=604800");
    expect(mockSql).toHaveBeenCalledTimes(3);
  });

  it("emits playerLink for an UNTRACKED prostage player (no proId) — this is what makes them navigable (2026-07-11)", async () => {
    // Oner (championId 2) has pro_name: null, pro_id: null in PROSTAGE_COMPS_5V5
    // — an untracked player, same shape as LYON's Dhokla/Inspired/Isles.
    mockSql
      .mockResolvedValueOnce([{ team: "T1" }])
      .mockResolvedValueOnce(PROSTAGE_COMPS_5V5)
      .mockResolvedValueOnce([]);
    const res = await GET(req("?source=prostage&gameId=LEC_2026_Summer_1_1&player=Faker"));
    const body = await res.json();
    const oner = body.allyPlayers.find((p: { championId: number }) => p.championId === 2);
    expect(oner.proId).toBeNull(); // untracked — no proId
    expect(oner.playerLink).toBe("Oner"); // but STILL carries the raw player_link, navigable via GET /api/pros?player=Oner
  });

  it("null/null + no-store when the requested (gameId, player) row doesn't exist", async () => {
    mockSql.mockResolvedValueOnce([]);
    const res = await GET(req("?source=prostage&gameId=LEC_2026_Summer_1_1&player=Nobody"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ allyPlayers: null, enemyPlayers: null });
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(mockSql).toHaveBeenCalledTimes(1); // never fires the comps query for a missing row
  });

  it("null/null when the game isn't a clean 5v5 split (a row missing)", async () => {
    const incomplete = PROSTAGE_COMPS_5V5.slice(0, 9); // only 4 on GEN
    mockSql.mockResolvedValueOnce([{ team: "T1" }]).mockResolvedValueOnce(incomplete).mockResolvedValueOnce([]);
    const res = await GET(req("?source=prostage&gameId=LEC_2026_Summer_1_1&player=Faker"));
    const body = await res.json();
    expect(body).toEqual({ allyPlayers: null, enemyPlayers: null });
  });

  it("cleans unlinked player names, keeps tracked pros.name as-is, and falls back to name-match for proId", async () => {
    const lyonHleComps = [
      { game_id: "MSI_2026_R4_2_3", team: "Hanwha Life Esports", champion_id: 68, player_link: "Zeus", pro_id: "pro-zeus", pro_name: "Zeus" },
      { game_id: "MSI_2026_R4_2_3", team: "Hanwha Life Esports", champion_id: 254, player_link: "Kanavi", pro_id: "pro-kanavi", pro_name: "Kanavi" },
      { game_id: "MSI_2026_R4_2_3", team: "Hanwha Life Esports", champion_id: 777, player_link: "Zeka (Kim Geon-woo)", pro_id: null, pro_name: null },
      { game_id: "MSI_2026_R4_2_3", team: "Hanwha Life Esports", champion_id: 96, player_link: "Gumayusi", pro_id: "pro-gumayusi", pro_name: "Gumayusi" },
      { game_id: "MSI_2026_R4_2_3", team: "Hanwha Life Esports", champion_id: 117, player_link: "Delight", pro_id: "pro-delight", pro_name: "Delight" },
      { game_id: "MSI_2026_R4_2_3", team: "LYON (2024 American Team)", champion_id: 112, player_link: "Saint (Kang Sung-in)", pro_id: null, pro_name: null },
      { game_id: "MSI_2026_R4_2_3", team: "LYON (2024 American Team)", champion_id: 887, player_link: "Dhokla", pro_id: null, pro_name: null },
      { game_id: "MSI_2026_R4_2_3", team: "LYON (2024 American Team)", champion_id: 72, player_link: "Inspired", pro_id: null, pro_name: null },
      { game_id: "MSI_2026_R4_2_3", team: "LYON (2024 American Team)", champion_id: 902, player_link: "Isles", pro_id: null, pro_name: null },
      { game_id: "MSI_2026_R4_2_3", team: "LYON (2024 American Team)", champion_id: 236, player_link: "Berserker (Kim Min-cheol)", pro_id: null, pro_name: null },
    ];
    mockSql
      .mockResolvedValueOnce([{ team: "Hanwha Life Esports" }])
      .mockResolvedValueOnce(lyonHleComps)
      .mockResolvedValueOnce([
        { id: "pro-zeus", name: "Zeus" },
        { id: "pro-kanavi", name: "Kanavi" },
        { id: "pro-zeka", name: "Zeka" }, // tracked pro's clean name; Zeka's row.player_link carries the raw suffix
        { id: "pro-gumayusi", name: "Gumayusi" },
        { id: "pro-delight", name: "Delight" },
      ]);
    const res = await GET(req("?source=prostage&gameId=MSI_2026_R4_2_3&player=Zeka%20(Kim%20Geon-woo)"));
    const body = await res.json();
    const all = [...body.allyPlayers, ...body.enemyPlayers] as { name: string | null; proId?: string | null }[];
    const zeka = all.find((p) => p.name === "Zeka");
    expect(zeka).toBeDefined();
    expect(zeka?.proId).toBe("pro-zeka"); // matched via the cleaned-form name fallback, not pm.pro_id (null in this fixture)
    const saint = all.find((p) => p.name === "Saint");
    expect(saint).toBeDefined();
    expect(all.some((p) => p.name?.includes("("))).toBe(false); // never the raw parenthetical form
    expect(saint?.proId ?? null).toBeNull(); // untracked -> proId stays null, no fuzzy match
  });

  it("allyPlayers/enemyPlayers are role-ordered (Top/Jungle/Mid/Bot/Support)", async () => {
    const roleOrdered = [
      { game_id: "G1", team: "T1", champion_id: 1, role: 0, pro_role: null, player_link: "p1", final_items: [1], trinket: null, pro_name: null, pro_id: null },
      { game_id: "G1", team: "T1", champion_id: 2, role: 1, pro_role: null, player_link: "p2", final_items: [2], trinket: null, pro_name: null, pro_id: null },
      { game_id: "G1", team: "T1", champion_id: 103, role: null, pro_role: 2, player_link: "Faker", final_items: [6653], trinket: 2055, pro_name: "Faker", pro_id: "pro-faker" },
      { game_id: "G1", team: "T1", champion_id: 3, role: 3, pro_role: null, player_link: "p3", final_items: [3], trinket: null, pro_name: null, pro_id: null },
      { game_id: "G1", team: "T1", champion_id: 4, role: 4, pro_role: null, player_link: "p4", final_items: [4], trinket: null, pro_name: null, pro_id: null },
      { game_id: "G1", team: "GEN", champion_id: 9, role: 4, pro_role: null, player_link: "p9", final_items: [9], trinket: null, pro_name: null, pro_id: null },
      { game_id: "G1", team: "GEN", champion_id: 8, role: 3, pro_role: null, player_link: "p8", final_items: [8], trinket: null, pro_name: null, pro_id: null },
      { game_id: "G1", team: "GEN", champion_id: 7, role: 2, pro_role: null, player_link: "p7", final_items: [7], trinket: null, pro_name: null, pro_id: null },
      { game_id: "G1", team: "GEN", champion_id: 6, role: 1, pro_role: null, player_link: "p6", final_items: [6], trinket: null, pro_name: null, pro_id: null },
      { game_id: "G1", team: "GEN", champion_id: 5, role: 0, pro_role: null, player_link: "p5", final_items: [5], trinket: null, pro_name: null, pro_id: null },
    ];
    mockSql.mockResolvedValueOnce([{ team: "T1" }]).mockResolvedValueOnce(roleOrdered).mockResolvedValueOnce([]);
    const res = await GET(req("?source=prostage&gameId=G1&player=Faker"));
    const body = await res.json();
    expect(body.allyPlayers.map((p: { championId: number }) => p.championId)).toEqual([1, 2, 103, 3, 4]);
    expect(body.allyPlayers[2].name).toBe("Faker");
    expect(body.enemyPlayers.map((p: { championId: number }) => p.championId)).toEqual([5, 6, 7, 8, 9]);
  });

  it("null/null when a third team is present (data too messy to call ally/enemy)", async () => {
    const threeTeams = [
      ...PROSTAGE_COMPS_5V5.slice(0, 5), // T1 x5
      { game_id: "LEC_2026_Summer_1_1", team: "GEN", champion_id: 5, player_link: "Kiin", final_items: [], trinket: null, pro_name: null, pro_id: null },
      { game_id: "LEC_2026_Summer_1_1", team: "GEN", champion_id: 6, player_link: "Canyon", final_items: [], trinket: null, pro_name: null, pro_id: null },
      { game_id: "LEC_2026_Summer_1_1", team: "GEN", champion_id: 7, player_link: "Chovy", final_items: [], trinket: null, pro_name: null, pro_id: null },
      { game_id: "LEC_2026_Summer_1_1", team: "FNC", champion_id: 8, player_link: "X", final_items: [], trinket: null, pro_name: null, pro_id: null },
      { game_id: "LEC_2026_Summer_1_1", team: "FNC", champion_id: 9, player_link: "Y", final_items: [], trinket: null, pro_name: null, pro_id: null },
    ];
    mockSql.mockResolvedValueOnce([{ team: "T1" }]).mockResolvedValueOnce(threeTeams).mockResolvedValueOnce([]);
    const res = await GET(req("?source=prostage&gameId=LEC_2026_Summer_1_1&player=Faker"));
    const body = await res.json();
    expect(body).toEqual({ allyPlayers: null, enemyPlayers: null });
  });
});
