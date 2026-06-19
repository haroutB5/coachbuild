"use client";

import type { ItemsBlock, Pick as PickType } from "@/lib/types";
import { wpaClass, wpaText, fmtSample } from "./StatBadge";

function ImgWithFallback({
  src,
  alt,
  className,
}: {
  src: string;
  alt: string;
  className?: string;
}) {
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

interface ItemSlotProps {
  label: string;
  pick: PickType;
  isBoots?: boolean;
  alts?: PickType[];
}

function ItemSlot({ label, pick, isBoots, alts }: ItemSlotProps) {
  return (
    <div className="w-[84px] flex flex-col items-center text-center cursor-default group">
      <div
        className="text-[9.5px] tracking-[0.5px] uppercase font-bold min-h-[14px] mb-1.5 text-gold"
      >
        {label}
      </div>
      <div
        title={`${pick.name} | WPA: ${wpaText(pick.wpa)} | ${fmtSample(pick.occurrence)} picks`}
        className={`w-[52px] h-[52px] rounded-xl bg-black/30 overflow-hidden flex items-center justify-center transition-transform group-hover:scale-105 ${
          isBoots ? "border border-teal-dim" : "border border-line"
        }`}
      >
        <ImgWithFallback
          src={pick.icon}
          alt={pick.name}
          className="w-full h-full object-contain"
        />
      </div>
      <div className="text-[10.5px] text-txt mt-1.5 leading-tight min-h-[28px] flex items-center justify-center">
        {pick.name}
      </div>
      <div className={`font-extrabold text-[12px] ${wpaClass(pick.wpa)}`}>
        {wpaText(pick.wpa)}
      </div>
      <div className="text-[9.5px] text-mut">{fmtSample(pick.occurrence)}</div>

      {alts && alts.length > 0 && (
        <div className="mt-2 pt-1.5 border-t border-line/60 w-full">
          <div className="text-[8px] uppercase tracking-[0.5px] text-mut mb-1">
            or
          </div>
          <div className="flex justify-center gap-1">
            {alts.map((a, ai) => (
              <div
                key={`${a.id}-${ai}`}
                title={`${a.name} | WPA: ${wpaText(a.wpa)} | ${fmtSample(a.occurrence)} picks`}
                className="flex flex-col items-center"
              >
                <div className="w-[26px] h-[26px] rounded-md bg-black/30 border border-line overflow-hidden opacity-75 hover:opacity-100 transition-opacity">
                  <ImgWithFallback
                    src={a.icon}
                    alt={a.name}
                    className="w-full h-full object-contain"
                  />
                </div>
                <div className={`text-[8px] font-bold leading-tight ${wpaClass(a.wpa)}`}>
                  {wpaText(a.wpa)}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Arrow() {
  return (
    <div className="text-mut text-lg px-0.5 self-start mt-[30px] select-none">›</div>
  );
}

export default function ItemPath({ items }: { items: ItemsBlock }) {
  const { starter, boots, first, second, third, fourthPlus, alts } = items;

  const slots: {
    label: string;
    pick: PickType;
    isBoots?: boolean;
    alts?: PickType[];
  }[] = [
    { label: "Start", pick: starter },
    { label: "1st", pick: first, alts: alts?.first },
    { label: "Boots", pick: boots, isBoots: true, alts: alts?.boots },
    { label: "2nd", pick: second, alts: alts?.second },
    { label: "3rd", pick: third, alts: alts?.third },
    ...fourthPlus.map((p, i) => ({
      label: i === 0 ? "4th" : `${i + 4}th`,
      pick: p,
    })),
  ];

  return (
    <div>
      <p className="text-[11px] tracking-[1.5px] uppercase text-teal font-bold mb-1">
        Item Path
      </p>
      <p className="text-[11px] text-mut mb-4">
        Core path with situational swaps (the <span className="text-txt">or</span> row) per slot.
      </p>
      <div className="flex items-start flex-wrap gap-1">
        {slots.map((slot, i) => (
          <div key={`${slot.label}-${slot.pick.id}-${i}`} className="flex items-start gap-1">
            {i > 0 && <Arrow />}
            <ItemSlot
              label={slot.label}
              pick={slot.pick}
              isBoots={slot.isBoots}
              alts={slot.alts}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
