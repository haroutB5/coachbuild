"use client";

import { ArrowLeft, CaretDown } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import type { ChampionRef } from "@/lib/types";
import { IconWithFallback } from "@/components/IconWithFallback";
import { getHeroStats, LANE_LABEL, LANE_ORDER, type LaneId, type HeroStats } from "./heroContracts";
import { confidenceBand, confidenceChipClass } from "./confidence";
import { resolveTabKeydown, isTabNavigationKey } from "./tabKeyboard";
import { BuildActionButtons, Scanline, StatValue } from "./builds/BuildVisuals";
import HextechTabs from "./HextechTabs";
import { BUILD_TAB_OPTIONS, type BuildTab } from "./buildTabLayout";
import { DIAMOND_PLUS_BRACKET } from "@/lib/rankBrackets";

const LANE_SHORT: Record<LaneId, string> = { top: "TOP", jungle: "JG", mid: "MID", bot: "BOT", support: "SUP" };

// The elo PILL ROW that used to live here is gone (2026-08-11), along with its
// `HERO_ELO_OPTIONS` list. That list was a SECOND hardcoded set of rank labels
// competing with lib/rankBrackets.ts — and it inherited the same off-by-one:
// its "Diamond" pill sent tier [5], which the confirmed coachless enum says is
// EMERALD. The app now has exactly one bracket (Diamond+), so there is nothing
// to pick and a pill row would be a control that cannot change anything. The
// row's slot is now a static scope note stating what the data actually is.

const CONFIDENCE_LABEL = { HIGH: "High confidence", MEDIUM: "Medium confidence", LOW: "Low confidence" } as const;

// The tab labels used to be a local `BUILD_VIEW_OPTIONS` here, competing with
// BUILD_TAB_OPTIONS in buildTabLayout.ts. This one rendered; that one only had a
// test. They drifted. Single table now — labels live in buildTabLayout.ts.

interface ChampionHeroProps {
  champ: ChampionRef;
  lane: LaneId;
  onLaneChange: (lane: LaneId) => void;
  /** The active bracket id. Single-valued today (there is only one bracket),
   *  but still threaded through rather than read from the module directly so
   *  the hero's stats query stays keyed off the SAME value BuildTabContent
   *  fetches with — see app/page.tsx, which owns it. */
  rankBracket: string;
  buildTab: BuildTab;
  onBuildTabChange: (tab: BuildTab) => void;
}
export default function ChampionHero({ champ, lane, onLaneChange, rankBracket, buildTab, onBuildTabChange }: ChampionHeroProps) {
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

  // One ref per lane tab so an arrow-key move can focus its destination. The
  // lane strip is a real `role="tablist"` (2026-08-12): it used to be plain
  // toggle buttons in a `role="group"`, so a screen reader could not announce
  // which lane was active — no `aria-selected`/`aria-current`, only a visual
  // accent chip. It now mirrors the BUILD/PRO/OTP tablist's contract (see
  // HextechTabs): `role="tab"` + `aria-selected`, roving tabindex so the strip
  // is ONE stop in the page tab order, and Left/Right/Home/End navigation via
  // the same pure `tabKeyboard` resolver — matching the sibling pattern rather
  // than inventing a second one. Selection follows focus, which is safe here
  // because switching lanes only refetches this hero's own stats.
  const laneTabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  function handleLaneKeyDown(e: React.KeyboardEvent<HTMLButtonElement>, index: number) {
    if (!isTabNavigationKey(e.key)) return;
    const next = resolveTabKeydown(e.key, index, LANE_ORDER.length);
    if (next === null) return;
    e.preventDefault();
    laneTabRefs.current[next]?.focus();
    onLaneChange(LANE_ORDER[next]);
  }

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
                <span className={`rounded-[5px] px-2 py-1 text-[9px] font-semibold uppercase tracking-[0.08em] ${confidenceChipClass(confidence)}`}>{CONFIDENCE_LABEL[confidence]}</span>
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
            {/* Real actions as of 2026-08-11 — they write an item set and a
                rune page into the League client through the same code
                ItemBuildCard's "Add to client" and the Runes card's "Apply
                runes" run. They read the build out of currentBuildStore, keyed
                on exactly these three values, so they can never act on a lane
                the hero is no longer showing. See BuildActionButtons. */}
            <BuildActionButtons champ={champ} lane={lane} rankBracket={rankBracket} />
            <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Lane">
              {LANE_ORDER.map((candidate, index) => (
                <button
                  key={candidate}
                  type="button"
                  role="tab"
                  ref={(el) => {
                    laneTabRefs.current[index] = el;
                  }}
                  onClick={() => onLaneChange(candidate)}
                  onKeyDown={(e) => handleLaneKeyDown(e, index)}
                  aria-selected={candidate === lane}
                  // Roving tab stop — only the active lane is in the page tab
                  // order; the rest are reached with Left/Right. Matches
                  // HextechTabs so the two tablists on this hero behave alike.
                  tabIndex={candidate === lane ? 0 : -1}
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
          {/* Scope note, in the slot the elo pills used to occupy. It is text,
              not a control: with one bracket there is nothing to choose, and a
              disabled-looking pill would read as a broken filter.

              The second line is not decoration. coachless filters by TIER only
              — no division axis exists on their API or in their own UI — so the
              requested "Diamond II and above" is not expressible and this
              sample necessarily includes Diamond III and IV. Saying that is
              cheaper than letting a reader assume a precision the data has not
              got. Do not shorten it away. */}
          <p className="mt-3 self-start text-[9px] font-semibold uppercase leading-[1.5] tracking-[0.08em] text-mut lg:mt-0 lg:mb-2 lg:self-end lg:text-right">
            All data from <span className="text-[#d2cefd]">{DIAMOND_PLUS_BRACKET.label}</span>
            {/* Full-alpha `text-mut`, NOT a dimmed `text-[#9397ab]/70`. This is
                9px body text, so WCAG AA wants 4.5:1; at 70% alpha over the
                hero gradient's darkest-for-contrast stop (#2c2949) it measures
                3.11:1. The lane pills on this same hero already had to be
                un-dimmed for exactly this reason — do not re-dim it to push
                the line back visually. */}
            <span className="block font-medium normal-case tracking-normal text-mut">
              {DIAMOND_PLUS_BRACKET.description} — tiers only, not divisions
            </span>
          </p>
        </div>
      </div>
    </section>
  );
}
