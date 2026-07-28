"use client";

import type { ItemsBlock, Pick as PickType } from "@/lib/types";
import { wpaClass, wpaText } from "@/components/StatBadge";
import { IconWithFallback } from "@/components/IconWithFallback";
import OptimizedPathRow from "./OptimizedPathRow";

interface CoreBuildOrderCardProps {
  items: ItemsBlock;
  onItemClick: (id: number) => void;
}

function ItemSquare({ pick, onItemClick }: { pick: PickType; onItemClick: (id: number) => void }) {
  return (
    <button
      type="button"
      onClick={() => onItemClick(pick.id)}
      aria-label={`View details for ${pick.name}`}
      className="flex flex-col items-center text-center w-[76px] flex-shrink-0 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal focus-visible:ring-offset-2 focus-visible:ring-offset-panel active:scale-95 transition-transform"
    >
      <span className="w-12 h-12 rounded-lg bg-black/30 border border-line-gold overflow-hidden flex items-center justify-center">
        <IconWithFallback src={pick.icon} alt={pick.name} fallbackGlyph={pick.name} className="w-full h-full object-contain" size={48} />
      </span>
      <span className="text-[10.5px] text-txt mt-1.5 leading-tight line-clamp-2 min-h-[26px]">{pick.name}</span>
      <span className={`text-[11px] font-bold tabular-nums ${wpaClass(pick.wpa)}`}>{wpaText(pick.wpa)}</span>
    </button>
  );
}

function Arrow() {
  return (
    <span aria-hidden="true" className="text-mut/60 text-base select-none mt-4 flex-shrink-0">
      &rarr;
    </span>
  );
}

export default function CoreBuildOrderCard({ items, onItemClick }: CoreBuildOrderCardProps) {
  // Progression order matching the spec: 1st -> 2nd -> 3rd legendary, then
  // boots, then any 4th+ items — deliberately NOT the same slot order as the
  // legacy ItemPath.tsx (starter/boots-early), since "Starting" now has its
  // own card and the spec screenshot shows boots landing after the core 3.
  const order: PickType[] = [items.first, items.second, items.third, items.boots, ...items.fourthPlus];

  // v0.51.0: no longer its own bordered card — nested inside ItemBuildCard.tsx
  // (mockup 4/5's merged "ITEM BUILD" card). Label updated to match the
  // mockup's "CORE ORDER — HIGHEST WPA" wording exactly.
  return (
    <div className="py-4 first:pt-0 last:pb-0">
      {/* The qualifier describes how each SLOT is filled (the highest-WPA
          option for that slot), not the sequence — the sequence is buy order.
          Read as "the whole list is sorted by WPA" it contradicts itself the
          moment a late slot's best available option is negative, which is a
          real state and one users have seen (Jinx's 6th item at -0.02). Say
          what it means instead of letting the number look like a bug. */}
      {/* Renamed from "Core Order — buy order" 2026-07-28. The in-game shop
          block carrying these exact items is titled "WPA build", and the page
          calling the same thing something else is a vocabulary split the user
          has to reconcile themselves. One name, both surfaces. "buy order" is
          kept as the qualifier because the arrows genuinely are a sequence. */}
      <p className="text-[10.5px] tracking-[0.14em] uppercase text-mut font-semibold mb-1">
        WPA Build <span className="text-mut/60 normal-case tracking-normal font-normal">— buy order</span>
      </p>
      {/* WPA is the app's central number and appeared NOWHERE in prose before
          v0.60.1 — every green/red figure on this page is one, on a scale
          nothing explained. Defined once, here, where the first labelled WPA
          lives; /compact renders this same card and inherits it.
          v0.71.1: the DEFINITION stays inline (a returning user still needs the
          scale named), but the two sentences of mechanics moved behind a tap.
          It was ~4 lines of prose on every mobile visit, above the build the
          user actually opened the page for. Native <details> so it needs no
          state, no JS, and stays keyboard- and screen-reader-operable. */}
      <details className="group mb-4">
        <summary className="text-[10.5px] text-mut/70 normal-case leading-relaxed cursor-pointer list-none marker:content-none focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-teal rounded-sm">
          <span className="text-txt/80">WPA is Win Probability Added</span>
          <span className="text-mut/50"> — how much a pick shifts your chance of winning. </span>
          <span className="text-teal-dim underline decoration-dotted underline-offset-2 group-open:hidden">
            More
          </span>
          <span className="text-teal-dim underline decoration-dotted underline-offset-2 hidden group-open:inline">
            Less
          </span>
        </summary>
        <p className="text-[10.5px] text-mut/70 normal-case mt-2 leading-relaxed">
          Measured by coachless.gg. Each slot shows the highest-WPA option for that point in the
          build; a negative value means even the best option there trends slightly below average.
        </p>
      </details>
      <div className="flex items-start flex-wrap gap-x-1 gap-y-4">
        {order.map((pick, i) => (
          <div key={`${pick.id}-${i}`} className="flex items-start">
            {i > 0 && <Arrow />}
            <ItemSquare pick={pick} onItemClick={onItemClick} />
          </div>
        ))}
      </div>

      {/* Feature 2 (sequential item optimizer) — nothing when
          items.optimizedPath is absent/empty, a tiny confirmation note when
          it matches this same core order, or its own conditioned strip when
          it genuinely differs. See OptimizedPathRow.tsx. */}
      <OptimizedPathRow items={items} onItemClick={onItemClick} />
    </div>
  );
}
