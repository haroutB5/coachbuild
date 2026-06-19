"use client";

import type { Pick } from "@/lib/types";
import StatBadge, { wpaClass, wpaText } from "./StatBadge";

interface SpellRowProps {
  spells: Pick[];
}

function ImgWithFallback({ src, alt, className }: { src: string; alt: string; className?: string }) {
  return (
    <img
      src={src}
      alt={alt}
      className={className}
      onError={(e) => {
        (e.currentTarget as HTMLImageElement).style.display = "none";
      }}
    />
  );
}

export default function SpellRow({ spells }: SpellRowProps) {
  return (
    <div>
      <p className="text-[11px] tracking-[1.5px] uppercase text-teal font-bold mb-3">
        Summoner Spells
      </p>
      <div className="flex gap-3 flex-wrap">
        {spells.map((spell) => (
          <div
            key={spell.id}
            className="flex items-center gap-3 bg-panel2 border border-line rounded-xl px-4 py-2.5 hover:border-teal-dim transition-colors"
            title={`WPA: ${wpaText(spell.wpa)} | ${spell.occurrence.toLocaleString()} picks`}
          >
            <div className="w-9 h-9 rounded-lg overflow-hidden flex-shrink-0 bg-black/30">
              <ImgWithFallback
                src={spell.icon}
                alt={spell.name}
                className="w-full h-full object-contain"
              />
            </div>
            <div>
              <div className="text-txt text-sm font-medium leading-none mb-1">{spell.name}</div>
              <div className={`text-xs font-bold ${wpaClass(spell.wpa)}`}>
                {wpaText(spell.wpa)}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
