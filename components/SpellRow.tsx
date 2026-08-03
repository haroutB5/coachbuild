"use client";

import type { Pick } from "@/lib/types";
import { wpaText } from "./StatBadge";
import AnimatedWpa from "./AnimatedWpa";

interface SpellRowProps {
  spells: Pick[];
}

function ImgWithFallback({
  src,
  alt,
  className,
  size,
}: {
  src: string;
  alt: string;
  className?: string;
  size?: number;
}) {
  return (
    /* eslint-disable-next-line @next/next/no-img-element -- Summoner-spell icons are runtime CDN URLs and this wrapper intentionally hides failed art. */
    <img
      src={src}
      alt={alt}
      className={className}
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
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
                size={36}
              />
            </div>
            <div>
              <div className="text-txt text-sm font-medium leading-none mb-1">{spell.name}</div>
              <AnimatedWpa wpa={spell.wpa} className="text-xs font-bold" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
