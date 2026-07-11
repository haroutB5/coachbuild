"use client";

// ─────────────────────────────────────────────────────────────────────────────
// TeamComp.tsx — dpm.lol-style ally/enemy team-comp display, shared between
// ProGameCard's dense collapsed row (CardCompStrip) and GameDetailSheet's
// "Teams" section (SheetTeamsSection).
//
// Both allyChampionIds/enemyChampionIds are OPTIONAL on ProGame (backend
// backfill in progress, per engy's concurrent contract change) — both
// components here render NOTHING (return null) when either array is
// undefined. This is a stronger check than "array is empty": an empty array
// would still mean "we know the comp and it's 0 champions," which never
// happens, whereas undefined means "not backfilled for this game yet" and
// must never show a skeleton or a reserved gap.
//
// allyPlayers/enemyPlayers (per-player champ/name/items/trinket/role) are a
// SEPARATE, independently-optional pair on top of that — a per-SIDE fallback:
// if a side's *Players array is missing/short (partial backfill, or an old
// cached response from before this feature shipped), that side renders the
// original icon-only roster instead of an empty box. The box chrome (panel,
// header, win/loss chip) is unconditional once *ChampionIds resolve; only the
// body content per side depends on *Players.
//
// Champion icons are resolved via proAssets.getChampionIconMap() — the same
// module-level-cached /api/champions fetch ProHistoryResults/ProGamesSection
// already use for the card's OWN champion icon, so mounting this on every
// card is cache-cheap (one real network fetch per page load, shared).
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from "react";
import { getChampionIconMap, itemIconUrl, type ChampionIconEntry } from "./proAssets";
import { IconWithFallback } from "./IconWithFallback";
import { WinLossPill } from "./ProGameCard";
import type { TeamCompPlayer } from "./proGames.types";
import { cleanPlayerName } from "./playerName";
import type { PendingPlayerSelect } from "./playerSelectHandoff";
import {
  ROSTER_ROLE_LABELS,
  STANDARD_ROSTER_LENGTH,
  roleAbbrForPlayer,
  teamBoxTitle,
  isSelfInAlly,
} from "./teamCompDisplay";

// roleAbbrForPlayer/teamBoxTitle/isSelfInAlly are re-exported here so any
// existing import site that reaches for them via "./TeamComp" keeps working
// — the actual logic + unit tests live in teamCompDisplay.ts (see that
// file's header comment for why: this file contains real JSX and this
// repo's Vitest harness can't import JSX-bearing modules directly).
export { roleAbbrForPlayer, teamBoxTitle, isSelfInAlly };

function useChampionIconMap(): Map<number, ChampionIconEntry> | null {
  const [map, setMap] = useState<Map<number, ChampionIconEntry> | null>(null);

  useEffect(() => {
    let cancelled = false;
    getChampionIconMap().then((m) => {
      if (!cancelled) setMap(m);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return map;
}

interface TeamCompProps {
  allyChampionIds?: number[];
  enemyChampionIds?: number[];
  /** game.championId — used to ring-highlight the player's own champion
   *  among their 4 ally teammates. Never matched against enemyChampionIds. */
  selfChampionId: number;
}

/** Dense icon-only ally-vs-enemy row for the collapsed card — 5 small ally
 *  icons (player's own champion ringed) beside 5 enemy icons. At 10 icons ×
 *  20px + gaps + the "vs" label this comes to well under 260px, safely inside
 *  even a 390px viewport's card content width — no overflow, no wrap.
 *  UNCHANGED by the per-player Teams-box work below — this stays the dense
 *  card-strip presentation regardless of allyPlayers/enemyPlayers. */
export function CardCompStrip({ allyChampionIds, enemyChampionIds, selfChampionId }: TeamCompProps) {
  const iconMap = useChampionIconMap();
  if (!allyChampionIds || !enemyChampionIds) return null;

  return (
    // NOTE: was `border-line/60` — since `line` is already an rgba() token,
    // Tailwind's opacity modifier can't compose with its baked-in alpha and
    // silently resolved to solid white at 60% opacity instead of a faint
    // hairline (measured: rgba(255,255,255,0.6), ~7.5x brighter than
    // intended). That bright seam is what made the strip read as a bolted-on
    // "orphan" row rather than the bottom of the same card — fixed by using
    // a plain (non-token) white with an arbitrary alpha, which Tailwind CAN
    // compose correctly, at roughly the card border's own faintness.
    <div className="flex items-center gap-2 px-4 py-2 border-t border-white/[0.08] overflow-hidden">
      <MiniCompRow
        championIds={allyChampionIds}
        selfChampionId={selfChampionId}
        iconMap={iconMap}
        ariaLabel="Ally team"
      />
      <span
        className="text-[9px] font-bold text-mut uppercase tracking-[0.5px] flex-shrink-0"
        aria-hidden="true"
      >
        vs
      </span>
      <MiniCompRow
        championIds={enemyChampionIds}
        selfChampionId={null}
        iconMap={iconMap}
        ariaLabel="Enemy team"
      />
    </div>
  );
}

function MiniCompRow({
  championIds,
  selfChampionId,
  iconMap,
  ariaLabel,
}: {
  championIds: number[];
  selfChampionId: number | null;
  iconMap: Map<number, ChampionIconEntry> | null;
  ariaLabel: string;
}) {
  return (
    <div className="flex items-center gap-1 min-w-0" role="group" aria-label={ariaLabel}>
      {championIds.map((champId, i) => {
        const entry = iconMap?.get(champId);
        const name = entry?.name ?? `Champion #${champId}`;
        const isSelf = champId === selfChampionId;
        return (
          <span
            key={`${champId}-${i}`}
            className={`w-5 h-5 rounded-full bg-black/30 overflow-hidden flex items-center justify-center flex-shrink-0 ${
              isSelf ? "ring-2 ring-teal" : "border border-line opacity-55"
            }`}
            title={name}
          >
            <IconWithFallback src={entry?.icon ?? ""} alt={name} className="w-full h-full object-cover" size={20} />
          </span>
        );
      })}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Sheet Teams section — boxed presentation.
// ─────────────────────────────────────────────────────────────────────────────

interface SheetTeamsSectionProps extends TeamCompProps {
  allyPlayers?: TeamCompPlayer[];
  enemyPlayers?: TeamCompPlayer[];
  /** True while GameDetailSheet's team-players fetch (GET
   *  /api/pros/team-players, fired on sheet open) is in flight. Renders a
   *  fixed-height skeleton sized to match the eventual 5-row player list
   *  instead of the shorter icon-only LegacyRosterBody strip — upgrading
   *  from the short strip straight to the tall row list would shift the
   *  sections below it inside the sheet; skeleton-at-final-height avoids
   *  that regardless of whether the shift would count against the page's
   *  CLS metric (it's a post-interaction shift, likely exempt, but a visible
   *  jump reads as janky either way). */
  teamPlayersLoading: boolean;
  /** game.win — whose box gets the WIN chip is derived from this + which
   *  box the tracked player's champion is in (always ally, by contract). */
  win: boolean;
  /** game.player.team — used for the "Ally team" fallback title only. */
  trackedPlayerTeam?: string | null;
  /** Real team names, when the backend has resolved them. Both optional and
   *  independent — see teamBoxTitle. */
  allyTeamName?: string | null;
  enemyTeamName?: string | null;
  /** Icon/data CDN version (proAssets.versionFromPatch(game.patch)) — needed
   *  here now that per-player item icons render inline in this section. */
  ver: string;
  /** Batch-resolved real item names (GameDetailSheet's getItemNameMap fetch)
   *  for tappable item aria-labels; null/missing id degrades to "Item #id". */
  itemNames: Map<number, string> | null;
  /** Opens the SAME item-detail popover the Final Build / Item Build Order
   *  sections already use (GameDetailSheet's openItemPopover). */
  onItemClick: (id: number) => void;
  /** Tap-to-view-their-games — fired from a per-player row whose `proId` is
   *  non-null. Owned by GameDetailSheet (see its header comment for the
   *  same-page-callback vs. cross-page-navigation split); undefined here
   *  would mean no rows are tappable, but GameDetailSheet always supplies
   *  it. */
  onSelectPlayer?: (player: PendingPlayerSelect) => void;
}

/** Boxed Ally/Enemy Teams section for the detail sheet. Each side is its own
 *  glass panel with a header (title + win/loss chip when derivable) and a
 *  body that's either the new 5-row per-player roster (champ + role + name +
 *  tappable final items) when that side's *Players array resolved, or the
 *  original icon-only roster otherwise — never an empty box. */
export function SheetTeamsSection({
  allyChampionIds,
  enemyChampionIds,
  allyPlayers,
  enemyPlayers,
  teamPlayersLoading,
  selfChampionId,
  win,
  trackedPlayerTeam,
  allyTeamName,
  enemyTeamName,
  ver,
  itemNames,
  onItemClick,
  onSelectPlayer,
}: SheetTeamsSectionProps) {
  const iconMap = useChampionIconMap();
  if (!allyChampionIds || !enemyChampionIds) return null;

  const showResult = isSelfInAlly(allyChampionIds, selfChampionId);

  return (
    <section className="mb-6">
      <p className="text-[10.5px] tracking-[1px] uppercase text-teal font-bold mb-2.5">Teams</p>
      <div className="space-y-2.5">
        <TeamBox
          title={teamBoxTitle("ally", allyTeamName, trackedPlayerTeam)}
          resultChip={showResult ? win : undefined}
          championIds={allyChampionIds}
          players={allyPlayers}
          loading={teamPlayersLoading}
          selfChampionId={selfChampionId}
          iconMap={iconMap}
          ver={ver}
          itemNames={itemNames}
          onItemClick={onItemClick}
          onSelectPlayer={onSelectPlayer}
        />
        <TeamBox
          title={teamBoxTitle("enemy", enemyTeamName)}
          resultChip={showResult ? !win : undefined}
          championIds={enemyChampionIds}
          players={enemyPlayers}
          loading={teamPlayersLoading}
          selfChampionId={null}
          iconMap={iconMap}
          ver={ver}
          itemNames={itemNames}
          onItemClick={onItemClick}
          onSelectPlayer={onSelectPlayer}
        />
      </div>
    </section>
  );
}

/** Fixed-height stand-in for one PlayerRow while the team-players fetch is in
 *  flight — same icon size (28px)/padding/gap as the real row so the box's
 *  total height doesn't change when the real rows swap in. */
function PlayerRowSkeleton() {
  return (
    <div className="flex items-center gap-1.5 rounded-lg px-1.5 py-1" aria-hidden="true">
      <span className="w-7 h-7 rounded-full bg-panel2 border border-line animate-pulse motion-reduce:animate-none flex-shrink-0" />
      <span className="w-6 h-[8.5px] rounded-sm bg-panel2 animate-pulse motion-reduce:animate-none flex-shrink-0" />
      <span className="h-[8.5px] flex-1 min-w-[36px] rounded-sm bg-panel2 animate-pulse motion-reduce:animate-none" />
      <div className="flex items-center gap-1 flex-shrink-0 ml-auto">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <span
            key={i}
            className="w-[23px] h-[23px] rounded-[5px] bg-panel2 border border-line animate-pulse motion-reduce:animate-none"
          />
        ))}
      </div>
    </div>
  );
}

function TeamBoxSkeleton() {
  return (
    <div className="space-y-1.5">
      {Array.from({ length: STANDARD_ROSTER_LENGTH }, (_, i) => (
        <PlayerRowSkeleton key={i} />
      ))}
    </div>
  );
}

function TeamBox({
  title,
  resultChip,
  championIds,
  players,
  loading,
  selfChampionId,
  iconMap,
  ver,
  itemNames,
  onItemClick,
  onSelectPlayer,
}: {
  title: string;
  /** undefined = not derivable, don't render a chip. */
  resultChip: boolean | undefined;
  championIds: number[];
  players: TeamCompPlayer[] | undefined;
  /** See SheetTeamsSectionProps.teamPlayersLoading. */
  loading: boolean;
  selfChampionId: number | null;
  iconMap: Map<number, ChampionIconEntry> | null;
  ver: string;
  itemNames: Map<number, string> | null;
  onItemClick: (id: number) => void;
  onSelectPlayer?: (player: PendingPlayerSelect) => void;
}) {
  // Border/label emphasis only — deliberately no red/blue full-box accent
  // color per the dispatch brief (that fights the token discipline; good/bad
  // is reserved for the win/loss chip alone).
  return (
    <div className="rounded-xl border border-line bg-black/15 p-3">
      <div className="flex items-center justify-between gap-2 mb-2.5">
        <p className="text-[9.5px] uppercase tracking-[0.5px] text-mut truncate min-w-0">{title}</p>
        {resultChip !== undefined && <WinLossPill win={resultChip} />}
      </div>
      {loading ? (
        <TeamBoxSkeleton />
      ) : players && players.length === STANDARD_ROSTER_LENGTH ? (
        <div className="space-y-1.5" role="group" aria-label={title}>
          {players.map((p, i) => (
            <PlayerRow
              key={`${p.championId}-${i}`}
              player={p}
              index={i}
              rosterLength={players.length}
              isSelf={p.championId === selfChampionId}
              iconMap={iconMap}
              ver={ver}
              itemNames={itemNames}
              onItemClick={onItemClick}
              onSelectPlayer={onSelectPlayer}
            />
          ))}
        </div>
      ) : (
        <LegacyRosterBody
          championIds={championIds}
          selfChampionId={selfChampionId}
          iconMap={iconMap}
          ariaLabel={title}
        />
      )}
    </div>
  );
}

/** Original icon-only roster body (no per-player items) — the fallback for
 *  when a side's *Players array hasn't backfilled yet. Same visual treatment
 *  this repo shipped before the per-player redesign, just without its own
 *  "Ally"/"Enemy" label paragraph (that's now the TeamBox header above it). */
function LegacyRosterBody({
  championIds,
  selfChampionId,
  iconMap,
  ariaLabel,
}: {
  championIds: number[];
  selfChampionId: number | null;
  iconMap: Map<number, ChampionIconEntry> | null;
  ariaLabel: string;
}) {
  return (
    <div className="flex items-start gap-2 flex-wrap" role="group" aria-label={ariaLabel}>
      {championIds.map((champId, i) => {
        const entry = iconMap?.get(champId);
        const name = entry?.name ?? `Champion #${champId}`;
        const isSelf = champId === selfChampionId;
        const role =
          championIds.length === ROSTER_ROLE_LABELS.length ? ROSTER_ROLE_LABELS[i] : undefined;
        const title = role ? `${role} — ${name}` : name;
        return (
          <div
            key={`${champId}-${i}`}
            className="flex flex-col items-center gap-1 w-12 flex-shrink-0"
            title={title}
          >
            <div
              className={`w-9 h-9 rounded-full bg-black/30 overflow-hidden flex items-center justify-center flex-shrink-0 ${
                isSelf
                  ? "border-2 border-teal shadow-[0_0_10px_rgba(130,219,247,0.3)]"
                  : "border border-line opacity-70"
              }`}
            >
              <IconWithFallback
                src={entry?.icon ?? ""}
                alt={name}
                fallbackGlyph={name}
                className="w-full h-full object-cover"
                size={36}
              />
            </div>
            <span className="text-[9px] text-mut text-center leading-tight truncate w-full">{name}</span>
          </div>
        );
      })}
    </div>
  );
}

/** One player row inside a per-player TeamBox — champion icon + role abbr +
 *  player name (only when non-null) + tappable final-build item icons +
 *  trinket. The tracked player's row keeps the same ring highlight the
 *  legacy roster used. The whole row is a single `flex-wrap` container so
 *  the item-icon cluster drops to its own line as a unit if the name +
 *  fixed-width bits don't leave enough room — never a horizontal overflow at
 *  390px. */
function PlayerRow({
  player,
  index,
  rosterLength,
  isSelf,
  iconMap,
  ver,
  itemNames,
  onItemClick,
  onSelectPlayer,
}: {
  player: TeamCompPlayer;
  index: number;
  rosterLength: number;
  isSelf: boolean;
  iconMap: Map<number, ChampionIconEntry> | null;
  ver: string;
  itemNames: Map<number, string> | null;
  onItemClick: (id: number) => void;
  onSelectPlayer?: (player: PendingPlayerSelect) => void;
}) {
  const entry = iconMap?.get(player.championId);
  const champName = entry?.name ?? `Champion #${player.championId}`;
  const roleAbbr = roleAbbrForPlayer(player.role, index, rosterLength);
  const displayName = cleanPlayerName(player.name);
  // Tappable identity area when this slot is a TRACKED pro (proId non-null)
  // OR an untracked prostage player we can still look up by raw Leaguepedia
  // link (playerLink non-null) — a soloq teammate/opponent with neither
  // (the common case there) renders exactly as before, no dead-looking
  // affordance.
  const isViewable = player.proId != null || player.playerLink != null;

  const identityContent = (
    <>
      <span
        className={`w-7 h-7 rounded-full bg-black/30 overflow-hidden flex items-center justify-center flex-shrink-0 ${
          isSelf ? "border-2 border-teal" : "border border-line opacity-80"
        }`}
        title={champName}
      >
        <IconWithFallback
          src={entry?.icon ?? ""}
          alt={champName}
          fallbackGlyph={champName}
          className="w-full h-full object-cover"
          size={28}
        />
      </span>
      {roleAbbr && (
        <span
          className="text-[8.5px] font-bold uppercase text-mut w-6 flex-shrink-0 text-center"
          aria-hidden="true"
        >
          {roleAbbr}
        </span>
      )}
      {displayName && (
        <span
          className={`text-[11px] truncate min-w-[36px] flex-1 ${
            isViewable
              ? "text-txt underline decoration-dotted decoration-mut/60 underline-offset-2 group-hover:text-teal group-hover:decoration-teal-dim"
              : "text-txt"
          }`}
          title={displayName}
        >
          {displayName}
        </span>
      )}
      {isViewable && (
        <span
          aria-hidden="true"
          className="text-[10px] text-mut flex-shrink-0 leading-none group-hover:text-teal transition-colors"
        >
          ›
        </span>
      )}
    </>
  );

  return (
    <div
      className={`flex items-center gap-1.5 flex-wrap rounded-lg px-1.5 py-1 ${
        isSelf ? "ring-1 ring-teal bg-teal/5" : ""
      }`}
    >
      {isViewable ? (
        <button
          type="button"
          onClick={() => {
            // Tracked pro wins when a row somehow has both (never happens in
            // practice — a tracked prostage entry's proId comes from the same
            // ingest that sets playerLink — but proId is the richer/queryable
            // identity, so prefer it defensively).
            if (player.proId != null) {
              onSelectPlayer?.({ id: player.proId, name: displayName ?? champName, team: null });
            } else if (player.playerLink != null) {
              onSelectPlayer?.({ playerLink: player.playerLink, name: displayName ?? champName });
            }
          }}
          aria-label={`View ${displayName ?? champName}'s games`}
          // Hit-slop via padding + equal negative margin (same technique as
          // the item-icon buttons below) — a few extra px of vertical tap
          // area without growing the row's visual footprint or jittering the
          // 5-row list. `group` drives the name/chevron hover color above.
          className="group flex items-center gap-1.5 min-w-0 flex-1 py-1.5 -my-1.5 rounded-md transition-transform active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal focus-visible:ring-offset-1 focus-visible:ring-offset-panel"
        >
          {identityContent}
        </button>
      ) : (
        <div className="flex items-center gap-1.5 min-w-0 flex-1">{identityContent}</div>
      )}
      <div className="flex items-center gap-1 flex-wrap justify-end flex-shrink-0 ml-auto">
        {player.items.map((id, i) => {
          const label = itemNames?.get(id) ?? `Item #${id}`;
          return (
            <button
              key={`${id}-${i}`}
              type="button"
              onClick={() => onItemClick(id)}
              aria-label={`View details for ${label}`}
              title={label}
              className="w-[23px] h-[23px] rounded-[5px] bg-black/30 border border-line overflow-hidden flex items-center justify-center flex-shrink-0 transition-transform active:scale-95 hover:border-teal-dim focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal focus-visible:ring-offset-1 focus-visible:ring-offset-panel"
            >
              <IconWithFallback src={itemIconUrl(id, ver)} alt={label} className="w-full h-full object-contain" size={23} />
            </button>
          );
        })}
        {player.trinket != null && (
          <button
            type="button"
            onClick={() => onItemClick(player.trinket as number)}
            aria-label={`View details for trinket ${itemNames?.get(player.trinket) ?? `#${player.trinket}`}`}
            title={itemNames?.get(player.trinket) ?? "Trinket"}
            className="w-[23px] h-[23px] rounded-full bg-black/30 border border-teal-dim overflow-hidden flex items-center justify-center flex-shrink-0 transition-transform active:scale-95 hover:border-teal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal focus-visible:ring-offset-1 focus-visible:ring-offset-panel"
          >
            <IconWithFallback
              src={itemIconUrl(player.trinket, ver)}
              alt={itemNames?.get(player.trinket) ?? "Trinket"}
              fallbackGlyph="Trinket"
              className="w-full h-full object-contain"
              size={23}
            />
          </button>
        )}
      </div>
    </div>
  );
}
