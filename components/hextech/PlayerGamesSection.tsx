"use client";

import { useEffect, useState } from "react";
import type { ProGame, ProGamesApiResponse, ProGameSource } from "@/components/proGames.types";
import { SOURCE_FILTER_OPTIONS, proGamesEmptyTitle, proGamesEmptySub } from "@/components/proGames.types";
import { getChampionIconMap, type ChampionIconEntry } from "@/components/proAssets";
import SegmentedControl from "@/components/SegmentedControl";
import type { PendingPlayerSelect } from "@/components/playerSelectHandoff";
import ProBuildRow from "./ProBuildRow";
import type { PlayerSubject } from "./homeSearch";

interface PlayerGamesSectionProps {
  /** v0.26.0: tracked (proId-addressable) or link-only untracked (raw
   *  Leaguepedia player_link, no `pros` row) — see homeSearch.ts's
   *  PlayerSubject doc comment. Previously this always received a fully-
   *  resolved PlayerRef (the sidebar PROS search flow's only source); a
   *  Teams-box sheet-tap can now also land here with a link-only subject. */
  subject: PlayerSubject;
  /** All/Solo Queue/Pro Play games-list filter (v0.24.0) — see ProBuildsTab's
   *  identical prop contract. Defaults to "all" here (a player's tracked
   *  history is mostly solo queue; "all" is the useful starting point,
   *  matching the pre-Hextech /history page's default for this same field).
   *  A link-only subject's server-side query is prostage-only regardless of
   *  this value (see app/api/pros/route.ts's `player=` doc comment) — the
   *  filter UI below locks to a single explanatory label for that case,
   *  mirroring /history's ProHistoryResults treatment, rather than offering
   *  a live control that can only ever change between "empty" and "empty". */
  source: ProGameSource;
  onSourceChange: (source: ProGameSource) => void;
  /** Back-gesture history integration (app/page.tsx) — the SAME
   *  useSheetBackNav instance ProBuildsTab uses (only one of the two is ever
   *  mounted at a time, since PROS mode replaces the champion view entirely
   *  rather than sitting alongside it), so opening a game sheet here also
   *  integrates with browser/iOS back-swipe. See ProBuildsTab's identical
   *  prop contract. */
  openGameId?: string | null;
  onOpenGame?: (gameId: string) => void;
  onDismissGame?: () => void;
  /** v0.26.0: Teams-box "view this player's games" tap FROM one of this
   *  section's own game sheets (e.g. browsing Bwipo's games, tap a teammate)
   *  — threaded straight through to ProBuildRow/GameDetailSheet. Previously
   *  unset, so this cross-player jump also fell through to the legacy
   *  cross-page fallback (see ProBuildsTab's identical prop for the same
   *  fix). */
  onSelectPlayer?: (player: PendingPlayerSelect) => void;
}

type State =
  | { status: "loading" }
  | { status: "ok"; games: ProGame[] }
  | { status: "empty" }
  | { status: "error" };

function RowSkeleton() {
  return <div className="h-[52px] bg-panel border border-line rounded-xl animate-pulse" />;
}

export default function PlayerGamesSection({
  subject,
  source,
  onSourceChange,
  openGameId,
  onOpenGame,
  onDismissGame,
  onSelectPlayer,
}: PlayerGamesSectionProps) {
  const [state, setState] = useState<State>({ status: "loading" });
  const [championMap, setChampionMap] = useState<Map<number, ChampionIconEntry> | null>(null);

  const isLinkOnly = subject.kind === "link";
  // A link-only subject's server query is prostage-only regardless of what
  // `source` holds (see app/api/pros/route.ts's `player=` doc comment) —
  // this is what the UI actually shows, used for both the fetch URL below
  // and the empty-state copy so they can never disagree.
  const effectiveSource: ProGameSource = isLinkOnly ? "prostage" : source;

  useEffect(() => {
    getChampionIconMap().then(setChampionMap);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    // Champion-agnostic — role=5 (all lanes) is the "auto" sentinel
    // /api/pros already defaults to for a proId/player lookup with no role
    // param; passed explicitly here since a player's games span every lane
    // they've played, not one fixed lane the way ProBuildsTab's champion
    // view is. Tracked subjects query by proId; link-only (untracked)
    // subjects have no `pros` row to key on at all, so they query by the
    // raw Leaguepedia player_link instead (v0.26.0 — see homeSearch.ts's
    // PlayerSubject doc comment for why this component now takes a subject
    // instead of always-fully-known PlayerRef).
    const url =
      subject.kind === "tracked"
        ? `/api/pros?proId=${encodeURIComponent(subject.id)}&role=5&limit=20&source=${effectiveSource}`
        : `/api/pros?player=${encodeURIComponent(subject.playerLink)}&role=5&limit=20&source=${effectiveSource}`;
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
  }, [subject, effectiveSource]);

  // A link-only player has no soloq data at all — showing a live All|Solo
  // Queue|Pro Play toggle would offer two tabs that are always empty (soloq,
  // and the difference between "all" and "pro play"). A locked, explained
  // label is more honest than a disabled control with no reason given —
  // mirrors /history's own ProHistoryResults treatment exactly (v0.20.0).
  const filterBar = isLinkOnly ? (
    <div className="flex justify-start mb-3">
      <span className="inline-flex items-center px-2.5 py-1 rounded-lg text-[11.5px] font-semibold bg-panel2 border border-line text-mut">
        Pro Play only <span className="text-mut/70 font-normal">— untracked player, no solo queue data</span>
      </span>
    </div>
  ) : (
    <div className="flex justify-start mb-3">
      <SegmentedControl
        ariaLabel="Filter games by source"
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
          <div className="text-txt font-semibold mb-1">Couldn&apos;t load {subject.name}&apos;s games</div>
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
          <div className="text-txt font-semibold mb-1">{proGamesEmptyTitle(effectiveSource, subject.name)}</div>
          <div className="text-mut text-sm">{proGamesEmptySub(effectiveSource)}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="mt-5">
      {filterBar}
      <div className="space-y-2.5">
        {state.games.map((game) => {
          // Unlike ProBuildsTab (fixed champion+lane, one enemy laner for
          // every row), a player's own recent games span many champions/
          // lanes — the champion icon/name AND the "vs" opponent are both
          // per-row here.
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
          );
        })}
      </div>
    </div>
  );
}
