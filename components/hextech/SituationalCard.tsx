"use client";

import type { ItemsBlock } from "@/lib/types";
import { wpaClass, wpaText } from "@/components/StatBadge";
import { IconWithFallback } from "@/components/IconWithFallback";
import { flattenSituational } from "./situational";

interface SituationalCardProps {
  items: ItemsBlock;
}

export default function SituationalCard({ items }: SituationalCardProps) {
  const situational = flattenSituational(items).slice(0, 6);
  if (situational.length === 0) return null;

  return (
    <div className="bg-panel border border-line rounded-xl p-5">
      <p className="text-[10.5px] tracking-[0.14em] uppercase text-mut font-semibold mb-4">
        Situational
      </p>
      <div className="flex flex-wrap gap-2.5">
        {situational.map((pick) => (
          <div
            key={pick.id}
            className="flex items-center gap-2 bg-panel2/70 border border-line rounded-lg px-2.5 py-2 hover:border-line-gold transition-colors"
          >
            <span className="w-7 h-7 rounded-md bg-black/30 border border-line overflow-hidden flex items-center justify-center flex-shrink-0">
              <IconWithFallback src={pick.icon} alt={pick.name} className="w-full h-full object-contain" size={28} />
            </span>
            <div className="leading-tight">
              <div className="text-[11.5px] text-txt font-medium">{pick.name}</div>
              <div className={`text-[10.5px] font-bold tabular-nums ${wpaClass(pick.wpa)}`}>
                {wpaText(pick.wpa)}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
