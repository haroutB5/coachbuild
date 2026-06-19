"use client";

import type { BuildResponse } from "@/lib/types";
import RunePage from "./RunePage";
import ItemPath from "./ItemPath";
import SpellRow from "./SpellRow";

interface BuildCardProps {
  build: BuildResponse;
}

export default function BuildCard({ build }: BuildCardProps) {
  return (
    <div className="bg-gradient-to-b from-panel to-[#0d121a] border border-line rounded-2xl overflow-hidden shadow-[0_8px_30px_rgba(0,0,0,0.35)] mt-6">
      {/* Card header */}
      <div className="flex items-center gap-4 px-5 py-4 border-b border-line bg-gradient-to-r from-teal/10 to-transparent">
        <div>
          <div className="text-xs text-mut">
            Patch <span className="text-txt font-semibold">{build.patch}</span>
            {" · "}
            <span className="text-txt font-semibold">{build.tierLabel}</span>
            {" · "}
            Data from{" "}
            <a
              href="https://coachless.gg"
              target="_blank"
              rel="noopener noreferrer"
              className="text-teal hover:underline"
            >
              coachless.gg
            </a>
          </div>
        </div>
        <div className="ml-auto text-[11px] text-mut">
          WPA:{" "}
          <span className="text-txt">Win Probability Added</span>
          {" · positive = adds win %"}
        </div>
      </div>

      {/* WPA legend */}
      <div className="flex gap-5 px-5 py-3 border-b border-line/60 bg-black/10 text-[11.5px] text-mut flex-wrap">
        <span className="flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-[3px] inline-block bg-good" />
          positive WPA (adds win %)
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-[3px] inline-block bg-bad" />
          negative WPA
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-[3px] inline-block bg-teal" />
          keystone / highlighted
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-[3px] inline-block bg-gold" />
          item path slot
        </span>
      </div>

      {/* Runes section */}
      <div className="px-5 py-5 border-b border-dashed border-line">
        <RunePage runes={build.runes} />
      </div>

      {/* Items section */}
      <div className="px-5 py-5 border-b border-dashed border-line">
        <ItemPath items={build.items} />
      </div>

      {/* Spells section */}
      <div className="px-5 py-5">
        <SpellRow spells={build.spells} />
      </div>
    </div>
  );
}
