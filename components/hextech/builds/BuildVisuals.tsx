"use client";

import { Fragment, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import {
  CaretRight,
  DownloadSimple,
  Info,
  Lightning,
  Sparkle,
} from "@phosphor-icons/react";
import type { BuildResponse, Pick as PickType } from "@/lib/types";
import type { EntityKind } from "@/components/EntityDetailPopover";
import { IconWithFallback } from "@/components/IconWithFallback";
import DetailPopover from "@/components/DetailPopover";
import type { AltKeystone } from "@/components/hextech/altKeystone";
import { resolveRuneDisplay, shardIconUrl, shardName, spellIconUrl, spellName, treeIconUrl, treeName } from "@/components/proAssets";
import { PERK_TREES, primaryMinorRow } from "../perkSlots";
import {
  buildRecommendedSkillGrid,
  fetchSkillOrder,
  formatPriorityString,
  hasDerivedTail,
  inferredTailRange,
  type SkillOrderModel,
} from "@/components/hextech/skillOrder";
import { SKILL_ROWS, type SkillGridCell } from "@/components/skillOrderGrid";
import type { LaneId } from "@/components/hextech/heroContracts";
import { LANE_TO_ROLE_ID } from "@/components/hextech/heroContracts";
import { buildRuneApplyBody } from "@/components/hextech/runeApplyBody";
import { applyRunes, getStoredPort, getStoredSession, hasSession } from "@/components/live/companionClient";

export const CARD_CLASS =
  "rounded-[9px] bg-[#1b1d2a] shadow-[inset_0_0_0_1px_rgba(233,233,237,0.08)]";

export const ACCENT_CARD_CLASS =
  "rounded-[9px] bg-[linear-gradient(145deg,rgba(58,54,99,0.42),rgba(27,29,42,0.96))] shadow-[inset_0_0_0_1px_rgba(145,132,217,0.24)]";

export function SectionLabel({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <p className={`text-[10px] font-semibold uppercase tracking-[0.14em] text-[#9397ab]/75 ${className}`}>
      {children}
    </p>
  );
}

export function Scanline({ className = "" }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={`pointer-events-none absolute inset-0 opacity-80 ${className}`}
      style={{ background: "repeating-linear-gradient(115deg, rgba(145,132,217,.05) 0 1px, transparent 1px 9px)" }}
    />
  );
}

export function Tile({
  pick,
  size = 50,
  onClick,
  accent = false,
  muted = false,
}: {
  pick: PickType;
  size?: number;
  onClick?: () => void;
  accent?: boolean;
  muted?: boolean;
}) {
  const className = `relative flex shrink-0 items-center justify-center overflow-hidden rounded-[8px] ${
    accent
      ? "bg-[linear-gradient(150deg,#3a3663,#20223a)] shadow-[inset_0_0_0_1px_rgba(145,132,217,0.45),0_0_22px_rgba(145,132,217,0.16)]"
      : "bg-[linear-gradient(150deg,#2b2e42,#1c1e2c)] shadow-[inset_0_0_0_1px_rgba(233,233,237,0.12)]"
  } ${muted ? "opacity-[.55]" : ""}`;
  const content = (
    <span className={className} style={{ width: size, height: size }}>
      <IconWithFallback
        src={pick.icon}
        alt={pick.name}
        fallbackGlyph={pick.name}
        className="h-full w-full object-cover"
        size={size}
      />
    </span>
  );

  if (!onClick) return content;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`View details for ${pick.name}`}
      className="rounded-[8px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#9184d9] focus-visible:ring-offset-2 focus-visible:ring-offset-[#1b1d2a]"
    >
      {content}
    </button>
  );
}

export function TierBadge({ tier = "S+" }: { tier?: string }) {
  const tone = tier === "S+" ? "bg-[#9184d9] text-[#191a28]" : tier === "S" ? "bg-[#9184d9]/35 text-[#d2cefd]" : tier === "A" ? "bg-[#9184d9]/20 text-[#b5abfc]" : "bg-white/[0.08] text-[#e9e9ed]/65";
  return (
    <span
      className={`inline-flex min-w-[28px] items-center justify-center rounded-[5px] px-2 py-1 text-[11px] font-semibold leading-none ${tone}`}
      style={{ clipPath: "polygon(0 0, 100% 0, 100% calc(100% - 5px), calc(100% - 5px) 100%, 0 100%)" }}
    >
      {tier}
    </span>
  );
}

export function StatValue({ label, value, tone = "normal", sub }: { label: string; value: string; tone?: "normal" | "good" | "bad"; sub?: string }) {
  const valueClass = tone === "good" ? "text-[#46c79b]" : tone === "bad" ? "text-[#e8736e]" : "text-[#e9e9ed]";
  return (
    <div className="min-w-0">
      <p className="text-[9px] font-semibold uppercase tracking-[0.12em] text-[#9397ab]/60">{label}</p>
      <p className={`mt-1 text-[21px] font-semibold leading-none tracking-[-0.02em] tabular-nums ${valueClass}`}>{value}</p>
      {sub && <p className="mt-1 text-[10px] leading-none text-[#9397ab]/70 tabular-nums">{sub}</p>}
    </div>
  );
}

export function RuneCircle({
  pick,
  size = 28,
  keystone = false,
  selected = true,
  onClick,
  ariaLabel,
}: {
  pick: PickType;
  size?: number;
  keystone?: boolean;
  selected?: boolean;
  onClick?: () => void;
  ariaLabel?: string;
}) {
  const inner = (
    <span
      className={`flex shrink-0 items-center justify-center overflow-hidden rounded-full ${
        keystone && selected
          ? "bg-[radial-gradient(circle_at_40%_35%,#4a4380,#25243c)] shadow-[0_0_0_2px_rgba(145,132,217,0.75),0_0_22px_rgba(145,132,217,0.3)]"
          : selected
            ? "bg-[#9184d9]/[0.28] shadow-[0_0_0_2px_#9184d9,0_0_10px_rgba(145,132,217,0.38),inset_0_0_0_1px_#d2cefd]"
            : "bg-white/[0.04] opacity-[.35] grayscale shadow-[inset_0_0_0_1px_rgba(233,233,237,0.16)]"
      }`}
      style={{ width: size, height: size }}
      title={pick.name}
    >
      <IconWithFallback src={pick.icon} alt={pick.name} fallbackGlyph={pick.name} className="h-full w-full object-cover" size={size} />
    </span>
  );
  if (!onClick) return inner;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel ?? `View details for ${pick.name}`}
      className="relative flex shrink-0 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#9184d9] focus-visible:ring-offset-2 focus-visible:ring-offset-[#1b1d2a] motion-reduce:transition-none"
      style={{ width: size, height: size }}
    >
      {inner}
    </button>
  );
}

type RuneRow = { ids: number[]; selectedIds: Set<number> };

export interface RuneGridTree {
  id: number | null;
  name: string;
  icon: string;
}

export interface RuneGridSample {
  count: number;
  denominator: number;
}

export interface RunePageGridRow {
  /** Every static option in this row, with the source pick(s) listed in
   * `selectedIds`. Unknown source ids are appended by the page adapter so a
   * real pick is never silently dropped. */
  options: readonly PickType[];
  selectedIds: ReadonlySet<number>;
  sample?: RuneGridSample | null;
  /** A source row/slot had no pick. The static options may still be rendered
   * for context, but the explicit dash keeps the absence honest. */
  empty?: boolean;
}

export interface RunePageGridPage {
  primaryTree: RuneGridTree | null;
  keystone: RunePageGridRow | null;
  primaryRows: readonly RunePageGridRow[];
  secondaryTree: RuneGridTree | null;
  secondaryRows: readonly RunePageGridRow[];
  shards: readonly RunePageGridRow[];
  /** Recorded ids whose source payload could not be assigned to a known row.
   * They remain visible instead of being silently dropped. */
  unmapped?: readonly PickType[];
}

export const SHARD_ROWS: number[][] = [
  [5005, 5008, 5007],
  [5008, 5010, 5001],
  [5002, 5003, 5011],
];

function pickPlaceholder(id: number, icon = "", name = `Rune #${id}`): PickType {
  return { id, name, icon, wpa: 0, winrate: null, occurrence: 0 };
}

function runeRowsForTree(
  treeId: number,
  selected: PickType[],
  alternatives: PickType[][] | undefined,
  includeOnlySelectedRows: boolean,
): RuneRow[] {
  const tree = PERK_TREES[treeId];
  const staticRows = tree?.minorRows.map((row) => [...row]) ?? [[], [], []];
  const rows = staticRows.map((row, index) => {
    const ids = new Set(row);
    for (const pick of alternatives?.[index] ?? []) ids.add(pick.id);
    return ids;
  });

  selected.forEach((pick, index) => {
    const knownRow = primaryMinorRow(treeId, pick.id);
    const rowIndex = knownRow ?? Math.min(index, rows.length - 1);
    rows[rowIndex]?.add(pick.id);
  });

  const selectedIds = new Set(selected.map((pick) => pick.id));
  return rows
    .map((ids) => ({ ids: [...ids], selectedIds }))
    .filter((row) => !includeOnlySelectedRows || row.ids.some((id) => selectedIds.has(id)));
}

function shardRowsForBuild(shards: PickType[]): RuneRow[] {
  const selectedIds = new Set(shards.map((pick) => pick.id));
  const rows = SHARD_ROWS.map((row) => new Set(row));
  shards.forEach((pick, index) => rows[index]?.add(pick.id));
  return rows.map((ids) => ({ ids: [...ids], selectedIds }));
}

function optionPick(
  id: number,
  selectedById: Map<number, PickType>,
  resolvedById: Map<number, PickType>,
  shard = false,
): PickType {
  const selected = selectedById.get(id);
  if (selected) return selected;
  const resolved = resolvedById.get(id);
  if (resolved) return resolved;
  return shard ? pickPlaceholder(id, shardIconUrl(id), shardName(id)) : pickPlaceholder(id);
}

/** How many label columns a LABELLED rune row is laid out in.
 *
 * A labelled row is a real CSS grid of equal `1fr` tracks rather than a flex
 * row of fixed-width boxes, because `align-items: center` on a fixed-width
 * flex column sizes the label to its own CONTENT — the label's `overflow`
 * never fires and a long name paints straight over its neighbours (measured
 * on Viktor: "Transcendence" rendered 66.0px inside a 38px column and
 * overlapped "Celerity" by 7.5px).
 *
 * Four options (Precision's and Sorcery's keystone rows) go 2x2 instead of
 * 4-across: inside the modal's ~166px tree column, four tracks leave ~38px
 * each, which cannot render "Stormraider's Surge" in any number of lines a
 * clamp allows. Two tracks give ~80px and the name reads. Three or fewer
 * options keep one row. */
export function runeLabelColumns(optionCount: number): number {
  if (optionCount <= 1) return 1;
  if (optionCount <= 3) return optionCount;
  if (optionCount === 4) return 2;
  return 3;
}

function RuneOptionRow({
  row,
  onOpenDetail,
  size = 28,
  shard = false,
  keystone = false,
  showLabels = false,
  showSamples = false,
  labelWidth = 68,
  optionGap,
}: {
  row: RunePageGridRow;
  onOpenDetail?: (kind: EntityKind, id: number) => void;
  size?: number;
  shard?: boolean;
  keystone?: boolean;
  showLabels?: boolean;
  showSamples?: boolean;
  /** Fixed slot width for the UNLABELLED sample layout (the inline OTP card's
   *  fraction column). A LABELLED row ignores it and shares the row's real
   *  width out across `runeLabelColumns` equal tracks instead — a fixed box
   *  narrower than the longest word is exactly what produced the overlapping
   *  modal labels. */
  labelWidth?: number;
  optionGap?: number;
}) {
  const hasNoData = row.empty || row.options.length === 0;
  const gap = optionGap ?? (showLabels ? 8 : 7);
  const slotCount = row.options.length + (hasNoData ? 1 : 0);
  // A labelled slot fills its own grid track and can never be wider than it;
  // `min-w-0` lets the track shrink below the label's max-content width so
  // the wrapping below is what absorbs a long name.
  const slotClass = showLabels
    ? "flex w-full min-w-0 flex-col items-center text-center"
    : "flex min-w-0 flex-col items-center text-center";
  const slotStyle = showLabels ? undefined : { width: labelWidth };
  // `break-words` + `hyphens-auto` handle the hard case the fixed box could
  // not: a single word longer than the column ("Transcendence") breaks inside
  // itself instead of spilling. The 3-line clamp is the last-resort ceiling —
  // at the widths this grid produces no live rune name reaches it.
  const labelClass =
    "mt-1 line-clamp-3 min-h-[22px] hyphens-auto break-words text-[9px] leading-tight" +
    (showLabels ? " w-full" : "");
  const emptySlot = (
    <span className={showLabels ? slotClass : "flex shrink-0 items-center justify-center"} style={showLabels ? undefined : slotStyle}>
      <span
        className="flex shrink-0 items-center justify-center rounded-full bg-white/[0.025] text-[10px] font-semibold text-[#9397ab]/70 shadow-[inset_0_0_0_1px_rgba(233,233,237,0.16)]"
        style={{ width: size, height: size }}
        role="img"
        aria-label={shard ? "No data for this stat shard slot" : "No data for this rune slot"}
        title={shard ? "No data for this stat shard slot" : "No data for this rune slot"}
      >
        —
      </span>
      {showLabels && <span className={`${labelClass} text-[#9397ab]/65`}>No data</span>}
    </span>
  );

  return (
    <div
      className={showLabels ? "grid w-full items-start" : "flex justify-center"}
      style={
        showLabels
          ? { gap, gridTemplateColumns: `repeat(${runeLabelColumns(slotCount)}, minmax(0, 1fr))` }
          : { gap }
      }
    >
      {hasNoData && emptySlot}
      {row.options.map((pick) => {
        const selected = row.selectedIds.has(pick.id);
        const circle = (
          <RuneCircle
            key={pick.id}
            pick={pick}
            size={size}
            keystone={keystone}
            selected={selected}
            onClick={onOpenDetail ? () => onOpenDetail(shard ? "shard" : "rune", pick.id) : undefined}
            ariaLabel={`View details for ${pick.name}`}
          />
        );
        if (!showLabels && !showSamples) return circle;
        return (
          <span key={pick.id} className={slotClass} style={slotStyle}>
            {circle}
            {showLabels && <span className={`${labelClass} text-[#e9e9ed]/75`} title={pick.name}>{pick.name}</span>}
            {showSamples && selected && row.sample && (
              <span className="mt-0.5 text-[9px] tabular-nums text-[#b5abfc]">
                {row.sample.count}/{row.sample.denominator}
              </span>
            )}
          </span>
        );
      })}
    </div>
  );
}

function RuneTreeHeading({ tree, primary }: { tree: RuneGridTree | null; primary: boolean }) {
  const title = tree?.name ?? (primary ? "Primary" : "Secondary");
  return (
    <div className="mb-3 flex items-center gap-2">
      <span className={`h-4 w-4 overflow-hidden rounded-full ${primary ? "bg-[#9184d9]/[0.25] shadow-[inset_0_0_0_1px_rgba(145,132,217,0.6)]" : "bg-white/[0.1] shadow-[inset_0_0_0_1px_rgba(233,233,237,0.28)]"}`}>
        <IconWithFallback src={tree?.icon ?? ""} alt={title} fallbackGlyph={title} className="h-full w-full object-cover" size={20} />
      </span>
      <span className={`text-[10px] font-semibold uppercase tracking-[0.1em] ${primary ? "text-[#b5abfc]" : "text-[#e9e9ed]/60"}`}>{title}</span>
    </div>
  );
}

export function RunePageGrid({
  page,
  onOpenDetail,
  onRuneClick,
  showLabels = false,
  showSamples = false,
  runeSize = 28,
  keystoneSize = 54,
  shardSize = 20,
  labelWidth = 68,
  optionGap,
}: {
  page: RunePageGridPage;
  onOpenDetail?: (kind: EntityKind, id: number) => void;
  onRuneClick?: (kind: EntityKind, id: number) => void;
  showLabels?: boolean;
  showSamples?: boolean;
  runeSize?: number;
  keystoneSize?: number;
  shardSize?: number;
  labelWidth?: number;
  optionGap?: number;
}) {
  const handleRuneClick = onRuneClick ?? onOpenDetail;
  const renderRows = (rows: readonly RunePageGridRow[], shard = false, rowSpacing = "space-y-2") => (
    <div className={rowSpacing}>
      {rows.map((row, index) => (
        <RuneOptionRow
          key={`${shard ? "shard" : "rune"}-${index}`}
          row={row}
          onOpenDetail={handleRuneClick}
          size={shard ? shardSize : runeSize}
          shard={shard}
          showLabels={showLabels}
          showSamples={showSamples}
          labelWidth={labelWidth}
          optionGap={optionGap}
        />
      ))}
    </div>
  );

  return (
    <div className="grid grid-cols-2 gap-x-3">
      <div className="min-w-0">
        <RuneTreeHeading tree={page.primaryTree} primary />
        {page.keystone ? (
          <div className="mb-3 flex justify-center">
            <RuneOptionRow row={page.keystone} onOpenDetail={handleRuneClick} size={keystoneSize} keystone showLabels={showLabels} showSamples={showSamples} labelWidth={labelWidth} optionGap={optionGap} />
          </div>
        ) : (
          <div className="mb-3 flex justify-center">
            <RuneOptionRow row={{ options: [], selectedIds: new Set(), empty: true }} size={keystoneSize} showLabels={showLabels} showSamples={showSamples} labelWidth={labelWidth} optionGap={optionGap} />
          </div>
        )}
        {renderRows(page.primaryRows)}
      </div>
      <div className="min-w-0">
        <RuneTreeHeading tree={page.secondaryTree} primary={false} />
        {renderRows(page.secondaryRows)}
        <div className="mt-3 border-t border-white/[0.08] pt-3">
          {renderRows(page.shards, true, "space-y-1.5")}
        </div>
        {page.unmapped && page.unmapped.length > 0 && (
          <div className="mt-3 border-t border-white/[0.08] pt-3">
            <p className="mb-2 text-[9px] uppercase tracking-[0.1em] text-[#9397ab]/60">Recorded, row unavailable</p>
            <div className="flex flex-wrap justify-center gap-2">
              {page.unmapped.map((pick) => (
                <RuneCircle
                  key={pick.id}
                  pick={pick}
                  size={runeSize}
                  onClick={handleRuneClick ? () => handleRuneClick("rune", pick.id) : undefined}
                />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export interface RunePageModalSpell {
  id: number | null;
  name: string;
  icon: string;
  sample?: RuneGridSample | null;
}

export function RunePageModal({
  open,
  onClose,
  title,
  subtitle,
  page,
  spells,
  compact = false,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  page: RunePageGridPage;
  spells: readonly RunePageModalSpell[];
  /** The modal is used inside a narrow card on desktop as well as on mobile;
   * compact keeps every static option in a row visible without changing the
   * shared WPA grid's established sizing. */
  compact?: boolean;
}) {
  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, open]);

  return (
    <DetailPopover
      open={open}
      onClose={onClose}
      ariaLabel={title}
      header={
        <div className="min-w-0 flex-1 pt-0.5">
          <h2 className="text-[14px] font-bold leading-tight text-[#e9e9ed]">{title}</h2>
          {subtitle && <p className="mt-1 text-[10px] leading-relaxed text-[#9397ab]/70">{subtitle}</p>}
        </div>
      }
    >
      <RunePageGrid
        page={page}
        showLabels
        showSamples
        runeSize={compact ? 24 : 28}
        keystoneSize={compact ? 34 : 54}
        shardSize={compact ? 18 : 20}
        labelWidth={compact ? 38 : 68}
        optionGap={compact ? 4 : undefined}
      />
      <section className="mt-4 border-t border-white/[0.08] pt-3">
        <SectionLabel>Summoner spells</SectionLabel>
        <div className="mt-2 flex flex-wrap gap-3">
          {spells.length === 0 ? (
            <span className="text-[10px] text-[#9397ab]/65">No spell data for this page.</span>
          ) : spells.map((spell, index) => (
            <div key={`${spell.id ?? "empty"}-${index}`} className="flex min-w-[68px] flex-col items-center text-center">
              {spell.id != null ? (
                <span className="flex h-8 w-8 items-center justify-center overflow-hidden rounded-[6px] bg-white/[0.06] shadow-[inset_0_0_0_1px_rgba(233,233,237,0.16)]">
                  <IconWithFallback src={spell.icon} alt={spell.name} fallbackGlyph={spell.name} className="h-full w-full object-cover" size={32} />
                </span>
              ) : (
                <span className="flex h-8 w-8 items-center justify-center rounded-[6px] bg-white/[0.025] text-[10px] font-semibold text-[#9397ab]/70 shadow-[inset_0_0_0_1px_rgba(233,233,237,0.16)]" role="img" aria-label="No data for this summoner spell slot">—</span>
              )}
              <span className="mt-1 line-clamp-2 min-h-[22px] text-[9px] leading-tight text-[#e9e9ed]/75">{spell.id != null ? spell.name : "No data"}</span>
              {spell.id != null && spell.sample && (
                <span className="mt-0.5 text-[9px] tabular-nums text-[#b5abfc]">{spell.sample.count}/{spell.sample.denominator}</span>
              )}
            </div>
          ))}
        </div>
      </section>
    </DetailPopover>
  );
}

export function BuildRuneSidebar({
  build,
  ver,
  altKeystone,
  onOpenDetail,
}: {
  build: BuildResponse;
  ver: string;
  altKeystone?: AltKeystone | null;
  onOpenDetail: (kind: EntityKind, id: number) => void;
}) {
  const { runes } = build;
  const primaryRows = useMemo(
    () => runeRowsForTree(runes.primaryTree.id, runes.primary, runes.alts?.primaryByRow, false),
    [runes],
  );
  const secondaryRows = useMemo(
    () => runeRowsForTree(runes.secondaryTree.id, runes.secondary, undefined, true),
    [runes],
  );
  const shardPicks = useMemo(() => [runes.shards.offense, runes.shards.flex, runes.shards.defense], [runes]);
  const shardRows = useMemo(() => shardRowsForBuild(shardPicks), [shardPicks]);
  const selectedById = useMemo(() => {
    const picks = [runes.keystone, ...runes.primary, ...runes.secondary, ...shardPicks];
    return new Map(picks.map((pick) => [pick.id, pick]));
  }, [runes, shardPicks]);
  const runeOptionIds = useMemo(
    () => [...new Set([...primaryRows, ...secondaryRows].flatMap((row) => row.ids))],
    [primaryRows, secondaryRows],
  );
  const [resolvedById, setResolvedById] = useState<Map<number, PickType>>(() => new Map());

  useEffect(() => {
    let cancelled = false;
    const missing = runeOptionIds.filter((id) => !selectedById.has(id) && !resolvedById.has(id));
    if (missing.length === 0) return;
    Promise.all(missing.map((id) => resolveRuneDisplay(id, ver))).then((resolved) => {
      if (cancelled) return;
      setResolvedById((previous) => {
        const next = new Map(previous);
        resolved.forEach((display) => {
          next.set(display.id, pickPlaceholder(display.id, display.icon, display.name));
        });
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [runeOptionIds, resolvedById, selectedById, ver]);

  const primaryGridRows = useMemo(
    () => primaryRows.map((row) => ({
      options: row.ids.map((id) => optionPick(id, selectedById, resolvedById)),
      selectedIds: row.selectedIds,
    })),
    [primaryRows, resolvedById, selectedById],
  );
  const secondaryGridRows = useMemo(
    () => secondaryRows.map((row) => ({
      options: row.ids.map((id) => optionPick(id, selectedById, resolvedById)),
      selectedIds: row.selectedIds,
    })),
    [resolvedById, secondaryRows, selectedById],
  );
  const shardGridRows = useMemo(
    () => shardRows.map((row) => ({
      options: row.ids.map((id) => optionPick(id, selectedById, resolvedById, true)),
      selectedIds: row.selectedIds,
    })),
    [resolvedById, selectedById, shardRows],
  );

  return (
    <aside className="space-y-4">
      <section className={`${CARD_CLASS} p-4`}>
        <div className="mb-3.5 flex items-center justify-between">
          <SectionLabel>Runes</SectionLabel>
          <div className="flex items-center gap-2">
            <span className="text-[10px] tabular-nums text-[#9397ab]/55">{build.tierLabel}</span>
            <ApplyRunesButton build={build} />
          </div>
        </div>
        <RunePageGrid
          page={{
            primaryTree: {
              id: runes.primaryTree.id,
              name: treeName(runes.primaryTree.id),
              icon: runes.primaryTree.icon || treeIconUrl(runes.primaryTree.id),
            },
            keystone: { options: [runes.keystone], selectedIds: new Set([runes.keystone.id]) },
            primaryRows: primaryGridRows,
            secondaryTree: {
              id: runes.secondaryTree.id,
              name: treeName(runes.secondaryTree.id),
              icon: runes.secondaryTree.icon || treeIconUrl(runes.secondaryTree.id),
            },
            secondaryRows: secondaryGridRows,
            shards: shardGridRows,
          }}
          onOpenDetail={onOpenDetail}
        />
        {altKeystone && (
          <div className="mt-4 border-t border-white/[0.08] pt-4">
            <SectionLabel>Not picked — scored higher</SectionLabel>
            <button
              type="button"
              onClick={() => onOpenDetail("rune", altKeystone.keystone.id)}
              aria-label={`View details for ${altKeystone.keystone.name}, an alternative keystone in the ${altKeystone.tree.name} tree. Not the recommended pick.`}
              className="group mt-2 flex w-full items-center gap-3 rounded-[7px] border border-dashed border-[#9184d9]/60 bg-white/[0.03] p-2.5 text-left transition-colors hover:border-[#9184d9] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#9184d9]"
            >
              <RuneCircle pick={altKeystone.keystone} size={40} selected={false} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[11px] font-semibold text-[#e9e9ed]">{altKeystone.keystone.name}</span>
                <span className="mt-0.5 block truncate text-[9px] tabular-nums text-[#9397ab]/65">{altKeystone.tree.name} · {altKeystone.keystone.occurrence.toLocaleString("en-US")} games</span>
              </span>
              <span className="shrink-0 text-[12px] font-semibold tabular-nums text-[#46c79b]">{altKeystone.keystone.wpa.toFixed(2)}</span>
            </button>
            <p className="mt-2 text-[10px] leading-snug text-[#9397ab]/65">The build above is still the recommendation. Each WPA is measured inside its own rune page, so these are separate readings.</p>
          </div>
        )}
        <div className="hr my-3" />
        <div className="flex items-center justify-between">
          <SectionLabel>Spells</SectionLabel>
          <div className="flex gap-2">
            {build.spells.slice(0, 2).map((spell) => (
              <button
                key={spell.id}
                type="button"
                onClick={() => onOpenDetail("spell", spell.id)}
                aria-label={`View details for ${spellName(spell.id)}`}
                className="flex h-11 w-11 items-center justify-center overflow-hidden rounded-[6px] bg-white/[0.06] shadow-[inset_0_0_0_1px_rgba(233,233,237,0.16)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#9184d9] lg:h-8 lg:w-8"
              >
                <IconWithFallback src={spell.icon || spellIconUrl(spell.id, ver)} alt={spellName(spell.id)} fallbackGlyph={spellName(spell.id)} className="h-full w-full object-cover" size={28} />
              </button>
            ))}
          </div>
        </div>
      </section>

      <section className={`${CARD_CLASS} p-4`}>
        <div className="mb-3 flex items-center justify-between">
          <SectionLabel>Matchups this lane</SectionLabel>
          <span className="text-[9px] uppercase tracking-[0.1em] text-[#9397ab]/45">standard sample</span>
        </div>
        <div className="space-y-3">
          <div className="rounded-[6px] bg-white/[0.03] px-3 py-2.5 text-[11px] leading-relaxed text-[#9397ab]/70">
            <Info size={14} className="mr-1 inline-block text-[#9184d9]" aria-hidden="true" />
            Matchup-conditioned data is not available for this build, so these runes use the lane-wide recommendation.
          </div>
        </div>
      </section>
    </aside>
  );
}

type ApplyUiState =
  | { status: "idle" }
  | { status: "applying" }
  | { status: "success"; message: string }
  | { status: "error"; message: string };

function ApplyRunesButton({ build }: { build: BuildResponse }) {
  const ready = useSyncExternalStore(subscribeToSession, hasSession, () => false);
  const [state, setState] = useState<ApplyUiState>({ status: "idle" });

  async function handleClick() {
    const session = getStoredSession();
    const port = getStoredPort();
    if (!session || !port) {
      setState({ status: "error", message: "Companion not connected." });
      window.setTimeout(() => setState({ status: "idle" }), 3000);
      return;
    }
    setState({ status: "applying" });
    try {
      const body = buildRuneApplyBody(build.champion.name, build.roleLabel, build.runes);
      const result = await applyRunes(port, session, body, "manual");
      setState(result.ok ? { status: "success", message: result.selected && result.verified ? "Applied in-client." : "Saved as a rune page." } : { status: "error", message: result.hint ?? "Apply failed." });
    } catch {
      setState({ status: "error", message: "Couldn't build a rune page." });
    }
    window.setTimeout(() => setState({ status: "idle" }), 3500);
  }

  if (!ready) return null;
  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={state.status === "applying"}
      title={state.status === "success" || state.status === "error" ? state.message : "Apply this rune page in-client"}
      className="rounded-[6px] px-2 py-1 text-[9px] font-semibold uppercase tracking-[0.08em] text-[#b5abfc] shadow-[inset_0_0_0_1px_#9184d9] transition-colors hover:bg-[#9184d9]/15 disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#9184d9]"
    >
      {state.status === "applying" ? "Applying…" : state.status === "success" ? "Applied" : state.status === "error" ? "Retry" : "Apply runes"}
    </button>
  );
}

const subscribeToSession = () => () => {};

function cellClass(cell: SkillGridCell | null, row: string): string {
  if (!cell) return "bg-[rgba(233,233,237,0.045)] text-transparent";
  if (cell.provenance === "derived") return "bg-[#9184d9]/20 text-[#b5abfc] shadow-[inset_0_0_0_1px_rgba(145,132,217,0.55)]";
  if (cell.provenance === "inferred") return "bg-[#9184d9]/10 text-[#b5abfc] shadow-[inset_0_0_0_1px_rgba(145,132,217,0.35)] outline outline-1 outline-dashed outline-[#9184d9]/60";
  if (cell.provenance === "auto") return "bg-white/[0.08] text-[#9397ab] shadow-[inset_0_0_0_1px_rgba(233,233,237,0.2)]";
  return row === "R" ? "bg-[#9184d9] text-[#191a28]" : "bg-[rgba(145,132,217,0.55)] text-[#191a28]";
}

function SkillGrid({ model }: { model: SkillOrderModel }) {
  const grid = buildRecommendedSkillGrid(model);
  return (
    <div className="overflow-x-auto">
      <div className="min-w-[500px]">
        <div className="grid grid-cols-[18px_repeat(18,minmax(0,1fr))] gap-[3px] text-center text-[8px] tabular-nums text-[#9397ab]/45">
          <span aria-hidden="true" />
          {Array.from({ length: 18 }, (_, index) => <span key={index}>{index + 1}</span>)}
          {SKILL_ROWS.map((row, rowIndex) => (
            <Fragment key={row}>
              <span className={`flex items-center justify-center text-[10px] font-semibold ${row === "R" ? "text-[#d2cefd]" : "text-[#9397ab]"}`}>{row}</span>
              {Array.from({ length: 18 }, (_, colIndex) => {
                const cell = grid[rowIndex]?.[colIndex] ?? null;
                return (
                    <span key={`${row}-${colIndex}`} className={`flex aspect-square items-center justify-center rounded-[4px] text-[8px] font-semibold tabular-nums ${cellClass(cell, row)}`}>
                    {cell?.level ?? ""}
                  </span>
                );
              })}
            </Fragment>
          ))}
        </div>
      </div>
    </div>
  );
}

export function BuildSkillOrderGrid({
  model,
  sampleLabel,
  missingLevelsContext = "champion",
  blankRecordedTail = false,
}: {
  model: SkillOrderModel;
  /** Copy shown at the right edge of the section heading. */
  sampleLabel?: string;
  /** Recorded samples must disclose an unobserved tail instead of filling it. */
  missingLevelsContext?: "champion" | "recorded sample";
  /** Pro and OTP display only the recorded 1–15 prefix; they never derive a tail. */
  blankRecordedTail?: boolean;
}) {
  const displayModel = blankRecordedTail && missingLevelsContext === "recorded sample"
    ? { ...model, order: model.order.slice(0, 15), observedLevels: Math.min(model.observedLevels ?? model.order.length, 15), inferredTail: [], completed: false }
    : model;
  const derived = hasDerivedTail(displayModel);
  const inferred = inferredTailRange(displayModel);
  const knownLevels = displayModel.order.length + (displayModel.inferredTail?.length ?? 0);

  return (
    <>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex items-baseline gap-3">
          <SectionLabel>Skill order</SectionLabel>
          <span className="text-[14px] font-semibold text-[#b5abfc]">{formatPriorityString(model.priority)}</span>
        </div>
        {sampleLabel && <span className="text-[10px] tabular-nums text-[#9397ab]/55">{sampleLabel}</span>}
      </div>
      <div className="mt-4"><SkillGrid model={displayModel} /></div>
      {inferred && (
        <p className="mt-3 text-[10px] leading-relaxed text-[#d2cefd]/75">
          The source publishes levels 1–{displayModel.order.length} only, and this champion&apos;s last points can&apos;t be worked out from them. Levels {inferred.from}–{inferred.to} are inferred from {displayModel.inferredBasis === "published" ? "the champion&apos;s published max order" : "the levelling path above"} (dashed) — a best guess, not recorded data.
        </p>
      )}
      {knownLevels < 18 && (
        <p className="mt-3 text-[10px] leading-relaxed tabular-nums text-[#d2cefd]/75">
          {blankRecordedTail
            ? "Levels 16–18 stay blank: nobody in this sample reached them on record, and this tab never fills a level in by rule."
            : missingLevelsContext === "recorded sample"
            ? `Levels ${knownLevels + 1}–18 stay blank: nobody in this sample reached them on record, and this tab never fills a level in by rule.`
            : `Levels ${knownLevels + 1}–18 are unknown for this champion and left blank.`}
        </p>
      )}
      {derived && (
        <p className="mt-3 text-[10px] leading-relaxed text-[#9397ab]/65">
          {displayModel.completionBasis === "published" ? "Outlined levels are derived from this champion's published max order, not recorded" : displayModel.completionBasis === "derived" ? "Outlined levels are derived from this champion's levelling path, not recorded" : "Outlined levels are derived, not recorded"} — the source publishes levels 1–15 only.
        </p>
      )}
    </>
  );
}

export function BuildSkillOrderPanel({ champId, lane }: { champId: number; lane: LaneId }) {
  const [model, setModel] = useState<SkillOrderModel | null>(null);
  const [status, setStatus] = useState<"loading" | "hidden" | "error" | "ok">("loading");
  const requestKey = `${champId}:${lane}`;
  const [previousRequestKey, setPreviousRequestKey] = useState(requestKey);
  if (requestKey !== previousRequestKey) {
    setPreviousRequestKey(requestKey);
    setModel(null);
    setStatus("loading");
  }

  useEffect(() => {
    let cancelled = false;
    fetchSkillOrder(champId, LANE_TO_ROLE_ID[lane]).then((result) => {
      if (cancelled) return;
      if (result.status === "ok") {
        setModel(result.model);
        setStatus("ok");
      } else {
        setModel(null);
        setStatus(result.status);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [champId, lane]);

  if (status === "hidden") return null;
  if (status === "error") {
    return (
      <section className={`${CARD_CLASS} p-4`}>
        <SectionLabel>Skill order</SectionLabel>
        <p className="mt-3 text-[11px] text-[#9397ab]/65">Skill-order data could not be loaded for this champion and lane.</p>
      </section>
    );
  }
  if (status === "loading" || !model) {
    return (
      <section className={`${CARD_CLASS} animate-pulse p-4`} aria-label="Loading skill order">
        <div className="h-2 w-24 rounded bg-white/[0.06]" />
        <div className="mt-4 h-20 rounded bg-white/[0.04]" />
      </section>
    );
  }

  return (
    <section className={`${CARD_CLASS} p-4`}>
      <BuildSkillOrderGrid model={model} sampleLabel={`${model.sampleSize.toLocaleString()} games`} />
    </section>
  );
}

// DESKTOP ONLY, by user directive 2026-08-10 ("in mobile version remove the
// apply runes and items import"). Both buttons only scroll the page to a section
// the reader can already reach by scrolling, and on a phone they ate a whole
// block above the fold. Hidden in CSS rather than behind a JS width check on
// purpose: a width check renders the wrong thing on the first paint and then
// swaps it. `hidden` removes the box entirely, so the hero's flex column drops
// its gap too and the lane row sits directly under the champion header.
export function BuildActionButtons() {
  return (
    <div className="hidden flex-wrap gap-2 lg:flex">
      <button
        type="button"
        className="inline-flex h-9 min-h-[44px] items-center gap-2 rounded-[8px] bg-[#9184d9] px-3.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-[#191a28] transition-colors hover:bg-[#b5abfc] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#9184d9] focus-visible:ring-offset-2 focus-visible:ring-offset-[#1b1d2a] lg:min-h-0"
        onClick={() => document.getElementById("build-items")?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" })}
      >
        <DownloadSimple size={14} weight="bold" aria-hidden="true" />
        Import build
      </button>
      <button
        type="button"
        className="inline-flex h-9 min-h-[44px] items-center gap-2 rounded-[8px] px-3.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-[#b5abfc] shadow-[inset_0_0_0_1px_#9184d9] transition-colors hover:bg-[#9184d9]/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#9184d9] focus-visible:ring-offset-2 focus-visible:ring-offset-[#1b1d2a] lg:min-h-0"
        onClick={() => document.getElementById("build-runes")?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" })}
      >
        <Lightning size={14} weight="bold" aria-hidden="true" />
        Apply runes
      </button>
    </div>
  );
}

export function EmptyDataNote({ children }: { children: React.ReactNode }) {
  return <div className="rounded-[7px] bg-white/[0.03] px-3 py-2.5 text-[11px] leading-relaxed text-[#9397ab]/70">{children}</div>;
}

export function BuildHeaderIcon() {
  return <Sparkle size={13} weight="fill" aria-hidden="true" />;
}

export function BuildPathArrow() {
  return <CaretRight aria-hidden="true" size={14} className="shrink-0 text-[#9184d9]/75" />;
}
