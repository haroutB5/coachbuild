"use client";

// ─────────────────────────────────────────────────────────────────────────────
// DraftBansTable — "SUGGESTED BANS" table (draft redesign plan §3/§5.3),
// replacing the prototype's cryptic dual-glyph columns with the existing
// honest ban-priority bar (DraftResultRow's own BAN_SCORE_BAR_CEILING logic,
// mirrored here — see draftBansTable.ts) + a single Difficulty column.
// BAN_MIN_MATCHUP_GAMES (1000-game floor) and the empty state are the
// caller's (app/draft/page.tsx) job, same honesty carryover as the picks
// table. Deliberately NOT sortable — 5 rows max (rankBans' own top-5 cap),
// server priority order IS the point of a ban list.
// ─────────────────────────────────────────────────────────────────────────────

import { IconWithFallback } from "@/components/IconWithFallback";
import type { DraftBanResult } from "@/components/live/draftRecommend";
import type { ChampionIconEntry } from "@/components/proAssets";
import { buildBanRows, banPriorityBarPct } from "./draftBansModel";
import { difficultyLabel } from "./draftPicksModel";

interface DraftBansTableProps {
  bans: DraftBanResult[];
  champIcons: Map<number, ChampionIconEntry>;
}

export default function DraftBansTable({ bans, champIcons }: DraftBansTableProps) {
  const rows = buildBanRows(bans, champIcons);

  return (
    <div className="dt-panel overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[420px] border-collapse" aria-label="Suggested bans">
          <thead>
            <tr className="border-b border-[color:var(--dt-line)]">
              <th scope="col" className="py-2 px-2.5 text-left text-[10px] tracking-[0.1em] uppercase font-bold text-[color:var(--dt-mut)]">
                Champion
              </th>
              <th scope="col" className="py-2 px-2.5 text-left text-[10px] tracking-[0.1em] uppercase font-bold text-[color:var(--dt-mut)]">
                Priority
              </th>
              <th scope="col" className="py-2 px-2.5 text-right text-[10px] tracking-[0.1em] uppercase font-bold text-[color:var(--dt-mut)]">
                Difficulty
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.champId} className="border-b border-[color:var(--dt-line)] last:border-b-0">
                <td className="py-2 px-2.5">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="w-8 h-8 rounded-lg bg-black/30 border border-[color:var(--dt-line)] overflow-hidden flex-shrink-0">
                      <IconWithFallback src={row.icon} alt={row.name} fallbackGlyph={row.name} className="w-full h-full object-cover" size={32} />
                    </span>
                    <span className="text-[12.5px] font-semibold text-[color:var(--dt-txt)] truncate">{row.name}</span>
                  </div>
                </td>
                <td className="py-2 px-2.5" title={`Ban priority score: ${row.score.toFixed(3)}`}>
                  <div className="flex items-center gap-2">
                    <span className="h-1.5 w-20 rounded-full bg-black/30 overflow-hidden flex-shrink-0">
                      <span className="block h-full rounded-full" style={{ width: `${banPriorityBarPct(row.score)}%`, background: "var(--dt-cyan)" }} />
                    </span>
                    <span className="text-[10px] tabular-nums text-[color:var(--dt-mut)]">n={row.minGames ?? "—"}</span>
                  </div>
                </td>
                <td className="py-2 px-2.5 text-right text-[11.5px] tabular-nums text-[color:var(--dt-mut)]">
                  {difficultyLabel(row.difficultyBand)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
