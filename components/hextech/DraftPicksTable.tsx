"use client";

import { IconWithFallback } from "@/components/IconWithFallback";
import type { ChampionIconEntry } from "@/components/proAssets";
import ThemedSelect, { type ThemedSelectOption } from "@/components/ThemedSelect";
import {
  draftTierForRank,
  isOffMetaLaneShare,
  resolveVisibleDraftAssistantRanking,
  type DraftAssistantCandidate,
  type DraftAssistantDetailSort,
} from "./draftAssistantModel";

interface DraftPicksTableProps {
  rows: DraftAssistantCandidate[];
  champIcons: Map<number, ChampionIconEntry>;
  laneAverageValue: number | null;
  sort: DraftAssistantDetailSort;
  onSortChange: (sort: DraftAssistantDetailSort) => void;
  selectedChampionId: number | null;
  onSelect: (championId: number) => void;
  showAll: boolean;
  onShowAll: () => void;
  preserveOrder: boolean;
  showNoEnemyBlindHint: boolean;
  showCountersNoEnemies: boolean;
}

const SORT_OPTIONS: readonly ThemedSelectOption<DraftAssistantDetailSort>[] = [
  { value: "winRate", label: "Win Rate" },
  { value: "pickRate", label: "Pick Rate" },
  { value: "games", label: "Games" },
];

function entryFor(champIcons: Map<number, ChampionIconEntry>, id: number): ChampionIconEntry {
  return champIcons.get(id) ?? { name: `Champion #${id}`, icon: "" };
}

function percent(value: number | null): string {
  return value === null || !Number.isFinite(value) ? "—" : `${(value * 100).toFixed(1)}%`;
}

function points(value: number | null): string {
  return value === null || !Number.isFinite(value) ? "—" : `${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)}pp`;
}

function games(value: number | null): string {
  return value === null || !Number.isFinite(value) ? "—" : Math.round(value).toLocaleString();
}

function tierClass(rank: number): string {
  const tier = draftTierForRank(rank);
  if (tier === "S+") return "bg-accent text-bg";
  if (tier === "S") return "bg-accent/[0.32] text-accent-300";
  if (tier === "A") return "bg-accent/[0.16] text-accent-400";
  return "bg-txt/[0.08] text-txt/[0.6]";
}

function SortButton({
  label,
  value,
  sort,
  onChange,
}: {
  label: string;
  value: DraftAssistantDetailSort;
  sort: DraftAssistantDetailSort;
  onChange: (sort: DraftAssistantDetailSort) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(value)}
      className={`text-[9px] font-medium uppercase tracking-[0.12em] transition-colors duration-[120ms] ease-in focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2 ${sort === value ? "text-accent-300" : "text-txt/[0.38] hover:text-txt/[0.7]"}`}
      aria-label={`Sort rankings by ${label}`}
    >
      {label}
    </button>
  );
}

export default function DraftPicksTable({
  rows,
  champIcons,
  laneAverageValue,
  sort,
  onSortChange,
  selectedChampionId,
  onSelect,
  showAll,
  onShowAll,
  preserveOrder,
  showNoEnemyBlindHint,
  showCountersNoEnemies,
}: DraftPicksTableProps) {
  const rankingRows = resolveVisibleDraftAssistantRanking({
    rows,
    sort,
    limit: showAll ? Number.MAX_SAFE_INTEGER : 10,
    preserveOrder,
  });

  return (
    <section
      id="draft-detailed-rankings"
      className="min-w-0 overflow-hidden rounded-[9px]"
      style={{ boxShadow: "inset 0 0 0 1px rgba(233,233,237,.08)", background: "#1b1d2a" }}
      aria-labelledby="detailed-rankings-heading"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 px-3.5 py-3.5">
        <div>
          <h2 id="detailed-rankings-heading" className="text-[10px] font-semibold uppercase tracking-[0.14em] text-txt/[0.5]">Detailed rankings</h2>
          <p className="mt-1 text-[10px] text-txt/[0.35]">Server order stays intact; display sorting is reference-only.</p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[9px] uppercase tracking-[0.1em] text-txt/[0.35]">Sort</span>
          <ThemedSelect
            value={sort}
            options={SORT_OPTIONS}
            disabled={preserveOrder}
            ariaLabel={preserveOrder ? "Sorting disabled for Comfort Picks" : "Sort detailed rankings"}
            onChange={onSortChange}
            triggerClassName="min-w-[92px] min-h-[44px] rounded-[6px] px-2 py-1.5 text-[10px] lg:min-h-0"
          />
        </div>
      </div>
      {showNoEnemyBlindHint && <p className="border-t border-txt/[0.06] px-3.5 py-2 text-[10px] text-txt/[0.42]">No enemies picked yet — ranked on overall lane performance, not matchups.</p>}
      <div className="overflow-x-auto">
        <table className="hidden w-full min-w-[600px] border-collapse text-left sm:table">
          <caption className="sr-only">Draft champions ranked for the selected view</caption>
          <thead>
            <tr className="border-t border-txt/[0.06] bg-txt/[0.025] text-[9px] font-medium uppercase tracking-[0.12em] text-txt/[0.4]">
              <th scope="col" className="w-8 px-3 py-2.5">#</th>
              <th scope="col" className="px-2 py-2.5">Champion</th>
              <th scope="col" className="px-2 py-2.5 text-right">Tier</th>
              <th scope="col" className="px-2 py-2.5 text-right"><SortButton label="Win rate" value="winRate" sort={sort} onChange={onSortChange} /></th>
              <th scope="col" className="px-2 py-2.5 text-right"><SortButton label="Pick" value="pickRate" sort={sort} onChange={onSortChange} /></th>
              <th scope="col" className="px-2 py-2.5 text-right">Δ vs comp</th>
              <th scope="col" className="px-3 py-2.5 text-right"><SortButton label="Games" value="games" sort={sort} onChange={onSortChange} /></th>
            </tr>
          </thead>
          <tbody>
            {rankingRows.map(({ candidate, rank }) => {
              const entry = entryFor(champIcons, candidate.champId);
              const delta = laneAverageValue === null ? null : candidate.winRate - laneAverageValue;
              const offMeta = isOffMetaLaneShare(candidate.laneShare);
              const comfort = candidate.personalOverall.games > 0;
              return (
                <tr
                  key={candidate.champId}
                  className={`border-t border-txt/[0.05] transition-colors duration-[120ms] ease-in hover:bg-txt/[0.04] ${selectedChampionId === candidate.champId ? "bg-accent/[0.1]" : ""}`}
                >
                  <td className="px-3 py-2.5 text-[11px] tabular-nums text-txt/[0.38]">{rank}</td>
                  <td className="px-2 py-2.5">
                    <button type="button" onClick={() => onSelect(candidate.champId)} className="flex min-w-0 items-center gap-2 text-left focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2">
                      <span className="h-7 w-7 flex-shrink-0 overflow-hidden rounded-[6px]" style={{ boxShadow: "inset 0 0 0 1px rgba(233,233,237,.12)" }}>
                        <IconWithFallback src={entry.icon} alt={entry.name} fallbackGlyph={entry.name} className="h-full w-full object-cover" size={28} />
                      </span>
                      <span className="min-w-0">
                        <span className="block max-w-[130px] truncate text-[12px] font-semibold text-txt">{entry.name}</span>
                        <span className="mt-0.5 flex items-center gap-1.5 text-[9px] uppercase tracking-[0.08em]">
                          <span className={comfort ? "text-good" : offMeta ? "text-txt/[0.45]" : "text-accent-400"}>{comfort ? "Comfort" : offMeta ? "Off-meta" : "Meta"}</span>
                          {candidate.isPotential && <span className="text-txt/[0.4]">Low sample</span>}
                        </span>
                      </span>
                    </button>
                  </td>
                  <td className="px-2 py-2.5 text-right">
                    <span className={`inline-flex min-w-[24px] justify-center rounded-[4px] px-1.5 py-1 text-[10px] font-semibold leading-none ${tierClass(rank)}`} style={{ clipPath: "polygon(0 0, 100% 0, 100% calc(100% - 5px), calc(100% - 5px) 100%, 0 100%)" }}>{draftTierForRank(rank)}</span>
                  </td>
                  <td className="px-2 py-2.5 text-right text-[12px] font-semibold tabular-nums text-txt">{percent(candidate.winRate)}</td>
                  <td className="px-2 py-2.5 text-right text-[11px] tabular-nums text-txt/[0.62]">{percent(candidate.laneShare)}</td>
                  <td className={`px-2 py-2.5 text-right text-[11px] font-semibold tabular-nums ${delta === null ? "text-txt/[0.38]" : delta >= 0 ? "text-good" : "text-bad"}`}>{points(delta)}</td>
                  <td className="px-3 py-2.5 text-right text-[11px] tabular-nums text-txt/[0.5]">{games(candidate.totalGames)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="divide-y divide-txt/[0.05] sm:hidden">
          {rankingRows.map(({ candidate, rank }) => {
            const entry = entryFor(champIcons, candidate.champId);
            const delta = laneAverageValue === null ? null : candidate.winRate - laneAverageValue;
            const offMeta = isOffMetaLaneShare(candidate.laneShare);
            const comfort = candidate.personalOverall.games > 0;
            return (
              <article
                key={candidate.champId}
                className={`grid grid-cols-[24px_minmax(0,1fr)_auto] gap-x-2 px-3 py-3 transition-colors duration-[120ms] ease-in ${selectedChampionId === candidate.champId ? "bg-accent/[0.1]" : "hover:bg-txt/[0.04]"}`}
              >
                <span className="pt-1 text-[11px] tabular-nums text-txt/[0.38]">{rank}</span>
                <button type="button" onClick={() => onSelect(candidate.champId)} className="flex min-h-[44px] min-w-0 items-center gap-2 text-left focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2">
                  <span className="h-8 w-8 flex-shrink-0 overflow-hidden rounded-[6px]" style={{ boxShadow: "inset 0 0 0 1px rgba(233,233,237,.12)" }}>
                    <IconWithFallback src={entry.icon} alt={entry.name} fallbackGlyph={entry.name} className="h-full w-full object-cover" size={32} />
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-[12px] font-semibold text-txt">{entry.name}</span>
                    <span className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 text-[9px] uppercase tracking-[0.08em]">
                      <span className={comfort ? "text-good" : offMeta ? "text-txt/[0.45]" : "text-accent-400"}>{comfort ? "Comfort" : offMeta ? "Off-meta" : "Meta"}</span>
                      {candidate.isPotential && <span className="text-txt/[0.4]">Low sample</span>}
                    </span>
                  </span>
                </button>
                <span className={`mt-1 inline-flex h-fit min-w-[30px] justify-center rounded-[4px] px-1.5 py-1 text-[10px] font-semibold leading-none ${tierClass(rank)}`} style={{ clipPath: "polygon(0 0, 100% 0, 100% calc(100% - 5px), calc(100% - 5px) 100%, 0 100%)" }}>{draftTierForRank(rank)}</span>
                <div className="col-start-2 col-span-2 mt-2 grid grid-cols-4 gap-2 border-t border-txt/[0.06] pt-2 text-right">
                  <div><span className="block text-[8px] uppercase tracking-[0.1em] text-txt/[0.35]">Win</span><span className="mt-0.5 block text-[11px] font-semibold tabular-nums text-txt">{percent(candidate.winRate)}</span></div>
                  <div><span className="block text-[8px] uppercase tracking-[0.1em] text-txt/[0.35]">Pick</span><span className="mt-0.5 block text-[11px] tabular-nums text-txt/[0.62]">{percent(candidate.laneShare)}</span></div>
                  <div><span className="block text-[8px] uppercase tracking-[0.1em] text-txt/[0.35]">Δ</span><span className={`mt-0.5 block text-[11px] font-semibold tabular-nums ${delta === null ? "text-txt/[0.38]" : delta >= 0 ? "text-good" : "text-bad"}`}>{points(delta)}</span></div>
                  <div><span className="block text-[8px] uppercase tracking-[0.1em] text-txt/[0.35]">Games</span><span className="mt-0.5 block text-[11px] tabular-nums text-txt/[0.5]">{games(candidate.totalGames)}</span></div>
                </div>
              </article>
            );
          })}
        </div>
      </div>

      {rows.length === 0 && <p className="border-t border-txt/[0.05] px-4 py-8 text-center text-[11px] text-txt/[0.48]">{showCountersNoEnemies ? "Add an enemy to see counters" : "No rankings meet the active filters."}</p>}
      <div className="border-t border-txt/[0.06] px-3.5 py-3 text-center">
        <button type="button" onClick={onShowAll} disabled={showAll || rows.length <= 10} className="min-h-[44px] text-[10.5px] font-medium text-accent-300 transition-colors duration-[120ms] ease-in hover:text-accent-200 disabled:cursor-default disabled:text-txt/[0.36] focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2 lg:min-h-0">
          {showAll ? "Showing full table" : "View full table →"}
        </button>
        <span className="mt-1 block text-[10px] text-txt/[0.35]">Figures are estimated from this lane&apos;s matchup data.</span>
      </div>
    </section>
  );
}
