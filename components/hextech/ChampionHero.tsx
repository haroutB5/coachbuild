"use client";

import { ArrowLeft, CaretDown } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import type { ChampionRef } from "@/lib/types";
import { IconWithFallback } from "@/components/IconWithFallback";
import { getHeroStats, LANE_LABEL, LANE_ORDER, type LaneId, type HeroStats } from "./heroContracts";
import { confidenceBand } from "./confidence";
import { BuildActionButtons, Scanline, StatValue, TierBadge } from "./builds/BuildVisuals";
import HextechTabs from "./HextechTabs";
import type { BuildTab } from "./buildTabLayout";

const LANE_SHORT: Record<LaneId, string> = { top: "TOP", jungle: "JG", mid: "MID", bot: "BOT", support: "SUP" };

const HERO_ELO_OPTIONS: { id: string; label: string }[] = [
  { id: "all", label: "High Elo" },
  { id: "diamond", label: "Diamond" },
  { id: "emerald", label: "Emerald" },
  { id: "platinum", label: "Platinum" },
];

const CONFIDENCE_LABEL = { HIGH: "High confidence", MEDIUM: "Medium confidence", LOW: "Low confidence" } as const;
const BUILD_VIEW_OPTIONS = [
  { value: "build", label: "WPA build" },
  { value: "pro", label: "Pro consensus" },
  { value: "otp", label: "One-trick" },
] as const;

interface ChampionHeroProps {
  champ: ChampionRef;
  lane: LaneId;
  onLaneChange: (lane: LaneId) => void;
  rankBracket: string;
  onRankChange: (id: string) => void;
  buildTab: BuildTab;
  onBuildTabChange: (tab: BuildTab) => void;
}
export default function ChampionHero({ champ, lane, onLaneChange, rankBracket, onRankChange, buildTab, onBuildTabChange }: ChampionHeroProps) {
  const [stats, setStats] = useState<HeroStats>({ winRatePct: null, gamesCount: null });

  useEffect(() => {
    let cancelled = false;
    getHeroStats(champ.id, lane, rankBracket).then((next) => {
      if (!cancelled) setStats(next);
    });
    return () => {
      cancelled = true;
    };
  }, [champ.id, lane, rankBracket]);

  const confidence = confidenceBand(stats.gamesCount);

  return (
    <section
      data-build-hero
      className="relative mb-3 overflow-hidden rounded-[10px] bg-[radial-gradient(90%_200%_at_12%_0%,#2c2949,#1c1e2b_60%,#191b27)] px-5 pt-4 shadow-[0_0_0_1px_rgba(145,132,217,0.3),0_14px_40px_rgba(0,0,0,0.32)] sm:px-6"
    >
      <Scanline />
      <div className="relative z-10">
        <button
          type="button"
          onClick={() => window.history.back()}
          className="mb-3 inline-flex h-11 -my-2 items-center gap-1 text-[11px] text-[#e9e9ed]/45 transition-colors hover:text-[#e9e9ed]/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#9184d9] lg:mt-0 lg:mb-3 lg:h-auto"
        >
          <ArrowLeft size={13} />
          All builds
        </button>

        <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex min-w-0 items-center gap-4">
            <div className="relative shrink-0">
              <span className="flex h-[88px] w-[88px] items-center justify-center overflow-hidden rounded-[11px] bg-[linear-gradient(150deg,#3a3663,#20223a)] shadow-[inset_0_0_0_1px_rgba(145,132,217,0.45),0_0_26px_rgba(145,132,217,0.2)]">
                <IconWithFallback src={champ.icon} alt={champ.name} fallbackGlyph={champ.name} className="h-full w-full object-cover" size={88} />
              </span>
              <span className="absolute -bottom-1.5 -left-1.5"><TierBadge /></span>
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
                <h1 className="truncate text-[33px] font-semibold leading-none tracking-[-0.025em] text-[#e9e9ed]">{champ.name}</h1>
                <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#e9e9ed]/45">{LANE_LABEL[lane]} lane</span>
                <span className="rounded-[5px] bg-[#46c79b]/15 px-2 py-1 text-[9px] font-semibold uppercase tracking-[0.08em] text-[#46c79b]">{CONFIDENCE_LABEL[confidence]}</span>
              </div>
              <div className="mt-3 grid grid-cols-2 gap-x-5 gap-y-3 sm:grid-cols-4">
                <StatValue label="Win rate" value={stats.winRatePct === null ? "—" : `${stats.winRatePct.toFixed(1)}%`} tone={stats.winRatePct === null ? "normal" : "good"} />
                <StatValue label="Pick rate" value="—" sub="not in build feed" />
                <StatValue label="Ban rate" value="—" sub="not in build feed" />
                <StatValue label="Games" value={stats.gamesCount === null ? "—" : stats.gamesCount.toLocaleString()} />
              </div>
            </div>
          </div>

          <div className="flex shrink-0 flex-col items-start gap-3 lg:items-end">
            <BuildActionButtons />
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Lane">
              {LANE_ORDER.map((candidate) => (
                <button
                  key={candidate}
                  type="button"
                  onClick={() => onLaneChange(candidate)}
                  aria-pressed={candidate === lane}
                  title={LANE_LABEL[candidate]}
                  className="inline-flex h-11 min-w-[44px] -my-2 items-center justify-center gap-1 rounded-[6px] px-0 text-[9px] font-semibold uppercase tracking-[0.08em] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#9184d9] lg:my-0 lg:h-7 lg:min-w-0"
                >
                  <span className={`inline-flex h-7 items-center gap-1 rounded-[6px] px-2 ${candidate === lane ? "bg-[#9184d9]/20 text-[#d2cefd]" : "text-[#9397ab]/55 hover:bg-white/[0.05] hover:text-[#e9e9ed]/80"}`}>
                    {LANE_SHORT[candidate]}
                    {candidate === lane && <CaretDown size={10} aria-hidden="true" />}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="mt-5 flex flex-col border-t border-white/[0.08] lg:flex-row lg:items-end lg:justify-between">
          <HextechTabs options={BUILD_VIEW_OPTIONS} value={buildTab} onChange={onBuildTabChange} ariaLabel="Build view" className="min-w-0 flex-1 border-transparent px-0" />
          <div className="flex flex-wrap gap-1 self-end rounded-[8px] bg-[#1c1e2c] p-1 shadow-[inset_0_0_0_1px_rgba(233,233,237,0.08)] lg:mb-1" role="group" aria-label="Rank bracket">
            {HERO_ELO_OPTIONS.map((option) => (
              <button
                key={option.id}
                type="button"
                onClick={() => onRankChange(option.id)}
                aria-pressed={rankBracket === option.id}
                className="flex h-11 min-w-[44px] -my-2 items-center justify-center rounded-[6px] px-0 text-[9px] font-semibold uppercase tracking-[0.08em] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#9184d9] lg:my-0 lg:h-auto lg:min-w-0"
              >
                <span className={`rounded-[6px] px-2.5 py-1.5 ${rankBracket === option.id ? "bg-[#9184d9]/20 text-[#d2cefd]" : "text-[#9397ab]/50 hover:bg-white/[0.05] hover:text-[#e9e9ed]/80"}`}>
                  {option.label}
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
