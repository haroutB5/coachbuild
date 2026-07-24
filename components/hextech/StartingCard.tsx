"use client";

import type { Pick as PickType } from "@/lib/types";
import { IconWithFallback } from "@/components/IconWithFallback";
import { wpaText } from "@/components/StatBadge";

interface StartingCardProps {
  starter: PickType;
  onItemClick: (id: number) => void;
}

// NOTE (fidelity deviation, see HANDOFF-fronty.md): the spec screenshot
// shows two starting-item rows (a ring + a potion). ItemsBlock only carries
// ONE `starter` Pick on the wire — there is no second starting-item slot in
// the /api/build contract to render honestly, so this card shows exactly
// one row rather than fabricating a second.
//
// v0.51.0: no longer its own bordered card — nested as a labeled section
// inside ItemBuildCard.tsx (mockup 4/5's merged "ITEM BUILD" card). `py-4
// first:pt-0` is a position-agnostic pad (resolves against real DOM order
// via `:first-child`, correct regardless of whether SupportItemCard renders
// before/after this in the parent's divide-y stack).
export default function StartingCard({ starter, onItemClick }: StartingCardProps) {
  return (
    <div className="py-4 first:pt-0 last:pb-0">
      <p className="text-[10.5px] tracking-[0.14em] uppercase text-mut font-semibold mb-3.5">
        Starting
      </p>
      <button
        type="button"
        onClick={() => onItemClick(starter.id)}
        aria-label={`View details for ${starter.name}`}
        title={`WPA ${wpaText(starter.wpa)}`}
        className="flex items-center gap-3 w-full text-left rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal focus-visible:ring-offset-2 focus-visible:ring-offset-panel active:scale-[0.98] transition-transform"
      >
        <span className="w-10 h-10 rounded-lg bg-black/30 border border-line overflow-hidden flex items-center justify-center flex-shrink-0">
          <IconWithFallback src={starter.icon} alt={starter.name} fallbackGlyph={starter.name} className="w-full h-full object-contain" size={40} />
        </span>
        <span className="text-[12.5px] text-txt font-medium leading-tight">{starter.name}</span>
      </button>
    </div>
  );
}
