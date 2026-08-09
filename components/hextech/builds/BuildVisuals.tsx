"use client";

import { Fragment, useEffect, useState, useSyncExternalStore } from "react";
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
import type { AltKeystone } from "@/components/hextech/altKeystone";
import { spellIconUrl, spellName, treeIconUrl, treeName, shardIconUrl } from "@/components/proAssets";
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

function RuneCircle({ pick, size = 31, keystone = false, onClick }: { pick: PickType; size?: number; keystone?: boolean; onClick?: () => void }) {
  const inner = (
    <span
      className={`flex shrink-0 items-center justify-center overflow-hidden rounded-full ${
        keystone
          ? "shadow-[0_0_0_2px_rgba(145,132,217,0.75),0_0_20px_rgba(145,132,217,0.28)]"
          : "shadow-[inset_0_0_0_1px_rgba(233,233,237,0.18)]"
      } bg-white/[0.05]`}
      style={{ width: size, height: size }}
    >
      <IconWithFallback src={pick.icon} alt={pick.name} fallbackGlyph={pick.name} className="h-full w-full object-cover" size={size} />
    </span>
  );
  if (!onClick) return inner;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`View details for ${pick.name}`}
      className="rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#9184d9] focus-visible:ring-offset-2 focus-visible:ring-offset-[#1b1d2a]"
    >
      {inner}
    </button>
  );
}

function RuneColumn({
  title,
  icon,
  keystone,
  picks,
  onOpenDetail,
}: {
  title: string;
  icon: string;
  keystone?: PickType;
  picks: PickType[];
  onOpenDetail: (kind: EntityKind, id: number) => void;
}) {
  return (
    <div className="min-w-0">
      <div className="mb-3 flex items-center gap-2">
        <span className="h-5 w-5 overflow-hidden rounded-full bg-white/[0.04]">
          <IconWithFallback src={icon} alt={title} fallbackGlyph={title} className="h-full w-full object-cover" size={20} />
        </span>
        <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[#9397ab]/70">{title}</span>
      </div>
      <div className="flex flex-wrap items-center gap-2.5">
        {keystone && <RuneCircle pick={keystone} size={54} keystone onClick={() => onOpenDetail("rune", keystone.id)} />}
        {picks.map((pick) => (
          <RuneCircle key={pick.id} pick={pick} onClick={() => onOpenDetail("rune", pick.id)} />
        ))}
      </div>
    </div>
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
  const shards = [
    { label: "OFF", pick: runes.shards.offense },
    { label: "FLEX", pick: runes.shards.flex },
    { label: "DEF", pick: runes.shards.defense },
  ];

  return (
    <aside className="space-y-4">
      <section className={`${CARD_CLASS} p-4`}>
        <div className="mb-4 flex items-center justify-between">
          <SectionLabel>Runes</SectionLabel>
          <div className="flex items-center gap-2">
            <span className="text-[10px] tabular-nums text-[#9397ab]/55">{build.tierLabel}</span>
            <ApplyRunesButton build={build} />
          </div>
        </div>
        <div className="grid grid-cols-1 gap-5 min-[460px]:grid-cols-2">
          <RuneColumn title={treeName(runes.primaryTree.id)} icon={runes.primaryTree.icon || treeIconUrl(runes.primaryTree.id)} keystone={runes.keystone} picks={runes.primary} onOpenDetail={onOpenDetail} />
          <RuneColumn title={treeName(runes.secondaryTree.id)} icon={runes.secondaryTree.icon || treeIconUrl(runes.secondaryTree.id)} picks={runes.secondary} onOpenDetail={onOpenDetail} />
        </div>
        {altKeystone && (
          <div className="mt-4 border-t border-white/[0.08] pt-4">
            <SectionLabel>Not picked — scored higher</SectionLabel>
            <button
              type="button"
              onClick={() => onOpenDetail("rune", altKeystone.keystone.id)}
              aria-label={`View details for ${altKeystone.keystone.name}, an alternative keystone in the ${altKeystone.tree.name} tree. Not the recommended pick.`}
              className="group mt-2 flex w-full items-center gap-3 rounded-[7px] border border-dashed border-[#9184d9]/60 bg-white/[0.03] p-2.5 text-left transition-colors hover:border-[#9184d9] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#9184d9]"
            >
              <span className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-full bg-white/[0.04] shadow-[inset_0_0_0_1px_rgba(145,132,217,0.55)]">
                <IconWithFallback src={altKeystone.keystone.icon} alt={altKeystone.keystone.name} fallbackGlyph={altKeystone.keystone.name} className="h-full w-full object-cover transition-transform group-hover:scale-105" size={40} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[11px] font-semibold text-[#e9e9ed]">{altKeystone.keystone.name}</span>
                <span className="mt-0.5 block truncate text-[9px] tabular-nums text-[#9397ab]/65">{altKeystone.tree.name} · {altKeystone.keystone.occurrence.toLocaleString("en-US")} games</span>
              </span>
              <span className="shrink-0 text-[12px] font-semibold tabular-nums text-[#46c79b]">{altKeystone.keystone.wpa.toFixed(2)}</span>
            </button>
            <p className="mt-2 text-[10px] leading-snug text-[#9397ab]/65">The build above is still the recommendation. Each WPA is measured inside its own rune page, so these are separate readings.</p>
          </div>
        )}
        <div className="mt-5 border-t border-white/[0.08] pt-4">
          <div className="mb-2 flex items-center justify-between">
            <SectionLabel>Shards</SectionLabel>
            <span className="text-[9px] uppercase tracking-[0.1em] text-[#9397ab]/45">stat runes</span>
          </div>
          <div className="flex gap-2.5">
            {shards.map(({ label, pick }) => (
              <button
                key={pick.id}
                type="button"
                onClick={() => onOpenDetail("shard", pick.id)}
                className="flex flex-1 flex-col items-center gap-1 rounded-[6px] py-1 text-center hover:bg-white/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#9184d9]"
              >
                <span className="flex h-6 w-6 items-center justify-center overflow-hidden rounded-full bg-white/[0.05] shadow-[inset_0_0_0_1px_rgba(233,233,237,0.12)]">
                  <IconWithFallback src={pick.icon || shardIconUrl(pick.id)} alt={pick.name} fallbackGlyph={pick.name} className="h-full w-full object-cover" size={24} />
                </span>
                <span className="text-[8px] font-semibold uppercase tracking-[0.08em] text-[#9397ab]/60">{label}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="mt-4 border-t border-white/[0.08] pt-3">
          <div className="flex items-center justify-between">
            <SectionLabel>Spells</SectionLabel>
            <div className="flex gap-2">
              {build.spells.slice(0, 2).map((spell) => (
                <button
                  key={spell.id}
                  type="button"
                  onClick={() => onOpenDetail("spell", spell.id)}
                  aria-label={`View details for ${spellName(spell.id)}`}
                  className="h-7 w-7 overflow-hidden rounded-[6px] bg-white/[0.06] shadow-[inset_0_0_0_1px_rgba(233,233,237,0.16)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#9184d9]"
                >
                  <IconWithFallback src={spell.icon || spellIconUrl(spell.id, ver)} alt={spellName(spell.id)} fallbackGlyph={spellName(spell.id)} className="h-full w-full object-cover" size={28} />
                </button>
              ))}
            </div>
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

export function BuildActionButtons() {
  return (
    <div className="flex flex-wrap gap-2">
      <button
        type="button"
        className="inline-flex h-9 items-center gap-2 rounded-[8px] bg-[#9184d9] px-3.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-[#191a28] transition-colors hover:bg-[#b5abfc] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#9184d9] focus-visible:ring-offset-2 focus-visible:ring-offset-[#1b1d2a]"
        onClick={() => document.getElementById("build-items")?.scrollIntoView({ behavior: "smooth", block: "start" })}
      >
        <DownloadSimple size={14} weight="bold" aria-hidden="true" />
        Import build
      </button>
      <button
        type="button"
        className="inline-flex h-9 items-center gap-2 rounded-[8px] px-3.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-[#b5abfc] shadow-[inset_0_0_0_1px_#9184d9] transition-colors hover:bg-[#9184d9]/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#9184d9] focus-visible:ring-offset-2 focus-visible:ring-offset-[#1b1d2a]"
        onClick={() => document.getElementById("build-runes")?.scrollIntoView({ behavior: "smooth", block: "start" })}
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
