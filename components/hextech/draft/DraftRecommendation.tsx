"use client";

import { IconWithFallback } from "@/components/IconWithFallback";
import type { ChampionIconEntry } from "@/components/proAssets";
import {
  draftTierForRank,
  isOffMetaLaneShare,
  type DraftAssistantCandidate,
  type DraftAssistantCard,
} from "../draftAssistantModel";
import { deltaVsLaneAverage, formatDeltaPoints } from "./draftDelta";

interface DraftRecommendationProps {
  candidate: DraftAssistantCandidate;
  floor: number | null;
  laneAverageValue: number | null;
  laneOpponentName: string | null;
  verdictChip: string | null;
  reason: string | null;
  champIcons: Map<number, ChampionIconEntry>;
  roleLabel: string;
  alternates: DraftAssistantCard[];
  onSelect: (championId: number) => void;
  onViewBuild: (championId: number) => void;
}

interface CompactPickProps {
  candidate: DraftAssistantCandidate;
  index: number;
  champIcons: Map<number, ChampionIconEntry>;
  laneOpponentName: string | null;
  laneAverageValue: number | null;
  floor: number | null;
  onSelect: (championId: number) => void;
}

function entryFor(champIcons: Map<number, ChampionIconEntry>, champId: number): ChampionIconEntry {
  return champIcons.get(champId) ?? { name: `Champion #${champId}`, icon: "" };
}

function percent(value: number | null): string {
  return value === null || !Number.isFinite(value) ? "—" : `${(value * 100).toFixed(1)}%`;
}

function games(value: number | null): string {
  return value === null || !Number.isFinite(value) ? "—" : Math.round(value).toLocaleString();
}

function sampleGames(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  if (value >= 1000) {
    const compact = value >= 10000 ? Math.round(value / 1000) : (value / 1000).toFixed(1);
    return `${compact}k`;
  }
  return Math.round(value).toLocaleString();
}

function tierClass(tier: ReturnType<typeof draftTierForRank>): string {
  if (tier === "S+") return "bg-accent text-bg";
  if (tier === "S") return "bg-accent/[0.32] text-accent-300";
  if (tier === "A") return "bg-accent/[0.16] text-accent-400";
  return "bg-txt/[0.08] text-txt/[0.6]";
}

function TierBadge({ rank }: { rank: number }) {
  const tier = draftTierForRank(rank);
  return (
    <span
      className={`inline-flex min-w-[24px] items-center justify-center rounded-[4px] px-1.5 py-1 text-[10px] font-semibold leading-none ${tierClass(tier)}`}
      style={{ clipPath: "polygon(0 0, 100% 0, 100% calc(100% - 5px), calc(100% - 5px) 100%, 0 100%)" }}
    >
      {tier}
    </span>
  );
}

function Tile({ entry, size, featured = false }: { entry: ChampionIconEntry; size: number; featured?: boolean }) {
  return (
    <span
      className={`relative block flex-shrink-0 overflow-hidden ${featured ? "rounded-[10px]" : "rounded-[7px]"}`}
      style={{
        width: size,
        height: size,
        background: featured
          ? "linear-gradient(150deg,#3a3663,#20223a)"
          : "linear-gradient(150deg,#2b2e42,#1c1e2c)",
        boxShadow: featured
          ? "inset 0 0 0 1px rgba(145,132,217,.45), 0 0 26px rgba(145,132,217,.2)"
          : "inset 0 0 0 1px rgba(233,233,237,.12)",
      }}
    >
      <IconWithFallback
        src={entry.icon}
        alt={entry.name}
        fallbackGlyph={entry.name}
        className="h-full w-full object-cover"
        size={size}
      />
    </span>
  );
}

function tagFor(candidate: DraftAssistantCandidate): string {
  if (candidate.personalOverall.games > 0) return "YOUR COMFORT";
  if (candidate.floor !== null) return "SAFEST";
  if (isOffMetaLaneShare(candidate.laneShare)) return "OFF-META";
  return "RELIABLE";
}

function whyFor(candidate: DraftAssistantCandidate, laneOpponentName: string | null): string {
  if (laneOpponentName && typeof candidate.synergyDelta === "number" && candidate.synergyDelta > 0) return `Answers ${laneOpponentName} cleanly.`;
  if (candidate.floor !== null) return "Keeps a stable first-pick floor.";
  if (candidate.personalOverall.games > 0) return "Already in your played pool.";
  return "Strongest available matchup evidence.";
}

function CompactPick({ candidate, index, champIcons, laneOpponentName, laneAverageValue, floor, onSelect }: CompactPickProps) {
  const entry = entryFor(champIcons, candidate.champId);
  const tag = tagFor(candidate);
  const delta = deltaVsLaneAverage(candidate.winRate, laneAverageValue);
  return (
    <button
      type="button"
      onClick={() => onSelect(candidate.champId)}
      className="group flex min-w-0 items-center gap-3 rounded-[8px] p-3 text-left transition-colors duration-[120ms] ease-in hover:bg-txt/[0.04] focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2"
      style={{ boxShadow: "inset 0 0 0 1px rgba(233,233,237,.08)" }}
      aria-label={`Use ${entry.name} as your draft pick`}
    >
      <Tile entry={entry} size={46} />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-[13px] font-semibold text-txt">{entry.name}</span>
          <span className="truncate text-[9px] font-medium uppercase tracking-[0.12em] text-accent-400">{tag}</span>
        </div>
        <p className="mt-1 text-[11.5px] leading-[1.35] text-txt/[0.52]">{whyFor(candidate, laneOpponentName)}</p>
      </div>
      <div className="flex-shrink-0 text-right tabular-nums">
        <p className="text-[17px] font-semibold leading-none text-txt">{percent(candidate.winRate)}</p>
        <p className={`mt-1 text-[10px] font-semibold ${delta === null ? "text-txt/[0.38]" : delta >= 0 ? "text-good" : "text-bad"}`}>{formatDeltaPoints(delta)} vs lane avg</p>
        {index === 0 && floor !== null && <span className="sr-only">First-pick floor {percent(floor)}</span>}
      </div>
    </button>
  );
}

export default function DraftRecommendation({
  candidate,
  floor,
  laneAverageValue,
  laneOpponentName,
  verdictChip,
  reason,
  champIcons,
  roleLabel,
  alternates,
  onSelect,
  onViewBuild,
}: DraftRecommendationProps) {
  const entry = entryFor(champIcons, candidate.champId);
  const delta = deltaVsLaneAverage(candidate.winRate, laneAverageValue);

  return (
    <section className="space-y-2.5" aria-labelledby="the-call-heading">
      <div className="flex items-center justify-between gap-3">
        <p id="the-call-heading" className="text-[10px] font-semibold uppercase tracking-[0.14em] text-txt/[0.5]">
          The call
        </p>
        <span className="text-[10px] text-txt/[0.36]">Carded recommendations · shown for reference</span>
      </div>

      <article
        className="relative overflow-hidden rounded-[10px] p-[18px_20px]"
        style={{
          background: "radial-gradient(130% 160% at 0% 0%, #2c2949 0%, #20222f 46%, #1b1d2a 100%)",
          boxShadow: "0 0 0 1px rgba(145,132,217,.3), 0 14px 40px rgba(0,0,0,.4)",
        }}
      >
        <span
          className="pointer-events-none absolute inset-0 opacity-80"
          aria-hidden="true"
          style={{ background: "repeating-linear-gradient(115deg, rgba(145,132,217,.05) 0 1px, transparent 1px 9px)" }}
        />
        <div className="relative grid min-w-0 gap-5 lg:grid-cols-[82px_minmax(0,0.85fr)_minmax(250px,1fr)]">
          <div className="relative self-start">
            <Tile entry={entry} size={82} featured />
            <span className="absolute -bottom-1.5 -left-1.5">
              <TierBadge rank={candidate.rank} />
            </span>
          </div>

          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <h2 className="text-[26px] font-semibold leading-none tracking-[-0.02em] text-txt">{entry.name}</h2>
              <span className="text-[11px] uppercase tracking-[0.1em] text-txt/[0.45]">{roleLabel}</span>
            </div>
            {verdictChip && (
              <span className="mt-2 inline-flex rounded-[5px] bg-good/[0.14] px-2 py-[3px] text-[10px] font-semibold uppercase tracking-[0.06em] text-good">
                {verdictChip}
              </span>
            )}
            {reason && <p className="mt-2 max-w-[430px] text-[13px] leading-[1.5] text-txt/[0.68]">{reason}</p>}
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => onSelect(candidate.champId)}
                className="min-h-[44px] rounded-[8px] bg-accent px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-bg transition-colors duration-[120ms] ease-in hover:bg-accent-400 focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2 lg:min-h-0"
                title="Sets the draft pick in CoachBuild; it does not lock the League client."
              >
                Lock in {entry.name}
              </button>
              <button
                type="button"
                onClick={() => onViewBuild(candidate.champId)}
                className="min-h-[44px] rounded-[8px] px-3.5 py-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-txt/[0.78] transition-colors duration-[120ms] ease-in hover:bg-txt/[0.07] focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2 lg:min-h-0"
                style={{ boxShadow: "inset 0 0 0 1px rgba(233,233,237,.16)" }}
              >
                See full build
              </button>
            </div>
          </div>

          <div className="flex min-w-0 max-w-full flex-wrap items-start gap-x-3 gap-y-4 border-t border-txt/[0.1] pt-4 tabular-nums lg:border-l lg:border-t-0 lg:pl-5 lg:pt-0">
            <div className="min-w-[96px] flex-[1_1_96px]">
              <p className="whitespace-nowrap text-[9px] font-semibold uppercase tracking-[0.12em] text-txt/[0.42]">Win rate</p>
              <p className="mt-1 whitespace-nowrap text-[32px] font-semibold leading-none tracking-[-0.03em] text-txt">{percent(candidate.winRate)}</p>
              <p className={`mt-1 whitespace-nowrap text-[10px] font-semibold ${delta === null ? "text-txt/[0.38]" : delta >= 0 ? "text-good" : "text-bad"}`}>{formatDeltaPoints(delta)} vs lane avg</p>
            </div>
            <div className="min-w-[96px] flex-[1_1_96px]">
              <p className="whitespace-nowrap text-[9px] font-semibold uppercase tracking-[0.12em] text-txt/[0.42]">Floor</p>
              <p className={`mt-1 whitespace-nowrap text-[32px] font-semibold leading-none tracking-[-0.03em] ${floor !== null && Number.isFinite(floor) ? "text-txt" : "text-txt/[0.55]"}`}>
                {floor !== null && Number.isFinite(floor) ? percent(floor) : "—"}
              </p>
              <p className="mt-1 whitespace-nowrap text-[10px] text-txt/[0.42]">{floor !== null && Number.isFinite(floor) ? "worst 10%" : "no data"}</p>
            </div>
            <div className="min-w-[96px] flex-[1_1_96px]">
              <p className="whitespace-nowrap text-[9px] font-semibold uppercase tracking-[0.12em] text-txt/[0.42]">Sample</p>
              <p className="mt-1 whitespace-nowrap text-[32px] font-semibold leading-none tracking-[-0.03em] text-txt">{sampleGames(candidate.totalGames)}</p>
              <p className="mt-1 whitespace-nowrap text-[10px] text-txt/[0.42]">{candidate.isPotential ? "low confidence" : "high confidence"}</p>
            </div>
          </div>
        </div>
      </article>

      {alternates.length > 0 && (
        <div className="grid min-w-0 gap-2.5 md:grid-cols-2">
          {alternates.slice(0, 2).map((card, index) => (
            <CompactPick
              key={card.candidate.champId}
              candidate={card.candidate}
              index={index}
              champIcons={champIcons}
              laneOpponentName={laneOpponentName}
              laneAverageValue={laneAverageValue}
              floor={card.candidate.floor}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </section>
  );
}

export { TierBadge, Tile, entryFor, percent, games };
