/**
 * Tests for lib/otp/ingest.ts — the discovery filter and the match-ingest
 * guards. Riot + op.gg are mocked; no network, no pacer.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSql = vi.fn();

vi.mock("../pro/db", () => ({ getSql: vi.fn(() => mockSql) }));
vi.mock("../otp/leaderboard", () => ({ fetchOtpCandidates: vi.fn() }));
vi.mock("../pro/riot", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../pro/riot")>();
  return {
    ...actual,
    getAccountByRiotId: vi.fn(),
    getMatchIdsByPuuid: vi.fn(),
    getMatch: vi.fn(),
  };
});

import { fetchOtpCandidates } from "../otp/leaderboard";
import { getAccountByRiotId, getMatch, getMatchIdsByPuuid } from "../pro/riot";
import {
  MIN_CHAMPION_PLAYS,
  discoverOtpAccounts,
  ingestOneOtpAccount,
  runOtpMatchIngest,
} from "../otp/ingest";

const candidate = (name: string, plays: number, rank = 1) => ({
  rank,
  gameName: name,
  tagLine: "EUW",
  championPlays: plays,
  championWins: Math.floor(plays / 2),
  tier: "MASTER" as string | null,
});

/** Minimal match-v5 response with ONE participant, enough for extractMatch. */
function riotMatch(matchId: string, puuid: string, championId: number) {
  return {
    metadata: { matchId },
    info: {
      gameCreation: Date.UTC(2026, 6, 20),
      gameDuration: 1800,
      gameVersion: "16.14.1.1",
      participants: [
        {
          puuid,
          participantId: 1,
          teamId: 100,
          teamPosition: "MIDDLE",
          championId,
          championName: "Viktor",
          win: true,
          kills: 5,
          deaths: 2,
          assists: 7,
          item0: 3100,
          item1: 0,
          item2: 0,
          item3: 0,
          item4: 0,
          item5: 0,
          item6: 3340,
          summoner1Id: 4,
          summoner2Id: 14,
          totalMinionsKilled: 200,
          neutralMinionsKilled: 5,
          totalDamageDealtToChampions: 20000,
          goldEarned: 12000,
          perks: { statPerks: {}, styles: [] },
        },
      ],
    },
  } as never;
}

beforeEach(() => {
  mockSql.mockReset();
  mockSql.mockResolvedValue([]);
  vi.mocked(fetchOtpCandidates).mockReset();
  vi.mocked(getAccountByRiotId).mockReset();
  vi.mocked(getMatchIdsByPuuid).mockReset();
  vi.mocked(getMatch).mockReset();
  process.env.RIOT_API_KEY = "test-key";
});

describe("discoverOtpAccounts", () => {
  it("rejects candidates below the one-trick floor", async () => {
    vi.mocked(fetchOtpCandidates).mockResolvedValue([
      candidate("RealOTP", MIN_CHAMPION_PLAYS + 1),
      candidate("Dabbler", MIN_CHAMPION_PLAYS - 1, 2),
    ]);
    vi.mocked(getAccountByRiotId).mockResolvedValue({
      puuid: "p1",
      gameName: "RealOTP",
      tagLine: "EUW",
    } as never);

    const out = await discoverOtpAccounts(112, "Viktor", { regions: ["EUW"] });
    // Only the qualifying candidate is ever resolved — the sub-floor player
    // must not even cost a Riot call.
    expect(vi.mocked(getAccountByRiotId)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(getAccountByRiotId).mock.calls[0][1]).toBe("RealOTP");
    expect(out.accountsUpserted).toBe(1);
    expect(out.candidatesSeen).toBe(2);
  });

  it("takes the highest-play candidates first, capped per region", async () => {
    vi.mocked(fetchOtpCandidates).mockResolvedValue([
      candidate("Low", 200, 1),
      candidate("High", 900, 2),
      candidate("Mid", 500, 3),
    ]);
    vi.mocked(getAccountByRiotId).mockImplementation(
      async (_r, name) => ({ puuid: `p-${name}`, gameName: name, tagLine: "EUW" }) as never
    );

    await discoverOtpAccounts(112, "Viktor", { regions: ["EUW"], perRegion: 2 });
    const resolved = vi.mocked(getAccountByRiotId).mock.calls.map((c) => c[1]);
    expect(resolved).toEqual(["High", "Mid"]);
  });

  it("does not let one unresolvable account sink the champion's pass", async () => {
    vi.mocked(fetchOtpCandidates).mockResolvedValue([
      candidate("Gone", 900, 1),
      candidate("Fine", 800, 2),
    ]);
    vi.mocked(getAccountByRiotId)
      .mockRejectedValueOnce(new Error("riot 404"))
      .mockResolvedValueOnce({ puuid: "p2", gameName: "Fine", tagLine: "EUW" } as never);

    const out = await discoverOtpAccounts(112, "Viktor", { regions: ["EUW"] });
    expect(out.accountsUpserted).toBe(1);
    expect(out.errors).toHaveLength(1);
    expect(out.errors[0]).toContain("Gone");
  });

  it("records an unmapped region as an error instead of calling out", async () => {
    const out = await discoverOtpAccounts(112, "Viktor", { regions: ["ATLANTIS"] });
    expect(vi.mocked(fetchOtpCandidates)).not.toHaveBeenCalled();
    expect(out.errors[0]).toContain("ATLANTIS");
  });

  it("survives a dead provider without throwing", async () => {
    vi.mocked(fetchOtpCandidates).mockResolvedValue([]);
    const out = await discoverOtpAccounts(112, "Viktor", { regions: ["EUW"] });
    expect(out.accountsUpserted).toBe(0);
    expect(out.errors).toEqual([]);
  });
});

describe("ingestOneOtpAccount", () => {
  const account = {
    puuid: "p1",
    champion_id: 112,
    region: "EUW",
    game_name: "Vork",
    tag_line: "135",
  };

  it("stores only games on the tracked champion", async () => {
    vi.mocked(getMatchIdsByPuuid).mockResolvedValue(["M1", "M2"]);
    mockSql.mockResolvedValue([]); // no existing rows
    vi.mocked(getMatch)
      .mockResolvedValueOnce(riotMatch("M1", "p1", 112))
      .mockResolvedValueOnce(riotMatch("M2", "p1", 103)); // Ahri — a one-trick's off-champ game

    const stored = await ingestOneOtpAccount(mockSql as never, account, 20, () => {});
    expect(stored).toBe(1);
  });

  it("skips a permanently unmapped region and stamps it so the walk terminates", async () => {
    const stored = await ingestOneOtpAccount(
      mockSql as never,
      { ...account, region: "ATLANTIS" },
      20,
      () => {}
    );
    expect(stored).toBe(0);
    expect(vi.mocked(getMatchIdsByPuuid)).not.toHaveBeenCalled();
    // The stamp bump is what stops this account re-sorting to the front of
    // every page forever.
    expect(mockSql).toHaveBeenCalled();
  });

  it("skips an individual match that Riot rejects, without failing the account", async () => {
    const { RiotRequestError } = await import("../pro/riot");
    vi.mocked(getMatchIdsByPuuid).mockResolvedValue(["M1", "M2"]);
    mockSql.mockResolvedValue([]);
    vi.mocked(getMatch)
      .mockRejectedValueOnce(new RiotRequestError("u", 404, "Not Found"))
      .mockResolvedValueOnce(riotMatch("M2", "p1", 112));

    expect(await ingestOneOtpAccount(mockSql as never, account, 20, () => {})).toBe(1);
  });

  it("does not re-fetch matches already stored", async () => {
    vi.mocked(getMatchIdsByPuuid).mockResolvedValue(["M1", "M2"]);
    mockSql.mockResolvedValueOnce([{ match_id: "M1" }]);
    vi.mocked(getMatch).mockResolvedValue(riotMatch("M2", "p1", 112));

    await ingestOneOtpAccount(mockSql as never, account, 20, () => {});
    expect(vi.mocked(getMatch)).toHaveBeenCalledTimes(1);
  });
});

describe("runOtpMatchIngest", () => {
  it("bumps the stamp of an account that throws, so a failing page can't loop", async () => {
    mockSql.mockResolvedValueOnce([
      { puuid: "p1", champion_id: 112, region: "EUW", game_name: "A", tag_line: "1" },
    ]);
    vi.mocked(getMatchIdsByPuuid).mockRejectedValue(new Error("riot 403"));

    const out = await runOtpMatchIngest({ championId: 112, batch: 1 });
    expect(out.accountsProcessed).toBe(1);
    expect(out.errors).toHaveLength(1);
    const stamped = mockSql.mock.calls.some((c) =>
      String(c[0]?.join?.("") ?? "").includes("SET last_fetched_at = now()")
    );
    expect(stamped).toBe(true);
  });

  it("throws when RIOT_API_KEY is absent — a config fault the caller must see", async () => {
    delete process.env.RIOT_API_KEY;
    await expect(runOtpMatchIngest({ championId: 112 })).rejects.toThrow();
  });
});
