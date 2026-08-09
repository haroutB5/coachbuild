"use client";

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
  enemyAnalysis: EnemyAnalysis[] | undefined | null;
  hoverSelected: boolean;
}

function entryFor(champIcons: Map<number, ChampionIconEntry>, id: number): ChampionIconEntry {
  return champIcons.get(id) ?? { name: `Champion #${id}`, icon: "" };
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
  const [addingSlot, setAddingSlot] = useState<number | null>(null);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const laneOppEntry = effectiveLaneOpponentId === null ? undefined : champIcons.get(effectiveLaneOpponentId);
  const emptySlots = Math.max(0, MAX_DRAFT_ENEMIES - enemyIds.length);

  return (
    <div className="min-w-0">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-bad/[0.8]">Enemy team</p>
        <span className="text-[9px] tabular-nums text-txt/[0.32]">{enemyIds.length}/{MAX_DRAFT_ENEMIES}</span>
      </div>
      <div className="mt-2 flex min-w-0 items-center gap-2">
        {enemyIds.map((id) => {
          const entry = entryFor(champIcons, id);
          const isLaneOpp = effectiveLaneOpponentId === id;
          const inferredOnly = isLaneOpp && laneOpponentId === null && serverInferredLaneOpponentId === id;
          return (
            <div key={id} className="group relative h-8 w-8 flex-shrink-0 rounded-[7px]" title={entry.name}>
              <IconWithFallback
                src={entry.icon}
                alt={entry.name}
                fallbackGlyph={entry.name}
                className="h-8 w-8 rounded-[7px] object-cover"
                size={32}
              />
              <button
                type="button"
                onClick={() => onToggleLaneOpponent(id)}
                aria-pressed={isLaneOpp}
                aria-label={isLaneOpp ? `${entry.name} is your lane opponent` : `Mark ${entry.name} as your lane opponent`}
                title={inferredOnly ? "Inferred lane opponent — tap to confirm or change" : "Toggle lane opponent"}
                className={`absolute inset-0 rounded-[7px] transition-colors duration-[120ms] ease-in focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2 ${
                  isLaneOpp ? "ring-2 ring-bad/[0.7] ring-offset-1 ring-offset-panel" : "group-hover:bg-bad/[0.15]"
                }`}
              >
                <span className="sr-only">{isLaneOpp ? "Lane opponent" : "Set lane opponent"}</span>
              </button>
              <button
                type="button"
                onClick={() => onRemoveEnemy(id)}
                aria-label={`Remove ${entry.name}`}
                className="absolute -right-1.5 -top-1.5 z-10 hidden h-4 w-4 items-center justify-center rounded-full bg-panel text-[11px] leading-none text-txt/[0.55] group-hover:flex hover:text-bad focus-visible:flex focus-visible:outline-2 focus-visible:outline-accent"
              >
                ×
              </button>
            </div>
          );
        })}
        {Array.from({ length: emptySlots }, (_, index) => {
          const slot = enemyIds.length + index;
          return (
            <button
              key={`enemy-empty-${slot}`}
              type="button"
              aria-label={`Add an enemy champion to slot ${slot + 1}`}
              aria-expanded={addingSlot === slot}
              onClick={() => setAddingSlot(addingSlot === slot ? null : slot)}
              className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-[7px] text-[17px] font-light text-txt/[0.28] transition-colors duration-[120ms] ease-in hover:bg-txt/[0.05] hover:text-txt/[0.6] focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2"
              style={{ boxShadow: "inset 0 0 0 1px rgba(233,233,237,.1)" }}
            >
              +
            </button>
          );
        })}
      </div>

      <div className="mt-2 flex min-w-0 items-center justify-between gap-2">
        <p className="min-w-0 truncate text-[10px] text-txt/[0.42]">
          <span className="mr-1 uppercase tracking-[0.1em]">Lane opponent</span>
          <span className="text-txt/[0.7]">{laneOppEntry?.name ?? "Not inferred"}</span>
          {laneOppEntry && <span className="text-txt/[0.34]"> · {laneOpponentId === null ? "inferred" : "selected"}</span>}
        </p>
        {effectiveLaneOpponentId !== null && (
          <button
            type="button"
            onClick={() => setPopoverOpen((open) => !open)}
            aria-expanded={popoverOpen}
            className="flex-shrink-0 rounded-[5px] px-1.5 py-1 text-[10px] font-medium text-accent-300 transition-colors duration-[120ms] ease-in hover:bg-accent/[0.12] focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2"
          >
            {popoverOpen ? "Hide read" : "Read matchup"}
          </button>
        )}
      </div>

      {addingSlot !== null && (
        <div className="mt-2 min-w-0 [&>div]:min-w-0">
          <ChampionPicker
            value={null}
            autoFocus
            placeholder="Add an enemy…"
            onChange={(champ) => {
              onAddEnemy(champ);
              setAddingSlot(null);
            }}
          />
        </div>
      )}

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
