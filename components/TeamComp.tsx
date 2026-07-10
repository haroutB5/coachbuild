"use client";

// ─────────────────────────────────────────────────────────────────────────────
// TeamComp.tsx — dpm.lol-style ally/enemy team-comp display, shared between
// ProGameCard's dense collapsed row (CardCompStrip) and GameDetailSheet's
// "Teams" section (SheetTeamsSection).
//
// Both allyChampionIds/enemyChampionIds are OPTIONAL on ProGame (backend
// backfill in progress, per engy's concurrent contract change) — both
// components here render NOTHING (return null) when either array is
// undefined. This is a stronger check than "array is empty": an empty array
// would still mean "we know the comp and it's 0 champions," which never
// happens, whereas undefined means "not backfilled for this game yet" and
// must never show a skeleton or a reserved gap.
//
// Champion icons are resolved via proAssets.getChampionIconMap() — the same
// module-level-cached /api/champions fetch ProHistoryResults/ProGamesSection
// already use for the card's OWN champion icon, so mounting this on every
// card is cache-cheap (one real network fetch per page load, shared).
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from "react";
import { getChampionIconMap, type ChampionIconEntry } from "./proAssets";
import { IconWithFallback } from "./IconWithFallback";

function useChampionIconMap(): Map<number, ChampionIconEntry> | null {
  const [map, setMap] = useState<Map<number, ChampionIconEntry> | null>(null);

  useEffect(() => {
    let cancelled = false;
    getChampionIconMap().then((m) => {
      if (!cancelled) setMap(m);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return map;
}

interface TeamCompProps {
  allyChampionIds?: number[];
  enemyChampionIds?: number[];
  /** game.championId — used to ring-highlight the player's own champion
   *  among their 4 ally teammates. Never matched against enemyChampionIds. */
  selfChampionId: number;
}

/** Dense icon-only ally-vs-enemy row for the collapsed card — 5 small ally
 *  icons (player's own champion ringed) beside 5 enemy icons. At 10 icons ×
 *  20px + gaps + the "vs" label this comes to well under 260px, safely inside
 *  even a 390px viewport's card content width — no overflow, no wrap. */
export function CardCompStrip({ allyChampionIds, enemyChampionIds, selfChampionId }: TeamCompProps) {
  const iconMap = useChampionIconMap();
  if (!allyChampionIds || !enemyChampionIds) return null;

  return (
    <div className="flex items-center gap-2 px-4 py-2 border-t border-line/60 overflow-hidden">
      <MiniCompRow
        championIds={allyChampionIds}
        selfChampionId={selfChampionId}
        iconMap={iconMap}
        ariaLabel="Ally team"
      />
      <span
        className="text-[9px] font-bold text-mut uppercase tracking-[0.5px] flex-shrink-0"
        aria-hidden="true"
      >
        vs
      </span>
      <MiniCompRow
        championIds={enemyChampionIds}
        selfChampionId={null}
        iconMap={iconMap}
        ariaLabel="Enemy team"
      />
    </div>
  );
}

function MiniCompRow({
  championIds,
  selfChampionId,
  iconMap,
  ariaLabel,
}: {
  championIds: number[];
  selfChampionId: number | null;
  iconMap: Map<number, ChampionIconEntry> | null;
  ariaLabel: string;
}) {
  return (
    <div className="flex items-center gap-1 min-w-0" role="group" aria-label={ariaLabel}>
      {championIds.map((champId, i) => {
        const entry = iconMap?.get(champId);
        const name = entry?.name ?? `Champion #${champId}`;
        const isSelf = champId === selfChampionId;
        return (
          <span
            key={`${champId}-${i}`}
            className={`w-5 h-5 rounded-full bg-black/30 overflow-hidden flex items-center justify-center flex-shrink-0 ${
              isSelf ? "ring-2 ring-teal" : "border border-line opacity-55"
            }`}
            title={name}
          >
            <IconWithFallback src={entry?.icon ?? ""} alt={name} className="w-full h-full object-cover" />
          </span>
        );
      })}
    </div>
  );
}

/** Labeled Ally/Enemy roster section for the detail sheet — slightly larger
 *  icons + a name label under each, player's own champion ring-highlighted
 *  the same way RunePerkTile's keystone tile is. */
export function SheetTeamsSection({ allyChampionIds, enemyChampionIds, selfChampionId }: TeamCompProps) {
  const iconMap = useChampionIconMap();
  if (!allyChampionIds || !enemyChampionIds) return null;

  return (
    <section className="mb-6">
      <p className="text-[10.5px] tracking-[1px] uppercase text-teal font-bold mb-2.5">Teams</p>
      <div className="space-y-3">
        <TeamRosterRow
          label="Ally"
          championIds={allyChampionIds}
          selfChampionId={selfChampionId}
          iconMap={iconMap}
        />
        <TeamRosterRow label="Enemy" championIds={enemyChampionIds} selfChampionId={null} iconMap={iconMap} />
      </div>
    </section>
  );
}

function TeamRosterRow({
  label,
  championIds,
  selfChampionId,
  iconMap,
}: {
  label: string;
  championIds: number[];
  selfChampionId: number | null;
  iconMap: Map<number, ChampionIconEntry> | null;
}) {
  return (
    <div>
      <p className="text-[9.5px] uppercase tracking-[0.5px] text-mut mb-1.5">{label}</p>
      <div className="flex items-start gap-2 flex-wrap" role="group" aria-label={`${label} team`}>
        {championIds.map((champId, i) => {
          const entry = iconMap?.get(champId);
          const name = entry?.name ?? `Champion #${champId}`;
          const isSelf = champId === selfChampionId;
          return (
            <div key={`${champId}-${i}`} className="flex flex-col items-center gap-1 w-12 flex-shrink-0">
              <div
                className={`w-9 h-9 rounded-full bg-black/30 overflow-hidden flex items-center justify-center flex-shrink-0 ${
                  isSelf
                    ? "border-2 border-teal shadow-[0_0_10px_rgba(130,219,247,0.3)]"
                    : "border border-line opacity-70"
                }`}
              >
                <IconWithFallback
                  src={entry?.icon ?? ""}
                  alt={name}
                  fallbackGlyph={name}
                  className="w-full h-full object-cover"
                />
              </div>
              <span className="text-[9px] text-mut text-center leading-tight truncate w-full">{name}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
