"use client";

import { useEffect, useState } from "react";
import type { ProGame } from "./proGames.types";
import {
  getChampionIconMap,
  itemIconUrl,
  resolveRuneDisplay,
  versionFromPatch,
  type ChampionIconEntry,
  type ResolvedRuneDisplay,
} from "./proAssets";
import GameDetailSheet from "./GameDetailSheet";
import { IconWithFallback } from "./IconWithFallback";
import { cleanPlayerName } from "./playerName";
import type { PendingPlayerSelect } from "./playerSelectHandoff";
import type { Pick as RunePick } from "@/lib/types";
import { RuneCircle } from "./hextech/builds/BuildVisuals";

export function ImgWithFallback({ src, alt, className, size }: { src: string; alt: string; className?: string; size?: number }) {
  return <IconWithFallback src={src} alt={alt} className={className} size={size} />;
}

export function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const diffMin = Math.round(diffMs / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${Math.round(diffHr / 24)}d ago`;
}

export function formatGameLength(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function formatMinuteStamp(sec: number): string {
  return `${Math.floor(sec / 60)}'`;
}

export function kdaRatioText(kills: number, deaths: number, assists: number): string {
  if (deaths === 0) return "Perfect";
  return `${((kills + assists) / deaths).toFixed(1)} KDA`;
}

function useRuneDisplay(runeId: number, ver: string): ResolvedRuneDisplay | null {
  const [rune, setRune] = useState<ResolvedRuneDisplay | null>(null);
  useEffect(() => {
    let cancelled = false;
    resolveRuneDisplay(runeId, ver).then((value) => {
      if (!cancelled) setRune(value);
    });
    return () => {
      cancelled = true;
    };
  }, [runeId, ver]);
  return rune;
}

function keystoneLabel(rune: ResolvedRuneDisplay | null): string {
  return rune && rune.name.trim() !== "" && !/^Rune #\d+$/.test(rune.name) ? rune.name : "Keystone —";
}

export function RunePerkIcon({ runeId, ver, size }: { runeId: number; ver: string; size: "lg" | "sm" | "xs" }) {
  const rune = useRuneDisplay(runeId, ver);
  const label = keystoneLabel(rune);
  const px = size === "lg" ? 44 : size === "sm" ? 24 : 20;
  const pick: RunePick = { id: runeId, name: label, icon: rune?.icon ?? "", wpa: 0, winrate: null, occurrence: 0 };
  return <RuneCircle pick={pick} size={px} keystone={size === "lg"} />;
}

function RunePerkName({ runeId, ver }: { runeId: number; ver: string }) {
  return <>{keystoneLabel(useRuneDisplay(runeId, ver))}</>;
}

export function WinLossPill({ win }: { win: boolean }) {
  return <span className={`inline-flex items-center rounded-[4px] px-1.5 py-1 text-[9px] font-semibold uppercase tracking-[0.08em] ${win ? "bg-good/15 text-good" : "bg-bad/15 text-bad"}`}>{win ? "Win" : "Loss"}</span>;
}

export interface HistorySheetControl {
  isOpen: boolean;
  onOpen: () => void;
  onDismiss: () => void;
}

interface ProGameCardProps {
  game: ProGame;
  championIcon?: string;
  championDisplayName?: string;
  onSelectPlayer?: (player: PendingPlayerSelect) => void;
  historySheet?: HistorySheetControl;
}

export const GAME_LANE_LABEL: Record<number, string> = { 0: "Top", 1: "Jungle", 2: "Mid", 3: "Bot", 4: "Support" };

function CardTeamStrip({ game, iconMap }: { game: ProGame; iconMap: Map<number, ChampionIconEntry> | null }) {
  if (!game.allyChampionIds || !game.enemyChampionIds) return null;
  return (
    <div className="flex items-center gap-2 border-t border-white/[0.06] px-4 py-3" aria-label="Five versus five champion strip">
      <div className="flex min-w-0 items-center gap-1" aria-label="Ally champions">
        {game.allyChampionIds.slice(0, 5).map((championId, index) => <CompIcon key={`${championId}-${index}`} championId={championId} iconMap={iconMap} tone="ally" self={championId === game.championId} />)}
      </div>
      <span className="shrink-0 text-[9px] font-semibold uppercase tracking-[0.08em] text-mut">VS</span>
      <div className="flex min-w-0 items-center gap-1" aria-label="Enemy champions">
        {game.enemyChampionIds.slice(0, 5).map((championId, index) => <CompIcon key={`${championId}-${index}`} championId={championId} iconMap={iconMap} tone="enemy" self={false} />)}
      </div>
    </div>
  );
}

function CompIcon({ championId, iconMap, tone, self }: { championId: number; iconMap: Map<number, ChampionIconEntry> | null; tone: "ally" | "enemy"; self: boolean }) {
  const entry = iconMap?.get(championId);
  const name = entry?.name ?? `Champion #${championId}`;
  return <span className={`flex h-[26px] w-[26px] shrink-0 items-center justify-center overflow-hidden rounded-[6px] bg-gradient-to-br from-[#2b2e42] to-[#1c1e2c] ${tone === "ally" ? "ring-1 ring-good/65" : "ring-1 ring-bad/65"} ${self ? "ring-2 ring-teal" : ""}`} title={name}><IconWithFallback src={entry?.icon ?? ""} alt={name} className="h-full w-full object-cover" size={26} /></span>;
}

function ItemSummary({ game, ver }: { game: ProGame; ver: string }) {
  const items = game.finalItems.filter((item) => item > 0).slice(0, 3);
  return (
    <div className="flex min-w-0 items-center gap-2 border-t border-white/[0.06] px-4 py-2.5">
      {game.runes.keystone > 0 ? <RunePerkIcon runeId={game.runes.keystone} ver={ver} size="xs" /> : <span className="h-5 w-5 shrink-0 rounded-full bg-white/[0.05]" title="Rune not recorded" />}
      <span className="truncate text-[10.5px] text-mut">{game.runes.keystone > 0 ? <RunePerkName runeId={game.runes.keystone} ver={ver} /> : "Rune data not recorded"}</span>
      <span className="text-[10px] text-mut/50">·</span>
      <div className="flex shrink-0 items-center gap-1">
        {items.map((itemId, index) => <span key={`${itemId}-${index}`} className="flex h-5 w-5 items-center justify-center overflow-hidden rounded-[4px] bg-black/25 shadow-[inset_0_0_0_1px_rgba(233,233,237,.1)]"><ImgWithFallback src={itemIconUrl(itemId, ver)} alt={`Item ${itemId}`} className="h-full w-full object-cover" size={20} /></span>)}
      </div>
      <span className="truncate text-[10.5px] text-mut">{items.length > 0 ? `${game.finalItems.filter((item) => item > 0).length} items` : "Items not recorded"}</span>
    </div>
  );
}

export default function ProGameCard({ game, championIcon, championDisplayName, onSelectPlayer, historySheet }: ProGameCardProps) {
  const [localOpen, setLocalOpen] = useState(false);
  const [iconMap, setIconMap] = useState<Map<number, ChampionIconEntry> | null>(null);
  const open = historySheet ? historySheet.isOpen : localOpen;
  const ver = versionFromPatch(game.patch);
  const displayName = championDisplayName ?? game.championName;
  const playerName = cleanPlayerName(game.player.name) ?? game.player.name;
  const sourceLabel = game.source === "prostage" ? "Pro Play" : "Solo queue";

  useEffect(() => {
    let cancelled = false;
    getChampionIconMap().then((map) => {
      if (!cancelled) setIconMap(map);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  function openSheet() {
    if (historySheet) historySheet.onOpen();
    else setLocalOpen(true);
  }

  function onCardKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openSheet();
    }
  }

  return (
    <>
      <article role="button" tabIndex={0} onClick={openSheet} onKeyDown={onCardKeyDown} aria-label={`View details — ${displayName}, ${playerName}, ${game.win ? "win" : "loss"}`} className="cursor-pointer overflow-hidden rounded-[9px] bg-panel-glass shadow-[inset_0_0_0_1px_rgba(233,233,237,.08)] transition-colors hover:bg-white/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal">
        <header className={`flex items-center gap-3 px-4 py-3 ${game.win ? "bg-good/[0.06]" : "bg-bad/[0.05]"}`}>
          <span className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-[8px] bg-gradient-to-br from-[#2b2e42] to-[#1c1e2c] shadow-[inset_0_0_0_1px_rgba(233,233,237,.12)]"><IconWithFallback src={championIcon ?? ""} alt={displayName} fallbackGlyph={displayName} className="h-full w-full object-cover" size={44} /></span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[14px] font-semibold text-txt">{playerName} <span className="text-[10px] font-medium uppercase tracking-[0.08em] text-mut">{game.player.team ?? ""}</span></p>
            <p className="mt-0.5 truncate text-[10.5px] text-mut">{displayName} · {sourceLabel}{game.patch ? ` · patch ${game.patch}` : ""}</p>
          </div>
          <div className="shrink-0 text-right">
            <span className={`inline-flex rounded-[4px] px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.08em] ${game.win ? "bg-good/20 text-good" : "bg-bad/20 text-bad"}`}>{game.win ? "W" : "L"}</span>
            <p className="mt-1 text-[12px] font-semibold text-txt tabular-nums">{game.kills}/{game.deaths}/{game.assists}</p>
          </div>
        </header>
        <CardTeamStrip game={game} iconMap={iconMap} />
        <ItemSummary game={game} ver={ver} />
      </article>

      <GameDetailSheet game={game} championIcon={championIcon} championDisplayName={championDisplayName} open={open} onClose={() => setLocalOpen(false)} onDismiss={historySheet?.onDismiss} onSelectPlayer={onSelectPlayer} />
    </>
  );
}
