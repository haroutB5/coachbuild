"use client";

import { ArrowLeft, CaretDown } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import type { ChampionRef } from "@/lib/types";
import { IconWithFallback } from "@/components/IconWithFallback";
import { getHeroStats, LANE_LABEL, LANE_ORDER, type LaneId, type HeroStats } from "./heroContracts";
import { confidenceBand } from "./confidence";
import { BuildActionButtons, Scanline, StatValue } from "./builds/BuildVisuals";
import HextechTabs from "./HextechTabs";
import { BUILD_TAB_OPTIONS, type BuildTab } from "./buildTabLayout";

const LANE_SHORT: Record<LaneId, string> = { top: "TOP", jungle: "JG", mid: "MID", bot: "BOT", support: "SUP" };

const HERO_ELO_OPTIONS: { id: string; label: string }[] = [
  { id: "all", label: "High Elo" },
  { id: "diamond", label: "Diamond" },
  { id: "emerald", label: "Emerald" },
  { id: "platinum", label: "Platinum" },
];

const CONFIDENCE_LABEL = { HIGH: "High confidence", MEDIUM: "Medium confidence", LOW: "Low confidence" } as const;

// The tab labels used to be a local `BUILD_VIEW_OPTIONS` here, competing with
// BUILD_TAB_OPTIONS in buildTabLayout.ts. This one rendered; that one only had a
// test. They drifted. Single table now — labels live in buildTabLayout.ts.

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
              {/* NO TIER BADGE HERE, AND THAT IS THE FIX (2026-08-10).
                  This corner used to render `<TierBadge />` with no `tier`
                  prop, so it fell through to that component's own default and
                  every champion in every lane claimed "S+" — Yuumi at a 48.6%
                  win rate, Viktor on JUNGLE where win rate and games both read
                  "—", Viktor on SUPPORT under a LOW CONFIDENCE header. The
                  same badge renders real ranks on the landing page, so a
                  reader has been trained to read it as a rank claim.

                  It is REMOVED rather than repaired because this app has no
                  genuine per-champion-per-lane tier to feed it. Traced, all
                  three candidate sources:
                    · BuildsLanding's tier list — the badge there is POSITIONAL
                      within an arbitrary <=8-champion sample (the first few of
                      /api/champions plus recents plus My Stats rows), sorted by
                      mid-lane win rate and sliced to 6. It is mid-lane only and
                      it is not a champion property. It cannot answer "what tier
                      is Aatrox TOP".
                    · /api/draft/recommend and /api/draft/blind-pick — real
                      per-lane ladders and the source `draftTierForRank` reads,
                      but both are capped at the top 10 of a ~173-champion pool
                      (`meta.topN`), and blindScore ranks BLIND-PICK SAFETY, not
                      champion strength. Re-labelling that as a strength tier
                      beside win rate and games would be a new false claim.
                    · /api/hero-stats — win rate and games only, and deriving a
                      tier from win rate here is explicitly out of bounds.
                  An absent badge is honest; a defaulted one is a lie. If a real
                  ranked-ladder endpoint ever lands, render it here and nowhere
                  else. */}
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
                <h1 className="truncate text-[33px] font-semibold leading-none tracking-[-0.025em] text-[#e9e9ed]">{champ.name}</h1>
                <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#e9e9ed]/45">{LANE_LABEL[lane]} lane</span>
                <span className="rounded-[5px] bg-[#46c79b]/15 px-2 py-1 text-[9px] font-semibold uppercase tracking-[0.08em] text-[#46c79b]">{CONFIDENCE_LABEL[confidence]}</span>
              </div>
              <div className="mt-3 grid grid-cols-2 gap-x-5 gap-y-3 sm:grid-cols-4">
                <StatValue
                  label="Win rate"
                  value={stats.winRatePct === null ? "—" : `${stats.winRatePct.toFixed(1)}%`}
                  tone={stats.winRatePct === null ? "normal" : stats.winRatePct >= 50 ? "good" : "bad"}
                />
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
                  {/* Inactive lane pill: `text-mut` (#9397ab at FULL alpha),
                      not the old `text-[#9397ab]/55`. Measured 2.74:1 at 9px
                      against the hero gradient — these are clickable control
                      labels, so WCAG AA wants 4.5:1. Full-alpha `mut` measures
                      4.77:1 against the gradient's darkest-for-contrast stop
                      (#2c2949) and 5.91:1 where the pills actually sit
                      (#191b27). The active/inactive split does NOT rest on the
                      text colour: active gets a filled accent chip
                      (bg-[#9184d9]/20), lavender #d2cefd text, and a caret.
                      Do not close this gap by dimming the text again. */}
                  <span className={`inline-flex h-7 items-center gap-1 rounded-[6px] px-2 ${candidate === lane ? "bg-[#9184d9]/20 text-[#d2cefd]" : "text-mut hover:bg-white/[0.05] hover:text-[#e9e9ed]"}`}>
                    {LANE_SHORT[candidate]}
                    {candidate === lane && <CaretDown size={10} aria-hidden="true" />}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="mt-5 flex flex-col border-t border-white/[0.08] lg:flex-row lg:items-end lg:justify-between">
          <HextechTabs options={BUILD_TAB_OPTIONS} value={buildTab} onChange={onBuildTabChange} ariaLabel="Build view" className="min-w-0 flex-1 border-transparent px-0" />
          <div className="flex flex-wrap gap-1 self-end rounded-[8px] bg-[#1c1e2c] p-1 shadow-[inset_0_0_0_1px_rgba(233,233,237,0.08)] lg:mb-1" role="group" aria-label="Rank bracket">
            {HERO_ELO_OPTIONS.map((option) => (
              <button
                key={option.id}
                type="button"
                onClick={() => onRankChange(option.id)}
                aria-pressed={rankBracket === option.id}
                className="flex h-11 min-w-[44px] -my-2 items-center justify-center rounded-[6px] px-0 text-[9px] font-semibold uppercase tracking-[0.08em] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#9184d9] lg:my-0 lg:h-auto lg:min-w-0"
              >
                {/* Same fix as the lane pills above. Inactive rank bracket was
                    `text-[#9397ab]/50` = 2.44:1 at 9px on this row's own
                    #1c1e2c panel; full-alpha `mut` measures 5.71:1 there. */}
                <span className={`rounded-[6px] px-2.5 py-1.5 ${rankBracket === option.id ? "bg-[#9184d9]/20 text-[#d2cefd]" : "text-mut hover:bg-white/[0.05] hover:text-[#e9e9ed]"}`}>
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
