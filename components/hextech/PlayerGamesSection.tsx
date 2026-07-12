"use client";

import { useEffect, useState } from "react";
import type { PlayerRef } from "@/components/proHistory.types";
import type { ProGame, ProGamesApiResponse } from "@/components/proGames.types";
import { getChampionIconMap, type ChampionIconEntry } from "@/components/proAssets";
import ProBuildRow from "./ProBuildRow";

interface PlayerGamesSectionProps {
  player: PlayerRef;
  /** Back-gesture history integration (app/page.tsx) — the SAME
   *  useSheetBackNav instance ProBuildsTab uses (only one of the two is ever
   *  mounted at a time, since PROS mode replaces the champion view entirely
   *  rather than sitting alongside it), so opening a game sheet here also
   *  integrates with browser/iOS back-swipe. See ProBuildsTab's identical
   *  prop contract. */
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

export default function PlayerGamesSection({ player, openGameId, onOpenGame, onDismissGame }: PlayerGamesSectionProps) {
  const [state, setState] = useState<State>({ status: "loading" });
  const [championMap, setChampionMap] = useState<Map<number, ChampionIconEntry> | null>(null);

  useEffect(() => {
    getChampionIconMap().then(setChampionMap);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    // Champion-agnostic — role=5 (all lanes) is the "auto" sentinel
    // /api/pros already defaults to for a proId lookup with no role param;
    // passed explicitly here since a player's games span every lane they've
    // played, not one fixed lane the way ProBuildsTab's champion view is.
    fetch(`/api/pros?proId=${encodeURIComponent(player.id)}&role=5&limit=20`)
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
  }, [player.id]);

  if (state.status === "loading") {
    return (
      <div className="mt-5 space-y-2.5">
        <RowSkeleton />
        <RowSkeleton />
        <RowSkeleton />
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div className="mt-5 bg-panel border border-line rounded-xl p-10 text-center">
        <div className="text-txt font-semibold mb-1">Couldn&apos;t load {player.name}&apos;s games</div>
        <div className="text-mut text-sm">Check your connection and try again.</div>
      </div>
    );
  }

  if (state.status === "empty") {
    return (
      <div className="mt-5 bg-panel border border-line rounded-xl p-10 text-center">
        <div className="text-txt font-semibold mb-1">No tracked games yet for {player.name}</div>
        <div className="text-mut text-sm">Check back after their next tracked game.</div>
      </div>
    );
  }

  return (
    <div className="mt-5 space-y-2.5">
      {state.games.map((game) => {
        // Unlike ProBuildsTab (fixed champion+lane, one enemy laner for every
        // row), a player's own recent games span many champions/lanes — the
        // champion icon/name AND the "vs" opponent are both per-row here.
        const champEntry = championMap?.get(game.championId);
        const enemyId = game.enemyChampionIds?.[game.role];
        const enemyLaner = enemyId !== undefined ? championMap?.get(enemyId) : undefined;
        return (
          <ProBuildRow
            key={game.id}
            game={game}
            championIcon={champEntry?.icon}
            championDisplayName={champEntry?.name ?? game.championName}
            enemyLaner={enemyLaner}
            showOwnChampion
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
  );
}
