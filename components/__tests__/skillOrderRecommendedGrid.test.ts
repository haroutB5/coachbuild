/**
 * Pure-logic tests for the RECOMMENDATION side of the shared skill grid —
 * components/hextech/skillOrder.ts's model→grid helpers, which are what decide
 * that a recommendation always answers all 18 levels while GameDetailSheet's
 * per-game grid never pads.
 *
 * The property under test throughout: the guess is renderable but always
 * DISTINGUISHABLE. No JSX (vitest's node environment) — SkillGrid.tsx itself is
 * a pure function of what these helpers return.
 */
import { describe, it, expect } from "vitest";
import {
  buildRecommendedSkillGrid,
  hasDerivedTail,
  hasInferredTail,
  inferredTailRange,
  recommendedSkillOrder,
  type Ability,
  type SkillOrderModel,
} from "../hextech/skillOrder";
import { SKILL_GRID_COLUMNS, SKILL_ROWS, levelsWithProvenance } from "../skillOrderGrid";
import { kitFromMaxRanks } from "@/lib/championKit";

const A = (s: string): Ability[] => s.split("") as Ability[];

const model = (over: Partial<SkillOrderModel>): SkillOrderModel => ({
  priority: A("QWE"),
  levels: { Q: [], W: [], E: [], R: [] },
  order: A("WQEQQRQWQWRWWEE"),
  completed: false,
  observedLevels: 15,
  sampleSize: 1000,
  winRate: 0.5,
  share: 0.4,
  ...over,
});

/** All cells of one provenance, across every row, level-ascending. */
function levelsOf(grid: ReturnType<typeof buildRecommendedSkillGrid>, p: "measured" | "derived" | "inferred") {
  return SKILL_ROWS.flatMap((_, ri) => levelsWithProvenance(grid[ri], p)).sort((a, b) => a - b);
}

describe("recommendedSkillOrder", () => {
  it("appends the inferred tail to the model's own order", () => {
    const m = model({ inferredTail: A("RWW") });
    expect(recommendedSkillOrder(m)).toEqual([...m.order, "R", "W", "W"]);
  });

  it("is just the order when nothing was inferred", () => {
    const m = model({});
    expect(recommendedSkillOrder(m)).toEqual(m.order);
  });

  it("tolerates a malformed payload rather than throwing", () => {
    const bad = { order: undefined, inferredTail: undefined } as unknown as SkillOrderModel;
    expect(recommendedSkillOrder(bad)).toEqual([]);
  });
});

describe("buildRecommendedSkillGrid", () => {
  it("is always 18 columns wide — a recommendation answers the whole game", () => {
    // Even for the worst case: 15 known levels and nothing inferable.
    const grid = buildRecommendedSkillGrid(model({}));
    for (const row of grid) expect(row.length).toBe(SKILL_GRID_COLUMNS);
    expect(SKILL_GRID_COLUMNS).toBe(18);
  });

  it("a cleanly COMPLETED order marks 16-18 derived, not measured and not inferred", () => {
    const grid = buildRecommendedSkillGrid(
      model({ order: A("WQEQQRQWQWRWWEEREE"), completed: true, observedLevels: 15 })
    );
    expect(levelsOf(grid, "measured")).toEqual(Array.from({ length: 15 }, (_, i) => i + 1));
    expect(levelsOf(grid, "derived")).toEqual([16, 17, 18]);
    expect(levelsOf(grid, "inferred")).toEqual([]);
  });

  it("an INFERRED tail marks 16-18 inferred — never derived, never measured", () => {
    const grid = buildRecommendedSkillGrid(model({ inferredTail: A("RWW") }));
    expect(levelsOf(grid, "measured")).toEqual(Array.from({ length: 15 }, (_, i) => i + 1));
    expect(levelsOf(grid, "derived")).toEqual([]);
    expect(levelsOf(grid, "inferred")).toEqual([16, 17, 18]);
  });

  it("THE BOUNDARY: a partial inferred tail fills what it can and leaves the rest blank", () => {
    // The one case where the recommendation grid genuinely has holes — the
    // priority named nothing left under a cap. Level 17-18 must stay empty
    // rather than being padded to look tidy.
    const grid = buildRecommendedSkillGrid(model({ inferredTail: A("R") }));
    expect(levelsOf(grid, "inferred")).toEqual([16]);
    for (const row of grid) {
      expect(row[16]).toBeNull();
      expect(row[17]).toBeNull();
    }
  });

  it("no cell is ever both — the three provenance sets are disjoint and cover every chip", () => {
    const grid = buildRecommendedSkillGrid(
      model({ order: A("WQEQQRQWQWRWWEER"), observedLevels: 15, inferredTail: A("WW") })
    );
    const measured = levelsOf(grid, "measured");
    const derived = levelsOf(grid, "derived");
    const inferred = levelsOf(grid, "inferred");
    expect(measured).toEqual(Array.from({ length: 15 }, (_, i) => i + 1));
    expect(derived).toEqual([16]);
    expect(inferred).toEqual([17, 18]);
    expect(new Set([...measured, ...derived, ...inferred]).size).toBe(18);
  });

  it("falls back to 'all measured' when observedLevels is absent (a pre-field cached payload)", () => {
    const m = model({ order: A("WQE"), completed: false });
    delete (m as { observedLevels?: number }).observedLevels;
    const grid = buildRecommendedSkillGrid(m);
    expect(levelsOf(grid, "measured")).toEqual([1, 2, 3]);
    expect(levelsOf(grid, "derived")).toEqual([]);
  });

  it("passes a non-standard kit through to the shared grid", () => {
    const jayce = model({
      kit: kitFromMaxRanks([6, 6, 6, 1]),
      order: A("QWEQQWQWQWQWWEEEEE"),
      observedLevels: 18,
    });
    const grid = buildRecommendedSkillGrid(jayce);
    expect(levelsWithProvenance(grid[SKILL_ROWS.indexOf("R")], "auto")).toEqual([1]);
    expect(levelsWithProvenance(grid[SKILL_ROWS.indexOf("R")], "measured")).toEqual([]);
  });
});

describe("caption predicates", () => {
  it("hasDerivedTail is true only when order runs past the observed levels", () => {
    expect(hasDerivedTail(model({ order: A("WQEQQRQWQWRWWEEREE"), completed: true }))).toBe(true);
    expect(hasDerivedTail(model({}))).toBe(false);
  });

  it("hasInferredTail is true only for a non-empty tail", () => {
    expect(hasInferredTail(model({ inferredTail: A("RWW") }))).toBe(true);
    expect(hasInferredTail(model({ inferredTail: [] }))).toBe(false);
    expect(hasInferredTail(model({}))).toBe(false);
  });

  it("inferredTailRange names the exact levels, so the disclosure is specific", () => {
    expect(inferredTailRange(model({ inferredTail: A("RWW") }))).toEqual({ from: 16, to: 18 });
    expect(inferredTailRange(model({ inferredTail: A("R") }))).toEqual({ from: 16, to: 16 });
    expect(inferredTailRange(model({}))).toBeNull();
  });
});
