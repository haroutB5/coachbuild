"use client";

import { useEffect, useState } from "react";
import type { ProGame, ProGamesApiResponse } from "./proGames.types";
import ProGameCard from "./ProGameCard";
import ProGamesSkeleton from "./ProGamesSkeleton";
import { getChampionIconMap, type ChampionIconEntry } from "./proAssets";

interface ProHistoryResultsProps {
  mode: "player" | "champion";
  playerId?: string;
  championId?: number;
  /** Already known in champion mode (the picked ChampionRef's own icon) —
   *  avoids a redundant lookup for the one-champion case. */
  championIcon?: string;
  role?: number; // champion mode only; 5 = all lanes
  limit?: number;
}

type ResultsState =
  | { status: "loading" }
  | { status: "ok"; games: ProGame[] }
  | { status: "empty" }
  | { status: "error" };

export default function ProHistoryResults({
  mode,
  playerId,
  championId,
  championIcon,
  role = 5,
  limit = 20,
}: ProHistoryResultsProps) {
  const [state, setState] = useState<ResultsState>({ status: "loading" });
  const [iconMap, setIconMap] = useState<Map<number, ChampionIconEntry> | null>(null);

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });

    const url =
      mode === "player"
        ? `/api/pros?proId=${encodeURIComponent(playerId ?? "")}&limit=${limit}`
        : `/api/pros?championId=${championId}&role=${role}&limit=${limit}`;

    fetch(url)
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
  }, [mode, playerId, championId, role, limit]);

  // Player mode: results can span multiple champions, so resolve the shared
  // id->icon map once (cheap after the first call — module-level cached).
  useEffect(() => {
    if (mode !== "player") return;
    let cancelled = false;
    getChampionIconMap().then((map) => {
      if (!cancelled) setIconMap(map);
    });
    return () => {
      cancelled = true;
    };
  }, [mode]);

  if (state.status === "loading") return <ProGamesSkeleton />;

  if (state.status === "error") {
    return (
      <div className="bg-gradient-to-b from-panel to-[#0d121a] border border-line rounded-2xl p-10 text-center">
        <div className="text-4xl mb-3 opacity-40">⚠️</div>
        <div className="text-txt font-semibold mb-1">Couldn&apos;t load games — try again</div>
        <div className="text-mut text-sm">Check your connection and refresh.</div>
      </div>
    );
  }

  if (state.status === "empty") {
    return (
      <div className="bg-gradient-to-b from-panel to-[#0d121a] border border-line rounded-2xl px-5 py-10 text-center">
        <div className="text-4xl mb-3 opacity-40">📊</div>
        <div className="text-txt font-semibold mb-1">No tracked games yet</div>
        <div className="text-mut text-sm">Check back after their next solo queue session.</div>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      {state.games.map((game) => (
        <ProGameCard
          key={game.id}
          game={game}
          championIcon={mode === "champion" ? championIcon : iconMap?.get(game.championId)?.icon}
        />
      ))}
    </div>
  );
}
