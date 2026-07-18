"use client";

import { LANE_ORDER, LANE_LABEL, type LaneId } from "./heroContracts";

interface LaneFilterPillsProps {
  value: LaneId;
  onChange: (lane: LaneId) => void;
}

/**
 * Lane-only pill row for /movers — same visual language as the legacy
 * components/LanePillRow.tsx pills, but deliberately WITHOUT an "All" option:
 * GET /api/patch-movers requires a concrete lane (role 0-4; 5/auto is not a
 * lane and 400s, per the engine handoff's contract). Built on LaneId (this
 * Hextech surface's own lane vocabulary, heroContracts.ts) rather than a raw
 * RoleId so this page composes with the rest of components/hextech/* without
 * a second lane-string translation.
 */
export default function LaneFilterPills({ value, onChange }: LaneFilterPillsProps) {
  return (
    <div className="flex gap-1.5 flex-wrap justify-center" role="group" aria-label="Filter by lane">
      {LANE_ORDER.map((lane) => {
        const active = value === lane;
        return (
          <button
            key={lane}
            type="button"
            onClick={() => onChange(lane)}
            aria-pressed={active}
            className={`px-3.5 py-1.5 rounded-lg text-[12.5px] font-semibold transition-all border active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal focus-visible:ring-offset-2 focus-visible:ring-offset-bg ${
              active
                ? "bg-teal text-bg border-teal shadow-[0_0_8px_rgba(200,170,110,0.4)]"
                : "bg-panel2 text-mut border-line hover:border-teal-dim hover:text-txt"
            }`}
          >
            {LANE_LABEL[lane]}
          </button>
        );
      })}
    </div>
  );
}
