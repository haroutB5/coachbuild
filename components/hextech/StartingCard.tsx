"use client";

import type { Pick as PickType } from "@/lib/types";
import { IconWithFallback } from "@/components/IconWithFallback";
import { wpaText } from "@/components/StatBadge";

interface StartingCardProps {
  starter: PickType;
}

// NOTE (fidelity deviation, see HANDOFF-fronty.md): the spec screenshot
// shows two starting-item rows (a ring + a potion). ItemsBlock only carries
// ONE `starter` Pick on the wire — there is no second starting-item slot in
// the /api/build contract to render honestly, so this card shows exactly
// one row rather than fabricating a second.
export default function StartingCard({ starter }: StartingCardProps) {
  return (
    <div className="bg-panel border border-line rounded-xl p-5 h-full">
      <p className="text-[10.5px] tracking-[0.14em] uppercase text-mut font-semibold mb-3.5">
        Starting
      </p>
      <div className="flex items-center gap-3" title={`WPA ${wpaText(starter.wpa)}`}>
        <span className="w-10 h-10 rounded-lg bg-black/30 border border-line overflow-hidden flex items-center justify-center flex-shrink-0">
          <IconWithFallback src={starter.icon} alt={starter.name} className="w-full h-full object-contain" size={40} />
        </span>
        <span className="text-[12.5px] text-txt font-medium leading-tight">{starter.name}</span>
      </div>
    </div>
  );
}
