"use client";

import { useEffect, useState } from "react";
import type { ItemsBlock, Pick as PickType } from "@/lib/types";
import { wpaClass, wpaText } from "@/components/StatBadge";
import { IconWithFallback } from "@/components/IconWithFallback";
import { itemIconUrl } from "@/components/proAssets";
import { getItemDetailMap, type ItemDetail } from "@/components/itemDetail";
import { selectHiddenGemPicks } from "./itemSetBody";
import { flattenSituational } from "./situational";

/**
 * HIDDEN GEM — the fourth build category, on the page.
 *
 * WHY THIS EXISTS (2026-07-28): the four-category cut shipped Hidden gem to the
 * in-game shop only, so the one way to find out what your hidden gem was, was
 * to load a game. That is backwards for a build page.
 *
 * It calls `selectHiddenGemPicks` — the SAME function itemSetBody.ts uses to
 * build the shop block, over the same candidate pool and the same exclusion set
 * (the WPA build's own ids). That shared call is the whole point: a
 * reimplementation here would drift from the shop within a patch or two, and
 * two different answers to "what's my hidden gem" is worse than not shipping
 * the card at all.
 *
 * Renders NOTHING when nothing qualifies — measured on 2 of 9 sampled
 * champions. A card that appears for everyone would not be describing a gem.
 */
interface HiddenGemCardProps {
  items: ItemsBlock;
  /** ddragon/CDN version, already resolved by the parent from the build's own
   *  patch — reused so these icons match every other icon on the tab. */
  ver: string;
  onItemClick: (id: number) => void;
}

export default function HiddenGemCard({ items, ver, onItemClick }: HiddenGemCardProps) {
  const [meta, setMeta] = useState<Map<number, ItemDetail> | null>(null);

  useEffect(() => {
    let cancelled = false;
    // getItemDetailMap is module-level memoized and never throws (it degrades
    // to an empty map), so this shares the SAME cached promise the item-set
    // export and the detail popovers already use — no extra network cost.
    getItemDetailMap(ver)
      .then((m) => {
        if (!cancelled) setMeta(m);
      })
      .catch(() => {
        if (!cancelled) setMeta(new Map());
      });
    return () => {
      cancelled = true;
    };
  }, [ver]);

  // No metadata yet -> render nothing rather than a placeholder that might
  // resolve to nothing anyway. This card is frequently absent by design, so a
  // skeleton would flash on champions that never had a gem to show.
  if (!meta) return null;

  // Same pool and same exclusion basis as itemSetBody's shop block.
  const wpaBuildIds = new Set<number>(
    [items.first, items.second, items.third, items.boots, ...items.fourthPlus]
      .filter(Boolean)
      .map((p) => p.id)
  );
  const pool: PickType[] = [
    items.first,
    items.second,
    items.third,
    items.boots,
    ...items.fourthPlus,
    ...(items.optimizedPath ?? []),
    ...flattenSituational(items),
  ].filter(Boolean);

  const gems = selectHiddenGemPicks(pool, wpaBuildIds, meta).slice(0, 4);
  if (gems.length === 0) return null;

  return (
    <div className="py-4 first:pt-0 last:pb-0">
      <p className="text-[10.5px] tracking-[0.14em] uppercase text-mut font-semibold mb-1">
        Hidden Gem{" "}
        <span className="text-mut/60 normal-case tracking-normal font-normal">
          — high win rate, rarely built
        </span>
      </p>
      {/* States the actual claim, so the card can be judged rather than
          trusted. The numbers under each item are the evidence for it. */}
      <p className="text-[10.5px] text-mut/70 normal-case mb-4 leading-relaxed">
        Not in your build above, but winning well above average for this champion while almost nobody
        buys it.
      </p>
      <div className="grid grid-cols-1 min-[420px]:grid-cols-2 gap-2.5">
        {gems.map((pick) => (
          <button
            key={pick.id}
            type="button"
            onClick={() => onItemClick(pick.id)}
            aria-label={`View details for ${pick.name} — ${
              pick.winrate != null ? `${pick.winrate.toFixed(1)}% win rate` : "win rate unavailable"
            } across ${pick.occurrence.toLocaleString()} games`}
            className="flex items-center gap-2.5 rounded-lg bg-panel2/60 border border-line/60 px-2.5 py-2 text-left hover:border-line-gold transition-colors active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal focus-visible:ring-offset-2 focus-visible:ring-offset-panel"
          >
            <span className="w-8 h-8 rounded-md bg-black/30 overflow-hidden flex-shrink-0 flex items-center justify-center">
              <IconWithFallback
                src={itemIconUrl(pick.id, ver)}
                alt={pick.name}
                fallbackGlyph={pick.name}
                className="w-full h-full object-contain"
                size={32}
              />
            </span>
            <span className="min-w-0">
              <span className="block text-[11.5px] text-txt leading-tight truncate">{pick.name}</span>
              <span className="block text-[10px] text-mut/70 tabular-nums leading-tight">
                {/* Win rate is the claim; games is what makes it credible. Both
                    are shown because either alone is misleading. */}
                {pick.winrate != null ? `${pick.winrate.toFixed(1)}% win` : "—"}
                {" · "}
                {pick.occurrence.toLocaleString()} games
                {" · "}
                <span className={wpaClass(pick.wpa)}>{wpaText(pick.wpa)}</span>
              </span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
