"use client";

import { useState } from "react";
import type { ChampionRef } from "@/lib/types";
import { IconWithFallback } from "@/components/IconWithFallback";
import type { ChampionIconEntry } from "@/components/proAssets";
import ChampionPicker from "@/components/ChampionPicker";
import ThemedSelect, { type ThemedSelectOption } from "@/components/ThemedSelect";
import { Crosshair, Plus } from "@phosphor-icons/react";
import type { LaneId } from "../heroContracts";
import { MAX_DRAFT_ENEMIES } from "@/components/live/draftLiveSync";

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
  enemyAnalysis: unknown;
  hoverSelected: boolean;
  /** Latches the manual-dirty flag (pauses live auto-fill). */
  onManualDraft: () => void;
  /** Clears the manual-dirty flag (resumes live auto-fill). */
  onResetLive: () => void;
}

function entryFor(champIcons: Map<number, ChampionIconEntry>, id: number): ChampionIconEntry {
  return champIcons.get(id) ?? { name: `Champion #${id}`, icon: "" };
}

/**
 * One 68x68 team slot. Empty slots render a Plus button (accessible name
 * passed in); filled slots render the square portrait with an optional gold
 * YOU badge or lane-opponent crosshair, an overlay toggle/remove button, and
 * the champion name centred below.
 */
function TeamSlot({ id, entry, emptyLabel, own, isLaneOpp, youBadge, nameBelow, onOpen, onToggle, toggleLabel, onRemove }: {
  id: string;
  entry: ChampionIconEntry | null;
  emptyLabel: string;
  own?: boolean;
  isLaneOpp?: boolean;
  youBadge?: boolean;
  nameBelow?: boolean;
  onOpen?: () => void;
  onToggle?: () => void;
  toggleLabel?: string;
  onRemove?: () => void;
}) {
  return (
    <div id={id} className="d25-slotwrap">
      <div
        className={`d25-slot${entry ? " d25-slot-filled" : ""}${own && !entry ? " d25-slot-you-empty" : ""}${isLaneOpp ? " d25-slot-laneopp" : ""}`}
      >
        {entry ? (
          <>
            <IconWithFallback
              src={entry.icon}
              alt={entry.name}
              fallbackGlyph={entry.name}
              className="d25-slotimg"
              size={68}
            />
            {youBadge && <span className="d25-youbadge">YOU</span>}
            {isLaneOpp && (
              <span className="d25-oppbadge" aria-hidden="true">
                <Crosshair size={16} weight="bold" color="#F2BE4F" />
              </span>
            )}
            {onToggle && (
              <button
                type="button"
                onClick={onToggle}
                aria-pressed={isLaneOpp}
                aria-label={toggleLabel}
                title="Toggle lane opponent"
                className="d25-slotoverlay"
              />
            )}
            {onRemove && (
              <button
                type="button"
                onClick={onRemove}
                aria-label={`Remove ${entry.name}`}
                className="d25-remove"
              >
                ×
              </button>
            )}
          </>
        ) : (
          <button type="button" onClick={onOpen} aria-label={emptyLabel} className="d25-slotempty">
            <Plus size={22} color="#AFC0D2" />
            {youBadge && <span className="d25-youbadge">YOU</span>}
          </button>
        )}
      </div>
      {nameBelow && entry && <span className="d25-slotname">{entry.name}</span>}
    </div>
  );
}

export default function DraftControls(props: DraftControlsProps) {
  const [pickerMode, setPickerMode] = useState<"self" | "ally" | null>(null);
  const [addingSlot, setAddingSlot] = useState<number | null>(null);

  function openManualDraft() {
    setPickerMode("self");
    props.onManualDraft();
  }

  return (
    <section aria-label="Team draft" id="d25-teamstrip" className="d25-teamcard">
      <div className="d25-rolecol">
        <span className="d25-rolelabel">Current role</span>
        <ThemedSelect
          value={props.lane}
          options={props.laneOptions}
          ariaLabel="Your role"
          onChange={props.onLaneChange}
          triggerClassName="d25-roletrigger"
        />
      </div>

      <span className="d25-div" aria-hidden="true" />

      <div className="d25-teamblock d25-teamblock-you">
        <p className="d25-teamlabel-you">YOUR TEAM</p>
        <div className="d25-slots">
          {Array.from({ length: 5 }, (_, index) => {
            if (index === 0) {
              const entry = props.hover === null ? null : entryFor(props.champIcons, props.hover);
              return (
                <TeamSlot
                  key="own"
                  id="d25-you-slot-0"
                  entry={entry}
                  own
                  youBadge
                  nameBelow
                  emptyLabel="Choose your champion"
                  toggleLabel={entry ? `Change your champion from ${entry.name}` : undefined}
                  onOpen={() => setPickerMode("self")}
                  onToggle={entry ? () => setPickerMode("self") : undefined}
                  onRemove={entry ? props.onClearPick : undefined}
                />
              );
            }
            const allyId = props.allyIds[index - 1];
            if (allyId !== undefined) {
              const entry = entryFor(props.champIcons, allyId);
              return (
                <TeamSlot
                  key={`ally-${allyId}`}
                  id={`d25-you-slot-${index}`}
                  entry={entry}
                  nameBelow
                  emptyLabel="Add an allied champion"
                  onRemove={() => props.onRemoveAlly(allyId)}
                />
              );
            }
            return (
              <TeamSlot
                key={`ally-empty-${index}`}
                id={`d25-you-slot-${index}`}
                entry={null}
                emptyLabel="Add an allied champion"
                onOpen={() => setPickerMode("ally")}
              />
            );
          })}
        </div>
        {pickerMode && (
          <div className="d25-pickerwrap">
            <ChampionPicker
              value={null}
              autoFocus
              placeholder={pickerMode === "self" ? "Choose your champion…" : "Add an ally…"}
              onChange={(champ) => {
                if (pickerMode === "self") props.onPick(champ);
                else props.onAddAlly(champ);
                setPickerMode(null);
              }}
            />
          </div>
        )}
      </div>

      <span className="d25-div d25-div2" aria-hidden="true" />

      <div className="d25-teamblock d25-teamblock-enemy">
        <p className="d25-teamlabel-enemy">ENEMY TEAM</p>
        <div className="d25-slots d25-slots-enemy">
          {Array.from({ length: MAX_DRAFT_ENEMIES }, (_, index) => {
            const id = props.enemyIds[index];
            if (id === undefined) {
              return (
                <TeamSlot
                  key={`enemy-empty-${index}`}
                  id={`d25-enemy-slot-${index}`}
                  entry={null}
                  emptyLabel={`Add an enemy champion to slot ${index + 1}`}
                  onOpen={() => setAddingSlot(addingSlot === index ? null : index)}
                />
              );
            }
            const entry = entryFor(props.champIcons, id);
            const isLaneOpp = props.effectiveLaneOpponentId === id;
            return (
              <TeamSlot
                key={id}
                id={`d25-enemy-slot-${index}`}
                entry={entry}
                isLaneOpp={isLaneOpp}
                nameBelow={isLaneOpp}
                emptyLabel={`Add an enemy champion to slot ${index + 1}`}
                toggleLabel={isLaneOpp ? `${entry.name} is your lane opponent` : `Mark ${entry.name} as your lane opponent`}
                onToggle={() => props.onToggleLaneOpponent(id)}
                onRemove={() => props.onRemoveEnemy(id)}
              />
            );
          })}
        </div>
        {addingSlot !== null && (
          <div className="d25-pickerwrap">
            <ChampionPicker
              value={null}
              autoFocus
              placeholder="Add an enemy…"
              onChange={(champ) => {
                props.onAddEnemy(champ);
                setAddingSlot(null);
              }}
            />
          </div>
        )}
      </div>

      <div className="d25-teambtns">
        <button type="button" onClick={openManualDraft} className="d25-btn-gold">
          Manual draft
        </button>
        <button type="button" onClick={props.onResetLive} className="d25-btn-outline">
          Reset to live
        </button>
      </div>
    </section>
  );
}
