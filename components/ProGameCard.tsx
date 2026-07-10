"use client";

import { useEffect, useState } from "react";
import type { ProGame } from "./proGames.types";
import {
  versionFromPatch,
  itemIconUrl,
  spellIconUrl,
  spellName,
  resolveRuneDisplay,
  type ResolvedRuneDisplay,
} from "./proAssets";
import GameDetailSheet from "./GameDetailSheet";
import { IconWithFallback } from "./IconWithFallback";

export function ImgWithFallback({
  src,
  alt,
  className,
}: {
  src: string;
  alt: string;
  className?: string;
}) {
  return <IconWithFallback src={src} alt={alt} className={className} />;
}

/** Compute a client-only relative-time string. This section only ever
 *  renders after a client fetch resolves (never during SSR), so there is no
 *  server-rendered timestamp to mismatch against. */
export function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const diffMin = Math.round(diffMs / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.round(diffHr / 24);
  return `${diffDay}d ago`;
}

export function formatGameLength(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function formatMinuteStamp(sec: number): string {
  return `${Math.floor(sec / 60)}'`;
}

/** (kills+assists)/deaths to 1 decimal — "Perfect" (no ratio to divide by)
 *  when deaths is 0. Deliberately neutral-colored, never good/bad — KDA
 *  ratio is not a WPA/winrate/performance-score signal, and that color
 *  language is reserved strictly for those. */
export function kdaRatioText(kills: number, deaths: number, assists: number): string {
  if (deaths === 0) return "Perfect";
  return `${((kills + assists) / deaths).toFixed(1)} KDA`;
}

/** Resolves a rune perk's name + icon asynchronously (shared module-level
 *  cache in proAssets.ts). Degrades to a plain circle with no crash if the
 *  rune bundle fetch fails. */
export function RunePerkIcon({
  runeId,
  ver,
  size,
}: {
  runeId: number;
  ver: string;
  size: "lg" | "sm" | "xs";
}) {
  const [rune, setRune] = useState<ResolvedRuneDisplay | null>(null);

  useEffect(() => {
    let cancelled = false;
    resolveRuneDisplay(runeId, ver).then((r) => {
      if (!cancelled) setRune(r);
    });
    return () => {
      cancelled = true;
    };
  }, [runeId, ver]);

  const dim = size === "lg" ? "w-11 h-11" : size === "sm" ? "w-6 h-6" : "w-5 h-5";
  const ring =
    size === "lg"
      ? "border-2 border-teal shadow-[0_0_10px_rgba(130,219,247,0.3)]"
      : "border border-line";

  return (
    <div
      className={`${dim} ${ring} rounded-full bg-black/30 overflow-hidden flex items-center justify-center flex-shrink-0`}
      title={rune ? rune.name : `Rune #${runeId}`}
    >
      <ImgWithFallback
        src={rune?.icon ?? ""}
        alt={rune?.name ?? `Rune #${runeId}`}
        className="w-full h-full object-contain"
      />
    </div>
  );
}

export function WinLossPill({ win }: { win: boolean }) {
  return (
    <span
      className={`inline-flex items-center px-1.5 py-0.5 rounded-md text-[10px] font-bold uppercase tracking-[0.5px] flex-shrink-0 ${
        win ? "bg-good/15 text-good border border-good/30" : "bg-bad/15 text-bad border border-bad/30"
      }`}
    >
      {win ? "Win" : "Loss"}
    </span>
  );
}

function Divider() {
  return <span className="w-px h-5 bg-line flex-shrink-0 hidden sm:block" aria-hidden="true" />;
}

interface ProGameCardProps {
  game: ProGame;
  /** Absolute champion icon URL, resolved by the parent (proAssets'
   *  getChampionIconMap() in player mode, or the already-selected
   *  ChampionRef.icon in champion mode). Optional — the champion name
   *  always renders regardless, so the card never loses champion identity
   *  even if icon resolution is skipped/fails. */
  championIcon?: string;
  /** Proper display name ("Wukong") — game.championName is Riot's INTERNAL
   *  id name from match-v5 ("MonkeyKing", "FiddleSticks"), which is wrong to
   *  show users. Falls back to the internal name when unresolved. */
  championDisplayName?: string;
}

// Lane the game was actually played in — matters on the "auto" (all-lanes)
// view where the section can mix lanes for the same champion.
export const GAME_LANE_LABEL: Record<number, string> = {
  0: "Top",
  1: "Jungle",
  2: "Mid",
  3: "Bot",
  4: "Support",
};

export default function ProGameCard({
  game,
  championIcon,
  championDisplayName,
}: ProGameCardProps) {
  const [open, setOpen] = useState(false);
  const ver = versionFromPatch(game.patch);
  const isProstage = game.source === "prostage";

  function openSheet() {
    setOpen(true);
  }

  function onCardKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openSheet();
    }
  }

  return (
    <>
      <div
        role="button"
        tabIndex={0}
        onClick={openSheet}
        onKeyDown={onCardKeyDown}
        aria-label={`View details — ${championDisplayName ?? game.championName}, ${game.player.name}, ${
          game.win ? "win" : "loss"
        }`}
        className="glass-card rounded-2xl overflow-hidden shadow-[0_6px_24px_rgba(0,0,0,0.3)] cursor-pointer transition-colors hover:border-teal-dim/60 active:scale-[0.995] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
      >
        {/* Dense collapsed row — identity, result, KDA, spells + keystone,
            items, and timing/source metadata all inline (wraps on narrow
            viewports; icon boxes are fixed-size so rows never jitter). */}
        <div className="flex items-center gap-2.5 px-4 py-3 flex-wrap">
          {/* Identity: champion + player */}
          <div className="flex items-center gap-1.5 min-w-0 flex-shrink-0">
            {championIcon && (
              <span
                className="w-7 h-7 rounded-full bg-black/30 border border-line overflow-hidden flex items-center justify-center flex-shrink-0"
                title={championDisplayName ?? game.championName}
              >
                <ImgWithFallback
                  src={championIcon}
                  alt={championDisplayName ?? game.championName}
                  className="w-full h-full object-cover"
                />
              </span>
            )}
            <span className="text-sm font-semibold text-txt truncate max-w-[110px]">
              {championDisplayName ?? game.championName}
            </span>
          </div>
          <div className="flex items-center gap-1 min-w-0 flex-shrink text-[12px]">
            <span className="text-txt font-medium truncate max-w-[100px]">{game.player.name}</span>
            {game.player.team && (
              <span className="text-mut truncate max-w-[70px]">{game.player.team}</span>
            )}
          </div>

          <Divider />

          {/* Result + KDA */}
          <div className="flex items-center gap-2 flex-shrink-0">
            <WinLossPill win={game.win} />
            <span className="text-[12.5px] font-semibold text-txt tabular-nums">
              {game.kills}/{game.deaths}/{game.assists}
            </span>
            <span className="text-[10.5px] text-mut tabular-nums">
              {kdaRatioText(game.kills, game.deaths, game.assists)}
            </span>
          </div>

          <Divider />

          {/* Spells + keystone */}
          {(game.spells.some(Boolean) || game.runes.keystone > 0) && (
            <div className="flex items-center gap-1 flex-shrink-0">
              {game.spells.map(
                (id, i) =>
                  id > 0 && (
                    <div
                      key={`spell-${id}-${i}`}
                      className="w-5 h-5 rounded-[5px] bg-black/30 border border-line overflow-hidden flex items-center justify-center flex-shrink-0"
                      title={spellName(id)}
                    >
                      <ImgWithFallback
                        src={spellIconUrl(id, ver)}
                        alt={spellName(id)}
                        className="w-full h-full object-contain"
                      />
                    </div>
                  )
              )}
              {game.runes.keystone > 0 && (
                <RunePerkIcon runeId={game.runes.keystone} ver={ver} size="sm" />
              )}
            </div>
          )}

          <Divider />

          {/* Full item build — 6 slots + trinket, small squares, fixed size */}
          <div className="flex items-center gap-1 flex-shrink-0">
            {game.finalItems.map((id, i) => (
              <div
                key={`item-${id}-${i}`}
                className="w-7 h-7 rounded-md bg-black/30 border border-line overflow-hidden flex items-center justify-center flex-shrink-0"
                title={`Item #${id}`}
              >
                <ImgWithFallback src={itemIconUrl(id, ver)} alt={`Item #${id}`} className="w-full h-full object-contain" />
              </div>
            ))}
            {game.trinket && (
              <div
                className="w-7 h-7 rounded-full bg-black/30 border border-teal-dim overflow-hidden flex items-center justify-center flex-shrink-0"
                title={`Trinket #${game.trinket}`}
              >
                <ImgWithFallback src={itemIconUrl(game.trinket, ver)} alt="Trinket" className="w-full h-full object-contain" />
              </div>
            )}
          </div>

          {/* Timing + source metadata, pinned right */}
          <div className="ml-auto flex items-center gap-1.5 text-[10.5px] text-mut flex-wrap justify-end">
            {isProstage && (
              <span className="inline-flex items-center px-1.5 py-[1px] rounded text-[9px] font-bold uppercase tracking-[0.5px] bg-gold/15 text-gold border border-gold/30">
                Pro Play
              </span>
            )}
            <span className="uppercase tracking-[0.5px]">
              {isProstage ? game.tournament : game.account.region}
            </span>
            {GAME_LANE_LABEL[game.role] && (
              <>
                <span>·</span>
                <span>{GAME_LANE_LABEL[game.role]}</span>
              </>
            )}
            {game.patch && (
              <>
                <span>·</span>
                <span className="tabular-nums">{game.patch}</span>
              </>
            )}
            {game.gameDurationSec > 0 && (
              <>
                <span>·</span>
                <span className="tabular-nums">{formatGameLength(game.gameDurationSec)}</span>
              </>
            )}
            <span>·</span>
            <span className="tabular-nums">{relativeTime(game.gameCreation)}</span>

            {/* Decorative click affordance — the whole card is the trigger
                (see the outer role="button"), so this is not its own
                interactive element. */}
            <span className="flex items-center gap-0.5 text-mut" aria-hidden="true">
              Details
              <span className="inline-block">›</span>
            </span>
          </div>
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
