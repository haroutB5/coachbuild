"use client";

import { useEffect, useState } from "react";
import type { ProGame, ProGamesApiResponse, ProGameSource } from "./proGames.types";
import { SOURCE_FILTER_OPTIONS, proGamesEmptyTitle, proGamesEmptySub } from "./proGames.types";
import ProGameCard from "./ProGameCard";
import ProGamesSkeleton from "./ProGamesSkeleton";
import SegmentedControl from "./SegmentedControl";
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
  /** Display name for the selected player/champion — drives the filter-aware
   *  empty-state copy ("No pro-play games tracked yet for X"). */
  subjectLabel: string;
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
  subjectLabel,
}: ProHistoryResultsProps) {
  const [state, setState] = useState<ResultsState>({ status: "loading" });
  const [iconMap, setIconMap] = useState<Map<number, ChampionIconEntry> | null>(null);
  const [source, setSource] = useState<ProGameSource>("all");

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });

    const url =
      mode === "player"
        ? `/api/pros?proId=${encodeURIComponent(playerId ?? "")}&limit=${limit}&source=${source}`
        : `/api/pros?championId=${championId}&role=${role}&limit=${limit}&source=${source}`;

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
  }, [mode, playerId, championId, role, limit, source]);

  // Both modes need the id->name/icon map: player mode for icons across
  // champions, and EVERY mode for display names — match-v5 stores Riot's
  // internal championName ("MonkeyKing"), not the display name ("Wukong").
  // Cheap after the first call — module-level cached.
  useEffect(() => {
    let cancelled = false;
    getChampionIconMap().then((map) => {
      if (!cancelled) setIconMap(map);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const sourceFilterRow = (
    <div className="flex justify-end mb-3 px-1">
      <SegmentedControl
        ariaLabel="Filter results by source"
        value={source}
        onChange={setSource}
        options={SOURCE_FILTER_OPTIONS}
        size="sm"
      />
    </div>
  );

  if (state.status === "loading") {
    return (
      <>
        {sourceFilterRow}
        <ProGamesSkeleton />
      </>
    );
  }

  if (state.status === "error") {
    return (
      <>
        {sourceFilterRow}
        <div className="glass-card rounded-2xl p-10 text-center">
          <div className="text-4xl mb-3 opacity-40">⚠️</div>
          <div className="text-txt font-semibold mb-1">Couldn&apos;t load games — try again</div>
          <div className="text-mut text-sm">Check your connection and refresh.</div>
        </div>
      </>
    );
  }

  if (state.status === "empty") {
    return (
      <>
        {sourceFilterRow}
        <div className="glass-card rounded-2xl px-5 py-10 text-center">
          <div className="text-4xl mb-3 opacity-40">📊</div>
          <div className="text-txt font-semibold mb-1">{proGamesEmptyTitle(source, subjectLabel)}</div>
          <div className="text-mut text-sm">{proGamesEmptySub(source)}</div>
        </div>
      </>
    );
  }

  return (
    <>
      {sourceFilterRow}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {state.games.map((game) => (
          <ProGameCard
            key={game.id}
            game={game}
            championIcon={mode === "champion" ? championIcon : iconMap?.get(game.championId)?.icon}
            championDisplayName={iconMap?.get(game.championId)?.name}
          />
        ))}
      </div>
    </>
  );
}
