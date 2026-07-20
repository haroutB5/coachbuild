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

export default function SituationalCard({ items, onItemClick, highlightIds }: SituationalCardProps) {
  const ordered = withHighlightsFirst(flattenSituational(items), highlightIds ?? []);
  const situational = ordered.slice(0, 6);
  if (situational.length === 0) return null;

  return (
    <div className="bg-panel border border-line rounded-xl p-5">
      <p className="text-[10.5px] tracking-[0.14em] uppercase text-mut font-semibold mb-4">
        Situational
      </p>
      <div className="flex flex-wrap gap-2.5">
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
              className={`flex items-center gap-2 bg-panel2/70 border rounded-lg px-2.5 py-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal focus-visible:ring-offset-2 focus-visible:ring-offset-panel active:scale-[0.98] ${
                isHighlighted ? "border-teal-dim ring-1 ring-teal/30" : "border-line hover:border-line-gold"
              }`}
            >
              <span className="w-7 h-7 rounded-md bg-black/30 border border-line overflow-hidden flex items-center justify-center flex-shrink-0">
                <IconWithFallback src={pick.icon} alt={pick.name} fallbackGlyph={pick.name} className="w-full h-full object-contain" size={28} />
              </span>
              <div className="leading-tight">
                <div className="text-[11.5px] text-txt font-medium">{pick.name}</div>
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
