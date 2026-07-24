"use client";

// ─────────────────────────────────────────────────────────────────────────────
// ProPlayersTable — /history's default "PRO PLAYERS" table (mockup 8.png,
// v0.51 wave B). Shows the most recent tracked competitive games across every
// pro player in one flat table, above the existing player/champion SEARCH
// flow (which stays fully functional, untouched, below this).
//
// Data: GET /api/pros/recent?limit=20 (engo, concurrent) -> lightweight rows
// (playerLink/playerName/team/championId/championName/role/win/kills/
// deaths/assists/event/gameId) — NOT a full ProGame (no items/runes/spells).
// Row click reuses the EXACT existing full-build flow: fetches
// `/api/pros?player=<playerLink>&source=prostage&limit=100` (the same
// untracked-player wiring ProHistoryResults/ProGameCard already use for a
// Teams-box tap), finds the matching game by `gameId` in that response, and
// opens the same GameDetailSheet component with it. No new detail endpoint
// needed.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from "react";
import { IconWithFallback } from "@/components/IconWithFallback";
import GameDetailSheet from "@/components/GameDetailSheet";
import { getChampionIconMap, type ChampionIconEntry } from "@/components/proAssets";
import type { ProGame, ProGamesApiResponse } from "@/components/proGames.types";

export interface RecentProGame {
  playerLink: string;
  playerName: string;
  team: string | null;
  championId: number;
  championName: string;
  role: number;
  win: boolean;
  kills: number;
  deaths: number;
  assists: number;
  event: string | null;
  gameId: string;
}

interface RecentProGamesWire {
  games: RecentProGame[];
}

type ListState = { status: "loading" } | { status: "ok"; games: RecentProGame[] } | { status: "empty" } | { status: "error" };

type DetailState =
  | { status: "idle" }
  | { status: "loading"; row: RecentProGame }
  | { status: "error"; row: RecentProGame }
  | { status: "ok"; row: RecentProGame; game: ProGame };

const ROLE_ABBR: Record<number, string> = { 0: "TOP", 1: "JG", 2: "MID", 3: "BOT", 4: "SUP" };

function Skeleton() {
  return (
    <div className="bg-panel border border-line rounded-xl p-5 animate-pulse space-y-4">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-full bg-panel2 flex-shrink-0" />
          <div className="flex-1 space-y-1.5">
            <div className="h-2.5 w-32 bg-panel2 rounded" />
          </div>
        </div>
      ))}
    </div>
  );
}

export default function ProPlayersTable() {
  const [state, setState] = useState<ListState>({ status: "loading" });
  const [champIcons, setChampIcons] = useState<Map<number, ChampionIconEntry>>(new Map());
  const [detail, setDetail] = useState<DetailState>({ status: "idle" });

  useEffect(() => {
    getChampionIconMap().then(setChampIcons);
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/pros/recent?limit=20")
      .then(async (res) => {
        if (!res.ok) throw new Error(`pros/recent fetch ${res.status}`);
        const data: RecentProGamesWire = await res.json();
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
  }, []);

  function openRow(row: RecentProGame) {
    setDetail({ status: "loading", row });
    fetch(`/api/pros?player=${encodeURIComponent(row.playerLink)}&limit=100&source=prostage`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`pros fetch ${res.status}`);
        const data: ProGamesApiResponse = await res.json();
        const found = Array.isArray(data?.games) ? data.games.find((g) => g.id === row.gameId) : undefined;
        if (!found) {
          setDetail({ status: "error", row });
          return;
        }
        setDetail({ status: "ok", row, game: found });
      })
      .catch(() => setDetail({ status: "error", row }));
  }

  if (state.status === "loading") return <Skeleton />;

  if (state.status === "error") {
    return (
      <div className="bg-panel border border-line rounded-xl p-8 text-center">
        <p className="text-txt font-semibold mb-1 text-[13px]">Couldn&apos;t load recent pro games</p>
        <p className="text-mut text-[12px]">Check your connection and refresh.</p>
      </div>
    );
  }

  if (state.status === "empty") {
    return (
      <div className="bg-panel border border-line rounded-xl p-8 text-center">
        <p className="text-txt font-semibold mb-1 text-[13px]">No recent pro games tracked yet</p>
        <p className="text-mut text-[12px]">Check back after the next tracked match.</p>
      </div>
    );
  }

  return (
    <>
      {detail.status === "error" && (
        <div className="mb-3 flex items-center justify-between gap-3 bg-bad/10 border border-bad/30 rounded-lg px-4 py-2.5 text-[12px] text-bad">
          <span>
            Couldn&apos;t load the full build for {detail.row.playerName} — {detail.row.championName}.
          </span>
          <button type="button" onClick={() => setDetail({ status: "idle" })} className="font-semibold hover:underline flex-shrink-0">
            Dismiss
          </button>
        </div>
      )}

      <div className="bg-panel border border-line rounded-xl px-5">
        <div className="hidden md:grid grid-cols-[1.1fr_0.7fr_1.3fr_0.6fr_0.6fr_0.9fr_1.1fr] gap-3 pt-4 pb-2 text-[10px] tracking-[0.1em] uppercase text-mut font-semibold">
          <span>Player</span>
          <span>Team</span>
          <span>Champion</span>
          <span>Role</span>
          <span>W-L</span>
          <span>KDA</span>
          <span>Event</span>
        </div>

        {state.games.map((row) => {
          const entry = champIcons.get(row.championId);
          const loadingThisRow = detail.status === "loading" && detail.row.gameId === row.gameId;
          return (
            <button
              key={row.gameId}
              type="button"
              onClick={() => openRow(row)}
              disabled={detail.status === "loading"}
              aria-label={`View full build — ${row.playerName}, ${row.championName}, ${row.win ? "win" : "loss"}`}
              className="w-full text-left grid grid-cols-[1fr_auto] md:grid-cols-[1.1fr_0.7fr_1.3fr_0.6fr_0.6fr_0.9fr_1.1fr] gap-x-3 gap-y-1 items-center py-2.5 border-b border-line last:border-b-0 hover:bg-panel2/60 transition-colors disabled:opacity-60 disabled:cursor-wait focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal focus-visible:ring-offset-2 focus-visible:ring-offset-bg rounded-lg"
            >
              <span className="text-[12.5px] text-txt font-semibold truncate">
                {row.playerName}
                {loadingThisRow && <span className="ml-1.5 text-mut font-normal">Loading…</span>}
              </span>

              <span className="hidden md:block text-[11.5px] font-bold uppercase text-teal truncate">{row.team ?? "—"}</span>

              <span className="col-span-2 md:col-span-1 flex items-center gap-2 min-w-0">
                <span className="w-6 h-6 rounded-full bg-black/30 border border-line overflow-hidden flex items-center justify-center flex-shrink-0">
                  <IconWithFallback
                    src={entry?.icon ?? ""}
                    alt=""
                    fallbackGlyph={row.championName}
                    className="w-full h-full object-cover"
                    size={24}
                  />
                </span>
                <span className="text-[12.5px] text-txt truncate">{row.championName}</span>
              </span>

              <span className="hidden md:block text-[10.5px] text-mut uppercase tracking-[0.05em]">
                {ROLE_ABBR[row.role] ?? "—"}
              </span>

              <span className={`hidden md:block text-[13px] font-extrabold ${row.win ? "text-good" : "text-bad"}`}>
                {row.win ? "W" : "L"}
              </span>

              <span className="hidden md:block text-[12px] text-txt tabular-nums">
                {row.kills} / {row.deaths} / {row.assists}
              </span>

              <span className="hidden md:block text-[11px] text-mut truncate">{row.event ?? "—"}</span>

              {/* Mobile-only compact second line — team/role/W-L/KDA/event
                  collapsed since the grid above hides those columns below
                  the md breakpoint. */}
              <span className="md:hidden col-span-2 flex items-center gap-1.5 text-[11px] text-mut tabular-nums">
                <span className={`font-extrabold ${row.win ? "text-good" : "text-bad"}`}>{row.win ? "W" : "L"}</span>
                <span aria-hidden="true">&middot;</span>
                <span>{ROLE_ABBR[row.role] ?? "—"}</span>
                <span aria-hidden="true">&middot;</span>
                <span>
                  {row.kills}/{row.deaths}/{row.assists}
                </span>
                {row.team && (
                  <>
                    <span aria-hidden="true">&middot;</span>
                    <span className="text-teal font-bold uppercase">{row.team}</span>
                  </>
                )}
              </span>
            </button>
          );
        })}
      </div>

      {detail.status === "ok" && (
        <GameDetailSheet
          game={detail.game}
          championIcon={champIcons.get(detail.game.championId)?.icon}
          championDisplayName={champIcons.get(detail.game.championId)?.name}
          open
          onClose={() => setDetail({ status: "idle" })}
        />
      )}
    </>
  );
}
