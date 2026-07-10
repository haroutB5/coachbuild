"use client";

import { Fragment, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ProGame, ProGamePurchase } from "./proGames.types";
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
  ImgWithFallback,
  relativeTime,
  formatGameLength,
  formatMinuteStamp,
  kdaRatioText,
  WinLossPill,
  GAME_LANE_LABEL,
} from "./ProGameCard";
import ItemDetailPopover from "./ItemDetailPopover";
import { buildSkillOrderGrid, SKILL_ROWS, SKILL_GRID_COLUMNS, type SkillLetter } from "./skillOrderGrid";

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
}

/** Rune perk tile with a visible name label (not just an icon + tooltip) —
 *  the detail sheet wants runes "in detail", unlike the dense card row's
 *  icon-only treatment. Shares the same module-level cached fetch as
 *  ProGameCard's RunePerkIcon (proAssets.resolveRuneDisplay). */
function RunePerkTile({
  runeId,
  ver,
  size,
}: {
  runeId: number;
  ver: string;
  size: "lg" | "sm";
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
    <div className="flex flex-col items-center gap-1 w-16 flex-shrink-0">
      <div
        className={`${dim} ${ring} rounded-full bg-black/30 overflow-hidden flex items-center justify-center flex-shrink-0`}
      >
        <ImgWithFallback src={rune?.icon ?? ""} alt={label} className="w-full h-full object-contain" />
      </div>
      <span className="text-[9.5px] text-mut text-center leading-tight line-clamp-2">{label}</span>
    </div>
  );
}

function TreeTile({ treeId, size }: { treeId: number; size: "lg" | "sm" }) {
  const dim = size === "lg" ? "w-10 h-10" : "w-8 h-8";
  return (
    <div className="flex flex-col items-center gap-1 w-16 flex-shrink-0">
      <div className={`${dim} rounded-full bg-black/30 border border-line overflow-hidden flex items-center justify-center flex-shrink-0`}>
        <ImgWithFallback src={treeIconUrl(treeId)} alt={treeName(treeId)} className="w-full h-full object-contain p-1.5" />
      </div>
      <span className="text-[9.5px] text-teal text-center leading-tight">{treeName(treeId)}</span>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <p className="text-[10.5px] tracking-[1px] uppercase text-teal font-bold mb-2.5">{children}</p>;
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
                ? "bg-teal text-bg"
                : "bg-panel2 border border-line text-txt"
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
}: GameDetailSheetProps) {
  const [rendered, setRendered] = useState(false);
  const [visible, setVisible] = useState(false);
  const [hideConsumables, setHideConsumables] = useState(true);
  // `activeItemId` (null = closed) drives the popover's `open` prop.
  // `lastItemId` is deliberately NOT cleared on close — ItemDetailPopover
  // stays mounted through its own exit transition (same decoupled
  // rendered/visible pattern this sheet uses for itself), so it needs an
  // itemId to keep showing while it fades out, not undefined.
  const [activeItemId, setActiveItemId] = useState<number | null>(null);
  const [lastItemId, setLastItemId] = useState<number>(0);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const triggerFocusRef = useRef<Element | null>(null);

  const ver = versionFromPatch(game.patch);
  // Local const (not the raw `game.trinket` property access) so TS's null
  // narrowing survives into the onClick closure below.
  const trinketId = game.trinket;
  const isProstage = game.source === "prostage";
  const hasFullRunes = game.runes.primary.length > 0 || game.runes.secondary.length > 0;
  const hasAnyRunes = game.runes.keystone > 0 || hasFullRunes || game.runes.shards.length > 0;

  const timeline = hideConsumables
    ? game.purchaseOrder.filter((p) => !CONSUMABLE_ITEM_IDS.has(p.itemId))
    : game.purchaseOrder;
  const minuteGroups = groupByMinute(timeline);
  const skillGrid = buildSkillOrderGrid(game.skillOrder);

  function openItemPopover(id: number) {
    setLastItemId(id);
    setActiveItemId(id);
  }
  function closeItemPopover() {
    setActiveItemId(null);
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
  // behind doesn't shift width while the sheet is up.
  useEffect(() => {
    if (!rendered) return;
    const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;
    const prevOverflow = document.body.style.overflow;
    const prevPaddingRight = document.body.style.paddingRight;
    document.body.style.overflow = "hidden";
    if (scrollbarWidth > 0) document.body.style.paddingRight = `${scrollbarWidth}px`;
    return () => {
      document.body.style.overflow = prevOverflow;
      document.body.style.paddingRight = prevPaddingRight;
    };
  }, [rendered]);

  useEffect(() => {
    if (!rendered) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      // First Escape closes the item popover only (if open); second press
      // (popover already gone) closes the sheet itself.
      if (activeItemId !== null) {
        closeItemPopover();
        return;
      }
      onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [rendered, onClose, activeItemId]);

  if (!rendered || typeof document === "undefined") return null;

  const accountLine = isProstage ? (
    <span className="inline-flex items-center gap-1.5">
      <span className="inline-flex items-center px-1.5 py-[1px] rounded text-[9px] font-bold uppercase tracking-[0.5px] bg-gold/15 text-gold border border-gold/30">
        Pro Play
      </span>
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
        role="dialog"
        aria-modal="true"
        aria-label={`Game detail — ${championDisplayName ?? game.championName}, ${game.player.name}`}
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
              <ImgWithFallback
                src={championIcon}
                alt={championDisplayName ?? game.championName}
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
              {game.player.name}
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
          {/* Runes */}
          {hasAnyRunes && (
            <section className="mb-6">
              <SectionLabel>Runes</SectionLabel>
              <div className="flex items-start gap-4 flex-wrap">
                {game.runes.keystone > 0 && (
                  <div className="flex items-start gap-2">
                    <RunePerkTile runeId={game.runes.keystone} ver={ver} size="lg" />
                    {game.runes.primary.length > 0 && (
                      <div className="flex items-start gap-2 pt-1">
                        {game.runes.primary.map((id, i) => (
                          <RunePerkTile key={`p-${id}-${i}`} runeId={id} ver={ver} size="sm" />
                        ))}
                      </div>
                    )}
                  </div>
                )}
                {(game.runes.secondaryTree > 0 || game.runes.secondary.length > 0) && (
                  <div className="flex items-start gap-2">
                    <TreeTile treeId={game.runes.secondaryTree} size="sm" />
                    {game.runes.secondary.map((id, i) => (
                      <RunePerkTile key={`s-${id}-${i}`} runeId={id} ver={ver} size="sm" />
                    ))}
                  </div>
                )}
                {game.runes.shards.length > 0 && (
                  <div className="flex items-start gap-2">
                    {game.runes.shards.map((id, i) => (
                      <div key={`shard-${id}-${i}`} className="flex flex-col items-center gap-1 w-16 flex-shrink-0">
                        <div className="w-7 h-7 rounded-full bg-black/30 border border-line overflow-hidden flex items-center justify-center flex-shrink-0">
                          <ImgWithFallback src={shardIconUrl(id)} alt={shardName(id)} className="w-full h-full object-contain p-1" />
                        </div>
                        <span className="text-[9.5px] text-mut text-center leading-tight">{shardName(id)}</span>
                      </div>
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
                      <div key={`spell-${id}-${i}`} className="flex flex-col items-center gap-1">
                        <div className="w-10 h-10 rounded-[8px] bg-black/30 border border-line overflow-hidden flex items-center justify-center flex-shrink-0">
                          <ImgWithFallback src={spellIconUrl(id, ver)} alt={spellName(id)} className="w-full h-full object-contain" />
                        </div>
                        <span className="text-[10px] text-mut">{spellName(id)}</span>
                      </div>
                    )
                )}
              </div>
            </section>
          )}

          {/* Final build */}
          <section className="mb-6">
            <SectionLabel>Final Build</SectionLabel>
            <div className="flex items-center gap-2 flex-wrap">
              {game.finalItems.map((id, i) => (
                <button
                  key={`item-${id}-${i}`}
                  type="button"
                  onClick={() => openItemPopover(id)}
                  aria-label={`View details for item #${id}`}
                  title={`Item #${id}`}
                  className="w-11 h-11 rounded-lg bg-black/30 border border-line overflow-hidden flex items-center justify-center flex-shrink-0 transition-transform hover:border-teal-dim active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal focus-visible:ring-offset-2 focus-visible:ring-offset-panel"
                >
                  <ImgWithFallback src={itemIconUrl(id, ver)} alt={`Item #${id}`} className="w-full h-full object-contain" />
                </button>
              ))}
              {trinketId && (
                <button
                  type="button"
                  onClick={() => openItemPopover(trinketId)}
                  aria-label={`View details for trinket #${trinketId}`}
                  title={`Trinket #${trinketId}`}
                  className="w-11 h-11 rounded-full bg-black/30 border border-teal-dim overflow-hidden flex items-center justify-center flex-shrink-0 transition-transform hover:border-teal active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal focus-visible:ring-offset-2 focus-visible:ring-offset-panel"
                >
                  <ImgWithFallback src={itemIconUrl(trinketId, ver)} alt="Trinket" className="w-full h-full object-contain" />
                </button>
              )}
            </div>
          </section>

          {isProstage ? (
            <p className="text-[11.5px] text-mut italic">
              Purchase and skill order detail isn&apos;t available for on-stage games.
            </p>
          ) : (
            <>
              {/* Item build order */}
              <section className="mb-6">
                <div className="flex items-center justify-between mb-2.5">
                  <SectionLabel>Item Build Order</SectionLabel>
                  <label className="flex items-center gap-1.5 text-[10.5px] text-mut cursor-pointer select-none -mt-2.5">
                    <input
                      type="checkbox"
                      checked={hideConsumables}
                      onChange={(e) => setHideConsumables(e.target.checked)}
                      className="accent-teal w-3 h-3"
                    />
                    Hide consumables
                  </label>
                </div>
                {minuteGroups.length === 0 ? (
                  <p className="text-[11px] text-mut py-2">No items to show.</p>
                ) : (
                  // Groups flow with wrapping — the sheet scrolls vertically
                  // only, never horizontally. Each group is a single
                  // self-contained flex item (label + its items + its own
                  // hairline border) so wrapping never splits a label away
                  // from its items, and the group separator still reads
                  // cleanly no matter where a row break lands.
                  <div className="flex flex-wrap gap-2.5">
                    {minuteGroups.map((g, gi) => (
                      <div
                        key={`${g.minute}-${gi}`}
                        className="flex flex-col items-center gap-1 px-2 py-1.5 rounded-lg bg-black/15 border border-line/60"
                      >
                        <span className="text-[10px] text-mut tabular-nums">{g.minute}&apos;</span>
                        <div className="flex items-center gap-1.5">
                          {g.items.map((p, i) => (
                            <button
                              key={`${p.itemId}-${p.ts}-${i}`}
                              type="button"
                              onClick={() => openItemPopover(p.itemId)}
                              aria-label={`View details for item #${p.itemId}, bought at ${formatMinuteStamp(p.ts)}`}
                              title={`Item #${p.itemId} — ${formatMinuteStamp(p.ts)}`}
                              className="w-11 h-11 rounded-md bg-black/30 border border-line overflow-hidden flex items-center justify-center flex-shrink-0 transition-transform hover:border-teal-dim active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal focus-visible:ring-offset-2 focus-visible:ring-offset-panel"
                            >
                              <ImgWithFallback src={itemIconUrl(p.itemId, ver)} alt={`Item #${p.itemId}`} className="w-full h-full object-contain" />
                            </button>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>

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

      {/* Always mounted (once an item has ever been opened) so its own
          rendered/visible exit transition — same decoupled pattern as this
          sheet's own — gets to play out on close instead of being yanked
          from the tree mid-fade. `lastItemId` intentionally persists across
          close; only `open` toggles. */}
      {lastItemId !== 0 && (
        <ItemDetailPopover
          itemId={lastItemId}
          ver={ver}
          open={activeItemId !== null}
          onClose={closeItemPopover}
        />
      )}
    </div>,
    document.body
  );
}
