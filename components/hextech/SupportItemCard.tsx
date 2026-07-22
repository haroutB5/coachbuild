"use client";

import type { BuildResponse, ChampionRef } from "@/lib/types";
import { IconWithFallback } from "@/components/IconWithFallback";
import { resolveSupportItemSuggestion, type SupportArchetype } from "./supportItem";

interface SupportItemCardProps {
  champ: ChampionRef;
  build: BuildResponse;
  ver: string;
  onItemClick: (id: number) => void;
}

const ARCHETYPE_LABEL: Record<SupportArchetype, string> = {
  Enchanter: "Enchanter",
  "Tank/Engage": "Tank/Engage",
  "AP/Poke": "AP/Poke",
  "AD/Aggressive": "AD/Aggressive",
};

/** Support-role-only card (rendered by BuildTabContent when lane === "support")
 *  showing which of the 5 support quest-item finals (Bloodsong / Celestial
 *  Opposition / Dream Maker / Solstice Sleigh / Zaz'Zak's Realmspike) to
 *  build off World Atlas. See components/hextech/supportItem.ts's module
 *  header for why this is virtually always a labelled SUGGESTION rather than
 *  a measured pick (the upstream build data never surfaces one — verified
 *  live, not a filter this app applies). Deliberately a separate card, not
 *  folded into CoreBuildOrderCard: that card renders build.items verbatim
 *  from the API contract, and mutating it here would misrepresent what the
 *  API actually returned — see HANDOFF-engy.md's v0.49.0 entry. */
export default function SupportItemCard({ champ, build, ver, onItemClick }: SupportItemCardProps) {
  const suggestion = resolveSupportItemSuggestion(champ, build, ver);

  return (
    <div className="bg-panel border border-line rounded-xl p-5 h-full">
      <p className="text-[10.5px] tracking-[0.14em] uppercase text-mut font-semibold mb-3.5">
        Support Item Upgrade
      </p>
      <button
        type="button"
        onClick={() => onItemClick(suggestion.item.id)}
        aria-label={`View details for ${suggestion.item.name}`}
        className="flex items-center gap-3 w-full text-left rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal focus-visible:ring-offset-2 focus-visible:ring-offset-panel active:scale-[0.98] transition-transform"
      >
        <span className="w-10 h-10 rounded-lg bg-black/30 border border-line overflow-hidden flex items-center justify-center flex-shrink-0">
          <IconWithFallback
            src={suggestion.icon}
            alt={suggestion.item.name}
            fallbackGlyph={suggestion.item.name}
            className="w-full h-full object-contain"
            size={40}
          />
        </span>
        <span className="flex flex-col min-w-0">
          <span className="text-[12.5px] text-txt font-medium leading-tight">{suggestion.item.name}</span>
          <span className="text-[10.5px] text-mut leading-tight mt-0.5">
            {suggestion.measured
              ? "From your recommended build"
              : `Suggested — ${ARCHETYPE_LABEL[suggestion.archetype]} build, not measured`}
          </span>
        </span>
      </button>
    </div>
  );
}
