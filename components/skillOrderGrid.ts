// ─────────────────────────────────────────────────────────────────────────────
// skillOrderGrid.ts — pure transform: a flat skillOrder (["Q","W","E",...],
// one entry per level-up, in order) into the classic per-ability Q/W/E/R ×
// 18-level grid used by GameDetailSheet's Skill Order section.
// ─────────────────────────────────────────────────────────────────────────────

export type SkillLetter = "Q" | "W" | "E" | "R";

export const SKILL_ROWS: readonly SkillLetter[] = ["Q", "W", "E", "R"];
export const SKILL_GRID_COLUMNS = 18;

/**
 * Returns a 4×18 grid (rows in SKILL_ROWS order, columns = level 1..18).
 * Cell value is the level number (1-indexed) at which that ability was
 * leveled, or `null` if that ability wasn't leveled at that level. A game
 * with fewer than 18 recorded levels just leaves the trailing columns null.
 * Unrecognized entries in `skillOrder` (not Q/W/E/R) are skipped rather than
 * throwing — a malformed/legacy row should degrade, not crash the sheet.
 */
export function buildSkillOrderGrid(skillOrder: string[]): (number | null)[][] {
  const grid: (number | null)[][] = SKILL_ROWS.map(() =>
    new Array<number | null>(SKILL_GRID_COLUMNS).fill(null)
  );
  for (let i = 0; i < skillOrder.length && i < SKILL_GRID_COLUMNS; i++) {
    const rowIdx = SKILL_ROWS.indexOf(skillOrder[i] as SkillLetter);
    if (rowIdx === -1) continue;
    grid[rowIdx][i] = i + 1;
  }
  return grid;
}
