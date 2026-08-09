"use client";

import { useState } from "react";
import type { ChampionRef } from "@/lib/types";
import { IconWithFallback } from "@/components/IconWithFallback";
import type { ChampionIconEntry } from "@/components/proAssets";
import ChampionPicker from "@/components/ChampionPicker";
import ThemedSelect, { type ThemedSelectOption } from "@/components/ThemedSelect";
import type { LaneId } from "../heroContracts";
import EnemyTeamPanel from "../EnemyTeamPanel";

interface DraftControlsProps {
  lane: LaneId;
  laneOptions: readonly ThemedSelectOption<LaneId>[];
  onLaneChange: (lane: LaneId) => void;
  hover: number | null;
  allyIds: number[];
  champIcons: Map<number, ChampionIconEntry>;
  onPick: (champ: ChampionRef) => void;
  onClearPick: () => void;
  onAddAlly: (champ: ChampionRef) => void;
  onRemoveAlly: (id: number) => void;
  enemyIds: number[];
  effectiveLaneOpponentId: number | null;
  laneOpponentId: number | null;
  serverInferredLaneOpponentId: number | null;
  onAddEnemy: (champ: ChampionRef) => void;
  onRemoveEnemy: (id: number) => void;
  onToggleLaneOpponent: (id: number) => void;
  enemyAnalysis: Parameters<typeof EnemyTeamPanel>[0]["enemyAnalysis"];
  hoverSelected: boolean;
}

function entryFor(champIcons: Map<number, ChampionIconEntry>, id: number): ChampionIconEntry {
  return champIcons.get(id) ?? { name: `Champion #${id}`, icon: "" };
}

function Slot({
  entry,
  label,
  onClick,
  onRemove,
  own = false,
}: {
  entry: ChampionIconEntry | null;
  label: string;
  onClick?: () => void;
  onRemove?: () => void;
  own?: boolean;
}) {
  return (
    <div className="group relative flex h-11 w-11 flex-shrink-0 items-center justify-center overflow-visible lg:h-8 lg:w-8">
      <div
        className={`relative flex h-8 w-8 items-center justify-center overflow-visible rounded-[7px] ${
          own
            ? "bg-accent/[0.1]"
            : entry
              ? ""
              : "bg-txt/[0.03]"
        }`}
        style={{
          boxShadow: own
            ? "inset 0 0 0 1px rgba(145,132,217,.7)"
            : entry
              ? "inset 0 0 0 1px rgba(233,233,237,.12)"
              : "inset 0 0 0 1px rgba(233,233,237,.1)",
        }}
      >
      {entry ? (
        <>
          <IconWithFallback
            src={entry.icon}
            alt={entry.name}
            fallbackGlyph={entry.name}
            className="h-8 w-8 rounded-[7px] object-cover"
            size={32}
          />
          {own && onClick && <button type="button" onClick={onClick} aria-label={label} className="absolute -inset-1.5 rounded-[7px] focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2 lg:inset-0" />}
        </>
      ) : (
        <button
          type="button"
          onClick={onClick}
          aria-label={label}
          className="absolute -inset-1.5 flex items-center justify-center rounded-[7px] text-[17px] font-light text-txt/[0.3] transition-colors duration-[120ms] ease-in hover:bg-txt/[0.05] hover:text-txt/[0.65] focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2 lg:inset-0"
        >
          +
        </button>
      )}
      {own && <span className="absolute -bottom-1 left-1/2 -translate-x-1/2 rounded-[3px] bg-accent/[0.72] px-1 text-[7px] font-semibold uppercase leading-[13px] text-accent-100">YOU</span>}
      {entry && onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${entry.name}`}
          className="absolute -right-1.5 -top-1.5 z-10 hidden h-4 w-4 items-center justify-center rounded-full bg-panel text-[11px] leading-none text-txt/[0.55] group-hover:flex hover:text-bad focus-visible:flex focus-visible:outline-2 focus-visible:outline-accent"
        >
          ×
        </button>
      )}
      </div>
    </div>
  );
}

function AlliedTeam({
  hover,
  allyIds,
  champIcons,
  onPick,
  onClearPick,
  onAddAlly,
  onRemoveAlly,
}: Pick<DraftControlsProps, "hover" | "allyIds" | "champIcons" | "onPick" | "onClearPick" | "onAddAlly" | "onRemoveAlly">) {
  const [pickerMode, setPickerMode] = useState<"self" | "ally" | null>(null);
  const ownIndex = Math.min(allyIds.length, 4);

  return (
    <div className="min-w-0">
      <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-good/[0.75]">Your team</p>
      <div className="flex min-w-0 items-center gap-2">
        {Array.from({ length: 5 }, (_, index) => {
          if (index < allyIds.length) {
            const id = allyIds[index];
            const entry = entryFor(champIcons, id);
            return <Slot key={`ally-${id}`} entry={entry} label={`Remove ${entry.name} from your team`} onRemove={() => onRemoveAlly(id)} />;
          }
          if (index === ownIndex) {
            const entry = hover === null ? null : entryFor(champIcons, hover);
            return (
              <Slot
                key="own"
                entry={entry}
                own
                label={entry ? `Change your champion from ${entry.name}` : "Choose your champion"}
                onClick={() => setPickerMode("self")}
                onRemove={entry ? onClearPick : undefined}
              />
            );
          }
          return <Slot key={`ally-empty-${index}`} entry={null} label="Add an allied champion" onClick={() => setPickerMode("ally")} />;
        })}
      </div>
      {pickerMode && (
        <div className="mt-2 min-w-0 [&>div]:min-w-0">
          <ChampionPicker
            value={null}
            autoFocus
            placeholder={pickerMode === "self" ? "Choose your champion…" : "Add an ally…"}
            onChange={(champ) => {
              if (pickerMode === "self") onPick(champ);
              else onAddAlly(champ);
              setPickerMode(null);
            }}
          />
        </div>
      )}
    </div>
  );
}

export default function DraftControls(props: DraftControlsProps) {
  return (
    <section className="grid min-w-0 gap-2.5 lg:grid-cols-[150px_minmax(0,1fr)]">
      <label
        className="flex min-w-0 flex-col justify-center rounded-[8px] p-3.5"
        style={{ boxShadow: "inset 0 0 0 1px rgba(233,233,237,.08)", background: "#232532" }}
      >
        <span className="mb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-txt/[0.5]">Your role</span>
        <ThemedSelect
          value={props.lane}
          options={props.laneOptions}
          ariaLabel="Your role"
          onChange={props.onLaneChange}
          triggerClassName="min-h-[44px] rounded-[7px] px-2.5 py-2 text-[12px] font-semibold lg:min-h-0"
        />
      </label>

      <div
        className="min-w-0 rounded-[8px] p-3.5"
        style={{ boxShadow: "inset 0 0 0 1px rgba(233,233,237,.08)", background: "#232532" }}
      >
        <div className="grid min-w-0 items-start gap-4 lg:grid-cols-[minmax(170px,0.8fr)_1px_minmax(0,1.2fr)]">
          <AlliedTeam
            hover={props.hover}
            allyIds={props.allyIds}
            champIcons={props.champIcons}
            onPick={props.onPick}
            onClearPick={props.onClearPick}
            onAddAlly={props.onAddAlly}
            onRemoveAlly={props.onRemoveAlly}
          />
          <span className="hidden h-10 self-center hr lg:block" aria-hidden="true" />
          <EnemyTeamPanel
            enemyIds={props.enemyIds}
            champIcons={props.champIcons}
            effectiveLaneOpponentId={props.effectiveLaneOpponentId}
            laneOpponentId={props.laneOpponentId}
            serverInferredLaneOpponentId={props.serverInferredLaneOpponentId}
            onAddEnemy={props.onAddEnemy}
            onRemoveEnemy={props.onRemoveEnemy}
            onToggleLaneOpponent={props.onToggleLaneOpponent}
            enemyAnalysis={props.enemyAnalysis}
            hoverSelected={props.hoverSelected}
          />
        </div>
      </div>
    </section>
  );
}
