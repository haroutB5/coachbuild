"use client";

import type { ItemsBlock, Pick as PickType } from "@/lib/types";
import { wpaClass, wpaText } from "@/components/StatBadge";
import { IconWithFallback } from "@/components/IconWithFallback";
import { flattenSituational } from "./situational";

interface SituationalCardProps {
  items: ItemsBlock;
  onItemClick: (id: number) => void;
  /** v0.32.0 (Live mode, plan §2d): ids to surface first + ring-highlight —
   *  computed by components/live/compHighlight.ts's selectCompAwareHighlights
   *  (always a SUBSET of this card's own picks, never a fabricated id — see
   *  that module's header comment on why it's an honest empty [] today).
   *  Optional and additive: every existing caller (BuildTabContent's Build
   *  tab render) omits it and renders exactly as before. */
  highlightIds?: number[];
}

/** Moves any pick whose id is in `highlightIds` to the front (stable order
 *  otherwise) — applied to the FULL flattened list before the top-6 slice,
 *  so a comp-relevant pick that wasn't already top-WPA still surfaces. */
function withHighlightsFirst(picks: PickType[], highlightIds: number[]): PickType[] {
  if (highlightIds.length === 0) return picks;
  const set = new Set(highlightIds);
  const highlighted = picks.filter((p) => set.has(p.id));
  const rest = picks.filter((p) => !set.has(p.id));
  return [...highlighted, ...rest];
}

// v0.51.0: no longer its own bordered card — nested inside ItemBuildCard.tsx
// (mockup 4/5's merged "ITEM BUILD" card), and switched from a flex-wrap chip
// row to a 2-col grid (mockup's layout). Fidelity note (HANDOFF-fronty.md):
// the mockup labels each row with a short contextual REASON string ("vs dive
// & burst", "kite & lockdown") — there's no such field on ItemsBlock/Pick's
// wire contract, so rather than fabricate flavor text this keeps the real
// WPA delta as the secondary line (same honesty convention as StartingCard's
// single-row note above).
export default function SituationalCard({ items, onItemClick, highlightIds }: SituationalCardProps) {
  const ordered = withHighlightsFirst(flattenSituational(items), highlightIds ?? []);
  const situational = ordered.slice(0, 6);
  if (situational.length === 0) return null;

  return (
    <div className="py-4 first:pt-0 last:pb-0">
      <p className="text-[10.5px] tracking-[0.14em] uppercase text-mut font-semibold mb-4">
        Situational
      </p>
      <div className="grid grid-cols-2 gap-2.5">
        {situational.map((pick) => {
          const isHighlighted = highlightIds?.includes(pick.id) ?? false;
          return (
            <button
              key={pick.id}
              type="button"
              onClick={() => onItemClick(pick.id)}
              aria-label={
                isHighlighted
                  ? `View details for ${pick.name} — relevant vs this matchup`
                  : `View details for ${pick.name}`
              }
              className={`flex items-center gap-2 bg-panel2/70 border rounded-lg px-2.5 py-2 min-w-0 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal focus-visible:ring-offset-2 focus-visible:ring-offset-panel active:scale-[0.98] ${
                isHighlighted ? "border-teal-dim ring-1 ring-teal/30" : "border-line hover:border-line-gold"
              }`}
            >
              <span className="w-7 h-7 rounded-md bg-black/30 border border-line overflow-hidden flex items-center justify-center flex-shrink-0">
                <IconWithFallback src={pick.icon} alt={pick.name} fallbackGlyph={pick.name} className="w-full h-full object-contain" size={28} />
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
