"use client";

import { IconWithFallback } from "@/components/IconWithFallback";
import type { ChampionIconEntry } from "@/components/proAssets";
import type { DraftAssistantCandidate, DraftMatchupPreview } from "../draftAssistantModel";

interface DraftMatchupGridProps {
  candidates: DraftAssistantCandidate[];
  enemyIds: number[];
  champIcons: Map<number, ChampionIconEntry>;
  previews: Map<number, DraftMatchupPreview>;
}

function entryFor(champIcons: Map<number, ChampionIconEntry>, id: number): ChampionIconEntry {
  return champIcons.get(id) ?? { name: `Champion #${id}`, icon: "" };
}

function cellValue(preview: DraftMatchupPreview | undefined, opponentId: number): number | null {
  if (!preview) return null;
  const row = [...preview.best, ...preview.worst].find((item) => item.oppId === opponentId);
  return row?.winRate ?? null;
}

function cellStyle(value: number | null): { background: string; color: string } {
  if (value === null || !Number.isFinite(value)) {
    return { background: "rgba(233,233,237,.04)", color: "rgba(233,233,237,.38)" };
  }
  if (value >= 0.53) return { background: "rgba(70,199,155,.22)", color: "#7fe0c0" };
  if (value >= 0.51) return { background: "rgba(70,199,155,.11)", color: "#46c79b" };
  if (value >= 0.49) return { background: "rgba(233,233,237,.06)", color: "rgba(233,233,237,.6)" };
  return { background: "rgba(232,115,110,.14)", color: "#e8736e" };
}

function percent(value: number | null): string {
  return value === null || !Number.isFinite(value) ? "—" : (value * 100).toFixed(1);
}

export default function DraftMatchupGrid({ candidates, enemyIds, champIcons, previews }: DraftMatchupGridProps) {
  return (
    <section
      className="min-w-0 overflow-hidden rounded-[9px] p-3.5"
      style={{ boxShadow: "inset 0 0 0 1px rgba(233,233,237,.08)", background: "#1b1d2a" }}
      aria-labelledby="matchup-grid-heading"
    >
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h2 id="matchup-grid-heading" className="text-[10px] font-semibold uppercase tracking-[0.14em] text-txt/[0.5]">
            Matchup grid
          </h2>
          <p className="mt-1 text-[10px] leading-[1.35] text-txt/[0.38]">Your top five candidates against every enemy locked so far.</p>
        </div>
        <span className="text-[9px] uppercase tracking-[0.1em] text-txt/[0.3]">u.gg pattern</span>
      </div>

      {enemyIds.length === 0 ? (
        <p className="py-8 text-center text-[11px] text-txt/[0.48]">Add enemies to reveal the matchup grid.</p>
      ) : candidates.length === 0 ? (
        <p className="py-8 text-center text-[11px] text-txt/[0.48]">No ranked candidates meet the active filters.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[330px] border-separate border-spacing-x-1 border-spacing-y-1 text-left">
            <thead>
              <tr>
                <th scope="col" className="w-[72px] px-1 pb-1 text-[9px] font-medium uppercase tracking-[0.1em] text-txt/[0.35]">Pick</th>
                {enemyIds.map((id) => {
                  const entry = entryFor(champIcons, id);
                  return (
                    <th key={id} scope="col" className="px-1 pb-1 text-center text-[9px] font-medium uppercase tracking-[0.08em] text-txt/[0.35]" title={entry.name}>
                      <span className="block truncate">{entry.name}</span>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {candidates.slice(0, 5).map((candidate) => {
                const entry = entryFor(champIcons, candidate.champId);
                const preview = previews.get(candidate.champId);
                return (
                  <tr key={candidate.champId}>
                    <th scope="row" className="px-1 py-0.5 font-normal">
                      <div className="flex min-w-0 items-center gap-1.5">
                        <span className="w-3 text-[9px] tabular-nums text-txt/[0.38]">{candidate.rank}</span>
                        <span className="h-6 w-6 flex-shrink-0 overflow-hidden rounded-[6px]" style={{ boxShadow: "inset 0 0 0 1px rgba(233,233,237,.12)" }}>
                          <IconWithFallback src={entry.icon} alt={entry.name} fallbackGlyph={entry.name} className="h-full w-full object-cover" size={24} />
                        </span>
                        <span className="min-w-0 truncate text-[10px] text-txt" title={entry.name}>{entry.name}</span>
                      </div>
                    </th>
                    {enemyIds.map((enemyId) => {
                      const value = cellValue(preview, enemyId);
                      const style = cellStyle(value);
                      return (
                        <td key={`${candidate.champId}-${enemyId}`} className="h-[30px] min-w-[42px] rounded-[6px] px-1 text-center text-[11px] font-semibold tabular-nums" style={style}>
                          {percent(value)}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export { cellStyle };
