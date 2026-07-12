"use client";

import { useEffect, useState } from "react";
import type { ChampionRef } from "@/lib/types";
import { getHeroStats, getSplashUrl, LANE_LABEL, type LaneId, type HeroStats } from "./heroContracts";

interface ChampionHeroProps {
  champ: ChampionRef;
  lane: LaneId;
}

export default function ChampionHero({ champ, lane }: ChampionHeroProps) {
  const [stats, setStats] = useState<HeroStats>({ winRatePct: null, gamesCount: null });

  useEffect(() => {
    let cancelled = false;
    getHeroStats(champ.id, lane).then((s) => {
      if (!cancelled) setStats(s);
    });
    return () => {
      cancelled = true;
    };
  }, [champ.id, lane]);

  const splash = getSplashUrl(champ.key);

  return (
    <div className="relative rounded-xl overflow-hidden border border-line">
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
      <div className="relative flex items-center gap-4 px-5 py-6 min-h-[128px]">
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
          <div className="mt-2 flex items-center gap-2 text-[12.5px] tabular-nums">
            <span className="text-mut font-semibold uppercase tracking-[0.05em]">
              {LANE_LABEL[lane]}
            </span>
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
          </div>
        </div>
      </div>
    </div>
  );
}
