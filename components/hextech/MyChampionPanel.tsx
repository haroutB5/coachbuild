"use client";

// ─────────────────────────────────────────────────────────────────────────────
// MyChampionPanel — "MY CHAMPION" panel (draft redesign plan §3): a large
// framed portrait, the existing hover-your-champ ChampionPicker (unchanged
// handler: onHoverChange, plus onClearHover), and 5 lane-role icon toggles
// replacing LaneFilterPills' text-pill row for this specific panel (same
// underlying handler: onLaneChange — this is purely a visual swap, not a new
// piece of state). Icons are hand-rolled inline SVG glyphs (no new asset/
// icon-pack dependency, consistent with the rest of this ship's "no new npm
// deps mid-parallel-run" call — see HANDOFF-fronty.md).
// ─────────────────────────────────────────────────────────────────────────────

import type { ChampionRef } from "@/lib/types";
import { IconWithFallback } from "@/components/IconWithFallback";
import ChampionPicker from "@/components/ChampionPicker";
import { LANE_ORDER, LANE_LABEL, type LaneId } from "./heroContracts";

interface MyChampionPanelProps {
  lane: LaneId;
  onLaneChange: (lane: LaneId) => void;
  hoverChamp: ChampionRef | null;
  onHoverChange: (champ: ChampionRef) => void;
  onClearHover: () => void;
}

function LaneGlyph({ lane }: { lane: LaneId }) {
  const common = { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  switch (lane) {
    case "top":
      return (
        <svg {...common} aria-hidden="true">
          <path d="M12 3v13M12 16l-3.5 5h7L12 16Z" />
          <path d="M8.5 6h7" />
        </svg>
      );
    case "jungle":
      return (
        <svg {...common} aria-hidden="true">
          <path d="M12 21c-4-1.5-6-5-6-9 0-3 1.5-6 6-9 4.5 3 6 6 6 9 0 4-2 7.5-6 9Z" />
          <path d="M12 21V9" />
        </svg>
      );
    case "mid":
      return (
        <svg {...common} aria-hidden="true">
          <path d="M12 3l7 4v5c0 5-3 8.5-7 9-4-.5-7-4-7-9V7l7-4Z" />
          <path d="M12 8v7" />
        </svg>
      );
    case "bot":
      return (
        <svg {...common} aria-hidden="true">
          <path d="M4 20 20 4" />
          <path d="M9 4h11v11" />
        </svg>
      );
    case "support":
      return (
        <svg {...common} aria-hidden="true">
          <path d="M12 21s7-3.5 7-9.5V6l-7-3-7 3v5.5C5 17.5 12 21 12 21Z" />
          <path d="M9 11.5 11 13.5 15.5 9" />
        </svg>
      );
  }
}

export default function MyChampionPanel({ lane, onLaneChange, hoverChamp, onHoverChange, onClearHover }: MyChampionPanelProps) {
  return (
    <div className="dt-panel p-4">
      <p className="text-[10px] tracking-[0.14em] uppercase text-[color:var(--dt-cyan)] font-semibold mb-1">My champion</p>
      {/* Audit P2-3: the old page said "(for ban suggestions)" — without this
          hint the bans section is silently absent and nothing tells the user
          how to unlock it. */}
      <p className="text-[10.5px] text-[color:var(--dt-mut)] mb-3">Set your champion to unlock ban suggestions.</p>

      <div className="flex justify-center mb-3">
        <div className="dt-panel-glow dt-chamfer-sm w-24 h-24 flex items-center justify-center overflow-hidden bg-black/30">
          {hoverChamp ? (
            <IconWithFallback src={hoverChamp.icon} alt={hoverChamp.name} fallbackGlyph={hoverChamp.name} className="w-full h-full object-cover" size={96} />
          ) : (
            <span className="text-[10.5px] text-[color:var(--dt-mut)] text-center px-2">Select your champion</span>
          )}
        </div>
      </div>

      <div role="group" aria-label="Lane" className="flex items-center justify-center gap-1.5 mb-3">
        {LANE_ORDER.map((l) => {
          const active = lane === l;
          return (
            <button
              key={l}
              type="button"
              onClick={() => onLaneChange(l)}
              aria-pressed={active}
              aria-label={LANE_LABEL[l]}
              title={LANE_LABEL[l]}
              className={`w-9 h-9 flex items-center justify-center rounded-md border transition-colors active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--dt-cyan)] ${
                active
                  ? "bg-[color:var(--dt-cyan)] text-black border-[color:var(--dt-cyan)]"
                  : "bg-transparent text-[color:var(--dt-mut)] border-[color:var(--dt-line)] hover:border-[color:var(--dt-cyan-dim)] hover:text-[color:var(--dt-txt)]"
              }`}
            >
              <LaneGlyph lane={l} />
            </button>
          );
        })}
      </div>

      <div className="flex items-center gap-2">
        <div className="flex-1">
          <ChampionPicker value={hoverChamp} onChange={onHoverChange} />
        </div>
        {hoverChamp !== null && (
          <button
            type="button"
            onClick={onClearHover}
            className="text-[11px] text-[color:var(--dt-mut)] hover:text-[color:var(--dt-txt)] underline decoration-dotted underline-offset-2 flex-shrink-0"
          >
            Clear
          </button>
        )}
      </div>
    </div>
  );
}
