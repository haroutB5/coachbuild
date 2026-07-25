"use client";

import { useEffect, useState } from "react";
import type { ChampionRef } from "@/lib/types";
import { getHeroStats, getSplashUrl, LANE_ORDER, LANE_LABEL, type LaneId, type HeroStats } from "./heroContracts";
import { confidenceBand } from "./confidence";

// v0.51.0 (Builds redesign, mockup 4/5): lane + rank-bracket selection moved
// INTO the hero (top-right, two stacked pill rows) — replaces the old
// BuildsSearchBar's own full-width "Lanes" grid, now retired from the page
// body entirely. Abbreviated to match the mockup exactly (TOP/JG/MID/BOT/SUP)
// — LANE_LABEL's full words are kept for aria-label/title (accessibility),
// this is a display-only shorthand local to this component.
const LANE_SHORT: Record<LaneId, string> = { top: "TOP", jungle: "JG", mid: "MID", bot: "BOT", support: "SUP" };

// v0.51.0 — the elo row shows a CURATED 4-item subset of lib/rankBrackets.ts's
// full 7-bracket list (all/challenger/grandmaster/master/diamond/emerald/
// platinum), matching mockup 4/5 exactly ("High Elo / Diamond / Emerald /
// Platinum"). Challenger/Grandmaster/Master remain valid, fully-supported
// ids in the data layer (BuildTabContent's fetch still accepts any
// RANK_BRACKETS id) — they're just not surfaced in this compact hero row.
// Documented as a deliberate fidelity choice in HANDOFF-fronty.md, not a
// capability regression.
const HERO_ELO_OPTIONS: { id: string; label: string }[] = [
  { id: "all", label: "High Elo" },
  { id: "diamond", label: "Diamond" },
  { id: "emerald", label: "Emerald" },
  { id: "platinum", label: "Platinum" },
];

const CONFIDENCE_CLASS: Record<"HIGH" | "MEDIUM" | "LOW", string> = {
  HIGH: "border-good/50 text-good",
  MEDIUM: "border-line-gold text-mut",
  LOW: "border-bad/40 text-bad",
};
const CONFIDENCE_LABEL: Record<"HIGH" | "MEDIUM" | "LOW", string> = {
  HIGH: "High confidence",
  MEDIUM: "Medium confidence",
  LOW: "Low confidence",
};

interface ChampionHeroProps {
  champ: ChampionRef;
  lane: LaneId;
  onLaneChange: (lane: LaneId) => void;
  rankBracket: string;
  onRankChange: (id: string) => void;
}

export default function ChampionHero({ champ, lane, onLaneChange, rankBracket, onRankChange }: ChampionHeroProps) {
  const [stats, setStats] = useState<HeroStats>({ winRatePct: null, gamesCount: null });

  // P1-1 fix (2026-07-25 audit): `rankBracket` MUST be in this effect's deps
  // and threaded into getHeroStats — this row renders the elo pill row right
  // above the build panel, but until this fix the stats effect was keyed
  // `[champ.id, lane]` only, so tapping "Platinum" changed the build panel
  // (BuildTabContent DOES append `&rank=`) while this line kept showing the
  // un-bracketed High-Elo WIN%/GAMES (verified live: 329,099 High-Elo games
  // vs. Platinum's 194,981 — see lib/rankBrackets.ts) beside a visibly-active
  // Platinum pill, and could flip the confidence chip to HIGH off that
  // inflated count while the shown build rested on a MEDIUM-band sample.
  useEffect(() => {
    let cancelled = false;
    getHeroStats(champ.id, lane, rankBracket).then((s) => {
      if (!cancelled) setStats(s);
    });
    return () => {
      cancelled = true;
    };
  }, [champ.id, lane, rankBracket]);

  const splash = getSplashUrl(champ.key);
  const band = confidenceBand(stats.gamesCount);

  return (
    <div className="relative rounded-xl overflow-hidden border border-line mb-6">
      {/* Splash background */}
      <div className="absolute inset-0">
        {splash && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={splash}
            alt=""
            aria-hidden="true"
            className="w-full h-full object-cover object-[50%_20%]"
            onError={(e) => {
              (e.currentTarget as HTMLImageElement).style.display = "none";
            }}
          />
        )}
        <div
          className="absolute inset-0"
          style={{
            background:
              "linear-gradient(90deg, rgba(10,13,11,0.97) 0%, rgba(10,13,11,0.82) 38%, rgba(10,13,11,0.35) 75%, rgba(10,13,11,0.55) 100%)",
          }}
        />
        <div
          className="absolute inset-0"
          style={{
            background: "linear-gradient(180deg, rgba(10,13,11,0.15) 0%, rgba(10,13,11,0.65) 100%)",
          }}
        />
      </div>

      {/* Content */}
      <div className="relative flex flex-col lg:flex-row lg:items-center gap-4 px-5 py-6 min-h-[128px]">
        <div className="flex items-center gap-4 min-w-0 flex-1">
          <div className="flex-shrink-0 w-[76px] h-[76px] rounded-lg overflow-hidden border-2 border-teal shadow-[0_0_22px_rgba(200,170,110,0.3)] bg-black/40">
            <img
              src={champ.icon}
              alt={champ.name}
              width={76}
              height={76}
              loading="eager"
              decoding="async"
              className="w-full h-full object-cover"
              onError={(e) => {
                (e.currentTarget as HTMLImageElement).style.display = "none";
              }}
            />
          </div>

          <div className="min-w-0">
            <h2 className="font-display text-teal text-[30px] sm:text-[36px] font-semibold uppercase tracking-[0.02em] leading-none truncate">
              {champ.name}
            </h2>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-[12.5px] tabular-nums">
              <span className="text-mut font-semibold uppercase tracking-[0.05em]">{LANE_LABEL[lane]}</span>
              <span className="text-mut/50" aria-hidden="true">
                &middot;
              </span>
              {stats.winRatePct !== null ? (
                <span className="text-good font-bold">{stats.winRatePct.toFixed(1)}% WIN</span>
              ) : (
                <span className="text-mut">— WIN</span>
              )}
              <span className="text-mut/50" aria-hidden="true">
                &middot;
              </span>
              {stats.gamesCount !== null ? (
                <span className="text-mut">{stats.gamesCount.toLocaleString()} GAMES</span>
              ) : (
                <span className="text-mut">— GAMES</span>
              )}
              <span
                className={`inline-flex items-center px-1.5 py-0.5 rounded border text-[9.5px] font-bold uppercase tracking-[0.05em] ${CONFIDENCE_CLASS[band]}`}
              >
                {CONFIDENCE_LABEL[band]}
              </span>
            </div>
          </div>
        </div>

        {/* v0.51.0: lane + elo pill rows (mockup 4/5's top-right stacked
            controls). Backed by a translucent dark chip so the gold-outlined
            active pill reads clearly over the splash art regardless of the
            champion's own palette. */}
        <div className="flex-shrink-0 flex flex-col items-stretch lg:items-end gap-2 bg-black/35 lg:bg-transparent rounded-lg p-2 lg:p-0 -mx-1 lg:mx-0">
          <div role="group" aria-label="Lane" className="grid grid-cols-5 gap-1">
            {LANE_ORDER.map((l) => {
              const active = l === lane;
              return (
                <button
                  key={l}
                  type="button"
                  onClick={() => onLaneChange(l)}
                  aria-pressed={active}
                  aria-label={LANE_LABEL[l]}
                  title={LANE_LABEL[l]}
                  className={`px-2.5 py-1.5 rounded-md border text-[11px] font-bold uppercase tracking-[0.04em] transition-colors active:scale-95 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-teal ${
                    active
                      ? "bg-panel2 border-line-gold text-teal"
                      : "border-line/70 bg-black/20 text-mut hover:text-txt hover:border-line-gold/60"
                  }`}
                >
                  {LANE_SHORT[l]}
                </button>
              );
            })}
          </div>
          <div role="group" aria-label="Rank bracket" className="flex flex-wrap justify-end gap-1">
            {HERO_ELO_OPTIONS.map((opt) => {
              const active = opt.id === rankBracket;
              return (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => onRankChange(opt.id)}
                  aria-pressed={active}
                  className={`px-2.5 py-1 rounded-md border text-[10.5px] font-semibold whitespace-nowrap transition-colors active:scale-95 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-teal ${
                    active
                      ? "bg-panel2 border-line-gold text-txt"
                      : "border-line/70 bg-black/20 text-mut hover:text-txt hover:border-line-gold/60"
                  }`}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
