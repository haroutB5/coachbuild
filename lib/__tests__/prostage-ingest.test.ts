/**
 * Tests for lib/prostage/ingest.ts's orchestration logic — staleness
 * reordering (P1-1), fastFailOnRatelimit threading (P2), and the >50%
 * null-role vocab-mismatch warning (P1-2c). DB/Cargo/ddragon are all mocked;
 * this is pure composition/wiring coverage, not extraction logic (see
 * prostage-extract.test.ts for that).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSql = vi.fn();
vi.mock("@/lib/pro/db", () => ({ getSql: vi.fn(() => mockSql) }));

vi.mock("../prostage/tournaments", () => ({
  resolveActiveTournaments: vi.fn(),
  orderByStaleness: vi.fn(),
}));

vi.mock("../prostage/ddragon", async (importOriginal) => {
  // extract.ts also imports normalizeName from this module directly — only
  // getDdragonMaps needs mocking (it's the network-touching part).
  const actual = await importOriginal<typeof import("../prostage/ddragon")>();
  return { ...actual, getDdragonMaps: vi.fn() };
});

vi.mock("../prostage/cargo", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../prostage/cargo")>();
  return { ...actual, cargoQueryWithRetry: vi.fn() };
});

import { getSql } from "@/lib/pro/db";
import { cargoQueryWithRetry } from "../prostage/cargo";
import { getDdragonMaps } from "../prostage/ddragon";
import { runProstageIngest } from "../prostage/ingest";
import { orderByStaleness, resolveActiveTournaments } from "../prostage/tournaments";

const AHRI_MAPS = {
  version: "16.13.1",
  championByName: new Map([["ahri", 103]]),
  championNameById: new Map([[103, "Ahri"]]),
  itemByName: new Map(),
  summonerByName: new Map(),
  runeByName: new Map(),
  styleByName: new Map(),
};

function scoreboardRow(overrides: Record<string, string | undefined> = {}) {
  return {
    GameId: "g1",
    Link: "Player1",
    OverviewPage: "A",
    Champion: "Ahri",
    "DateTime UTC": "2026-01-01 00:00:00",
    PlayerWin: "1",
    ...overrides,
  };
}

describe("runProstageIngest", () => {
  beforeEach(() => {
    mockSql.mockReset();
    vi.mocked(getSql).mockReturnValue(mockSql as never);
    vi.mocked(resolveActiveTournaments).mockReset();
    vi.mocked(orderByStaleness).mockReset();
    vi.mocked(getDdragonMaps).mockReset().mockResolvedValue(AHRI_MAPS as never);
    vi.mocked(cargoQueryWithRetry).mockReset();
  });

  it("applies staleness ordering when tournaments are resolved fresh (no override)", async () => {
    vi.mocked(resolveActiveTournaments).mockResolvedValue(["B", "A"]);
    vi.mocked(orderByStaleness).mockResolvedValue(["A", "B"]); // stalest-first reorder
    mockSql.mockResolvedValueOnce([]); // pro-name index
    vi.mocked(cargoQueryWithRetry).mockResolvedValueOnce([]);

    const result = await runProstageIngest({ cursor: 0 });
    expect(orderByStaleness).toHaveBeenCalledWith(mockSql, ["B", "A"]);
    expect(result.tournament).toBe("A"); // the REORDERED list's cursor=0, not resolveActiveTournaments' raw order
  });

  it("bypasses staleness ordering entirely when an explicit tournaments override is given", async () => {
    mockSql.mockResolvedValueOnce([]);
    vi.mocked(cargoQueryWithRetry).mockResolvedValueOnce([]);

    const result = await runProstageIngest({ cursor: 0, tournaments: ["Explicit"] });
    expect(orderByStaleness).not.toHaveBeenCalled();
    expect(resolveActiveTournaments).not.toHaveBeenCalled();
    expect(result.tournament).toBe("Explicit");
  });

  it("threads fastFailOnRatelimit to both the Tournaments lookup and the ScoreboardPlayers call", async () => {
    vi.mocked(resolveActiveTournaments).mockResolvedValue(["A"]);
    vi.mocked(orderByStaleness).mockResolvedValue(["A"]);
    mockSql.mockResolvedValueOnce([]);
    vi.mocked(cargoQueryWithRetry).mockResolvedValueOnce([]);

    await runProstageIngest({ cursor: 0, fastFailOnRatelimit: true });

    expect(resolveActiveTournaments).toHaveBeenCalledWith(
      expect.objectContaining({ fastFailOnRatelimit: true })
    );
    const [, retryOpts] = vi.mocked(cargoQueryWithRetry).mock.calls[0];
    expect(retryOpts).toEqual({ fastFail: true });
  });

  it("defaults fastFailOnRatelimit to false (script path keeps the full cooldown)", async () => {
    vi.mocked(resolveActiveTournaments).mockResolvedValue(["A"]);
    vi.mocked(orderByStaleness).mockResolvedValue(["A"]);
    mockSql.mockResolvedValueOnce([]);
    vi.mocked(cargoQueryWithRetry).mockResolvedValueOnce([]);

    await runProstageIngest({ cursor: 0 });

    expect(resolveActiveTournaments).toHaveBeenCalledWith(
      expect.objectContaining({ fastFailOnRatelimit: false })
    );
    const [, retryOpts] = vi.mocked(cargoQueryWithRetry).mock.calls[0];
    expect(retryOpts).toEqual({ fastFail: false });
  });

  it("logs a warning when >50% of a tournament's extracted rows have unresolved role", async () => {
    vi.mocked(resolveActiveTournaments).mockResolvedValue(["A"]);
    vi.mocked(orderByStaleness).mockResolvedValue(["A"]);
    mockSql.mockResolvedValueOnce([]); // pro-name index; insert calls below are left unmocked (resolve undefined, caught per-row)
    vi.mocked(cargoQueryWithRetry).mockResolvedValueOnce([
      scoreboardRow({ GameId: "g1", Role: "Top" }), // resolves
      scoreboardRow({ GameId: "g2", Role: "Coach" }), // unresolved
      scoreboardRow({ GameId: "g3", Role: "Analyst" }), // unresolved -> 2/3 = 67% > 50%
    ] as never);

    const log = vi.fn();
    await runProstageIngest({ cursor: 0, onProgress: log });

    expect(
      log.mock.calls.some(([msg]) => msg.includes("unresolved role") && msg.includes("roleMap.ts"))
    ).toBe(true);
  });

  it("uses a caller-supplied queryFn for the ScoreboardPlayers fetch instead of cargoQueryWithRetry", async () => {
    // Regression for the 2026-07-10 CargoExport follow-up: scripts/ingest-
    // prostage.mjs's --via-export flag passes cargoExportQuery here to route
    // around api.php's rate limit. cargoQueryWithRetry must NOT be called
    // when an override is supplied.
    vi.mocked(resolveActiveTournaments).mockResolvedValue(["A"]);
    vi.mocked(orderByStaleness).mockResolvedValue(["A"]);
    mockSql.mockResolvedValueOnce([]); // pro-name index
    const queryFn = vi.fn().mockResolvedValue([scoreboardRow({ GameId: "g1", Role: "Top" })]);

    const result = await runProstageIngest({ cursor: 0, queryFn });

    expect(queryFn).toHaveBeenCalledTimes(1);
    const [calledOpts] = queryFn.mock.calls[0];
    expect(calledOpts).toMatchObject({ tables: "ScoreboardPlayers", where: 'OverviewPage="A"' });
    expect(cargoQueryWithRetry).not.toHaveBeenCalled();
    expect(result.rowsSeen).toBe(1);
  });

  it("does NOT warn when unresolved role is at or below 50%", async () => {
    vi.mocked(resolveActiveTournaments).mockResolvedValue(["A"]);
    vi.mocked(orderByStaleness).mockResolvedValue(["A"]);
    mockSql.mockResolvedValueOnce([]);
    vi.mocked(cargoQueryWithRetry).mockResolvedValueOnce([
      scoreboardRow({ GameId: "g1", Role: "Top" }),
      scoreboardRow({ GameId: "g2", Role: "Jungle" }),
      scoreboardRow({ GameId: "g3", Role: "Coach" }), // 1/3 = 33%, below threshold
    ] as never);

    const log = vi.fn();
    await runProstageIngest({ cursor: 0, onProgress: log });

    expect(log.mock.calls.some(([msg]) => msg.includes("unresolved role"))).toBe(false);
  });
});
