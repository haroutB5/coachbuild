"use client";

import type { RunesBlock, Pick as PickType } from "@/lib/types";
import type { EntityKind } from "@/components/EntityDetailPopover";
import { wpaClass, wpaText } from "@/components/StatBadge";
import { IconWithFallback } from "@/components/IconWithFallback";
import { buildRunesPageModel } from "./runesPage";

function CardHeader({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[10.5px] tracking-[0.14em] uppercase text-mut font-semibold mb-3.5">
      {children}
    </p>
  );
}

function TreeLabel({ icon, name }: { icon: string; name: string }) {
  return (
    <div className="flex items-center gap-2 mb-3">
      <span className="w-5 h-5 rounded-full bg-black/20 overflow-hidden flex items-center justify-center flex-shrink-0">
        <IconWithFallback src={icon} alt={name} fallbackGlyph={name} className="w-full h-full object-contain" size={20} />
      </span>
      <span className="text-[11.5px] text-txt font-semibold">{name}</span>
    </div>
  );
}

// Quiet, dim caution glyph for a low-sample pick — matches RunePage.tsx /
// ItemPath.tsx's own local copy. Not shared as a component (see
// StatBadge.tsx's header comment on why the vitest oxc/JSX split keeps these
// duplicated per-file rather than extracted into a pure-logic module).
function LowSampleFlag() {
  return (
    <span title="Low sample size — treat this pick with caution" aria-label="low sample size" className="text-gold/70">
      ⚠
    </span>
  );
}

const TAP_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal focus-visible:ring-offset-2 focus-visible:ring-offset-panel active:scale-95 transition-transform";

interface RuneTileProps {
  pick: PickType;
  isKeystone?: boolean;
  onOpenDetail: (kind: EntityKind, id: number) => void;
}

function RuneTile({ pick, isKeystone, onOpenDetail }: RuneTileProps) {
  const dim = isKeystone
    ? "w-14 h-14 border-2 border-teal shadow-[0_0_14px_rgba(130,219,247,0.3)]"
    : "w-10 h-10 border border-line";
  const pxSize = isKeystone ? 56 : 40;

  return (
    <button
      type="button"
      onClick={() => onOpenDetail("rune", pick.id)}
      aria-label={`View details for rune ${pick.name}`}
      className={`group flex flex-col items-center text-center w-[68px] gap-1 rounded-md ${TAP_RING}`}
    >
      <span
        className={`${dim} rounded-full bg-black/30 overflow-hidden flex items-center justify-center flex-shrink-0 transition-transform group-hover:scale-105`}
      >
        <IconWithFallback
          src={pick.icon}
          alt={pick.name}
          fallbackGlyph={pick.name}
          className="w-full h-full object-contain"
          size={pxSize}
        />
      </span>
      <span className="text-[10px] text-txt leading-tight line-clamp-2 min-h-[24px]">{pick.name}</span>
      <span className={`text-[11px] font-bold tabular-nums flex items-center gap-0.5 ${wpaClass(pick.wpa)}`}>
        {wpaText(pick.wpa)}
        {pick.lowSample && <LowSampleFlag />}
      </span>
    </button>
  );
}

interface ShardTileProps {
  label: string;
  pick: PickType;
  onOpenDetail: (kind: EntityKind, id: number) => void;
}

function ShardTile({ label, pick, onOpenDetail }: ShardTileProps) {
  return (
    <button
      type="button"
      onClick={() => onOpenDetail("shard", pick.id)}
      aria-label={`View details for stat shard ${pick.name}`}
      className={`flex flex-col items-center text-center w-14 gap-1 rounded-md ${TAP_RING}`}
    >
      <span className="w-8 h-8 rounded-full bg-black/30 border border-line overflow-hidden flex items-center justify-center flex-shrink-0">
        <IconWithFallback
          src={pick.icon}
          alt={pick.name}
          fallbackGlyph={pick.name}
          className="w-full h-full object-contain p-1"
          size={32}
        />
      </span>
      <span className="text-[9px] text-mut leading-tight">{label}</span>
    </button>
  );
}

interface SummonerTileProps {
  spell: PickType;
  onOpenDetail: (kind: EntityKind, id: number) => void;
}

function SummonerTile({ spell, onOpenDetail }: SummonerTileProps) {
  return (
    <button
      type="button"
      onClick={() => onOpenDetail("spell", spell.id)}
      aria-label={`View details for summoner spell ${spell.name}`}
      title={`WPA ${wpaText(spell.wpa)}`}
      className={`flex items-center gap-2 rounded-lg ${TAP_RING}`}
    >
      <span className="w-9 h-9 rounded-[8px] bg-black/30 border border-line overflow-hidden flex items-center justify-center flex-shrink-0">
        <IconWithFallback
          src={spell.icon}
          alt={spell.name}
          fallbackGlyph={spell.name}
          className="w-full h-full object-contain"
          size={36}
        />
      </span>
      <span className="text-[11.5px] text-txt font-medium leading-tight">{spell.name}</span>
    </button>
  );
}

interface RunesSummonersCardProps {
  runes: RunesBlock;
  spells: PickType[];
  onOpenDetail: (kind: EntityKind, id: number) => void;
}

export default function RunesSummonersCard({ runes, spells, onOpenDetail }: RunesSummonersCardProps) {
  const model = buildRunesPageModel(runes);

  return (
    <div className="bg-panel border border-line rounded-xl p-5">
      <CardHeader>Runes &amp; Summoners</CardHeader>

      <div className="grid grid-cols-1 md:grid-cols-[1.5fr_1.1fr_auto] gap-x-8 gap-y-5">
        {/* Primary tree: keystone (large) + 3 minors */}
        <div>
          <TreeLabel icon={model.primaryTree.icon} name={model.primaryTree.name} />
          <div className="flex flex-wrap items-end gap-2.5">
            <RuneTile pick={runes.keystone} isKeystone onOpenDetail={onOpenDetail} />
            {model.primaryMinors.map((p) => (
              <RuneTile key={p.id} pick={p} onOpenDetail={onOpenDetail} />
            ))}
          </div>
        </div>

        {/* Secondary tree: 2 picks + stat shards */}
        <div>
          <TreeLabel icon={model.secondaryTree.icon} name={model.secondaryTree.name} />
          <div className="flex flex-wrap gap-2.5 mb-4">
            {model.secondaryPicks.map((p) => (
              <RuneTile key={p.id} pick={p} onOpenDetail={onOpenDetail} />
            ))}
          </div>
          <div className="flex gap-2.5">
            {model.shards.map((s) => (
              <ShardTile key={`${s.label}-${s.pick.id}`} label={s.label} pick={s.pick} onOpenDetail={onOpenDetail} />
            ))}
          </div>
        </div>

        {/* Summoner spells */}
        <div className="flex md:flex-col gap-2 md:justify-center">
          {spells.map((spell) => (
            <SummonerTile key={spell.id} spell={spell} onOpenDetail={onOpenDetail} />
          ))}
        </div>
      </div>
    </div>
  );
}
