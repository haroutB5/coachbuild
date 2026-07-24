"use client";

// ─────────────────────────────────────────────────────────────────────────────
// EnemyTeamPanel — "ENEMY TEAM" panel (draft redesign v0.51.0, mockup 3).
// v0.51.0: rethemed from the retired cyan `.draft-tactical`/`.dt-*` HUD to the
// app-wide navy/gold tokens — vertical stack of up to MAX_DRAFT_ENEMIES
// portraits + the existing ChampionPicker add-flow. Handlers (onAddEnemy/
// onRemoveEnemy/onToggleLaneOpponent) are unchanged wiring straight through
// to app/draft/page.tsx's preserved state machine — only className/token
// usage changed here.
//
// Honesty note (unchanged from the pre-reskin version): this app has no
// per-enemy role/lane data (only a single "lane opponent" tag), so a
// per-portrait role icon is deliberately NOT reproduced — only the
// lane-opponent slot gets a distinguishing ring + label.
// ─────────────────────────────────────────────────────────────────────────────

import { useState } from "react";
import type { ChampionRef } from "@/lib/types";
import { IconWithFallback } from "@/components/IconWithFallback";
import ChampionPicker from "@/components/ChampionPicker";
import type { ChampionIconEntry } from "@/components/proAssets";
import { MAX_DRAFT_ENEMIES } from "@/components/live/draftLiveSync";
import MatchupAnalysisPopover from "./MatchupAnalysisPopover";
import type { EnemyAnalysis } from "./matchupAnalysis";

interface EnemyTeamPanelProps {
  enemyIds: number[];
  champIcons: Map<number, ChampionIconEntry>;
  effectiveLaneOpponentId: number | null;
  laneOpponentId: number | null;
  serverInferredLaneOpponentId: number | null;
  onAddEnemy: (champ: ChampionRef) => void;
  onRemoveEnemy: (id: number) => void;
  onToggleLaneOpponent: (id: number) => void;
  /** Passed straight through to MatchupAnalysisPopover. */
  enemyAnalysis: EnemyAnalysis[] | undefined | null;
  hoverSelected: boolean;
}

export default function EnemyTeamPanel({
  enemyIds,
  champIcons,
  effectiveLaneOpponentId,
  laneOpponentId,
  serverInferredLaneOpponentId,
  onAddEnemy,
  onRemoveEnemy,
  onToggleLaneOpponent,
  enemyAnalysis,
  hoverSelected,
}: EnemyTeamPanelProps) {
  const [popoverOpen, setPopoverOpen] = useState(false);
  const emptySlots = Math.max(0, MAX_DRAFT_ENEMIES - enemyIds.length);
  const laneOppEntry = effectiveLaneOpponentId !== null ? champIcons.get(effectiveLaneOpponentId) : undefined;

  return (
    <div className="bg-panel border border-line rounded-xl p-4">
      <p className="text-[10px] tracking-[0.14em] uppercase text-teal font-semibold mb-3">
        Enemy Team ({enemyIds.length}/{MAX_DRAFT_ENEMIES})
      </p>

      <div className="space-y-1.5 mb-3">
        {enemyIds.map((id) => {
          const entry = champIcons.get(id);
          const isLaneOpp = effectiveLaneOpponentId === id;
          const isServerInferredOnly = laneOpponentId === null && serverInferredLaneOpponentId === id;
          return (
            <div
              key={id}
              className={`flex items-center gap-2.5 pl-2 pr-1.5 py-1.5 rounded-md border transition-colors ${
                isLaneOpp ? "border-line-gold bg-teal/8" : "border-line"
              }`}
            >
              <span
                className={`w-9 h-9 rounded-md overflow-hidden bg-black/30 flex-shrink-0 border ${
                  isLaneOpp ? "border-teal" : "border-transparent"
                }`}
              >
                <IconWithFallback src={entry?.icon ?? ""} alt={entry?.name ?? `Champion #${id}`} fallbackGlyph={entry?.name} className="w-full h-full object-cover" size={36} />
              </span>
              <span className="flex-1 min-w-0 text-[12.5px] font-medium text-txt truncate">
                {entry?.name ?? `#${id}`}
              </span>
              <button
                type="button"
                onClick={() => onToggleLaneOpponent(id)}
                aria-pressed={isLaneOpp}
                aria-label={isLaneOpp ? `${entry?.name ?? "Champion"} set as your lane opponent — tap to unset` : `Mark ${entry?.name ?? "champion"} as your lane opponent`}
                title={isServerInferredOnly ? "Auto-detected as your lane opponent — tap to confirm or pick a different chip" : isLaneOpp ? "Your lane opponent (weighted heaviest) — tap to unset" : "Mark as your lane opponent"}
                className={`px-1.5 py-0.5 rounded text-[8.5px] font-bold uppercase tracking-[0.04em] border transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-teal flex-shrink-0 ${
                  isLaneOpp
                    ? isServerInferredOnly
                      ? "bg-panel2 text-txt border-teal border-dashed"
                      : "bg-teal text-bg border-teal"
                    : "bg-transparent text-mut border-line hover:border-line-gold hover:text-txt"
                }`}
              >
                {isLaneOpp ? "Lane opp" : "+ Lane"}
                {isServerInferredOnly ? " (inferred)" : ""}
              </button>
              {isLaneOpp && (
                <button
                  type="button"
                  onClick={() => setPopoverOpen((v) => !v)}
                  aria-expanded={popoverOpen}
                  aria-label={`${popoverOpen ? "Hide" : "Show"} matchup analysis for ${entry?.name ?? "your lane opponent"}`}
                  className="w-6 h-6 flex items-center justify-center rounded text-teal hover:bg-teal/12 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-teal flex-shrink-0"
                >
                  <span aria-hidden="true" className="text-[13px] leading-none">
                    {popoverOpen ? "▴" : "▾"}
                  </span>
                </button>
              )}
              <button
                type="button"
                onClick={() => onRemoveEnemy(id)}
                aria-label={`Remove ${entry?.name ?? "champion"}`}
                className="w-6 h-6 flex items-center justify-center rounded text-mut hover:text-bad hover:bg-bad/10 transition-colors flex-shrink-0"
              >
                ×
              </button>
            </div>
          );
        })}

        {Array.from({ length: emptySlots }).map((_, i) => (
          <div
            key={`empty-${i}`}
            aria-hidden="true"
            className="flex items-center gap-2.5 pl-2 pr-1.5 py-1.5 rounded-md border border-dashed border-line"
          >
            <span className="w-9 h-9 rounded-md border border-dashed border-line flex-shrink-0" />
            <span className="text-[11.5px] text-mut/60">Open slot</span>
          </div>
        ))}
      </div>

      {enemyIds.length < MAX_DRAFT_ENEMIES && <ChampionPicker value={null} onChange={onAddEnemy} />}

      {popoverOpen && effectiveLaneOpponentId !== null && (
        <MatchupAnalysisPopover
          enemyAnalysis={enemyAnalysis}
          laneOpponentId={effectiveLaneOpponentId}
          laneOpponentName={laneOppEntry?.name ?? `Champion #${effectiveLaneOpponentId}`}
          hoverSelected={hoverSelected}
        />
      )}
    </div>
  );
}
