"use client";

import type { PatchMover } from "@/lib/patchMovers";
import { IconWithFallback } from "@/components/IconWithFallback";
import { fmtSample } from "@/components/StatBadge";
import { deltaClass, deltaArrow, deltaText, wpaSwingText, moverKindLabel } from "./patchMoversFormat";

interface MoverRowProps {
  mover: PatchMover;
  /** Resolved champion icon URL (components/proAssets.ts's getChampionIconMap,
   *  fetched once by the page and shared across every row) — "" degrades
   *  gracefully via IconWithFallback's lettered-glyph fallback. */
  championIcon: string;
}

export default function MoverRow({ mover, championIcon }: MoverRowProps) {
  return (
    <div className="flex items-center gap-3 py-3 border-b border-line last:border-b-0">
      <span className="w-10 h-10 rounded-lg bg-black/30 border border-line overflow-hidden flex items-center justify-center flex-shrink-0">
        <IconWithFallback
          src={championIcon}
          alt={mover.championName}
          fallbackGlyph={mover.championName}
          className="w-full h-full object-contain"
          size={40}
        />
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-[13px] text-txt font-semibold truncate">{mover.championName}</span>
          <span className="text-[9px] tracking-[0.08em] uppercase font-bold px-1.5 py-0.5 rounded bg-panel2 text-mut border border-line flex-shrink-0">
            {moverKindLabel(mover.kind)}
          </span>
        </div>
        <div className="flex items-center gap-1.5 mt-1">
          <span className="w-5 h-5 rounded bg-black/30 border border-line overflow-hidden flex items-center justify-center flex-shrink-0">
            <IconWithFallback
              src={mover.iconHint}
              alt={mover.name}
              fallbackGlyph={mover.name}
              className="w-full h-full object-contain"
              size={20}
            />
          </span>
          <span className="text-[11.5px] text-mut truncate">{mover.name}</span>
        </div>
      </div>

      <div className="text-right flex-shrink-0">
        <div
          className={`text-[13.5px] font-bold tabular-nums flex items-center justify-end gap-1 ${deltaClass(mover.delta)}`}
        >
          <span aria-hidden="true">{deltaArrow(mover.delta)}</span>
          {deltaText(mover.delta)}
        </div>
        <div className="text-[9.5px] text-mut/70 tabular-nums">{wpaSwingText(mover.prevWpa, mover.currWpa)}</div>
        <div className="text-[9px] text-mut/60 tabular-nums">{fmtSample(mover.gamesCount)} games</div>
      </div>
    </div>
  );
}
