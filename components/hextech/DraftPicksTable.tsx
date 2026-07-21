"use client";

// ─────────────────────────────────────────────────────────────────────────────
// DraftPicksTable — "SUGGESTED PICKS" sortable table (draft redesign plan
// §3/§5.4). Native <table> (no shadcn Table pull — a plain semantic table
// with `aria-sort` header buttons IS the accessible primitive here; nothing
// about sorting a column needs Radix-level focus-trap/portal machinery, so
// hand-rolling is the right call rather than adding a dependency mid-parallel
// -run with engo touching package.json-adjacent files). Row-shaping/sort
// logic lives in the JSX-free draftPicksTable.ts (unit-tested there).
//
// Honesty carryover (plan §5.4/§6): default sort is ALWAYS the server's own
// rank; any other sort is purely a display transform (sortPickRows never
// mutates/re-scores) and shows a caption disclaiming it; n=/LOW SAMPLE/
// personal badges survive every sort untouched, same rows just reordered.
// ─────────────────────────────────────────────────────────────────────────────

import { useState } from "react";
import { IconWithFallback } from "@/components/IconWithFallback";
import type { DraftPlayResult } from "@/components/live/draftRecommend";
import type { ChampionIconEntry } from "@/components/proAssets";
import { buildPersonalBadgeModel } from "@/components/live/personalBadge";
import {
  buildPickRows,
  sortPickRows,
  nextPickSortState,
  ariaSortFor,
  pickSortCaption,
  difficultyLabel,
  synergyClass,
  DEFAULT_PICK_SORT,
  type PickSortKey,
  type SortState,
} from "./draftPicksModel";

interface DraftPicksTableProps {
  plays: DraftPlayResult[];
  champIcons: Map<number, ChampionIconEntry>;
  /** aria-label context — "Suggested picks" vs "Potential counters" (the
   *  under-1,000-game leads list, plan §37.4) render through this SAME
   *  table component with a different caption/label, never a forked
   *  implementation that could silently drift on the honesty states. */
  caption: string;
}

function pct(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

function SortHeader({
  column,
  label,
  sort,
  onSort,
  align = "right",
}: {
  column: PickSortKey;
  label: string;
  sort: SortState;
  onSort: (col: PickSortKey) => void;
  align?: "left" | "right";
}) {
  const ariaSort = ariaSortFor(column, sort);
  return (
    <th scope="col" aria-sort={ariaSort} className={`py-2 px-2.5 ${align === "right" ? "text-right" : "text-left"}`}>
      <button
        type="button"
        onClick={() => onSort(column)}
        className="dt-th-btn inline-flex items-center gap-1 text-[10px] tracking-[0.1em] uppercase font-bold text-[color:var(--dt-mut)] hover:text-[color:var(--dt-txt)] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[color:var(--dt-cyan)] rounded"
      >
        {label}
        <span aria-hidden="true" className="text-[9px]">
          {ariaSort === "ascending" ? "▲" : ariaSort === "descending" ? "▼" : "⇅"}
        </span>
      </button>
    </th>
  );
}

export default function DraftPicksTable({ plays, champIcons, caption }: DraftPicksTableProps) {
  const [sort, setSort] = useState<SortState>(DEFAULT_PICK_SORT);

  const rows = sortPickRows(buildPickRows(plays, champIcons), sort);
  const captionText = pickSortCaption(sort);

  function handleSort(col: PickSortKey) {
    setSort((cur) => nextPickSortState(cur, col));
  }

  return (
    <div className="dt-panel overflow-hidden">
      {captionText && <p className="text-[10.5px] text-[color:var(--dt-cyan)] px-3 pt-2.5">{captionText}</p>}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] border-collapse" aria-label={caption}>
          <thead>
            <tr className="border-b border-[color:var(--dt-line)]">
              <SortHeader column="rank" label="Rank" sort={sort} onSort={handleSort} align="left" />
              <th scope="col" className="py-2 px-2.5 text-left text-[10px] tracking-[0.1em] uppercase font-bold text-[color:var(--dt-mut)]">
                Champion
              </th>
              <SortHeader column="winRate" label="Win Rate" sort={sort} onSort={handleSort} />
              <SortHeader column="difficulty" label="Difficulty" sort={sort} onSort={handleSort} />
              <SortHeader column="synergy" label="Synergy" sort={sort} onSort={handleSort} />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const personalBadge = buildPersonalBadgeModel(row.personal, row.personalOverall);
              return (
                <tr key={row.champId} className="border-b border-[color:var(--dt-line)] last:border-b-0">
                  <td className="py-2 px-2.5 text-[11px] font-bold tabular-nums text-[color:var(--dt-mut)]">{row.rank}</td>
                  <td className="py-2 px-2.5">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="w-8 h-8 rounded-lg bg-black/30 border border-[color:var(--dt-line)] overflow-hidden flex-shrink-0">
                        <IconWithFallback src={row.icon} alt={row.name} fallbackGlyph={row.name} className="w-full h-full object-cover" size={32} />
                      </span>
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="text-[12.5px] font-semibold text-[color:var(--dt-txt)] truncate">{row.name}</span>
                          {row.confidence === "low" && (
                            <span className="text-[8.5px] tracking-[0.06em] uppercase font-bold px-1 py-0.5 rounded border border-[color:var(--dt-line)] text-[color:var(--dt-mut)] flex-shrink-0">
                              Low sample
                            </span>
                          )}
                        </div>
                        <div className="text-[10px] text-[color:var(--dt-mut)] tabular-nums">n={row.minGames ?? "—"}</div>
                      </div>
                    </div>
                  </td>
                  <td className="py-2 px-2.5 text-right">
                    <div className="inline-flex flex-col items-end gap-1 w-24">
                      <span className="text-[12px] font-bold tabular-nums text-[color:var(--dt-txt)]">{pct(row.score)}</span>
                      <span className="h-1 w-full rounded-full bg-black/30 overflow-hidden">
                        <span
                          className="block h-full rounded-full"
                          style={{ width: `${Math.min(100, Math.max(2, row.score * 100))}%`, background: "var(--dt-cyan)" }}
                        />
                      </span>
                      {personalBadge?.vsLabel && (
                        <span className="text-[9px] tabular-nums text-[color:var(--dt-mut)]" title={personalBadge.tooltip}>
                          {personalBadge.vsLabel}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="py-2 px-2.5 text-right text-[11.5px] tabular-nums text-[color:var(--dt-mut)]">
                    {difficultyLabel(row.difficultyBand)}
                  </td>
                  <td className={`py-2 px-2.5 text-right text-[11.5px] font-semibold ${synergyClass(row.synergyBand)}`}>
                    {row.synergyBand}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
