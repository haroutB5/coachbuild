"use client";

import { useState } from "react";
import type { ProGame } from "@/components/proGames.types";
import { versionFromPatch, itemIconUrl } from "@/components/proAssets";
import { IconWithFallback } from "@/components/IconWithFallback";
import { cleanPlayerName } from "@/components/playerName";
import GameDetailSheet from "@/components/GameDetailSheet";
import type { ChampionIconEntry } from "@/components/proAssets";

function formatShortDate(iso: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(new Date(iso));
  } catch {
    return "";
  }
}

interface ProBuildRowProps {
  game: ProGame;
  championIcon?: string;
  championDisplayName?: string;
  /** Enemy laner (same role as the tracked player), resolved by the parent
   *  from game.enemyChampionIds[role] + the shared champion icon map — see
   *  ProBuildsTab. Undefined when the game has no role-ordered comp data
   *  (renders no "vs" — never a guessed opponent). */
  enemyLaner?: ChampionIconEntry;
}

export default function ProBuildRow({ game, championIcon, championDisplayName, enemyLaner }: ProBuildRowProps) {
  const [open, setOpen] = useState(false);
  const ver = versionFromPatch(game.patch);
  const cleanedName = cleanPlayerName(game.player.name);
  const items = game.finalItems.slice(0, 4);

  return (
    <>
      <div
        role="button"
        tabIndex={0}
        onClick={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setOpen(true);
          }
        }}
        aria-label={`View details — ${cleanedName ?? game.player.name}, vs ${enemyLaner?.name ?? "opponent"}, ${
          game.win ? "win" : "loss"
        }`}
        className="flex items-center gap-3 px-4 py-3 bg-panel border border-line rounded-xl hover:border-line-gold transition-colors cursor-pointer active:scale-[0.995] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-teal"
      >
        {/* W/L badge */}
        <span
          className={`flex-shrink-0 w-6 h-6 rounded-md flex items-center justify-center text-[11px] font-bold ${
            game.win ? "bg-win text-black/80" : "bg-loss text-white"
          }`}
          aria-hidden="true"
        >
          {game.win ? "W" : "L"}
        </span>

        {/* Player identity */}
        <div className="min-w-0 w-[130px] flex-shrink-0">
          <div className="text-[13px] font-semibold text-txt truncate">{cleanedName ?? game.player.name}</div>
          <div className="text-[11px] text-mut truncate">{game.player.team ?? "—"}</div>
        </div>

        {/* vs opponent */}
        <div className="flex items-center gap-1.5 min-w-0 w-[140px] flex-shrink-0 text-[12px] text-mut">
          <span>vs</span>
          {enemyLaner && (
            <span className="w-5 h-5 rounded-full bg-black/30 overflow-hidden flex items-center justify-center flex-shrink-0">
              <IconWithFallback src={enemyLaner.icon} alt={enemyLaner.name} className="w-full h-full object-cover" size={20} />
            </span>
          )}
          <span className="truncate text-txt/90">{enemyLaner?.name ?? "—"}</span>
        </div>

        {/* KDA */}
        <div className="w-[64px] flex-shrink-0 text-[12.5px] font-semibold text-txt tabular-nums">
          {game.kills}/{game.deaths}/{game.assists}
        </div>

        {/* Final items */}
        <div className="flex items-center gap-1 flex-shrink-0">
          {items.map((id, i) => (
            <span
              key={`${id}-${i}`}
              className="w-6 h-6 rounded bg-black/30 border border-line overflow-hidden flex items-center justify-center flex-shrink-0"
            >
              <IconWithFallback src={itemIconUrl(id, ver)} alt="" className="w-full h-full object-contain" size={24} />
            </span>
          ))}
        </div>

        {/* League + date, right-aligned */}
        <div className="ml-auto text-right flex-shrink-0 hidden sm:block">
          <div className="text-[11.5px] text-txt/85 truncate max-w-[140px]">{game.tournament ?? "—"}</div>
          <div className="text-[10.5px] text-mut tabular-nums">{formatShortDate(game.gameCreation)}</div>
        </div>
      </div>

      <GameDetailSheet
        game={game}
        championIcon={championIcon}
        championDisplayName={championDisplayName}
        open={open}
        onClose={() => setOpen(false)}
      />
    </>
  );
}
