/**
 * Tests for lib/mystats/purge.ts's season-boundary purge orchestration.
 * sql mocked content-based (same pattern as draft-recommend.test.ts /
 * mystats-ingest.test.ts). Focus: idempotence (a second run purges 0 rows
 * without erroring or double-counting) + the anomaly cross-check.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSql = vi.fn();
vi.mock("@/lib/pro/db", () => ({ getSql: vi.fn(() => mockSql) }));

import { runSeasonPurge } from "@/lib/mystats/purge";
import { SEASON_START_MS } from "@/lib/mystats/season";

function sqlText(strings: TemplateStringsArray): string {
  return strings.join("|");
}

const PRE_SEASON_ROW = { match_id: "OLD1", game_creation: "2025-12-01T00:00:00.000Z", patch: "15.24" };
const IN_SEASON_ROW = { match_id: "NEW1", game_creation: "2026-02-01T00:00:00.000Z", patch: "16.3" };

describe("runSeasonPurge", () => {
  beforeEach(() => {
    mockSql.mockReset();
  });

  it("first run: deletes pre-season rows, keeps in-season rows, resets the cursor", async () => {
    let deleteCalled = false;
    let cursorReset = false;
    let cursorResetSql = "";
    mockSql.mockImplementation((strings: TemplateStringsArray) => {
      const text = sqlText(strings);
      if (text.includes("SELECT match_id, game_creation, patch FROM coachbuild.my_matches")) {
        return Promise.resolve([PRE_SEASON_ROW, IN_SEASON_ROW]);
      }
      if (text.includes("DELETE FROM coachbuild.my_matches")) {
        deleteCalled = true;
        return Promise.resolve([{ match_id: "OLD1" }]); // one row deleted
      }
      if (text.includes("SELECT count(*)::int AS n FROM coachbuild.my_matches WHERE patch NOT LIKE")) {
        return Promise.resolve([{ n: 0 }]);
      }
      if (text.includes("SELECT count(*)::int AS n FROM coachbuild.my_matches")) {
        return Promise.resolve([{ n: 1 }]); // NEW1 remains
      }
      if (text.includes("my_ingest_cursor")) {
        cursorReset = true;
        cursorResetSql = text;
        return Promise.resolve([]);
      }
      return Promise.resolve([]);
    });

    const result = await runSeasonPurge(mockSql as never);

    expect(deleteCalled).toBe(true);
    expect(cursorReset).toBe(true);
    // Migration 0020: the DELETE above is deliberately account-WIDE, so the
    // cursor reset must be too. A reset scoped to one account would leave
    // every OTHER account claiming backfill_done over a hole the purge just
    // made, and its next backfill would refuse to re-walk it. Asserted as
    // "no WHERE clause" because that is exactly the property that matters.
    expect(cursorResetSql).toContain("UPDATE coachbuild.my_ingest_cursor");
    expect(cursorResetSql.toLowerCase()).not.toContain("where");
    expect(result.rowsBefore).toBe(2);
    expect(result.rowsDeleted).toBe(1);
    expect(result.rowsKept).toBe(1);
    expect(result.offPatchRemaining).toBe(0);
    expect(result.anomalies).toEqual([]);
    expect(result.seasonStartIso).toBe(new Date(SEASON_START_MS).toISOString());
  });

  it("IDEMPOTENT: a second run (nothing pre-season left) deletes 0 rows without erroring", async () => {
    mockSql.mockImplementation((strings: TemplateStringsArray) => {
      const text = sqlText(strings);
      if (text.includes("SELECT match_id, game_creation, patch FROM coachbuild.my_matches")) {
        return Promise.resolve([IN_SEASON_ROW]); // only in-season rows remain
      }
      if (text.includes("DELETE FROM coachbuild.my_matches")) {
        return Promise.resolve([]); // nothing matches the WHERE clause anymore
      }
      if (text.includes("SELECT count(*)::int AS n FROM coachbuild.my_matches WHERE patch NOT LIKE")) {
        return Promise.resolve([{ n: 0 }]);
      }
      if (text.includes("SELECT count(*)::int AS n FROM coachbuild.my_matches")) {
        return Promise.resolve([{ n: 1 }]);
      }
      return Promise.resolve([]);
    });

    const result = await runSeasonPurge(mockSql as never);

    expect(result.rowsDeleted).toBe(0);
    expect(result.rowsKept).toBe(1);
    expect(result.anomalies).toEqual([]);
  });

  it("flags a game_creation/patch disagreement but still purges by game_creation alone", async () => {
    const disagreeingRow = { match_id: "WEIRD1", game_creation: "2025-12-01T00:00:00.000Z", patch: "16.1" }; // 16.x patch, pre-season timestamp
    mockSql.mockImplementation((strings: TemplateStringsArray) => {
      const text = sqlText(strings);
      if (text.includes("SELECT match_id, game_creation, patch FROM coachbuild.my_matches")) {
        return Promise.resolve([disagreeingRow]);
      }
      if (text.includes("DELETE FROM coachbuild.my_matches")) {
        return Promise.resolve([{ match_id: "WEIRD1" }]); // deleted anyway -- game_creation is pre-season
      }
      if (text.includes("SELECT count(*)::int AS n FROM coachbuild.my_matches WHERE patch NOT LIKE")) {
        return Promise.resolve([{ n: 0 }]);
      }
      if (text.includes("SELECT count(*)::int AS n FROM coachbuild.my_matches")) {
        return Promise.resolve([{ n: 0 }]);
      }
      return Promise.resolve([]);
    });

    const result = await runSeasonPurge(mockSql as never);

    expect(result.anomalies).toHaveLength(1);
    expect(result.anomalies[0].reason).toContain("pre-season");
    expect(result.rowsDeleted).toBe(1); // still purged -- game_creation is authoritative, not the patch label
  });

  it("reports offPatchRemaining > 0 when a surviving row's patch doesn't match, without crashing", async () => {
    mockSql.mockImplementation((strings: TemplateStringsArray) => {
      const text = sqlText(strings);
      if (text.includes("SELECT match_id, game_creation, patch FROM coachbuild.my_matches")) return Promise.resolve([]);
      if (text.includes("DELETE FROM coachbuild.my_matches")) return Promise.resolve([]);
      if (text.includes("SELECT count(*)::int AS n FROM coachbuild.my_matches WHERE patch NOT LIKE")) {
        return Promise.resolve([{ n: 3 }]);
      }
      if (text.includes("SELECT count(*)::int AS n FROM coachbuild.my_matches")) return Promise.resolve([{ n: 10 }]);
      return Promise.resolve([]);
    });

    const result = await runSeasonPurge(mockSql as never);
    expect(result.offPatchRemaining).toBe(3);
  });
});
