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
    mockSql.mockResolvedValueOnce(undefined); // ingest-attempt stamp (migration 0008)
    mockSql.mockResolvedValueOnce([]); // pro-name index
    vi.mocked(cargoQueryWithRetry).mockResolvedValueOnce([]);

    const result = await runProstageIngest({ cursor: 0 });
    expect(orderByStaleness).toHaveBeenCalledWith(mockSql, ["B", "A"]);
    expect(result.tournament).toBe("A"); // the REORDERED list's cursor=0, not resolveActiveTournaments' raw order
  });

  it("bypasses staleness ordering entirely when an explicit tournaments override is given", async () => {
    mockSql.mockResolvedValueOnce(undefined); // ingest-attempt stamp
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
    mockSql.mockResolvedValueOnce(undefined); // ingest-attempt stamp
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
    mockSql.mockResolvedValueOnce(undefined); // ingest-attempt stamp
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
    mockSql.mockResolvedValueOnce(undefined); // ingest-attempt stamp
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
    mockSql.mockResolvedValueOnce(undefined); // ingest-attempt stamp
    mockSql.mockResolvedValueOnce([]); // pro-name index
    const queryFn = vi.fn().mockResolvedValue([scoreboardRow({ GameId: "g1", Role: "Top" })]);

    const result = await runProstageIngest({ cursor: 0, queryFn });

    expect(queryFn).toHaveBeenCalledTimes(1);
    const [calledOpts] = queryFn.mock.calls[0];
    expect(calledOpts).toMatchObject({ tables: "ScoreboardPlayers", where: 'OverviewPage="A"' });
    expect(cargoQueryWithRetry).not.toHaveBeenCalled();
    expect(result.rowsSeen).toBe(1);
  });

  it("resolves pro_id against a CLEANED player_link when the raw form (with Leaguepedia's real-name disambiguator) doesn't exact-match pros.name", async () => {
    // Regression for the 2026-07-11 fix: player_link "Zeka (Kim Geon-woo)"
    // must still resolve to the tracked pro named "Zeka" — the exact-match-
    // only lookup this replaces silently left pro_id NULL for every such row
    // (~400 rows found live, see scripts/backfill-prostage-proid.mjs).
    vi.mocked(resolveActiveTournaments).mockResolvedValue(["A"]);
    vi.mocked(orderByStaleness).mockResolvedValue(["A"]);
    mockSql.mockResolvedValueOnce(undefined); // [0] = ingest-attempt stamp
    mockSql.mockResolvedValueOnce([{ id: "pro-zeka", name: "Zeka" }]); // [1] = pro-name index
    vi.mocked(cargoQueryWithRetry).mockResolvedValueOnce([
      scoreboardRow({ GameId: "g1", Link: "Zeka (Kim Geon-woo)", Role: "Mid" }),
    ] as never);

    await runProstageIngest({ cursor: 0 });

    const insertCall = mockSql.mock.calls[2]; // [0] = stamp, [1] = pro-name index, [2] = the row INSERT
    const proIdArg = insertCall[insertCall.length - 1]; // pro_id is the LAST value bound in the INSERT
    expect(proIdArg).toBe("pro-zeka");
  });

  it("prefers an exact RAW player_link match over the cleaned form when both happen to resolve", async () => {
    vi.mocked(resolveActiveTournaments).mockResolvedValue(["A"]);
    vi.mocked(orderByStaleness).mockResolvedValue(["A"]);
    // A pro literally named with the raw (undisambiguated) form should win
    // over a coincidental match on the cleaned form.
    mockSql.mockResolvedValueOnce(undefined); // ingest-attempt stamp
    mockSql.mockResolvedValueOnce([
      { id: "pro-raw-exact", name: "Zeka (Kim Geon-woo)" },
      { id: "pro-cleaned", name: "Zeka" },
    ]);
    vi.mocked(cargoQueryWithRetry).mockResolvedValueOnce([
      scoreboardRow({ GameId: "g1", Link: "Zeka (Kim Geon-woo)", Role: "Mid" }),
    ] as never);

    await runProstageIngest({ cursor: 0 });

    const insertCall = mockSql.mock.calls[2]; // [0] = stamp, [1] = pro-name index, [2] = row INSERT
    const proIdArg = insertCall[insertCall.length - 1];
    expect(proIdArg).toBe("pro-raw-exact");
  });

  it("paginate:false (default) makes exactly one queryFn call with no offset key", async () => {
    vi.mocked(resolveActiveTournaments).mockResolvedValue(["A"]);
    vi.mocked(orderByStaleness).mockResolvedValue(["A"]);
    mockSql.mockResolvedValueOnce(undefined); // ingest-attempt stamp
    mockSql.mockResolvedValueOnce([]);
    const queryFn = vi.fn().mockResolvedValue([scoreboardRow({ GameId: "g1", Role: "Top" })]);

    const result = await runProstageIngest({ cursor: 0, queryFn });

    expect(queryFn).toHaveBeenCalledTimes(1);
    expect(queryFn.mock.calls[0][0]).not.toHaveProperty("offset");
    expect(result.rowsSeen).toBe(1);
  });

  it("paginate:true walks offset in 500-row pages until a short page ends the walk", async () => {
    // Regression for the 2026-07-13 truncation fix: live-verified a real
    // tournament (LPL/2026 Season/Split 2 Playoffs) has 680 ScoreboardPlayers
    // rows — a single limit=500 call silently drops the last 180. Simulates
    // a 2-page tournament: page 1 full (500), page 2 short (180) ends it.
    vi.mocked(resolveActiveTournaments).mockResolvedValue(["A"]);
    vi.mocked(orderByStaleness).mockResolvedValue(["A"]);
    mockSql.mockResolvedValueOnce(undefined); // ingest-attempt stamp
    mockSql.mockResolvedValueOnce([]); // pro-name index
    const page1 = Array.from({ length: 500 }, (_, i) => scoreboardRow({ GameId: `g${i}` }));
    const page2 = Array.from({ length: 180 }, (_, i) => scoreboardRow({ GameId: `g${500 + i}` }));
    const queryFn = vi.fn().mockResolvedValueOnce(page1).mockResolvedValueOnce(page2);

    const result = await runProstageIngest({ cursor: 0, queryFn, paginate: true });

    expect(queryFn).toHaveBeenCalledTimes(2);
    expect(queryFn.mock.calls[0][0]).not.toHaveProperty("offset"); // first page: no offset key at all
    expect(queryFn.mock.calls[1][0]).toMatchObject({ offset: 500 }); // second page: offset=PAGE_SIZE
    expect(result.rowsSeen).toBe(680); // both pages' rows counted
  });

  it("paginate:true stops after a single page when it's already short (no wasted second call)", async () => {
    vi.mocked(resolveActiveTournaments).mockResolvedValue(["A"]);
    vi.mocked(orderByStaleness).mockResolvedValue(["A"]);
    mockSql.mockResolvedValueOnce(undefined); // ingest-attempt stamp
    mockSql.mockResolvedValueOnce([]);
    const queryFn = vi.fn().mockResolvedValue([scoreboardRow({ GameId: "g1", Role: "Top" })]);

    const result = await runProstageIngest({ cursor: 0, queryFn, paginate: true });

    expect(queryFn).toHaveBeenCalledTimes(1);
    expect(result.rowsSeen).toBe(1);
  });

  it("paginate:true caps at MAX_PAGES (10) as a safety backstop against a pathological always-full response", async () => {
    vi.mocked(resolveActiveTournaments).mockResolvedValue(["A"]);
    vi.mocked(orderByStaleness).mockResolvedValue(["A"]);
    mockSql.mockResolvedValueOnce(undefined); // ingest-attempt stamp
    mockSql.mockResolvedValueOnce([]);
    const fullPage = Array.from({ length: 500 }, (_, i) => scoreboardRow({ GameId: `g${i}` }));
    const queryFn = vi.fn().mockResolvedValue(fullPage); // ALWAYS returns a full page

    const result = await runProstageIngest({ cursor: 0, queryFn, paginate: true });

    expect(queryFn).toHaveBeenCalledTimes(10); // MAX_PAGES, not an infinite loop
    expect(result.rowsSeen).toBe(5000);
  });

  it("does NOT warn when unresolved role is at or below 50%", async () => {
    vi.mocked(resolveActiveTournaments).mockResolvedValue(["A"]);
    vi.mocked(orderByStaleness).mockResolvedValue(["A"]);
    mockSql.mockResolvedValueOnce(undefined); // ingest-attempt stamp
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

  it("stamps coachbuild.prostage_ingest_attempts at the START of the pass, keyed on the overview_page, upserting on conflict", async () => {
    // Regression for the P2 fix: this stamp — not prostage_matches.ingested_at
    // — is what orderByStaleness now sorts on, so it must fire on EVERY
    // attempt (not just ones that write new rows).
    vi.mocked(resolveActiveTournaments).mockResolvedValue(["A"]);
    vi.mocked(orderByStaleness).mockResolvedValue(["A"]);
    mockSql.mockResolvedValueOnce(undefined); // the stamp itself
    mockSql.mockResolvedValueOnce([]); // pro-name index
    vi.mocked(cargoQueryWithRetry).mockResolvedValueOnce([]);

    await runProstageIngest({ cursor: 0 });

    expect(mockSql.mock.calls.length).toBeGreaterThanOrEqual(2);
    const [strings, ...values] = mockSql.mock.calls[0];
    const queryText = (strings as TemplateStringsArray).join("?");
    expect(queryText).toContain("prostage_ingest_attempts");
    expect(queryText).toContain("ON CONFLICT");
    expect(values).toContain("A");
  });

  it("a stamp-write failure is recorded as an error but never blocks the ingest attempt itself", async () => {
    vi.mocked(resolveActiveTournaments).mockResolvedValue(["A"]);
    vi.mocked(orderByStaleness).mockResolvedValue(["A"]);
    mockSql.mockRejectedValueOnce(new Error("stamp write failed")); // the stamp fails...
    mockSql.mockResolvedValueOnce([]); // ...but pro-name index still runs
    vi.mocked(cargoQueryWithRetry).mockResolvedValueOnce([
      scoreboardRow({ GameId: "g1", Role: "Top" }),
    ] as never);

    const result = await runProstageIngest({ cursor: 0 });

    expect(result.errors.some((e) => e.includes("failed to stamp ingest attempt"))).toBe(true);
    expect(result.rowsSeen).toBe(1); // the ingest attempt itself still proceeded
  });
});
