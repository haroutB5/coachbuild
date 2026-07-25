"use client";

import { useEffect, useState } from "react";
import type { ProGame, ProGamesApiResponse, ProGameSource } from "./proGames.types";
import { SOURCE_FILTER_OPTIONS, proGamesEmptyTitle, proGamesEmptySub } from "./proGames.types";
import ProGameCard from "./ProGameCard";
import ProGamesSkeleton from "./ProGamesSkeleton";
import SegmentedControl from "./SegmentedControl";
import { getChampionIconMap, type ChampionIconEntry } from "./proAssets";
import type { PendingPlayerSelect } from "./playerSelectHandoff";

interface ProHistoryResultsProps {
  mode: "player" | "champion";
  playerId?: string;
  /** Untracked prostage-only player identity (Teams-box tap on a roster slot
   *  with no `pros` row) — mutually exclusive with playerId; when playerId
   *  is also set, playerId wins (shouldn't happen in practice, see
   *  TeamComp.tsx's PlayerRow). Forces the fetch + the source filter to Pro
   *  Play — a link-only player has no soloq data to show. */
  playerLink?: string;
  championId?: number;
  /** Already known in champion mode (the picked ChampionRef's own icon) —
   *  avoids a redundant lookup for the one-champion case. */
  championIcon?: string;
  role?: number; // champion mode only; 5 = all lanes
  limit?: number;
  /** Display name for the selected player/champion — drives the filter-aware
   *  empty-state copy ("No pro-play games tracked yet for X"). */
  subjectLabel: string;
  /** Threaded straight through to each ProGameCard/GameDetailSheet — see
   *  GameDetailSheet's doc comment for the same-page-callback vs.
   *  cross-page-navigation split. /history passes its own "switch to Player
   *  mode + select" handler here; nothing else renders this component. */
  onSelectPlayer?: (player: PendingPlayerSelect) => void;
  /** Back-gesture history integration (app/history/page.tsx) — the game id
   *  whose sheet should be forced open, plus the open/dismiss reporters.
   *  Forwarded straight through to every ProGameCard as its historySheet
   *  prop. This component has exactly one consumer (/history) so these are
   *  always supplied together in practice; kept optional for the same
   *  defensive-future-consumer posture the rest of this file already uses. */
  openGameId?: string | null;
  onOpenGame?: (gameId: string) => void;
  onDismissGame?: () => void;
}

type ResultsState =
  | { status: "loading" }
  | { status: "ok"; games: ProGame[] }
  | { status: "empty" }
  | { status: "error" };

export default function ProHistoryResults({
  mode,
  playerId,
  playerLink,
  championId,
  championIcon,
  role = 5,
  limit = 20,
  subjectLabel,
  onSelectPlayer,
  openGameId,
  onOpenGame,
  onDismissGame,
}: ProHistoryResultsProps) {
  const [state, setState] = useState<ResultsState>({ status: "loading" });
  const [iconMap, setIconMap] = useState<Map<number, ChampionIconEntry> | null>(null);
  const [source, setSource] = useState<ProGameSource>("all");

  // Bumped when an on-demand refresh actually inserted new games, to re-run the
  // fetch below (see the refresh effect).
  const [refreshTick, setRefreshTick] = useState(0);

  // A link-only player (no `pros` row — see proHistory.types.ts) has no
  // soloq data at all: the source is forced to Pro Play regardless of the
  // (unrendered, see sourceFilterRow below) `source` toggle state.
  const isLinkOnly = mode === "player" && !playerId && !!playerLink;
  const effectiveSource: ProGameSource = isLinkOnly ? "prostage" : source;

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });

    const url =
      mode === "player"
        ? playerId
          ? `/api/pros?proId=${encodeURIComponent(playerId)}&limit=${limit}&source=${source}`
          : `/api/pros?player=${encodeURIComponent(playerLink ?? "")}&limit=${limit}&source=prostage`
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
  }, [mode, playerId, playerLink, championId, role, limit, source, refreshTick]);

  // On-demand solo-queue refresh for the player being opened.
  //
  // The background sweep cannot keep everyone current — it walks 5 accounts per
  // invocation behind a 2-daily Hobby cron with no pinger draining its cursor,
  // which against 2801 accounts is a ~3-year cycle (measured 2026-07-25: 2440
  // accounts NEVER fetched, 1 fetched in the prior 2 days). That is what
  // "Bwipo's soloQ isn't up to date" and "TheShy has no games" actually were.
  // Pull freshness to the moment of interest instead.
  //
  // Deliberately does NOT block the render: the list above paints from whatever
  // we already hold, and we only re-fetch if the refresh actually inserted
  // something. Server-side cooldown keeps repeat opens off Riot's API.
  // `cancelled` guard per gotcha (q) — prop-keyed effect, stale-response risk.
  useEffect(() => {
    if (mode !== "player" || !playerId) return;
    let cancelled = false;

    // POST: the route mutates and spends the Riot key, so it must not be a
    // safe method (a GET was cross-origin-triggerable via a bare <img> tag).
    fetch(`/api/pros/refresh?proId=${encodeURIComponent(playerId)}`, { method: "POST" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { inserted?: number } | null) => {
        if (!cancelled && (data?.inserted ?? 0) > 0) setRefreshTick((tick) => tick + 1);
      })
      .catch(() => {
        // A failed refresh is non-fatal — we still show what we have.
      });

    return () => {
      cancelled = true;
    };
  }, [mode, playerId]);

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

  // Link-only players have no soloq data to filter to/from at all — showing
  // a live All|Solo Queue|Pro Play toggle would offer two tabs that are
  // always empty (soloq, and the difference between "all" and "pro play").
  // A locked, explained label is more honest than a disabled control with no
  // reason given.
  const sourceFilterRow = isLinkOnly ? (
    <div className="flex justify-end mb-3 px-1">
      <span className="inline-flex items-center px-2.5 py-1 rounded-lg text-[11.5px] font-semibold bg-panel2 border border-line text-mut">
        Pro Play only <span className="text-mut/70 font-normal">— no solo queue data</span>
      </span>
    </div>
  ) : (
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
          <div className="text-txt font-semibold mb-1">{proGamesEmptyTitle(effectiveSource, subjectLabel)}</div>
          <div className="text-mut text-sm">{proGamesEmptySub(effectiveSource)}</div>
        </div>
      </>
    );
  }

  return (
    <>
      {sourceFilterRow}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        {state.games.map((game) => (
          <ProGameCard
            key={game.id}
            game={game}
            championIcon={mode === "champion" ? championIcon : iconMap?.get(game.championId)?.icon}
            championDisplayName={iconMap?.get(game.championId)?.name}
            onSelectPlayer={onSelectPlayer}
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
        ))}
      </div>
    </>
  );
}
