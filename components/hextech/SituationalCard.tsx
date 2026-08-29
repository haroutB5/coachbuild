"use client";

import type { ItemsBlock, Pick as PickType } from "@/lib/types";
import { wpaClass, wpaText } from "@/components/StatBadge";
import { IconWithFallback } from "@/components/IconWithFallback";
import { flattenSituational, SITUATIONAL_DISPLAY_LIMIT, orderSituationalForComp } from "./situational";
import type { CompSignal } from "@/lib/enemyComp/compSignal";

interface SituationalCardProps {
  items: ItemsBlock;
  onItemClick: (id: number) => void;
  /**
   * The enemy-composition signal, or null when no rule fired (the common
   * case). Replaces the old `highlightIds: number[]` prop, which carried the
   * WHAT with no WHY: a ring around an item with nothing saying why it is
   * ringed is the "specific, unbacked claim" HARD RULE 4 exists to stop. The
   * signal carries its own reason and its own measured cost, so the card can
   * show both or neither.
   *
   * Optional and additive: a caller that omits it renders exactly as before.
   */
  compSignal?: CompSignal | null;
}

// v0.51.0: no longer its own bordered card, nested inside ItemBuildCard.tsx
// (mockup 4/5's merged "ITEM BUILD" card), and switched from a flex-wrap chip
// row to a 2-col grid.
//
// FIDELITY NOTE, UPDATED 2026-08-29. The mockup labelled each row with a short
// contextual REASON string ("vs dive & burst"), and this file used to say that
// no such field exists on the wire so the WPA delta stands in rather than
// fabricating flavour text. Half of that is now out of date: there IS a real
// reason available, but only when the companion is in champ select AND the
// comp clears a threshold, and it is a DERIVED reason with a measured cost
// attached, never flavour text. It is shown per-CARD (one line, naming the
// rule) rather than per-row, because the claim is about the comp, not about
// each individual item.
export default function SituationalCard({ items, onItemClick, compSignal }: SituationalCardProps) {
  const promotedIds = compSignal?.promotedIds ?? [];
  const ordered = orderSituationalForComp(flattenSituational(items), promotedIds);
  // SITUATIONAL_DISPLAY_LIMIT, not a literal 6: itemSetBody.ts ships this same
  // window into the in-game shop as a "Situational" block, and the two must
  // not drift. With no signal (the common case) this is byte-identical to
  // situationalShortlist(items).
  const situational = ordered.slice(0, SITUATIONAL_DISPLAY_LIMIT);
  if (situational.length === 0) return null;

  const promoted = new Set(promotedIds);

  return (
    <div className="py-4 first:pt-0 last:pb-0">
      <div className="flex items-baseline gap-2 flex-wrap mb-1">
        <p className="text-[10.5px] tracking-[0.14em] uppercase text-mut font-semibold">Situational</p>
        {compSignal && (
          <span className="text-[10.5px] tracking-[0.14em] uppercase text-teal font-semibold">
            {compSignal.labelSuffix}
          </span>
        )}
      </div>
      {compSignal && (
        // The honesty line. It states the reason, the cost of taking it, and
        // that the reordering is a suggestion rather than a replacement: the
        // block still holds the same items it would have held, and the build
        // above is unchanged. `wpaCost` is signed the intuitive way (positive
        // means the swap is worse than the model's own boot), so it is printed
        // rather than run through wpaText, whose sign convention is the other
        // one.
        <p className="text-[10px] text-mut leading-snug mb-3">
          Reordered against the enemy comp, not replaced. Costs{" "}
          <span className="tabular-nums text-txt">{compSignal.wpaCost.toFixed(2)}</span> WPA against the
          recommended boots.{" "}
          {compSignal.evidence.estimatedCount > 0 && "Some enemy kit ratings are estimated. "}
          Curated kit ratings, not a measured stat.
        </p>
      )}
      {!compSignal && <div className="mb-3" />}
      <div className="grid grid-cols-1 min-[420px]:grid-cols-2 gap-2.5">
        {situational.map((pick: PickType) => {
          const isPromoted = promoted.has(pick.id);
          return (
            <button
              key={pick.id}
              type="button"
              onClick={() => onItemClick(pick.id)}
              aria-label={
                isPromoted
                  ? `View details for ${pick.name}, suggested ${compSignal?.labelSuffix ?? "against this comp"}`
                  : `View details for ${pick.name}`
              }
              className={`flex items-center gap-2 bg-panel2/70 border rounded-lg px-2.5 py-2 min-w-0 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal focus-visible:ring-offset-2 focus-visible:ring-offset-panel active:scale-[0.98] ${
                isPromoted ? "border-teal-dim ring-1 ring-teal/30" : "border-line hover:border-line-gold"
              }`}
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
