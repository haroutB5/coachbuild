"use client";

import { useEffect, useState } from "react";
import type { ChampionRef } from "@/lib/types";
import type { ProGame, ProGamesApiResponse, ProGameSource } from "@/components/proGames.types";
import { SOURCE_FILTER_OPTIONS, proGamesEmptyTitle, proGamesEmptySub } from "@/components/proGames.types";
import { getChampionIconMap, type ChampionIconEntry } from "@/components/proAssets";
import SegmentedControl from "@/components/SegmentedControl";
import { LANE_TO_ROLE_ID, type LaneId } from "./heroContracts";
import ProBuildRow from "./ProBuildRow";

interface ProBuildsTabProps {
  champ: ChampionRef;
  lane: LaneId;
  /** All/Solo Queue/Pro Play games-list filter (v0.24.0) — the SAME
   *  ProGameSource/SOURCE_FILTER_OPTIONS the pre-Hextech /history page's
   *  ProGamesSection.tsx already uses, restored here after the Hextech
   *  redesign dropped it. Controlled from app/page.tsx (not local state) so
   *  it survives back/forward as view sub-state — see homeSearch.ts's
   *  WireMainView doc comment. Defaults to "prostage": the Hextech spec's
   *  PRO BUILDS mockup (Design/redesign-2026-07/pro-builds-tab.png) shows
   *  only prostage rows (league + date column), so that's what pixel-matches
   *  the spec on first load — but the old /history page offered all three
   *  sources here too, so the toggle stays available rather than locking the
   *  tab to prostage-only. */
  source: ProGameSource;
  onSourceChange: (source: ProGameSource) => void;
  /** Back-gesture history integration (app/page.tsx) — the game id whose
   *  sheet should be forced open, plus the open/dismiss reporters. Forwarded
   *  straight through to every ProBuildRow as its historySheet prop. See
   *  ProHistoryResults' identical props (app/history/page.tsx's original
   *  wiring) for the full contract. */
  openGameId?: string | null;
  onOpenGame?: (gameId: string) => void;
  onDismissGame?: () => void;
}

type State =
  | { status: "loading" }
  | { status: "ok"; games: ProGame[] }
  | { status: "empty" }
  | { status: "error" };

function RowSkeleton() {
  return <div className="h-[52px] bg-panel border border-line rounded-xl animate-pulse" />;
}

export default function ProBuildsTab({
  champ,
  lane,
  source,
  onSourceChange,
  openGameId,
  onOpenGame,
  onDismissGame,
}: ProBuildsTabProps) {
  const [state, setState] = useState<State>({ status: "loading" });
  const [championMap, setChampionMap] = useState<Map<number, ChampionIconEntry> | null>(null);

  useEffect(() => {
    getChampionIconMap().then(setChampionMap);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    const role = LANE_TO_ROLE_ID[lane];
    fetch(`/api/pros?championId=${champ.id}&role=${role}&limit=20&source=${source}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`pros fetch ${res.status}`);
        const data: ProGamesApiResponse = await res.json();
        if (cancelled) return;
        const games = Array.isArray(data?.games) ? data.games : [];
        setState(games.length > 0 ? { status: "ok", games } : { status: "empty" });
      })
      .catch(() => {
        if (!cancelled) setState({ status: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [champ.id, lane, source]);

  const filterBar = (
    <div className="flex justify-start mb-3">
      <SegmentedControl
        ariaLabel="Filter pro builds by source"
        value={source}
        onChange={onSourceChange}
        options={SOURCE_FILTER_OPTIONS}
        size="sm"
      />
    </div>
  );

  if (state.status === "loading") {
    return (
      <div className="mt-5">
        {filterBar}
        <div className="space-y-2.5">
          <RowSkeleton />
          <RowSkeleton />
          <RowSkeleton />
        </div>
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div className="mt-5">
        {filterBar}
        <div className="bg-panel border border-line rounded-xl p-10 text-center">
          <div className="text-txt font-semibold mb-1">Couldn&apos;t load pro builds</div>
          <div className="text-mut text-sm">Check your connection and try again.</div>
        </div>
      </div>
    );
  }

  if (state.status === "empty") {
    return (
      <div className="mt-5">
        {filterBar}
        <div className="bg-panel border border-line rounded-xl p-10 text-center">
          <div className="text-txt font-semibold mb-1">{proGamesEmptyTitle(source, champ.name)}</div>
          <div className="text-mut text-sm">{proGamesEmptySub(source)}</div>
        </div>
      </div>
    );
  }

  const role = LANE_TO_ROLE_ID[lane];

  return (
    <div className="mt-5">
      {filterBar}
      <div className="space-y-2.5">
        {state.games.map((game) => {
          const enemyId = game.enemyChampionIds?.[role];
          const enemyLaner = enemyId !== undefined ? championMap?.get(enemyId) : undefined;
          return (
            <ProBuildRow
              key={game.id}
              game={game}
              championIcon={champ.icon}
              championDisplayName={champ.name}
              enemyLaner={enemyLaner}
              historySheet={
                openGameId !== undefined
                  ? {
                      isOpen: openGameId === game.id,
                      onOpen: () => onOpenGame?.(game.id),
                      onDismiss: () => onDismissGame?.(),
                    }
                  : undefined
              }
            />
          );
        })}
      </div>
    </div>
  );
}
