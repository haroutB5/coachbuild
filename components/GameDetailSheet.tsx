"use client";

import { Fragment, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import type { ProGame, ProGamePurchase } from "./proGames.types";
import { cleanPlayerName } from "./playerName";
import { matchupLabel } from "./teamCompDisplay";
import { stashPendingPlayerSelect, type PendingPlayerSelect } from "./playerSelectHandoff";
import {
  versionFromPatch,
  itemIconUrl,
  spellIconUrl,
  spellName,
  treeIconUrl,
  treeName,
  shardIconUrl,
  shardName,
  resolveRuneDisplay,
  CONSUMABLE_ITEM_IDS,
  type ResolvedRuneDisplay,
} from "./proAssets";
import {
  relativeTime,
  formatGameLength,
  formatMinuteStamp,
  kdaRatioText,
  WinLossPill,
  GAME_LANE_LABEL,
} from "./ProGameCard";
import { IconWithFallback } from "./IconWithFallback";
import { SheetTeamsSection } from "./TeamComp";
import ItemDetailPopover from "./ItemDetailPopover";
import EntityDetailPopover, { type EntityKind } from "./EntityDetailPopover";
import { getItemNameMap } from "./itemDetail";
import { buildSkillOrderGrid, SKILL_ROWS, SKILL_GRID_COLUMNS, type SkillLetter } from "./skillOrderGrid";
import { useProstageTimeline } from "./prostageTimeline";
import { trapTabKey } from "./focusTrap";

// Delay before actually unmounting after close — must be >= the longest
// `duration-*` class used on the backdrop/panel exit transition below (150ms
// currently), with a small safety margin so the CSS transition always
// finishes before the node leaves the DOM.
const EXIT_MS = 200;

interface GameDetailSheetProps {
  game: ProGame;
  championIcon?: string;
  championDisplayName?: string;
  open: boolean;
  onClose: () => void;
  /** Same-page fast path for the Teams-box "view this player's games" tap —
   *  supplied by /history (which owns the mode/player state directly and can
   *  just call this instead of navigating). When absent (this sheet is
   *  mounted from the Builds page's ProGamesSection instead), the tap falls
   *  back to stashing the pick + a real `router.push("/history")` — see
   *  playerSelectHandoff.ts. */
  onSelectPlayer?: (player: PendingPlayerSelect) => void;
}

/** Rune perk tile with a visible name label (not just an icon + tooltip) —
 *  the detail sheet wants runes "in detail", unlike the dense card row's
 *  icon-only treatment. Shares the same module-level cached fetch as
 *  ProGameCard's RunePerkIcon (proAssets.resolveRuneDisplay). */
function RunePerkTile({
  runeId,
  ver,
  size,
  onOpenDetail,
}: {
  runeId: number;
  ver: string;
  size: "lg" | "sm";
  onOpenDetail: (kind: EntityKind, id: number) => void;
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

  const dim = size === "lg" ? "w-14 h-14" : "w-9 h-9";
  const ring =
    size === "lg"
      ? "border-2 border-teal shadow-[0_0_12px_rgba(130,219,247,0.35)]"
      : "border border-line";
  const label = rune ? rune.name : `Rune #${runeId}`;

  return (
    <button
      type="button"
      onClick={() => onOpenDetail("rune", runeId)}
      aria-label={`View details for rune ${label}`}
      className="flex flex-col items-center gap-1 w-16 flex-shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal focus-visible:ring-offset-2 focus-visible:ring-offset-panel rounded-md active:scale-95 transition-transform"
    >
      <div
        className={`${dim} ${ring} rounded-full bg-black/30 overflow-hidden flex items-center justify-center flex-shrink-0`}
      >
        <IconWithFallback src={rune?.icon ?? ""} alt={label} fallbackGlyph={label} className="w-full h-full object-contain" />
      </div>
      <span className="text-[9.5px] text-mut text-center leading-tight line-clamp-2">{label}</span>
    </button>
  );
}

function TreeTile({ treeId, size }: { treeId: number; size: "lg" | "sm" }) {
  const dim = size === "lg" ? "w-10 h-10" : "w-8 h-8";
  return (
    <div className="flex flex-col items-center gap-1 w-16 flex-shrink-0">
      <div className={`${dim} rounded-full bg-black/30 border border-line overflow-hidden flex items-center justify-center flex-shrink-0`}>
        <IconWithFallback
          src={treeIconUrl(treeId)}
          alt={treeName(treeId)}
          fallbackGlyph={treeName(treeId)}
          className="w-full h-full object-contain p-1.5"
        />
      </div>
      <span className="text-[9.5px] text-teal text-center leading-tight">{treeName(treeId)}</span>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <p className="text-[10.5px] tracking-[1px] uppercase text-teal font-bold mb-2.5">{children}</p>;
}

/** Real item name when the sheet's batch name-map fetch (getItemNameMap) has
 *  resolved; degrades to the id form when it hasn't (or failed) — runes/
 *  spells/shards already announce real names via proAssets, this is the item
 *  buttons' equivalent (P3 a11y fix — "item #3152" was the only remaining
 *  id-only accessible name in the sheet). */
function itemLabelFrom(names: Map<number, string> | null, id: number): string {
  return names?.get(id) ?? `Item #${id}`;
}

/** One Q/W/E/R row of the skill-order grid: a label cell + SKILL_GRID_COLUMNS
 *  level cells, emitted as a `Fragment` (no wrapper element) so they land as
 *  direct children of the parent `grid` and CSS Grid's row-major auto-flow
 *  places them correctly — a wrapper div here would break into its own grid
 *  item instead of 19 individual cells. */
function SkillGridRow({ letter, levels }: { letter: SkillLetter; levels: (number | null)[] }) {
  const isUlt = letter === "R";
  return (
    <Fragment>
      <div
        className={`flex items-center justify-center text-[10px] font-bold ${isUlt ? "text-teal" : "text-mut"}`}
      >
        {letter}
      </div>
      {levels.map((level, ci) => (
        <div
          key={ci}
          className={`aspect-square min-w-0 rounded-[3px] flex items-center justify-center text-[8px] font-bold tabular-nums leading-none ${
            level
              ? isUlt
                ? // Ult (R) row — the vivid, solid-fill treatment. Deliberately
                  // the brightest cell on the grid; Q/W/E below stay one step
                  // down so R still reads as "the hero ability."
                  "bg-teal text-bg"
                : // Q/W/E filled cells — bg-panel2 (#202329) here was only
                  // ~1.07:1 against the sheet's own bg-panel (#1a1d21), i.e.
                  // functionally invisible as a "filled" indicator even
                  // though the number text inside it was legible. Swapped to
                  // a translucent teal-dim tint + solid teal-dim border: a
                  // real hue shift (not just a lightness bump) reads as
                  // clearly "filled" against the neutral sheet bg, while
                  // staying visually one step down from R's solid fill.
                  "bg-teal-dim/25 border border-teal-dim text-teal-hover"
              : "bg-black/10 border border-line/30"
          }`}
        >
          {level ?? ""}
        </div>
      ))}
    </Fragment>
  );
}

/** Purchases bucketed by in-game minute — consecutive buys in the same
 *  minute render as one group with a single minute label, so the timeline
 *  reads as "what did they buy at minute N" rather than a flat list. */
function groupByMinute(purchases: ProGamePurchase[]): { minute: number; items: ProGamePurchase[] }[] {
  const groups: { minute: number; items: ProGamePurchase[] }[] = [];
  for (const p of purchases) {
    const minute = Math.floor(p.ts / 60);
    const last = groups[groups.length - 1];
    if (last && last.minute === minute) {
      last.items.push(p);
    } else {
      groups.push({ minute, items: [p] });
    }
  }
  return groups;
}

/** The minute-grouped, wrapping item-purchase timeline — the SAME component
 *  path for soloq (fed `game.purchaseOrder` directly) and prostage (fed the
 *  fetched timeline once `/api/prostage/timeline` resolves `status: "ok"`).
 *  Owns the consumables filter + minute bucketing; the hide-consumables
 *  checkbox state itself lives in the parent sheet (one toggle, shared by
 *  whichever source is active for a given game). */
function ItemBuildOrderSection({
  purchases,
  ver,
  itemNames,
  hideConsumables,
  onToggleHideConsumables,
  onItemClick,
}: {
  purchases: ProGamePurchase[];
  ver: string;
  itemNames: Map<number, string> | null;
  hideConsumables: boolean;
  onToggleHideConsumables: (v: boolean) => void;
  onItemClick: (id: number) => void;
}) {
  const timeline = hideConsumables ? purchases.filter((p) => !CONSUMABLE_ITEM_IDS.has(p.itemId)) : purchases;
  const minuteGroups = groupByMinute(timeline);

  return (
    <section className="mb-6">
      <div className="flex items-center justify-between mb-2.5">
        <SectionLabel>Item Build Order</SectionLabel>
        <label className="flex items-center gap-1.5 text-[10.5px] text-mut cursor-pointer select-none -mt-2.5">
          <input
            type="checkbox"
            checked={hideConsumables}
            onChange={(e) => onToggleHideConsumables(e.target.checked)}
            className="accent-teal w-3 h-3"
          />
          Hide consumables
        </label>
      </div>
      {minuteGroups.length === 0 ? (
        <p className="text-[11px] text-mut py-2">No items to show.</p>
      ) : (
        // Groups flow with wrapping — the sheet scrolls vertically only,
        // never horizontally. Each group is a single self-contained flex
        // item (label + its items + its own trailing separator glyph) so
        // wrapping never splits a label away from its items, and the "·"
        // divider (the same glyph the header stat-line above already uses
        // between stats) never ends up orphaned at the start of a wrapped
        // row. No card chrome (bg/border) per group — density over
        // decoration, ~half the vertical footprint of the old bordered-card
        // treatment.
        <div className="flex flex-wrap items-start gap-x-1 gap-y-2.5">
          {minuteGroups.map((g, gi) => (
            <div key={`${g.minute}-${gi}`} className="flex items-center">
              <div className="flex flex-col items-start gap-0.5">
                <span className="text-[9px] text-mut/80 tabular-nums leading-none">{g.minute}&apos;</span>
                <div className="flex items-center gap-1.5">
                  {g.items.map((p, i) => {
                    const label = itemLabelFrom(itemNames, p.itemId);
                    return (
                      <button
                        key={`${p.itemId}-${p.ts}-${i}`}
                        type="button"
                        onClick={() => onItemClick(p.itemId)}
                        aria-label={`View details for ${label}, bought at ${formatMinuteStamp(p.ts)}`}
                        title={`${label} — ${formatMinuteStamp(p.ts)}`}
                        // Hit-slop via padding + equal negative margin (same
                        // technique as matchday's PlayerInsightPanel ItemTile):
                        // the visible icon shrinks to 28px for density, but the
                        // actual tap target stays a few px larger on each side
                        // without pushing neighboring icons apart.
                        className="p-[3px] -m-[3px] flex-shrink-0 rounded-[8px] block leading-none transition-transform active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal focus-visible:ring-offset-2 focus-visible:ring-offset-panel"
                      >
                        <span className="w-7 h-7 rounded-md bg-black/30 border border-line overflow-hidden flex items-center justify-center transition-colors hover:border-teal-dim">
                          <IconWithFallback src={itemIconUrl(p.itemId, ver)} alt={label} className="w-full h-full object-contain" />
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
              {gi < minuteGroups.length - 1 && (
                <span aria-hidden="true" className="text-mut/40 text-[11px] px-1.5 self-center">
                  ·
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/** Loading placeholder for the prostage build-order fetch — sized to match
 *  ItemBuildOrderSection's real minute-group layout (same w-7 h-7 icon
 *  slots, same label height) so resolving the fetch never shifts layout
 *  (CLS). */
function ItemBuildOrderSkeleton() {
  return (
    <div className="flex flex-wrap items-start gap-x-1 gap-y-2.5" aria-hidden="true">
      {[0, 1, 2].map((gi) => (
        <div key={gi} className="flex flex-col items-start gap-0.5">
          <span className="block h-[9px] w-4 rounded-sm bg-panel2 animate-pulse motion-reduce:animate-none" />
          <div className="flex items-center gap-1.5">
            {[0, 1].map((ii) => (
              <span
                key={ii}
                className="w-7 h-7 rounded-md bg-panel2 border border-line animate-pulse motion-reduce:animate-none"
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Pro-play item build order: fetches GET /api/prostage/timeline (via the
 *  useProstageTimeline hook, never throws) and renders one of: loading
 *  skeleton, the real ItemBuildOrderSection (same component soloq uses), or
 *  a muted fallback note. Skill order has no livestats source and is never
 *  shown for prostage — the note text below changes depending on whether the
 *  timeline itself came through. */
function ProstageBuildOrder({
  game,
  ver,
  itemNames,
  hideConsumables,
  onToggleHideConsumables,
  onItemClick,
}: {
  game: ProGame;
  ver: string;
  itemNames: Map<number, string> | null;
  hideConsumables: boolean;
  onToggleHideConsumables: (v: boolean) => void;
  onItemClick: (id: number) => void;
}) {
  const { state, retry } = useProstageTimeline(game.id, game.playerLink);

  if (state.status === "loading") {
    return (
      <section className="mb-6">
        <SectionLabel>Item Build Order</SectionLabel>
        <ItemBuildOrderSkeleton />
      </section>
    );
  }

  if (state.status === "ok") {
    return (
      <>
        <ItemBuildOrderSection
          purchases={state.purchaseOrder}
          ver={ver}
          itemNames={itemNames}
          hideConsumables={hideConsumables}
          onToggleHideConsumables={onToggleHideConsumables}
          onItemClick={onItemClick}
        />
        <p className="text-[11.5px] text-mut italic">Skill order detail isn&apos;t available for on-stage games.</p>
      </>
    );
  }

  if (state.status === "error") {
    return (
      <p className="text-[11.5px] text-mut italic">
        Couldn&apos;t load item build order.{" "}
        <button
          type="button"
          onClick={retry}
          className="underline hover:text-txt focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal rounded-sm"
        >
          Try again
        </button>
        . Skill order detail isn&apos;t available for on-stage games.
      </p>
    );
  }

  // state.status === "unavailable" (backend-permanent, or no player
  // identifier at all) — same combined note the sheet always showed for
  // prostage games before this feature existed.
  return (
    <p className="text-[11.5px] text-mut italic">
      Purchase and skill order detail isn&apos;t available for on-stage games.
    </p>
  );
}

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export default function GameDetailSheet({
  game,
  championIcon,
  championDisplayName,
  open,
  onClose,
  onSelectPlayer,
}: GameDetailSheetProps) {
  const router = useRouter();
  const [rendered, setRendered] = useState(false);
  const [visible, setVisible] = useState(false);
  const [hideConsumables, setHideConsumables] = useState(true);
  // Batch-resolved once per sheet-open (not once per button) via
  // itemDetail.ts's getItemNameMap — real item names for the FINAL BUILD /
  // ITEM BUILD ORDER buttons' aria-labels instead of "item #3152" (P3 a11y
  // fix). null until resolved (or on fetch failure); every read-site
  // degrades to the id form via itemLabelFrom rather than blocking render.
  const [itemNames, setItemNames] = useState<Map<number, string> | null>(null);
  // One unified "which detail popover is open" tracker for items, runes,
  // shards, AND summoner spells — `activeDetail` (null = closed) drives the
  // popover's `open` prop. `lastDetail` is deliberately NOT cleared on
  // close — the popover stays mounted through its own exit transition (same
  // decoupled rendered/visible pattern this sheet uses for itself), so it
  // needs a kind+id to keep showing while it fades out, not undefined. The
  // sheet's own item/rune/shard/spell tap buttons are all covered by the
  // backdrop while a popover is open, so `lastDetail.kind` can never change
  // mid-open — only one popover is ever live at a time.
  type DetailRef = { kind: "item" | EntityKind; id: number };
  const [activeDetail, setActiveDetail] = useState<DetailRef | null>(null);
  const [lastDetail, setLastDetail] = useState<DetailRef | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const triggerFocusRef = useRef<Element | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const ver = versionFromPatch(game.patch);
  // Local const (not the raw `game.trinket` property access) so TS's null
  // narrowing survives into the onClick closure below.
  const trinketId = game.trinket;
  const isProstage = game.source === "prostage";
  const hasFullRunes = game.runes.primary.length > 0 || game.runes.secondary.length > 0;
  const hasAnyRunes = game.runes.keystone > 0 || hasFullRunes || game.runes.shards.length > 0;

  const skillGrid = buildSkillOrderGrid(game.skillOrder);

  // Fetch the sheet's item name map only once it actually opens (this
  // component is always mounted per-card with `open` toggling visibility —
  // fetching on mount instead would kick off an item.json fetch for every
  // card on the page, not just the one the user taps). Keyed on `ver` too:
  // a stale name map from a previous patch's icon set would mislabel this
  // game's items.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    getItemNameMap(ver).then((names) => {
      if (!cancelled) setItemNames(names);
    });
    return () => {
      cancelled = true;
    };
  }, [open, ver]);

  function openDetail(kind: "item" | EntityKind, id: number) {
    setLastDetail({ kind, id });
    setActiveDetail({ kind, id });
  }
  function openItemPopover(id: number) {
    openDetail("item", id);
  }
  function closeDetail() {
    setActiveDetail(null);
  }

  /** Teams-box row tap ("view this player's games"). Always closes this
   *  sheet first, then either hands off to the parent's same-page callback
   *  or stashes + navigates cross-page — see the `onSelectPlayer` prop doc. */
  function handleSelectPlayer(player: PendingPlayerSelect) {
    onClose();
    if (onSelectPlayer) {
      onSelectPlayer(player);
    } else {
      stashPendingPlayerSelect(player);
      router.push("/history");
    }
  }

  // Mount/unmount is decoupled from `open` so the exit transition can
  // actually play before the sheet leaves the DOM.
  useEffect(() => {
    if (open) {
      triggerFocusRef.current = document.activeElement;
      setRendered(true);
      const raf = requestAnimationFrame(() => setVisible(true));
      return () => cancelAnimationFrame(raf);
    }
    setVisible(false);
    const delay = prefersReducedMotion() ? 0 : EXIT_MS;
    const t = setTimeout(() => setRendered(false), delay);
    return () => clearTimeout(t);
  }, [open]);

  // Focus the close button on open; return focus to whatever triggered the
  // sheet (the card) once it's fully gone.
  useEffect(() => {
    if (open) {
      const t = setTimeout(() => closeButtonRef.current?.focus(), 0);
      return () => clearTimeout(t);
    }
    if (!rendered && triggerFocusRef.current instanceof HTMLElement) {
      triggerFocusRef.current.focus();
    }
  }, [open, rendered]);

  // Lock body scroll + compensate for the vanished scrollbar so the page
  // behind doesn't shift width while the sheet is up. Plain
  // `overflow:hidden` on body does NOT stop iOS Safari's rubber-band scroll
  // from bleeding the page behind through underneath the sheet (verified on
  // device) — the standard fix is pinning body to `position:fixed` at its
  // current scroll offset, then restoring both the inline styles AND the
  // scroll position on cleanup.
  useEffect(() => {
    if (!rendered) return;
    const scrollY = window.scrollY;
    const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;
    const body = document.body;
    const prev = {
      position: body.style.position,
      top: body.style.top,
      left: body.style.left,
      right: body.style.right,
      width: body.style.width,
      overflow: body.style.overflow,
      paddingRight: body.style.paddingRight,
    };
    body.style.position = "fixed";
    body.style.top = `-${scrollY}px`;
    body.style.left = "0";
    body.style.right = "0";
    body.style.width = "100%";
    body.style.overflow = "hidden";
    if (scrollbarWidth > 0) body.style.paddingRight = `${scrollbarWidth}px`;
    return () => {
      body.style.position = prev.position;
      body.style.top = prev.top;
      body.style.left = prev.left;
      body.style.right = prev.right;
      body.style.width = prev.width;
      body.style.overflow = prev.overflow;
      body.style.paddingRight = prev.paddingRight;
      window.scrollTo(0, scrollY);
    };
  }, [rendered]);

  useEffect(() => {
    if (!rendered) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        // First Escape closes whichever detail popover is open (item, rune,
        // shard, or spell); second press (popover already gone) closes the
        // sheet itself.
        if (activeDetail !== null) {
          closeDetail();
          return;
        }
        onClose();
        return;
      }
      // Tab trap for the sheet's own dialog — only while no popover is on
      // top of it; a popover open traps Tab within ITSELF instead (see
      // DetailPopover's own listener), so the sheet stays out of the way.
      if (e.key === "Tab" && activeDetail === null && panelRef.current) {
        trapTabKey(panelRef.current, e);
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [rendered, onClose, activeDetail]);

  if (!rendered || typeof document === "undefined") return null;

  const cleanedPlayerName = cleanPlayerName(game.player.name);
  // "LYON vs HLE" — only when both cleaned team names resolved; null on
  // soloq or a not-yet-backfilled prostage row degrades to the pre-existing
  // Pro Play badge + tournament line, unchanged.
  const matchup = matchupLabel(game.allyTeamName, game.enemyTeamName);

  const accountLine = isProstage ? (
    <span className="inline-flex items-center gap-1.5 flex-wrap">
      <span className="inline-flex items-center px-1.5 py-[1px] rounded text-[9px] font-bold uppercase tracking-[0.5px] bg-gold/15 text-gold border border-gold/30">
        Pro Play
      </span>
      {matchup && <span className="text-txt font-semibold">{matchup}</span>}
      {matchup && game.tournament && <span aria-hidden="true" className="text-mut/50">·</span>}
      {game.tournament && <span className="text-mut">{game.tournament}</span>}
    </span>
  ) : (
    <span className="text-mut tabular-nums">{game.account.riotId || game.account.region}</span>
  );

  return createPortal(
    <div className="fixed inset-0 z-[100]" role="presentation">
      {/* Backdrop */}
      <div
        onClick={onClose}
        aria-hidden="true"
        className={`absolute inset-0 bg-black/70 backdrop-blur-sm transition-opacity motion-reduce:transition-none ${
          visible ? "opacity-100 duration-200 ease-[cubic-bezier(0.2,0,0,1)]" : "opacity-0 duration-150 ease-[cubic-bezier(0.3,0,0.8,0.15)]"
        }`}
      />

      {/* Panel — full-screen sheet on mobile, centered modal on desktop */}
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={`Game detail — ${championDisplayName ?? game.championName}, ${cleanedPlayerName ?? game.player.name}`}
        className={`absolute inset-0 sm:inset-auto sm:top-1/2 sm:left-1/2 sm:-translate-x-1/2 sm:w-full sm:max-w-2xl sm:max-h-[85vh] sm:rounded-2xl flex flex-col bg-panel border-0 sm:border sm:border-line shadow-[0_20px_60px_rgba(0,0,0,0.6)] transition-[opacity,transform] motion-reduce:transition-none ${
          visible
            ? "opacity-100 translate-y-0 sm:-translate-y-1/2 duration-200 ease-[cubic-bezier(0.16,1,0.3,1)]"
            : "opacity-0 translate-y-3 sm:translate-y-[calc(-50%+12px)] duration-150 ease-[cubic-bezier(0.3,0,0.8,0.15)]"
        }`}
      >
        {/* Header */}
        <div className="flex items-start gap-3 px-5 pt-5 pb-4 border-b border-line flex-shrink-0">
          {championIcon && (
            <span className="w-12 h-12 rounded-full bg-black/30 border border-line overflow-hidden flex items-center justify-center flex-shrink-0">
              <IconWithFallback
                src={championIcon}
                alt={championDisplayName ?? game.championName}
                fallbackGlyph={championDisplayName ?? game.championName}
                className="w-full h-full object-cover"
              />
            </span>
          )}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-base font-bold text-txt truncate">
                {championDisplayName ?? game.championName}
              </h2>
              <WinLossPill win={game.win} />
            </div>
            <p className="text-[13px] text-txt mt-0.5 truncate">
              {cleanedPlayerName ?? game.player.name}
              {game.player.team && <span className="text-mut"> — {game.player.team}</span>}
            </p>
            <div className="flex items-center gap-1.5 flex-wrap text-[11px] text-mut mt-1.5">
              <span className="font-semibold text-txt tabular-nums">
                {game.kills}/{game.deaths}/{game.assists}
              </span>
              <span className="tabular-nums">{kdaRatioText(game.kills, game.deaths, game.assists)}</span>
              {GAME_LANE_LABEL[game.role] && (
                <>
                  <span aria-hidden="true">·</span>
                  <span>{GAME_LANE_LABEL[game.role]}</span>
                </>
              )}
              {game.patch && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="tabular-nums">{game.patch}</span>
                </>
              )}
              {game.gameDurationSec > 0 && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="tabular-nums">{formatGameLength(game.gameDurationSec)}</span>
                </>
              )}
              <span aria-hidden="true">·</span>
              <span className="tabular-nums">{relativeTime(game.gameCreation)}</span>
            </div>
            <div className="mt-1 text-[11px]">{accountLine}</div>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            onClick={onClose}
            aria-label="Close game detail"
            className="flex items-center justify-center w-8 h-8 rounded-md text-mut hover:text-txt hover:bg-panel2 transition-colors active:scale-95 flex-shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal focus-visible:ring-offset-2 focus-visible:ring-offset-panel"
          >
            <span aria-hidden="true" className="text-lg leading-none">
              ×
            </span>
          </button>
        </div>

        {/* Scrollable body */}
        <div className="overflow-y-auto px-5 py-4 flex-1">
          {/* Teams — ally/enemy comps, right after the header since it's
              read-only context for the whole game (same reading order
              dpm.lol uses). Renders nothing until backfilled. */}
          <SheetTeamsSection
            allyChampionIds={game.allyChampionIds}
            enemyChampionIds={game.enemyChampionIds}
            allyPlayers={game.allyPlayers}
            enemyPlayers={game.enemyPlayers}
            selfChampionId={game.championId}
            win={game.win}
            trackedPlayerTeam={game.player.team}
            allyTeamName={game.allyTeamName}
            enemyTeamName={game.enemyTeamName}
            ver={ver}
            itemNames={itemNames}
            onItemClick={openItemPopover}
            onSelectPlayer={handleSelectPlayer}
          />

          {/* Runes */}
          {hasAnyRunes && (
            <section className="mb-6">
              <SectionLabel>Runes</SectionLabel>
              <div className="flex items-start gap-4 flex-wrap">
                {game.runes.keystone > 0 && (
                  <div className="flex items-start gap-2">
                    <RunePerkTile runeId={game.runes.keystone} ver={ver} size="lg" onOpenDetail={openDetail} />
                    {game.runes.primary.length > 0 && (
                      <div className="flex items-start gap-2 pt-1">
                        {game.runes.primary.map((id, i) => (
                          <RunePerkTile key={`p-${id}-${i}`} runeId={id} ver={ver} size="sm" onOpenDetail={openDetail} />
                        ))}
                      </div>
                    )}
                  </div>
                )}
                {(game.runes.secondaryTree > 0 || game.runes.secondary.length > 0) && (
                  <div className="flex items-start gap-2">
                    <TreeTile treeId={game.runes.secondaryTree} size="sm" />
                    {game.runes.secondary.map((id, i) => (
                      <RunePerkTile key={`s-${id}-${i}`} runeId={id} ver={ver} size="sm" onOpenDetail={openDetail} />
                    ))}
                  </div>
                )}
                {game.runes.shards.length > 0 && (
                  <div className="flex items-start gap-2">
                    {game.runes.shards.map((id, i) => (
                      <button
                        key={`shard-${id}-${i}`}
                        type="button"
                        onClick={() => openDetail("shard", id)}
                        aria-label={`View details for stat shard ${shardName(id)}`}
                        className="flex flex-col items-center gap-1 w-16 flex-shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal focus-visible:ring-offset-2 focus-visible:ring-offset-panel rounded-md active:scale-95 transition-transform"
                      >
                        <div className="w-7 h-7 rounded-full bg-black/30 border border-line overflow-hidden flex items-center justify-center flex-shrink-0">
                          <IconWithFallback
                            src={shardIconUrl(id)}
                            alt={shardName(id)}
                            fallbackGlyph={shardName(id)}
                            className="w-full h-full object-contain p-1"
                          />
                        </div>
                        <span className="text-[9.5px] text-mut text-center leading-tight">{shardName(id)}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </section>
          )}

          {/* Summoner spells */}
          {game.spells.some(Boolean) && (
            <section className="mb-6">
              <SectionLabel>Summoner Spells</SectionLabel>
              <div className="flex items-center gap-4">
                {game.spells.map(
                  (id, i) =>
                    id > 0 && (
                      <button
                        key={`spell-${id}-${i}`}
                        type="button"
                        onClick={() => openDetail("spell", id)}
                        aria-label={`View details for summoner spell ${spellName(id)}`}
                        className="flex flex-col items-center gap-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal focus-visible:ring-offset-2 focus-visible:ring-offset-panel rounded-md active:scale-95 transition-transform"
                      >
                        <div className="w-10 h-10 rounded-[8px] bg-black/30 border border-line overflow-hidden flex items-center justify-center flex-shrink-0">
                          <IconWithFallback
                            src={spellIconUrl(id, ver)}
                            alt={spellName(id)}
                            fallbackGlyph={spellName(id)}
                            className="w-full h-full object-contain"
                          />
                        </div>
                        <span className="text-[10px] text-mut">{spellName(id)}</span>
                      </button>
                    )
                )}
              </div>
            </section>
          )}

          {/* Final build */}
          <section className="mb-6">
            <SectionLabel>Final Build</SectionLabel>
            <div className="flex items-center gap-2 flex-wrap">
              {game.finalItems.map((id, i) => {
                const label = itemLabelFrom(itemNames, id);
                return (
                  <button
                    key={`item-${id}-${i}`}
                    type="button"
                    onClick={() => openItemPopover(id)}
                    aria-label={`View details for ${label}`}
                    title={label}
                    className="w-11 h-11 rounded-lg bg-black/30 border border-line overflow-hidden flex items-center justify-center flex-shrink-0 transition-transform hover:border-teal-dim active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal focus-visible:ring-offset-2 focus-visible:ring-offset-panel"
                  >
                    <IconWithFallback src={itemIconUrl(id, ver)} alt={label} className="w-full h-full object-contain" />
                  </button>
                );
              })}
              {trinketId && (
                <button
                  type="button"
                  onClick={() => openItemPopover(trinketId)}
                  aria-label={`View details for trinket ${itemNames?.get(trinketId) ?? `#${trinketId}`}`}
                  title={itemNames?.get(trinketId) ?? "Trinket"}
                  className="w-11 h-11 rounded-full bg-black/30 border border-teal-dim overflow-hidden flex items-center justify-center flex-shrink-0 transition-transform hover:border-teal active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal focus-visible:ring-offset-2 focus-visible:ring-offset-panel"
                >
                  <IconWithFallback
                    src={itemIconUrl(trinketId, ver)}
                    alt={itemNames?.get(trinketId) ?? "Trinket"}
                    fallbackGlyph="Trinket"
                    className="w-full h-full object-contain"
                  />
                </button>
              )}
            </div>
          </section>

          {isProstage ? (
            <ProstageBuildOrder
              game={game}
              ver={ver}
              itemNames={itemNames}
              hideConsumables={hideConsumables}
              onToggleHideConsumables={setHideConsumables}
              onItemClick={openItemPopover}
            />
          ) : (
            <>
              <ItemBuildOrderSection
                purchases={game.purchaseOrder}
                ver={ver}
                itemNames={itemNames}
                hideConsumables={hideConsumables}
                onToggleHideConsumables={setHideConsumables}
                onItemClick={openItemPopover}
              />

              {/* Skill order — classic per-ability Q/W/E/R rows × 18 level
                  columns. Fixed to a CSS grid with `fr` cell columns (not
                  fixed pixel widths) so all 18 columns always fit the
                  sheet's width with zero horizontal scroll, down to 390px. */}
              {game.skillOrder.length > 0 && (
                <section>
                  <SectionLabel>Skill Order</SectionLabel>
                  <div
                    className="grid gap-[3px]"
                    style={{ gridTemplateColumns: `18px repeat(${SKILL_GRID_COLUMNS}, minmax(0, 1fr))` }}
                  >
                    {SKILL_ROWS.map((letter, ri) => (
                      <SkillGridRow key={letter} letter={letter} levels={skillGrid[ri]} />
                    ))}
                  </div>
                </section>
              )}
            </>
          )}
        </div>
      </div>

      {/* Always mounted (once any item/rune/shard/spell has ever been
          opened) so its own rendered/visible exit transition — same
          decoupled pattern as this sheet's own — gets to play out on close
          instead of being yanked from the tree mid-fade. `lastDetail`
          intentionally persists across close; only `open` toggles. */}
      {lastDetail && lastDetail.kind === "item" && (
        <ItemDetailPopover itemId={lastDetail.id} ver={ver} open={activeDetail !== null} onClose={closeDetail} />
      )}
      {lastDetail && lastDetail.kind !== "item" && (
        <EntityDetailPopover
          kind={lastDetail.kind}
          id={lastDetail.id}
          ver={ver}
          open={activeDetail !== null}
          onClose={closeDetail}
        />
      )}
    </div>,
    document.body
  );
}
