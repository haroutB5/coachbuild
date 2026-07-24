"use client";

// ─────────────────────────────────────────────────────────────────────────────
// MyChampionPanel — "MY CHAMPION" panel (draft redesign v0.51.0, mockup 3).
// Retheme from the retired cyan `.draft-tactical`/`.dt-*` HUD to the app-wide
// navy/gold tokens (bg-panel/border-line/text-teal/text-mut, same as every
// other Hextech card) — no functional change to lane/hover-champion handling
// (onLaneChange/onHoverChange/onClearHover are byte-identical wiring to
// app/draft/page.tsx's preserved state machine).
//
// v0.51.0 also ABSORBS ban-suggestion rendering from the retired
// DraftBansTable.tsx (mockup 3 shows bans INLINE inside this card, not as a
// separate page section) — still importing draftBansModel.ts's pure
// buildBanRows/banWinVsYouLabel (engo's file, untouched) for the row shaping,
// just rendering them as red-tinted rows here instead of a standalone table.
//
// Fidelity note (HANDOFF-fronty.md): the mockup's MY CHAMPION card shows only
// a portrait + name + "TOP · AUTO-DETECTED" label — no visible lane-picker or
// champion-search affordance. Since manual lane override and manual champion
// pick are real, load-bearing interactions (app/draft/page.tsx's
// handleLaneChange/handleHoverChange), this keeps a compact lane-icon row +
// ChampionPicker rather than dropping the controls to chase pixel-fidelity.
// ─────────────────────────────────────────────────────────────────────────────

import type { ChampionRef } from "@/lib/types";
import { IconWithFallback } from "@/components/IconWithFallback";
import ChampionPicker from "@/components/ChampionPicker";
import { LANE_ORDER, LANE_LABEL, type LaneId } from "./heroContracts";
import type { DraftBanResult } from "@/components/live/draftRecommend";
import type { ChampionIconEntry } from "@/components/proAssets";
import { buildBanRows, banWinVsYouLabel } from "./draftBansModel";

const LANE_SHORT: Record<LaneId, string> = { top: "TOP", jungle: "JG", mid: "MID", bot: "BOT", support: "SUP" };

interface MyChampionPanelProps {
  lane: LaneId;
  onLaneChange: (lane: LaneId) => void;
  hoverChamp: ChampionRef | null;
  onHoverChange: (champ: ChampionRef) => void;
  onClearHover: () => void;
  /** True while the shown champion/lane is being passively synced from a
   *  live champ select (companion.phase === "ChampSelect" && !dirty) — drives
   *  the "AUTO-DETECTED" vs "MANUAL" label per mockup 3. */
  autoDetected: boolean;
  bans: DraftBanResult[];
  champIcons: Map<number, ChampionIconEntry>;
}

export default function MyChampionPanel({
  lane,
  onLaneChange,
  hoverChamp,
  onHoverChange,
  onClearHover,
  autoDetected,
  bans,
  champIcons,
}: MyChampionPanelProps) {
  const banRows = buildBanRows(bans, champIcons);

  return (
    <div className="bg-panel border border-line rounded-xl p-4">
      <p className="text-[10px] tracking-[0.14em] uppercase text-teal font-semibold mb-3">My Champion</p>

      {hoverChamp ? (
        <div className="flex items-center gap-3 mb-3">
          <span className="w-12 h-12 rounded-lg overflow-hidden bg-black/30 border-2 border-good flex-shrink-0">
            <IconWithFallback
              src={hoverChamp.icon}
              alt={hoverChamp.name}
              fallbackGlyph={hoverChamp.name}
              className="w-full h-full object-cover"
              size={48}
            />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[14px] font-semibold text-txt truncate">{hoverChamp.name}</p>
            <p className="text-[10.5px] text-mut uppercase tracking-[0.04em]">
              {LANE_LABEL[lane]} · {autoDetected ? "Auto-detected" : "Manual"}
            </p>
          </div>
          <button
            type="button"
            onClick={onClearHover}
            aria-label="Clear my champion"
            className="w-7 h-7 flex items-center justify-center rounded-md text-mut hover:text-bad hover:bg-bad/10 transition-colors flex-shrink-0"
          >
            ×
          </button>
        </div>
      ) : (
        <p className="text-[10.5px] text-mut mb-3">Set your champion to unlock ban suggestions.</p>
      )}

      <div role="group" aria-label="Lane" className="flex items-center gap-1.5 mb-3">
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
              className={`flex-1 py-1.5 rounded-md border text-[10px] font-bold uppercase tracking-[0.04em] transition-colors active:scale-95 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-teal ${
                active ? "bg-panel2 border-line-gold text-teal" : "border-line text-mut hover:bg-panel2/60 hover:text-txt"
              }`}
            >
              {LANE_SHORT[l]}
            </button>
          );
        })}
      </div>

      <div className="flex items-center gap-2">
        <div className="flex-1 min-w-0">
          <ChampionPicker value={hoverChamp} onChange={onHoverChange} />
        </div>
      </div>

      {banRows.length > 0 && (
        <div className="mt-4 pt-4 border-t border-line">
          <p className="text-[10px] tracking-[0.14em] uppercase text-mut font-semibold mb-2">Ban Suggestions</p>
          <div className="space-y-1.5">
            {banRows.map((row) => (
              <div
                key={row.champId}
                className="flex items-center gap-2.5 px-2.5 py-2 rounded-md bg-bad/[0.06] border border-bad/25"
              >
                <span className="w-7 h-7 rounded-md overflow-hidden bg-black/30 flex-shrink-0">
                  <IconWithFallback src={row.icon} alt={row.name} fallbackGlyph={row.name} className="w-full h-full object-cover" size={28} />
                </span>
                <span className="flex-1 min-w-0 text-[12px] font-medium text-txt truncate">{row.name}</span>
                <span className="text-[10.5px] text-bad text-right flex-shrink-0 tabular-nums">
                  {banWinVsYouLabel(row.winVsYou)} into you
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
