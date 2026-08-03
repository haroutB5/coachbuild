"use client";

// ─────────────────────────────────────────────────────────────────────────────
// DraftPicksTable — "SUGGESTED PICKS" sortable table (draft redesign,
// mockup 3). Native <table> (no shadcn Table pull — a plain semantic table
// with `aria-sort` header buttons IS the accessible primitive here). Row-
// shaping/sort logic lives in the JSX-free draftPicksModel.ts (engo's file,
// unit-tested there).
//
// v0.51.0: rethemed from the retired cyan `.draft-tactical`/`.dt-*` HUD to
// the app-wide navy/gold tokens, and added a GAMES column between WIN RATE
// and DIFFICULTY (mockup 3's exact column order: # / CHAMPION / WIN RATE /
// GAMES / DIFFICULTY / SYNERGY). `PickRow` doesn't have an explicit `games`
// field on this wave's pinned contract snapshot yet (engo's addition to
// draftPicksModel.ts) — read defensively via a locally-widened type (same
// "consume engo's in-flight fields without editing the shared contract or
// guessing" pattern as the matchday tennis defensive-field convention) so
// this compiles whether or not the field has landed yet. Missing sample data
// stays absent in the column rather than becoming a fabricated zero.
//
// Honesty carryover (unchanged): default sort is ALWAYS the server's own
// rank; any other sort is purely a display transform and shows a caption
// disclaiming it; n=/LOW SAMPLE/personal badges survive every sort
// untouched, same rows just reordered.
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
  type PickRow,
} from "./draftPicksModel";

/** Defensive widen — see this file's header comment. `games` is this wave's
 *  pinned-contract addition to PickRow; may not exist yet depending on merge
 *  order. */
type PickRowWithGames = PickRow & { games?: number | null };

function gamesFor(row: PickRow): number | null {
  const widened = row as PickRowWithGames;
  if (typeof widened.games === "number") return widened.games;
  return row.minGames ?? null;
}

interface DraftPicksTableProps {
  plays: DraftPlayResult[];
  champIcons: Map<number, ChampionIconEntry>;
  /** aria-label context — "Suggested picks" vs "Potential counters" (the
   *  under-1,000-game leads list) render through this SAME table component
   *  with a different caption/label, never a forked implementation that
   *  could silently drift on the honesty states. */
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
  const active = ariaSort !== "none";
  return (
    <th scope="col" aria-sort={ariaSort} className={`py-2 px-2.5 ${align === "right" ? "text-right" : "text-left"}`}>
      <button
        type="button"
        onClick={() => onSort(column)}
        className={`inline-flex items-center gap-1 text-[10px] tracking-[0.1em] uppercase font-bold transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-teal rounded ${
          active ? "text-teal" : "text-mut hover:text-txt"
        }`}
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
    <div className="bg-panel border border-line rounded-xl overflow-hidden">
      {captionText && <p className="text-[10.5px] text-teal px-3 pt-2.5">{captionText}</p>}
      <div className="overflow-x-auto">
        {/* 620px forced a horizontal scroll (and a visually clipped Synergy column)
            inside the right-hand column at 1440px — a very common laptop width.
            540 fits without one; the container keeps overflow-x-auto for the
            genuinely narrow case. */}
        <table className="w-full min-w-[540px] border-collapse" aria-label={caption}>
          <thead>
            <tr className="border-b border-line">
              <SortHeader column="rank" label="#" sort={sort} onSort={handleSort} align="left" />
              <th scope="col" className="py-2 px-2.5 text-left text-[10px] tracking-[0.1em] uppercase font-bold text-mut">
                Champion
              </th>
              <SortHeader column="winRate" label="Win Rate" sort={sort} onSort={handleSort} />
              <th scope="col" className="py-2 px-2.5 text-right text-[10px] tracking-[0.1em] uppercase font-bold text-mut">
                Games
              </th>
              <SortHeader column="difficulty" label="Difficulty" sort={sort} onSort={handleSort} />
              <SortHeader column="synergy" label="Synergy" sort={sort} onSort={handleSort} />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const personalBadge = buildPersonalBadgeModel(row.personal, row.personalOverall);
              const games = gamesFor(row);
              return (
                <tr key={row.champId} className="border-b border-line last:border-b-0">
                  <td className="py-2 px-2.5 text-[11px] font-bold tabular-nums text-mut">{row.rank}</td>
                  <td className="py-2 px-2.5">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="w-8 h-8 rounded-lg bg-black/30 border border-line overflow-hidden flex-shrink-0">
                        <IconWithFallback src={row.icon} alt={row.name} fallbackGlyph={row.name} className="w-full h-full object-cover" size={32} />
                      </span>
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="text-[12.5px] font-semibold text-txt truncate">{row.name}</span>
                          {row.confidence === "low" && (
                            <span className="text-[8.5px] tracking-[0.06em] uppercase font-bold px-1 py-0.5 rounded border border-line text-mut flex-shrink-0">
                              Low sample
                            </span>
                          )}
                        </div>
                        {personalBadge?.vsLabel && (
                          <div className="text-[10px] text-mut tabular-nums" title={personalBadge.tooltip}>
                            {personalBadge.vsLabel}
                          </div>
                        )}
                      </div>
                    </div>
                  </td>
                  <td className="py-2 px-2.5 text-right">
                    <div className="inline-flex flex-col items-end gap-1 w-24">
                      <span className="text-[12px] font-bold tabular-nums text-txt">{pct(row.score)}</span>
                      <span className="h-1 w-full rounded-full bg-panel2 overflow-hidden">
                        <span
                          className="block h-full rounded-full bg-teal"
                          style={{ width: `${Math.min(100, Math.max(2, row.score * 100))}%` }}
                        />
                      </span>
                    </div>
                  </td>
                  <td className="py-2 px-2.5 text-right text-[11.5px] tabular-nums text-mut">{games ?? "—"}</td>
                  <td className="py-2 px-2.5 text-right text-[11.5px] tabular-nums text-mut">
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
