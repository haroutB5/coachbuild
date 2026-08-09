"use client";

import type { RunesBlock, Pick as PickType } from "@/lib/types";
import { IconWithFallback } from "@/components/IconWithFallback";
import { fmtSample, wpaClass, wpaText } from "@/components/StatBadge";

function RuneTile({ pick, keystone = false, small = false }: { pick: PickType; keystone?: boolean; small?: boolean }) {
  const size = keystone ? 54 : small ? 24 : 34;
  return (
    <div className={`flex flex-col items-center text-center ${keystone ? "w-[64px]" : small ? "w-[40px]" : "w-[54px]"}`} title={`${pick.name} · WPA ${wpaText(pick.wpa)} · ${fmtSample(pick.occurrence)} picks`}>
      <span className={`flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-white/[0.05] ${keystone ? "shadow-[0_0_0_2px_rgba(145,132,217,0.75),0_0_20px_rgba(145,132,217,0.28)]" : "shadow-[inset_0_0_0_1px_rgba(233,233,237,0.16)]"}`} style={{ width: size, height: size }}>
        <IconWithFallback src={pick.icon} alt={pick.name} fallbackGlyph={pick.name} className="h-full w-full object-cover" size={size} />
      </span>
      {!small && <span className="mt-1.5 line-clamp-2 min-h-[22px] text-[9px] leading-tight text-[#e9e9ed]/75">{pick.name}</span>}
      <span className={`mt-1 text-[9px] font-semibold tabular-nums ${wpaClass(pick.wpa)}`}>{wpaText(pick.wpa)}</span>
    </div>
  );
}

function TreeHeading({ icon, name, label }: { icon: string; name: string; label: string }) {
  return (
    <div className="mb-3 flex items-center gap-2">
      <span className="h-5 w-5 overflow-hidden rounded-full bg-white/[0.04]"><IconWithFallback src={icon} alt={name} fallbackGlyph={name} className="h-full w-full object-cover" size={20} /></span>
      <span className="text-[11px] font-semibold text-[#e9e9ed]/85">{name}</span>
      <span className="text-[9px] uppercase tracking-[0.08em] text-[#9397ab]/55">{label}</span>
    </div>
  );
}

export default function RunePage({ runes }: { runes: RunesBlock }) {
  return (
    <section className="rounded-[9px] bg-[#1b1d2a] p-4 shadow-[inset_0_0_0_1px_rgba(233,233,237,0.08)]">
      <div className="grid gap-5 sm:grid-cols-2">
        <div>
          <TreeHeading icon={runes.primaryTree.icon} name={runes.primaryTree.name} label="primary" />
          <div className="flex flex-wrap items-end gap-2">
            <RuneTile pick={runes.keystone} keystone />
            {runes.primary.map((pick) => <RuneTile key={pick.id} pick={pick} />)}
          </div>
        </div>
        <div>
          <TreeHeading icon={runes.secondaryTree.icon} name={runes.secondaryTree.name} label="secondary" />
          <div className="flex flex-wrap gap-2">
            {runes.secondary.map((pick) => <RuneTile key={pick.id} pick={pick} />)}
          </div>
          <div className="mt-4 border-t border-white/[0.07] pt-3">
            <p className="mb-2 text-[9px] font-semibold uppercase tracking-[0.12em] text-[#9397ab]/60">Stat shards</p>
            <div className="flex gap-2">
              {([
                ["Offense", runes.shards.offense],
                ["Flex", runes.shards.flex],
                ["Defense", runes.shards.defense],
              ] as Array<[string, PickType]>).map(([label, pick]) => (
                <div key={(pick as PickType).id} className="flex items-center gap-1.5">
                  <RuneTile pick={pick} small />
                  <span className="text-[9px] text-[#9397ab]/55">{label}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
