"use client";

import type { PlayerRef } from "@/components/proHistory.types";

interface PlayerHeroProps {
  player: PlayerRef;
}

/** Player-mode counterpart to ChampionHero (v0.22.0) — same shape, spacing,
 *  and gold-serif-display-name typography so the two hero states read as one
 *  family, but there's no equivalent to champion splash art for a person: no
 *  headshot data exists anywhere in this app's pipeline (ProGame carries
 *  stats, not portraits). Rather than inventing/stock-photo-ing an image,
 *  this renders a subtle dark gradient (derived from the same panel palette
 *  every other Hextech surface uses) and a lettered avatar tile — the same
 *  fallback-glyph treatment IconWithFallback already uses app-wide for a
 *  failed icon, just applied intentionally here instead of as a failure
 *  state. */
export default function PlayerHero({ player }: PlayerHeroProps) {
  const initial = player.name.trim().charAt(0).toUpperCase() || "?";

  return (
    <div className="relative rounded-xl overflow-hidden border border-line">
      <div
        className="absolute inset-0"
        aria-hidden="true"
        style={{
          background:
            "radial-gradient(120% 140% at 12% 15%, rgba(200,170,110,0.12) 0%, rgba(200,170,110,0) 55%), linear-gradient(180deg, #12160f 0%, #0a0d0b 100%)",
        }}
      />

      <div className="relative flex items-center gap-4 px-5 py-6 min-h-[128px]">
        <div className="flex-shrink-0 w-[76px] h-[76px] rounded-lg overflow-hidden border-2 border-teal shadow-[0_0_22px_rgba(200,170,110,0.3)] bg-panel2 flex items-center justify-center">
          <span className="font-display text-teal text-[30px] font-semibold select-none" aria-hidden="true">
            {initial}
          </span>
        </div>

        <div className="min-w-0">
          <h2 className="font-display text-teal text-[30px] sm:text-[36px] font-semibold uppercase tracking-[0.02em] leading-none truncate">
            {player.name}
          </h2>
          <div className="mt-2 flex items-center gap-2 text-[12.5px] tabular-nums">
            <span className="text-mut font-semibold uppercase tracking-[0.05em] truncate">
              {player.team ?? "Free agent"}
            </span>
            <span className="text-mut/50" aria-hidden="true">
              &middot;
            </span>
            <span className="text-mut">{player.gameCount.toLocaleString()} GAMES</span>
          </div>
        </div>
      </div>
    </div>
  );
}
