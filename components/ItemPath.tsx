"use client";

import type { ItemsBlock, Pick as PickType } from "@/lib/types";
import { IconWithFallback } from "@/components/IconWithFallback";
import { fmtSample, wpaClass, wpaText } from "@/components/StatBadge";
import { BuildPathArrow, CARD_CLASS, SectionLabel } from "@/components/hextech/builds/BuildVisuals";

function ItemNode({ label, pick, isBoots = false, alts = [] }: { label: string; pick: PickType; isBoots?: boolean; alts?: PickType[] }) {
  return (
    <div className="flex min-w-[70px] flex-col items-center text-center">
      <span className="mb-1 text-[8px] font-semibold uppercase tracking-[0.1em] text-[#9397ab]/55">{label}</span>
      <span className={`flex h-[46px] w-[46px] items-center justify-center overflow-hidden rounded-[8px] ${isBoots ? "shadow-[inset_0_0_0_1px_rgba(70,199,155,0.55)]" : "shadow-[inset_0_0_0_1px_rgba(233,233,237,0.12)]"} bg-[linear-gradient(150deg,#2b2e42,#1c1e2c)]`}>
        <IconWithFallback src={pick.icon} alt={pick.name} fallbackGlyph={pick.name} className="h-full w-full object-cover" size={46} />
      </span>
      <span className="mt-1.5 line-clamp-2 min-h-[24px] max-w-[76px] text-[9px] leading-tight text-[#e9e9ed]/75">{pick.name}</span>
      <span className={`mt-0.5 text-[9px] font-semibold tabular-nums ${wpaClass(pick.wpa)}`}>{wpaText(pick.wpa)}</span>
      <span className="text-[8px] tabular-nums text-[#9397ab]/55">{fmtSample(pick.occurrence)}</span>
      {alts.length > 0 && <span className="mt-1 text-[8px] uppercase tracking-[0.08em] tabular-nums text-[#9397ab]/55">+{alts.length} alt</span>}
    </div>
  );
}
export default function ItemPath({ items }: { items: ItemsBlock }) {
  const slots: { label: string; pick: PickType; isBoots?: boolean; alts?: PickType[] }[] = [
    { label: "Start", pick: items.starter },
    { label: "Boots", pick: items.boots, isBoots: true, alts: items.alts?.boots },
    { label: "1st", pick: items.first, alts: items.alts?.first },
    { label: "2nd", pick: items.second, alts: items.alts?.second },
    { label: "3rd", pick: items.third, alts: items.alts?.third },
    ...items.fourthPlus.map((pick, index) => ({ label: `${index + 4}th`, pick })),
  ].slice(0, 6);

  return (
    <section className={`${CARD_CLASS} p-4`}>
      <SectionLabel>Item path</SectionLabel>
      <p className="mt-1 text-[10px] leading-relaxed text-[#9397ab]/60">The six-slot view keeps starting items, boots, and completed items honest.</p>
      <div className="mt-4 flex items-start gap-1 overflow-x-auto pb-1">
        {slots.map((slot, index) => <div key={`${slot.pick.id}-${index}`} className="flex items-start gap-1">{index > 0 && <BuildPathArrow />}<ItemNode {...slot} /></div>)}
      </div>
    </section>
  );
}
