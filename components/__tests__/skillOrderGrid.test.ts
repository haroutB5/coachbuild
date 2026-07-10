/**
 * Pure-logic tests for the Skill Order grid transform used by
 * GameDetailSheet's Q/W/E/R × 18-level section. No JSX rendering — plain
 * functions, so they run fine under vitest's node environment.
 */
import { describe, it, expect } from "vitest";
import { buildSkillOrderGrid, SKILL_ROWS, SKILL_GRID_COLUMNS } from "../skillOrderGrid";

describe("buildSkillOrderGrid", () => {
  it("returns a 4-row grid, one row per SKILL_ROWS entry", () => {
    const grid = buildSkillOrderGrid([]);
    expect(grid.length).toBe(SKILL_ROWS.length);
  });

  it("each row has exactly SKILL_GRID_COLUMNS cells, all null for empty input", () => {
    const grid = buildSkillOrderGrid([]);
    for (const row of grid) {
      expect(row.length).toBe(SKILL_GRID_COLUMNS);
      expect(row.every((c) => c === null)).toBe(true);
    }
  });

  it("places the level number in the leveled ability's row at the (level-1) column", () => {
    const grid = buildSkillOrderGrid(["Q", "W", "E", "Q"]);
    const qRow = SKILL_ROWS.indexOf("Q");
    const wRow = SKILL_ROWS.indexOf("W");
    const eRow = SKILL_ROWS.indexOf("E");
    expect(grid[qRow][0]).toBe(1);
    expect(grid[wRow][1]).toBe(2);
    expect(grid[eRow][2]).toBe(3);
    expect(grid[qRow][3]).toBe(4);
  });

  it("leaves untouched cells in the leveled row as null (only one ability per level)", () => {
    const grid = buildSkillOrderGrid(["Q", "W"]);
    const qRow = SKILL_ROWS.indexOf("Q");
    expect(grid[qRow][1]).toBeNull();
  });

  it("R row is highlighted the same way structurally — R just leveled like any other", () => {
    const grid = buildSkillOrderGrid(["R"]);
    const rRow = SKILL_ROWS.indexOf("R");
    expect(grid[rRow][0]).toBe(1);
  });

  it("games with fewer than 18 recorded levels leave trailing columns null", () => {
    const grid = buildSkillOrderGrid(["Q", "W", "E"]);
    for (const row of grid) {
      expect(row.slice(3).every((c) => c === null)).toBe(true);
    }
  });

  it("caps at SKILL_GRID_COLUMNS even if skillOrder somehow has more entries", () => {
    const long = Array.from({ length: 25 }, (_, i) => (["Q", "W", "E", "R"] as const)[i % 4]);
    const grid = buildSkillOrderGrid(long);
    for (const row of grid) {
      expect(row.length).toBe(SKILL_GRID_COLUMNS);
    }
  });

  it("skips unrecognized ability letters instead of throwing", () => {
    expect(() => buildSkillOrderGrid(["Q", "X", "W"])).not.toThrow();
    const grid = buildSkillOrderGrid(["Q", "X", "W"]);
    const wRow = SKILL_ROWS.indexOf("W");
    // "X" at index 1 is skipped; "W" at index 2 still lands at level 3.
    expect(grid[wRow][2]).toBe(3);
  });
});
