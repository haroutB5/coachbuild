"use client";

// ─────────────────────────────────────────────────────────────────────────────
// MyChampionPanel — "MY CHAMPION" panel (draft redesign plan §3): a large
// framed portrait, the existing hover-your-champ ChampionPicker (unchanged
// handler: onHoverChange, plus onClearHover), and 5 lane-role icon toggles
// replacing LaneFilterPills' text-pill row for this specific panel (same
// underlying handler: onLaneChange — this is purely a visual swap, not a new
// piece of state). Icons are inlined path data traced from Riot's OWN
// champ-select position glyphs (CommunityDragon
// raw.communitydragon.org/latest/plugins/rcp-fe-lol-champ-select/global/
// default/svg/position-{top,jungle,middle,bottom,utility}.svg, fetched
// 2026-07-22) — not hand-drawn placeholders, no hotlink (strict-SW/offline +
// this app's self-contained-asset convention), no new npm dep. Riot's source
// splits each non-jungle/support glyph into a faint always-on frame
// (opacity .5) plus a bright corner-bracket "active" accent; both are kept
// here as one fill="currentColor" icon (opacity baked into the frame path)
// so the EXISTING active/inactive theming contract (cyan fill vs muted text)
// still drives the whole glyph via currentColor, same as before.
// ─────────────────────────────────────────────────────────────────────────────

import type { ChampionRef } from "@/lib/types";
import { IconWithFallback } from "@/components/IconWithFallback";
import ChampionPicker from "@/components/ChampionPicker";
import { LANE_ORDER, LANE_LABEL, type LaneId } from "./heroContracts";

function LaneGlyph({ lane }: { lane: LaneId }) {
  const common = { width: 16, height: 16, viewBox: "0 0 34 34", fill: "currentColor" as const };
  switch (lane) {
    case "top":
      return (
        <svg {...common} aria-hidden="true">
          <path opacity="0.5" fillRule="evenodd" d="M21,14H14v7h7V14Zm5-3V26L11.014,26l-4,4H30V7.016Z" />
          <polygon points="4 4 4.003 28.045 9 23 9 9 23 9 28.045 4.003 4 4" />
        </svg>
      );
    case "jungle":
      return (
        <svg {...common} aria-hidden="true">
          <path fillRule="evenodd" d="M25,3c-2.128,3.3-5.147,6.851-6.966,11.469A42.373,42.373,0,0,1,20,20a27.7,27.7,0,0,1,1-3C21,12.023,22.856,8.277,25,3ZM13,20c-1.488-4.487-4.76-6.966-9-9,3.868,3.136,4.422,7.52,5,12l3.743,3.312C14.215,27.917,16.527,30.451,17,31c4.555-9.445-3.366-20.8-8-28C11.67,9.573,13.717,13.342,13,20Zm8,5a15.271,15.271,0,0,1,0,2l4-4c0.578-4.48,1.132-8.864,5-12C24.712,13.537,22.134,18.854,21,25Z" />
        </svg>
      );
    case "mid":
      return (
        <svg {...common} aria-hidden="true">
          <path opacity="0.5" fillRule="evenodd" d="M30,12.968l-4.008,4L26,26H17l-4,4H30ZM16.979,8L21,4H4V20.977L8,17,8,8h8.981Z" />
          <polygon points="25 4 4 25 4 30 9 30 30 9 30 4 25 4" />
        </svg>
      );
    case "bot":
      return (
        <svg {...common} aria-hidden="true">
          <path opacity="0.5" fillRule="evenodd" d="M13,20h7V13H13v7ZM4,4V26.984l3.955-4L8,8,22.986,8l4-4H4Z" />
          <polygon points="29.997 5.955 25 11 25 25 11 25 5.955 29.997 30 30 29.997 5.955" />
        </svg>
      );
    case "support":
      return (
        <svg {...common} aria-hidden="true">
          <path fillRule="evenodd" d="M26,13c3.535,0,8-4,8-4H23l-3,3,2,7,5-2-3-4h2ZM22,5L20.827,3H13.062L12,5l5,6Zm-5,9-1-1L13,28l4,3,4-3L18,13ZM11,9H0s4.465,4,8,4h2L7,17l5,2,2-7Z" />
        </svg>
      );
  }
}

interface MyChampionPanelProps {
  lane: LaneId;
  onLaneChange: (lane: LaneId) => void;
  hoverChamp: ChampionRef | null;
  onHoverChange: (champ: ChampionRef) => void;
  onClearHover: () => void;
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
