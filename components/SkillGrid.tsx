// ─────────────────────────────────────────────────────────────────────────────
// SkillGrid.tsx — THE skill grid. One row per ability, one column per champion
// level, a coloured chip where that ability took a point.
//
// Extracted from GameDetailSheet 2026-07-29 when the Builds page's recommended
// skill order moved from per-ability level lists to this same grid. ONE
// primitive on purpose: two grids that look alike and drift apart is the
// failure mode here, and provenance rendering (measured / derived / inferred /
// auto)
// is exactly the kind of rule that would drift.
//
// TAKES NO VIEW ON COMPLETENESS. It renders `columns` columns and fills the
// cells it is handed; whether the tail is filled is the caller's decision, and
// the two callers answer it differently on purpose — see skillOrderGrid.ts's
// header ("ONE PRIMITIVE, TWO FILL RULES").
//
// ── Mobile ──────────────────────────────────────────────────────────────────
// 18 columns at 390px is the reason a grid was rejected here once before. It is
// solved by `minmax(0, 1fr)` cells: the track can shrink below its content, so
// the grid always fits its container's width and the PAGE never gains a
// horizontal scrollbar. The `overflow-x-auto` wrapper is a second line of
// defence, not the mechanism — if some future container is narrower than the
// grid's own minimum, the GRID scrolls inside it and the page still does not.
// `max-w` on the card side caps how large the cells get on a 1920px desktop, so
// the grid reads as a compact chart rather than 18 giant squares.
// ─────────────────────────────────────────────────────────────────────────────

import { Fragment } from "react";
import type { ChampionKit } from "@/lib/types";
import {
  SKILL_GRID_COLUMNS,
  SKILL_ROWS,
  describeSkillRow,
  skillCellClass,
  skillRowLabelClass,
  type SkillGridCell,
} from "./skillOrderGrid";

export interface SkillGridProps {
  /** Rows in SKILL_ROWS order, each `columns` long. From `buildSkillGrid`. */
  grid: (SkillGridCell | null)[][];
  /** Column count — must match what `buildSkillGrid` produced. */
  columns?: number;
  /** Extra classes on the grid element itself (e.g. a `max-w-*` cap). */
  className?: string;
  /** Kit used to style Udyr's R as a basic row. */
  kit?: ChampionKit | null;
}

export default function SkillGrid({ grid, columns = SKILL_GRID_COLUMNS, className = "", kit }: SkillGridProps) {
  const rAsBasic = kit?.ultimateLevels === null;
  return (
    <div className="overflow-x-auto">
      {/* The visual grid is aria-hidden and the same information is served to
          assistive tech as the list below it. Doing it this way (rather than
          labelling cells) is what lets the rows stay FLAT children of one CSS
          grid — a per-row wrapper element would become a single grid item and
          collapse the whole layout. */}
      <div
        aria-hidden="true"
        className={`grid gap-[2px] sm:gap-[3px] ${className}`}
        style={{ gridTemplateColumns: `18px repeat(${columns}, minmax(0, 1fr))` }}
      >
        {SKILL_ROWS.map((letter, ri) => (
          <Fragment key={letter}>
            <div
              className={`flex items-center justify-center text-[10px] font-bold leading-none ${skillRowLabelClass(letter, {
                rAsBasic,
              })}`}
            >
              {letter}
            </div>
            {(grid[ri] ?? []).map((cell, ci) => (
              <div
                key={ci}
                className={`aspect-square min-w-0 rounded-[3px] flex items-center justify-center text-[8px] sm:text-[10px] font-bold tabular-nums leading-none ${skillCellClass(
                  letter,
                  cell,
                  { rAsBasic }
                )}`}
              >
                {cell ? cell.level : ""}
              </div>
            ))}
          </Fragment>
        ))}
      </div>

      <ul className="sr-only">
        {SKILL_ROWS.map((letter, ri) => (
          <li key={letter}>{describeSkillRow(letter, grid[ri] ?? [])}</li>
        ))}
      </ul>
    </div>
  );
}
