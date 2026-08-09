"use client";

import type { ItemsBlock, Pick as PickType } from "@/lib/types";
import { IconWithFallback } from "@/components/IconWithFallback";
import { fmtSample, wpaClass, wpaText } from "@/components/StatBadge";
import { BuildPathArrow, CARD_CLASS, SectionLabel } from "./builds/BuildVisuals";

interface CoreBuildOrderCardProps {
  items: ItemsBlock;
  onItemClick: (id: number) => void;
}
function ItemStep({ pick, index, onItemClick }: { pick: PickType; index: number; onItemClick: (id: number) => void }) {
  return (
    <div className="flex min-w-[74px] shrink-0 items-start gap-2 lg:min-w-0 lg:shrink lg:flex-1">
      {index > 0 && <BuildPathArrow />}
      <button
        type="button"
        onClick={() => onItemClick(pick.id)}
        aria-label={`View details for ${pick.name}`}
        className="group flex min-w-0 flex-1 flex-col items-center rounded-[7px] px-0.5 text-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#9184d9]"
      >
        <span className="flex h-[50px] w-[50px] items-center justify-center overflow-hidden rounded-[9px] bg-[linear-gradient(150deg,#2b2e42,#1c1e2c)] shadow-[inset_0_0_0_1px_rgba(233,233,237,0.12)] transition-colors group-hover:shadow-[inset_0_0_0_1px_rgba(145,132,217,0.42)]">
          <IconWithFallback src={pick.icon} alt={pick.name} fallbackGlyph={pick.name} className="h-full w-full object-cover" size={50} />
        </span>
        <span className="mt-2 line-clamp-2 min-h-[26px] max-w-[74px] text-[10px] leading-[1.2] text-[#e9e9ed]/75">{pick.name}</span>
        <span className={`mt-1 text-[10px] font-semibold tabular-nums ${wpaClass(pick.wpa)}`}>{wpaText(pick.wpa)}</span>
        <span className="text-[9px] tabular-nums text-[#9397ab]/55">{fmtSample(pick.occurrence)} games</span>
      </button>
    </div>
  );
}

export default function CoreBuildOrderCard({ items, onItemClick }: CoreBuildOrderCardProps) {
  // The display is deliberately capped at the same six inventory decisions as
  // lib/buildSlots.ts. The starter is an opener and the boots occupy one
  // inventory slot; no path here can imply a seventh simultaneous item.
  const order = [items.starter, items.boots, items.first, items.second, items.third, ...items.fourthPlus].filter(Boolean).slice(0, 6);
  const wpaTotal = order.reduce((sum, pick) => sum + pick.wpa, 0);

  return (
    <section id="build-items" className={`${CARD_CLASS} p-4 sm:p-5`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-baseline gap-3">
          <SectionLabel>Buy order</SectionLabel>
          <span className="text-[10px] text-[#9397ab]/55">Each step conditioned on owning the one before it</span>
        </div>
        <span className="rounded-[5px] bg-[#46c79b]/15 px-2 py-1 text-[10px] font-semibold tabular-nums text-[#46c79b]">{wpaTotal >= 0 ? "+" : ""}{wpaTotal.toFixed(1)} WPA</span>
      </div>
      <div className="mt-4 flex items-start gap-1 overflow-x-auto pb-1 sm:gap-2">
        {order.map((pick, index) => <ItemStep key={`${pick.id}-${index}`} pick={pick} index={index} onItemClick={onItemClick} />)}
      </div>
      <p className="mt-3 border-t border-white/[0.06] pt-3 text-[10px] leading-relaxed text-[#9397ab]/55">Six-slot display cap. Starter and boots stay separate from the completed-item recommendation in the data contract.</p>
    </section>
  );
}
