"use client";

// ─────────────────────────────────────────────────────────────────────────────
// EnemyTeamPanel — "ENEMY TEAM" panel (draft redesign plan §3): vertical
// stack of up to MAX_DRAFT_ENEMIES portraits + the existing ChampionPicker
// add-flow, re-homing app/draft/page.tsx's existing enemy chip UI (unchanged
// handlers: onAddEnemy/onRemoveEnemy/onToggleLaneOpponent) into the new HUD
// layout. Owns ONE new, purely-local piece of UI state — whether the
// MatchupAnalysisPopover is expanded — since that's new-surface state, not
// part of the page's preserved live-sync/fetch state (plan §9 only pins the
// EXISTING state/effects/handlers verbatim).
//
// Honesty note: the prototype's mockup shows a per-portrait ROLE icon (Top/
// Jungle/etc. per enemy) — this app has no per-enemy role/lane data (only a
// single "lane opponent" tag), so that's deliberately NOT reproduced here
// rather than fabricated. Only the lane-opponent slot gets a distinguishing
// glow + label; the rest are plain portraits.
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
    <div className="dt-panel p-4">
      <p className="text-[10px] tracking-[0.14em] uppercase text-[color:var(--dt-cyan)] font-semibold mb-3">
        Enemy team ({enemyIds.length}/{MAX_DRAFT_ENEMIES})
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
                isLaneOpp ? "dt-panel-glow bg-[rgba(45,216,255,0.08)]" : "border-[color:var(--dt-line)]"
              }`}
            >
              <span
                className={`w-9 h-9 rounded-md overflow-hidden bg-black/30 flex-shrink-0 border ${
                  isLaneOpp ? "dt-node-pulse" : "border-transparent"
                }`}
                style={isLaneOpp ? { borderColor: "var(--dt-cyan)" } : undefined}
              >
                <IconWithFallback src={entry?.icon ?? ""} alt={entry?.name ?? `Champion #${id}`} fallbackGlyph={entry?.name} className="w-full h-full object-cover" size={36} />
              </span>
              <span className="flex-1 min-w-0 text-[12.5px] font-medium text-[color:var(--dt-txt)] truncate">
                {entry?.name ?? `#${id}`}
              </span>
              <button
                type="button"
                onClick={() => onToggleLaneOpponent(id)}
                aria-pressed={isLaneOpp}
                aria-label={isLaneOpp ? `${entry?.name ?? "Champion"} set as your lane opponent — tap to unset` : `Mark ${entry?.name ?? "champion"} as your lane opponent`}
                title={isServerInferredOnly ? "Auto-detected as your lane opponent — tap to confirm or pick a different chip" : isLaneOpp ? "Your lane opponent (weighted heaviest) — tap to unset" : "Mark as your lane opponent"}
                className={`px-1.5 py-0.5 rounded text-[8.5px] font-bold uppercase tracking-[0.04em] border transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[color:var(--dt-cyan)] flex-shrink-0 ${
                  isLaneOpp
                    ? isServerInferredOnly
                      ? "bg-[color:var(--dt-cyan-dim)] text-[color:var(--dt-txt)] border-[color:var(--dt-cyan)] border-dashed"
                      : "bg-[color:var(--dt-cyan)] text-black border-[color:var(--dt-cyan)]"
                    : "bg-transparent text-[color:var(--dt-mut)] border-[color:var(--dt-line)] hover:border-[color:var(--dt-cyan-dim)] hover:text-[color:var(--dt-txt)]"
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
                  className="w-6 h-6 flex items-center justify-center rounded text-[color:var(--dt-cyan)] hover:bg-[rgba(45,216,255,0.12)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[color:var(--dt-cyan)] flex-shrink-0"
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
                className="w-6 h-6 flex items-center justify-center rounded text-[color:var(--dt-mut)] hover:text-[color:var(--dt-bad)] hover:bg-[rgba(242,85,90,0.1)] transition-colors flex-shrink-0"
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
            className="flex items-center gap-2.5 pl-2 pr-1.5 py-1.5 rounded-md border border-dashed border-[color:var(--dt-line)]"
          >
            <span className="w-9 h-9 rounded-md border border-dashed border-[color:var(--dt-line)] flex-shrink-0" />
            <span className="text-[11.5px] text-[color:var(--dt-mut)]/60">Open slot</span>
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
