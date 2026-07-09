/**
 * Tests for lib/pro/ingestRoster.ts's applyRegionRuleToPro — the DB-facing
 * orchestration around lib/pro/teamRegions.ts's pure decision function.
 * sql is a mocked tagged-template function; no network/DB involved.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { applyRegionRuleToPro } from "../pro/ingestRoster";

function freshResult() {
  return {
    pagesFetched: 0,
    prosSeen: 0,
    prosUpserted: 0,
    accountsUpserted: 0,
    accountsUnresolved: 0,
    errors: [],
    accountsRegionActivated: 0,
    accountsRegionDeactivated: 0,
    unmappedTeams: [] as string[],
  };
}

describe("applyRegionRuleToPro", () => {
  let mockSql: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockSql = vi.fn();
  });

  it("no-ops entirely when the pro has zero accounts on file (no UPDATE issued)", async () => {
    mockSql.mockResolvedValueOnce([]); // SELECT returns no accounts
    const result = freshResult();
    await applyRegionRuleToPro(mockSql as never, "pro-1", "T1", result, () => {});
    expect(mockSql).toHaveBeenCalledTimes(1); // only the SELECT, no UPDATE
    expect(result.accountsRegionActivated).toBe(0);
    expect(result.accountsRegionDeactivated).toBe(0);
  });

  it("Faker-shaped case: 4 active EUW accounts + T1 team -> 4 UPDATEs, all deactivated", async () => {
    mockSql.mockResolvedValueOnce([
      { puuid: "e1", region: "EUW", active: true },
      { puuid: "e2", region: "EUW", active: true },
      { puuid: "e3", region: "EUW", active: true },
      { puuid: "e4", region: "EUW", active: true },
    ]);
    const result = freshResult();
    const log = vi.fn();
    await applyRegionRuleToPro(mockSql as never, "faker-id", "T1", result, log);

    // 1 SELECT + 4 UPDATEs
    expect(mockSql).toHaveBeenCalledTimes(5);
    expect(result.accountsRegionDeactivated).toBe(4);
    expect(result.accountsRegionActivated).toBe(0);
    expect(result.unmappedTeams).toEqual([]);
    expect(log).not.toHaveBeenCalled();
  });

  it("only issues UPDATEs for accounts whose active flag actually changes", async () => {
    mockSql.mockResolvedValueOnce([
      { puuid: "kr1", region: "KR", active: true }, // already correct -> no UPDATE
      { puuid: "euw1", region: "EUW", active: true }, // needs deactivating -> 1 UPDATE
    ]);
    const result = freshResult();
    await applyRegionRuleToPro(mockSql as never, "pro-1", "T1", result, () => {});
    expect(mockSql).toHaveBeenCalledTimes(2); // 1 SELECT + 1 UPDATE (not 2)
    expect(result.accountsRegionDeactivated).toBe(1);
  });

  it("logs and tracks an unmapped team without issuing any UPDATE", async () => {
    mockSql.mockResolvedValueOnce([{ puuid: "a1", region: "EUW", active: true }]);
    const result = freshResult();
    const log = vi.fn();
    await applyRegionRuleToPro(mockSql as never, "pro-1", "Witchcraft", result, log);
    expect(mockSql).toHaveBeenCalledTimes(1); // SELECT only
    expect(log).toHaveBeenCalled();
    expect(result.unmappedTeams).toEqual(["Witchcraft"]);
  });

  it("dedupes repeated unmapped team names across calls sharing the same result object", async () => {
    const result = freshResult();
    mockSql.mockResolvedValueOnce([{ puuid: "a1", region: "EUW", active: true }]);
    await applyRegionRuleToPro(mockSql as never, "pro-1", "Witchcraft", result, () => {});
    mockSql.mockResolvedValueOnce([{ puuid: "a2", region: "NA", active: true }]);
    await applyRegionRuleToPro(mockSql as never, "pro-2", "Witchcraft", result, () => {});
    expect(result.unmappedTeams).toEqual(["Witchcraft"]);
  });

  it("null team: no UPDATEs at all, even for a previously-inactive account", async () => {
    mockSql.mockResolvedValueOnce([{ puuid: "a1", region: "EUW", active: false }]);
    const result = freshResult();
    await applyRegionRuleToPro(mockSql as never, "pro-1", null, result, () => {});
    expect(mockSql).toHaveBeenCalledTimes(1); // SELECT only
    expect(result.accountsRegionActivated).toBe(0);
  });

  it("unreachable (LPL) team with a KR account activates only that account", async () => {
    mockSql.mockResolvedValueOnce([
      { puuid: "kr1", region: "KR", active: false },
      { puuid: "cn1", region: "EUW", active: true },
    ]);
    const result = freshResult();
    await applyRegionRuleToPro(mockSql as never, "pro-1", "Bilibili Gaming", result, () => {});
    expect(mockSql).toHaveBeenCalledTimes(3); // SELECT + 2 UPDATEs
    expect(result.accountsRegionActivated).toBe(1);
    expect(result.accountsRegionDeactivated).toBe(1);
  });
});
