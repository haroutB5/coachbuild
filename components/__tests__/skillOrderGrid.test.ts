/**
 * Pure-logic tests for the SHARED skill-grid transform — the primitive behind
 * both GameDetailSheet's per-game timeline and the Builds page's recommended
 * skill order (components/SkillGrid.tsx renders it). No JSX rendering: plain
 * functions, so they run under vitest's node environment.
 *
 * The provenance cases below are the load-bearing ones. A grid that renders a
 * derived or inferred level identically to a measured one is a fabrication
 * (repo CLAUDE.md hard rule #4), and the only thing standing between those two
 * outcomes is `buildSkillGrid`'s two boundary parameters.
 */
import { describe, it, expect } from "vitest";
import {
  ABILITY_PALETTE,
  EMPTY_CELL_CLASS,
  SKILL_GRID_COLUMNS,
  SKILL_ROWS,
  buildSkillGrid,
  describeSkillRow,
  levelsWithProvenance,
  skillCellClass,
} from "../skillOrderGrid";

const rowOf = (letter: (typeof SKILL_ROWS)[number]) => SKILL_ROWS.indexOf(letter);

describe("buildSkillGrid — structure", () => {
  it("returns a 4-row grid, one row per SKILL_ROWS entry", () => {
    expect(buildSkillGrid([]).length).toBe(SKILL_ROWS.length);
  });

  it("each row has exactly SKILL_GRID_COLUMNS cells, all null for empty input", () => {
    for (const row of buildSkillGrid([])) {
      expect(row.length).toBe(SKILL_GRID_COLUMNS);
      expect(row.every((c) => c === null)).toBe(true);
    }
  });

  it("places the level in the leveled ability's row at the (level-1) column", () => {
    const grid = buildSkillGrid(["Q", "W", "E", "Q"]);
    expect(grid[rowOf("Q")][0]?.level).toBe(1);
    expect(grid[rowOf("W")][1]?.level).toBe(2);
    expect(grid[rowOf("E")][2]?.level).toBe(3);
    expect(grid[rowOf("Q")][3]?.level).toBe(4);
  });

  it("leaves untouched cells in the leveled row null (one ability per level)", () => {
    expect(buildSkillGrid(["Q", "W"])[rowOf("Q")][1]).toBeNull();
  });

  it("R levels like any other ability, structurally", () => {
    expect(buildSkillGrid(["R"])[rowOf("R")][0]?.level).toBe(1);
  });

  it("a game with fewer than 18 recorded levels leaves trailing columns null — NEVER padded", () => {
    // The per-game fill rule. A game that ended at level 16 shows 16.
    const sixteen = Array.from({ length: 16 }, (_, i) => (["Q", "W", "E", "R"] as const)[i % 4]);
    const grid = buildSkillGrid(sixteen);
    for (const row of grid) {
      expect(row.length).toBe(SKILL_GRID_COLUMNS);
      expect(row[16]).toBeNull();
      expect(row[17]).toBeNull();
    }
  });

  it("caps at the column count even if the order somehow has more entries", () => {
    const long = Array.from({ length: 25 }, (_, i) => (["Q", "W", "E", "R"] as const)[i % 4]);
    for (const row of buildSkillGrid(long)) expect(row.length).toBe(SKILL_GRID_COLUMNS);
  });

  it("honours an explicit narrower column count", () => {
    for (const row of buildSkillGrid(["Q", "W"], { columns: 6 })) expect(row.length).toBe(6);
  });

  it("skips unrecognized ability letters instead of throwing", () => {
    expect(() => buildSkillGrid(["Q", "X", "W"])).not.toThrow();
    // "X" at index 1 is skipped; "W" at index 2 still lands at level 3.
    expect(buildSkillGrid(["Q", "X", "W"])[rowOf("W")][2]?.level).toBe(3);
  });
});

describe("buildSkillGrid — provenance", () => {
  const fifteen = Array.from({ length: 15 }, (_, i) => (["Q", "W", "E"] as const)[i % 3]);

  it("defaults every cell to measured — the per-game caller passes no boundaries", () => {
    const grid = buildSkillGrid(["Q", "W", "E", "R"]);
    for (const letter of SKILL_ROWS) {
      for (const cell of grid[rowOf(letter)]) {
        if (cell) expect(cell.provenance).toBe("measured");
      }
    }
  });

  it("splits measured / derived / inferred at the two boundaries", () => {
    // 15 measured + 2 derived + 1 inferred = the full 18.
    const order = [...fifteen, "R", "E", "E"];
    const grid = buildSkillGrid(order, { measuredThrough: 15, derivedThrough: 17 });
    // `.flat()` is row-major, so levels come out interleaved — sort before
    // comparing rather than asserting an accidental traversal order.
    const levelsOf = (p: string) =>
      grid
        .flat()
        .filter((c) => c?.provenance === p)
        .map((c) => c!.level)
        .sort((a, b) => a - b);
    expect(levelsOf("measured")).toEqual(Array.from({ length: 15 }, (_, i) => i + 1));
    expect(levelsOf("derived")).toEqual([16, 17]);
    expect(levelsOf("inferred")).toEqual([18]);
  });

  it("an entirely inferred tail: measuredThrough === derivedThrough === 15", () => {
    const order = [...fifteen, "R", "W", "W"];
    const grid = buildSkillGrid(order, { measuredThrough: 15, derivedThrough: 15 });
    const inferred = grid
      .flat()
      .filter((c) => c?.provenance === "inferred")
      .map((c) => c!.level)
      .sort((a, b) => a - b);
    expect(inferred).toEqual([16, 17, 18]);
  });

  it("derivedThrough below measuredThrough is clamped up — never demotes a measured cell", () => {
    const grid = buildSkillGrid(["Q", "W", "E"], { measuredThrough: 3, derivedThrough: 1 });
    for (const cell of grid.flat()) if (cell) expect(cell.provenance).toBe("measured");
  });

  it("boundaries past the order length are clamped rather than throwing", () => {
    const grid = buildSkillGrid(["Q", "W"], { measuredThrough: 99, derivedThrough: 99 });
    expect(grid.flat().filter((c) => c !== null).every((c) => c!.provenance === "measured")).toBe(true);
  });

  it("omitting derivedThrough means 'nothing was inferred' — the under-claiming default", () => {
    // A caller who forgets the parameter must never have a GUESS rendered as
    // measured arithmetic; the safe direction is to under-claim.
    const grid = buildSkillGrid(["Q", "Q", "Q"], { measuredThrough: 1 });
    const row = grid[rowOf("Q")];
    expect(levelsWithProvenance(row, "measured")).toEqual([1]);
    expect(levelsWithProvenance(row, "derived")).toEqual([2, 3]);
    expect(levelsWithProvenance(row, "inferred")).toEqual([]);
  });

  it("a negative or non-integer boundary falls back to 'all measured'", () => {
    for (const bad of [-1, 1.5, NaN]) {
      const grid = buildSkillGrid(["Q", "W"], { measuredThrough: bad });
      expect(grid.flat().filter((c) => c !== null).every((c) => c!.provenance === "measured")).toBe(true);
    }
  });
});

describe("cell styling", () => {
  it("a null cell gets the empty treatment", () => {
    expect(skillCellClass("Q", null)).toBe(EMPTY_CELL_CLASS);
  });

  it("every ability × provenance combination resolves to a distinct class string", () => {
    const seen = new Set<string>();
    for (const letter of SKILL_ROWS) {
      for (const provenance of ["measured", "derived", "inferred"] as const) {
        const cls = skillCellClass(letter, { level: 1, provenance });
        expect(cls).toBe(ABILITY_PALETTE[letter][provenance]);
        expect(cls.length).toBeGreaterThan(0);
        seen.add(cls);
      }
    }
    // 4 abilities × 3 provenances, none colliding — a collision would render a
    // guess identically to a measurement.
    expect(seen.size).toBe(12);
  });

  it("inferred is the only treatment using a dashed border, so it cannot be mistaken for derived", () => {
    for (const letter of SKILL_ROWS) {
      expect(ABILITY_PALETTE[letter].inferred).toContain("border-dashed");
      expect(ABILITY_PALETTE[letter].derived).not.toContain("border-dashed");
      expect(ABILITY_PALETTE[letter].measured).not.toContain("border-dashed");
    }
  });
});

describe("accessible row descriptions", () => {
  it("names the levels an ability is ranked at", () => {
    const grid = buildSkillGrid(["Q", "W", "Q"]);
    expect(describeSkillRow("Q", grid[rowOf("Q")])).toContain("levels 1, 3");
  });

  it("says so when a row has no data at all", () => {
    expect(describeSkillRow("R", buildSkillGrid(["Q"])[rowOf("R")])).toContain("no levelling data");
  });

  it("carries DERIVED provenance to screen readers, not just to sighted users", () => {
    const grid = buildSkillGrid(["Q", "Q"], { measuredThrough: 1, derivedThrough: 2 });
    const text = describeSkillRow("Q", grid[rowOf("Q")]);
    expect(text).toContain("Level 2 derived, not recorded");
  });

  it("carries INFERRED provenance too, and names it as inferred rather than derived", () => {
    const grid = buildSkillGrid(["Q", "Q"], { measuredThrough: 1, derivedThrough: 1 });
    const text = describeSkillRow("Q", grid[rowOf("Q")]);
    expect(text).toContain("inferred from the max-priority order");
    expect(text).not.toContain("derived, not recorded");
  });

  it("levelsWithProvenance filters to exactly one provenance", () => {
    const grid = buildSkillGrid(["Q", "Q", "Q"], { measuredThrough: 1, derivedThrough: 2 });
    const row = grid[rowOf("Q")];
    expect(levelsWithProvenance(row, "measured")).toEqual([1]);
    expect(levelsWithProvenance(row, "derived")).toEqual([2]);
    expect(levelsWithProvenance(row, "inferred")).toEqual([3]);
  });
});
