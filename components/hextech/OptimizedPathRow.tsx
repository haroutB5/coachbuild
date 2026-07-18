"use client";

import type { ItemsBlock, Pick as PickType } from "@/lib/types";
import { wpaClass, wpaText, fmtSample } from "@/components/StatBadge";
import { IconWithFallback } from "@/components/IconWithFallback";
import { resolveOptimizedPathView } from "./optimizedPath";

interface OptimizedPathRowProps {
  items: ItemsBlock;
  onItemClick: (id: number) => void;
}

function Arrow() {
  return (
    <span aria-hidden="true" className="text-mut/60 text-base select-none mt-4 flex-shrink-0">
      &rarr;
    </span>
  );
}

function OptimizedTile({
  pick,
  prev,
  onItemClick,
}: {
  pick: PickType;
  prev: PickType | null;
  onItemClick: (id: number) => void;
}) {
  const title = prev
    ? `${pick.name}, after ${prev.name} | WPA: ${wpaText(pick.wpa)} | ${fmtSample(pick.occurrence)} games`
    : `${pick.name} | WPA: ${wpaText(pick.wpa)} | ${fmtSample(pick.occurrence)} games`;
  return (
    <button
      type="button"
      onClick={() => onItemClick(pick.id)}
      title={title}
      aria-label={
        prev
          ? `View details for ${pick.name}, conditioned on owning ${prev.name}`
          : `View details for ${pick.name}`
      }
      className="flex flex-col items-center text-center w-[76px] flex-shrink-0 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal focus-visible:ring-offset-2 focus-visible:ring-offset-panel active:scale-95 transition-transform"
    >
      <span className="w-12 h-12 rounded-lg bg-black/30 border border-line-gold overflow-hidden flex items-center justify-center">
        <IconWithFallback
          src={pick.icon}
          alt={pick.name}
          fallbackGlyph={pick.name}
          className="w-full h-full object-contain"
          size={48}
        />
      </span>
      <span className="text-[10.5px] text-txt mt-1.5 leading-tight line-clamp-2 min-h-[26px]">
        {pick.name}
      </span>
      {prev && (
        <span className="text-[8.5px] text-mut/70 italic leading-tight truncate max-w-full">
          after {prev.name}
        </span>
      )}
      <span className={`text-[11px] font-bold tabular-nums ${wpaClass(pick.wpa)}`}>{wpaText(pick.wpa)}</span>
      <span className="text-[9.5px] text-mut tabular-nums">{fmtSample(pick.occurrence)}</span>
    </button>
  );
}

/**
 * Feature 2 (sequential item optimizer) — renders under CoreBuildOrderCard's
 * existing reliable core order. Three outcomes per resolveOptimizedPathView
 * (optimizedPath.ts, pure + unit-tested):
 *   - "none"      -> nothing (no empty shell)
 *   - "confirmed" -> optimizedPath is IDENTICAL to the reliable core path
 *                    (same ids, same order) -> a tiny note instead of a
 *                    duplicate strip
 *   - "path"      -> genuinely differs -> the full conditioned strip, each
 *                    item after the first subtly labeled "after <prev>"
 *                    (title tooltip + a small caption), WPA + sample size in
 *                    the same muted-stat style CoreBuildOrderCard/ItemPath use.
 */
export default function OptimizedPathRow({ items, onItemClick }: OptimizedPathRowProps) {
  const view = resolveOptimizedPathView(items);

  if (view.kind === "none") return null;

  if (view.kind === "confirmed") {
    return (
      <p className="mt-4 pt-4 border-t border-line/60 text-[10.5px] text-mut/70 italic">
        Order confirmed by conditioned data
      </p>
    );
  }

  return (
    <div className="mt-4 pt-4 border-t border-line/60">
      <p className="text-[10.5px] tracking-[0.14em] uppercase text-mut font-semibold mb-4">
        Optimized order
      </p>
      <div className="flex items-start flex-wrap gap-x-1 gap-y-4">
        {view.path.map((pick, i) => (
          <div key={`${pick.id}-${i}`} className="flex items-start">
            {i > 0 && <Arrow />}
            <OptimizedTile pick={pick} prev={i > 0 ? view.path[i - 1] : null} onItemClick={onItemClick} />
          </div>
        ))}
      </div>
    </div>
  );
}
