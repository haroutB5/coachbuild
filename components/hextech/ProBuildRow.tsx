"use client";

import { useState } from "react";
import type { ProGame } from "@/components/proGames.types";
import { versionFromPatch, itemIconUrl } from "@/components/proAssets";
import { IconWithFallback } from "@/components/IconWithFallback";
import { cleanPlayerName } from "@/components/playerName";
import GameDetailSheet from "@/components/GameDetailSheet";
import type { ChampionIconEntry } from "@/components/proAssets";
import type { HistorySheetControl } from "@/components/ProGameCard";

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
  /** v0.22.0 (PlayerGamesSection): ProBuildsTab's rows all share ONE fixed
   *  champion (announced once by the page's ChampionHero above the list), so
   *  the row itself never needed to name it. A player's recent games span
   *  many different champions — without this, every row here would read
   *  identically ("Bwipo · Estral Esports … vs X") with no way to tell which
   *  champion was played except opening the sheet. Renders `championIcon`/
   *  `championDisplayName` (already-forwarded-to-the-sheet props, reused
   *  rather than duplicated) as a small badge next to the player identity.
   *  False by default so ProBuildsTab's rows render byte-identical. */
  showOwnChampion?: boolean;
  /** Back-gesture history integration (app/page.tsx's home PRO BUILDS tab,
   *  wired via the same useSheetBackNav hook /history uses) — see
   *  ProGameCard's HistorySheetControl doc comment for the controlled-vs-
   *  local-state split. Absent falls back to fully local `open` state,
   *  unchanged prior behavior. */
  historySheet?: HistorySheetControl;
}

export default function ProBuildRow({
  game,
  championIcon,
  championDisplayName,
  enemyLaner,
  showOwnChampion,
  historySheet,
}: ProBuildRowProps) {
  const [localOpen, setLocalOpen] = useState(false);
  const open = historySheet ? historySheet.isOpen : localOpen;
  const ver = versionFromPatch(game.patch);
  const cleanedName = cleanPlayerName(game.player.name);
  const items = game.finalItems.slice(0, 4);

  function openSheet() {
    if (historySheet) historySheet.onOpen();
    else setLocalOpen(true);
  }

  const kda = (
    <>
      {game.kills}/{game.deaths}/{game.assists}
    </>
  );

  return (
    <>
      <div
        role="button"
        tabIndex={0}
        onClick={openSheet}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            openSheet();
          }
        }}
        aria-label={`View details — ${cleanedName ?? game.player.name}${
          showOwnChampion ? ` on ${championDisplayName ?? game.championName}` : ""
        }, vs ${enemyLaner?.name ?? "opponent"}, ${game.win ? "win" : "loss"}`}
        // Desktop keeps the original single-row layout. At <=sm the two
        // inner wrappers below switch from `flex` to `sm:contents` (they
        // stop generating their own box and hand their children straight to
        // this flex-col container as siblings), so mobile gets two stacked
        // rows — badge/identity/KDA, then vs/items/league+date — while every
        // datum stays visible (nothing drops behind `hidden sm:block`
        // anymore) instead of overflowing the 390px card horizontally.
        className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3 px-4 py-3 bg-panel border border-line rounded-xl hover:border-line-gold transition-colors cursor-pointer active:scale-[0.995] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-teal"
      >
        {/* Row 1 (mobile) — badge, identity, KDA. Dissolves into the outer
            flex row at sm+. */}
        <div className="flex items-center gap-3 sm:contents">
          {/* W/L badge */}
          <span
            className={`flex-shrink-0 w-6 h-6 rounded-md flex items-center justify-center text-[11px] font-bold ${
              game.win ? "bg-win text-black/80" : "bg-loss text-white"
            }`}
            aria-hidden="true"
          >
            {game.win ? "W" : "L"}
          </span>

          {/* Own champion — only in player-view mode (PlayerGamesSection),
              where rows span many different champions and would otherwise
              be indistinguishable without opening the sheet. ProBuildsTab
              never sets showOwnChampion (its rows already share one
              champion, announced once by the page's ChampionHero). */}
          {showOwnChampion && (
            <span
              className="flex-shrink-0 w-6 h-6 rounded-full bg-black/30 border border-line overflow-hidden flex items-center justify-center"
              title={championDisplayName ?? game.championName}
            >
              <IconWithFallback
                src={championIcon ?? ""}
                alt={championDisplayName ?? game.championName}
                className="w-full h-full object-cover"
                size={24}
              />
            </span>
          )}

          {/* Player identity */}
          <div className="min-w-0 flex-1 sm:w-[130px] sm:flex-shrink-0">
            <div className="text-[13px] font-semibold text-txt truncate">{cleanedName ?? game.player.name}</div>
            <div className="text-[11px] text-mut truncate">
              {showOwnChampion ? championDisplayName ?? game.championName : game.player.team ?? "—"}
            </div>
          </div>

          {/* KDA — mobile position (row 1, right edge). Desktop shows the
              second copy below instead. */}
          <div className="flex-shrink-0 sm:hidden text-[12.5px] font-semibold text-txt tabular-nums">{kda}</div>
        </div>

        {/* Row 2 (mobile) — vs opponent, items, league+date. Dissolves into
            the outer flex row at sm+, landing in the original column order
            (vs, KDA, items, league). */}
        <div className="flex items-center gap-2 sm:gap-3 sm:contents">
          {/* vs opponent */}
          <div className="flex items-center gap-1.5 min-w-0 flex-1 sm:w-[140px] sm:flex-shrink-0 text-[12px] text-mut">
            <span>vs</span>
            {enemyLaner && (
              <span className="w-5 h-5 rounded-full bg-black/30 overflow-hidden flex items-center justify-center flex-shrink-0">
                <IconWithFallback src={enemyLaner.icon} alt={enemyLaner.name} className="w-full h-full object-cover" size={20} />
              </span>
            )}
            <span className="truncate text-txt/90">{enemyLaner?.name ?? "—"}</span>
          </div>

          {/* KDA — desktop position (between vs and items). */}
          <div className="hidden sm:block w-[64px] flex-shrink-0 text-[12.5px] font-semibold text-txt tabular-nums">{kda}</div>

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

          {/* League + date, right-aligned — visible at every width now
              (previously `hidden sm:block` dropped it entirely at 390px);
              tighter max-width on mobile keeps the tournament name from
              pushing items off-row. */}
          <div className="ml-auto text-right flex-shrink-0">
            <div className="text-[11.5px] text-txt/85 truncate max-w-[92px] sm:max-w-[140px]">{game.tournament ?? "—"}</div>
            <div className="text-[10.5px] text-mut tabular-nums">{formatShortDate(game.gameCreation)}</div>
          </div>
        </div>
      </div>

      <GameDetailSheet
        game={game}
        championIcon={championIcon}
        championDisplayName={championDisplayName}
        open={open}
        // Controlled (historySheet present, home PRO BUILDS tab) mode: this
        // is only ever reached via the cross-player-jump path inside the
        // sheet — updating localOpen is inert there (open reads from
        // historySheet.isOpen instead). Uncontrolled mode: unchanged, this
        // IS the real close. Same split as ProGameCard's onClose.
        onClose={() => setLocalOpen(false)}
        onDismiss={historySheet?.onDismiss}
      />
    </>
  );
}
