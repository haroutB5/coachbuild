"use client";

import type { RunesBlock, Pick as PickType } from "@/lib/types";
import { wpaClass, wpaText } from "@/components/StatBadge";
import { IconWithFallback } from "@/components/IconWithFallback";

function CardHeader({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[10.5px] tracking-[0.14em] uppercase text-mut font-semibold mb-3.5">
      {children}
    </p>
  );
}

function ShardDot({ pick }: { pick: PickType }) {
  return (
    <span
      className="w-[18px] h-[18px] rounded-full bg-black/30 border border-line overflow-hidden flex items-center justify-center flex-shrink-0"
      title={`${pick.name} — WPA ${wpaText(pick.wpa)}`}
    >
      <IconWithFallback src={pick.icon} alt={pick.name} className="w-full h-full object-contain" size={18} />
    </span>
  );
}

interface RunesSummonersCardProps {
  runes: RunesBlock;
  spells: PickType[];
}

export default function RunesSummonersCard({ runes, spells }: RunesSummonersCardProps) {
  const { secondaryTree, keystone, shards } = runes;

  return (
    <div className="bg-panel border border-line rounded-xl p-5">
      <CardHeader>Runes &amp; Summoners</CardHeader>

      <div className="flex flex-wrap items-center gap-x-6 gap-y-4">
        {/* Keystone */}
        <div className="flex items-center gap-3">
          <span className="w-12 h-12 rounded-full bg-black/30 border-2 border-teal overflow-hidden flex items-center justify-center flex-shrink-0 shadow-[0_0_14px_rgba(200,170,110,0.3)]">
            <IconWithFallback src={keystone.icon} alt={keystone.name} className="w-full h-full object-contain" size={48} />
          </span>
          <div>
            <div className="text-[13.5px] font-semibold text-txt leading-tight">{keystone.name}</div>
            <div className={`text-[12px] font-bold tabular-nums ${wpaClass(keystone.wpa)}`}>
              {wpaText(keystone.wpa)}
            </div>
          </div>
        </div>

        {/* Secondary tree + shards */}
        <div className="flex items-center gap-2.5">
          <span className="w-7 h-7 rounded-full bg-black/20 overflow-hidden flex items-center justify-center flex-shrink-0">
            <IconWithFallback
              src={secondaryTree.icon}
              alt={secondaryTree.name}
              className="w-full h-full object-contain"
              size={28}
            />
          </span>
          <span className="text-[12.5px] text-txt font-medium">{secondaryTree.name}</span>
          <span className="flex items-center gap-1 ml-1">
            <ShardDot pick={shards.offense} />
            <ShardDot pick={shards.flex} />
            <ShardDot pick={shards.defense} />
          </span>
        </div>

        {/* Summoner spells */}
        <div className="flex items-center gap-2 ml-auto">
          {spells.map((spell) => (
            <span
              key={spell.id}
              className="w-8 h-8 rounded-md bg-black/30 border border-line overflow-hidden flex items-center justify-center flex-shrink-0"
              title={`${spell.name} — WPA ${wpaText(spell.wpa)}`}
            >
              <IconWithFallback src={spell.icon} alt={spell.name} className="w-full h-full object-contain" size={32} />
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
