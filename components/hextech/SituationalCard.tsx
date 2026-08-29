"use client";

import type { ItemsBlock, Pick as PickType } from "@/lib/types";
import { wpaClass, wpaText } from "@/components/StatBadge";
import { IconWithFallback } from "@/components/IconWithFallback";
import { flattenSituational, SITUATIONAL_DISPLAY_LIMIT } from "./situational";

interface SituationalCardProps {
  items: ItemsBlock;
  onItemClick: (id: number) => void;
}

// v0.51.0: no longer its own bordered card, nested inside ItemBuildCard.tsx
// (mockup 4/5's merged "ITEM BUILD" card), and switched from a flex-wrap chip
// row to a 2-col grid.
//
// FIDELITY NOTE, UPDATED 2026-08-29 (0.120.0). The mockup labelled each row
// with a short contextual REASON string ("vs dive & burst"). No such field
// exists on the wire, so the WPA delta stands in rather than fabricating
// flavour text.
//
// 0.118.0 briefly put a real one here: the enemy-comp signal promoted an item
// into this row and printed a line explaining why. That is REMOVED. The comp
// now gets its own block and its own card (ForThisGameCard), and two
// comp-driven opinions about one build cannot be reconciled by the reader --
// the promotion was gated on the item existing in the champion's own pool and
// on a WPA cost ceiling, and the new block is gated on neither, so the two
// could legitimately disagree with nothing on screen explaining it. This row is
// a pure SOURCE claim again: the alternatives the champion's own per-slot data
// offers, WPA-ordered.
export default function SituationalCard({ items, onItemClick }: SituationalCardProps) {
  // SITUATIONAL_DISPLAY_LIMIT, not a literal 6: itemSetBody.ts ships this same
  // window into the in-game shop as a "Situational" block, and the two must not
  // drift.
  const situational = flattenSituational(items).slice(0, SITUATIONAL_DISPLAY_LIMIT);
  if (situational.length === 0) return null;

  return (
    <div className="py-4 first:pt-0 last:pb-0">
      <p className="text-[10.5px] tracking-[0.14em] uppercase text-mut font-semibold mb-3">
        Situational
      </p>
      <div className="grid grid-cols-1 min-[420px]:grid-cols-2 gap-2.5">
        {situational.map((pick: PickType) => {
          return (
            <button
              key={pick.id}
              type="button"
              onClick={() => onItemClick(pick.id)}
              aria-label={"View details for " + pick.name}
              className="flex items-center gap-2 bg-panel2/70 border border-line hover:border-line-gold rounded-lg px-2.5 py-2 min-w-0 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal focus-visible:ring-offset-2 focus-visible:ring-offset-panel active:scale-[0.98]"
            >
              <span className="w-7 h-7 rounded-md bg-black/30 border border-line overflow-hidden flex items-center justify-center flex-shrink-0">
                <IconWithFallback
                  src={pick.icon}
                  alt={pick.name}
                  fallbackGlyph={pick.name}
                  className="w-full h-full object-contain"
                  size={28}
                />
              </span>
              <div className="leading-tight min-w-0">
                <div className="text-[11.5px] text-txt font-medium truncate">{pick.name}</div>
                <div className={`text-[10.5px] font-bold tabular-nums ${wpaClass(pick.wpa)}`}>
                  {wpaText(pick.wpa)}
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
