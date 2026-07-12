"use client";

import type { ItemsBlock, Pick as PickType } from "@/lib/types";
import { wpaClass, wpaText } from "@/components/StatBadge";
import { IconWithFallback } from "@/components/IconWithFallback";

interface CoreBuildOrderCardProps {
  items: ItemsBlock;
}

function ItemSquare({ pick }: { pick: PickType }) {
  return (
    <div className="flex flex-col items-center text-center w-[76px] flex-shrink-0">
      <span className="w-12 h-12 rounded-lg bg-black/30 border border-line-gold overflow-hidden flex items-center justify-center">
        <IconWithFallback src={pick.icon} alt={pick.name} className="w-full h-full object-contain" size={48} />
      </span>
      <span className="text-[10.5px] text-txt mt-1.5 leading-tight line-clamp-2 min-h-[26px]">{pick.name}</span>
      <span className={`text-[11px] font-bold tabular-nums ${wpaClass(pick.wpa)}`}>{wpaText(pick.wpa)}</span>
    </div>
  );
}

function Arrow() {
  return (
    <span aria-hidden="true" className="text-mut/60 text-base select-none mt-4 flex-shrink-0">
      &rarr;
    </span>
  );
}

export default function CoreBuildOrderCard({ items }: CoreBuildOrderCardProps) {
  // Progression order matching the spec: 1st -> 2nd -> 3rd legendary, then
  // boots, then any 4th+ items — deliberately NOT the same slot order as the
  // legacy ItemPath.tsx (starter/boots-early), since "Starting" now has its
  // own card and the spec screenshot shows boots landing after the core 3.
  const order: PickType[] = [items.first, items.second, items.third, items.boots, ...items.fourthPlus];

  return (
    <div className="bg-panel border border-line rounded-xl p-5">
      <p className="text-[10.5px] tracking-[0.14em] uppercase text-mut font-semibold mb-4">
        Core Build Order
      </p>
      <div className="flex items-start flex-wrap gap-x-1 gap-y-4">
        {order.map((pick, i) => (
          <div key={`${pick.id}-${i}`} className="flex items-start">
            {i > 0 && <Arrow />}
            <ItemSquare pick={pick} />
          </div>
        ))}
      </div>
    </div>
  );
}
