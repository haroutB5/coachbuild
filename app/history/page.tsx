"use client";

import { useState } from "react";
import type { ChampionRef } from "@/lib/types";
import SegmentedControl from "@/components/SegmentedControl";
import PlayerPicker from "@/components/PlayerPicker";
import ChampionPicker from "@/components/ChampionPicker";
import LanePillRow from "@/components/LanePillRow";
import ProHistoryResults from "@/components/ProHistoryResults";
import FavoritePlayerChips from "@/components/FavoritePlayerChips";
import FavoriteChampionChips from "@/components/FavoriteChampionChips";
import FavoriteStarButton from "@/components/FavoriteStarButton";
import { isFavorite, isFavoriteChampion } from "@/lib/favorites";
import { FAVORITES_CHANGED_EVENT, CHAMPION_FAVORITES_CHANGED_EVENT, toggleFavoritePlayer, toggleFavoriteChampion } from "@/components/favoritesSync";
import type { PlayerRef } from "@/components/proHistory.types";
import { consumePendingPlayerSelect, type PendingPlayerSelect } from "@/components/playerSelectHandoff";
import { useSheetBackNav, HISTORY_NAV_NAMESPACE } from "@/components/useSheetBackNav";
import {
  restoreSelectionState,
  type WirePlayerSubject,
  type WireSelection,
} from "@/components/historyRestore";
import ProPlayersSpotlight from "@/components/ProPlayersSpotlight";

// Module-level (stable references) so FavoriteStarButton's subscribe effect
// doesn't re-run on every page re-render.
const checkPlayerFavorited = (id: string | number) => isFavorite(String(id));
const checkChampionFavorited = (id: string | number) => isFavoriteChampion(Number(id));

type Mode = "player" | "champion";

const LANE_LABEL: Record<number, string> = {
  0: "Top",
  1: "Jungle",
  2: "Mid",
  3: "Bot",
  4: "Support",
  5: "All lanes",
};

// ─────────────────────────────────────────────────────────────────────────────
// Back-gesture history integration.
//
// Selection (player/champion pick) and sheet-open are both invisible client
// state today — a back gesture just leaves the page entirely. The actual
// pushState/popstate mechanics live in the shared `useSheetBackNav` hook
// (components/useSheetBackNav.ts, extracted here in v0.21.1 so the home
// page's PRO BUILDS tab could reuse the identical contract instead of a
// hand-rolled fork) so back steps through: sheet-open -> the selection it
// was opened on -> the selection before that -> ... -> wherever the user
// came from (no extra entry for the initial load, so the LAST back always
// exits correctly).
//
// Every entry is SELF-SUFFICIENT (full mode/subject/lane + which game's sheet
// is open, if any) rather than a delta — popstate only ever hands back a
// single state object for the entry landed on, never a diff from the
// previous one, so each entry must carry everything needed to repaint the
// page from scratch. This page owns the WireSelection shape (below) and
// hands it to the hook as its generic `S`; the hook owns openGameId +
// pushState/popstate/replaceState wiring.
//
// Two distinct "closing a sheet" paths, deliberately NOT unified:
//  - Explicit dismiss (✕ / Escape / backdrop) -> GameDetailSheet's onDismiss
//    -> the hook's dismissGame() -> history.back(), POPPING the sheet-open
//    entry so the stack never accumulates ghosts.
//  - Cross-player jump from inside the sheet (tap a Teams-box row) -> the
//    sheet closes visually, but its history entry is left in the stack
//    un-popped, and a NEW selection entry is pushed on top — so backing out
//    of the new player's games lands back on THIS selection with the sheet
//    still open (restored from that entry), then a second back closes it.
// ─────────────────────────────────────────────────────────────────────────────

/** Page-level view of "who is selected" — a superset of PlayerRef that also
 *  covers an untracked prostage player (Teams-box tap on a roster slot with
 *  no `pros` row: only a raw Leaguepedia `playerLink`, no `proId`/full
 *  PlayerRef fields). Tracked pros keep every existing behavior (favorite
 *  star, PlayerPicker/FavoritePlayerChips interop); link-only players are a
 *  read-only, Pro-Play-only view — see ProHistoryResults' isLinkOnly branch
 *  and the summary line below. */
type PlayerSubject =
  | { kind: "tracked"; ref: PlayerRef }
  | { kind: "link"; playerLink: string; name: string };

function toWirePlayerSubject(p: PlayerSubject): WirePlayerSubject {
  if (p.kind === "tracked") {
    return { kind: "tracked", id: p.ref.id, name: p.ref.name, team: p.ref.team };
  }
  return { kind: "link", playerLink: p.playerLink, name: p.name };
}

function fromWirePlayerSubject(s: WirePlayerSubject): PlayerSubject {
  if (s.kind === "tracked") {
    return {
      kind: "tracked",
      ref: { id: s.id, name: s.name, slug: "", team: s.team, role: null, country: null, gameCount: 0 },
    };
  }
  return { kind: "link", playerLink: s.playerLink, name: s.name };
}

/** Converts the Teams-box-tap / cross-page-handoff wire shape
 *  (PendingPlayerSelect — tracked {id,name,team} or link {playerLink,name},
 *  distinguished structurally, see playerSelectHandoff.ts) into a
 *  PlayerSubject. Pure — used both by the mount-time handoff consumption and
 *  the same-page sheet-tap handler below. */
function toPlayerSubject(ref: PendingPlayerSelect): PlayerSubject {
  if ("id" in ref) {
    return {
      kind: "tracked",
      ref: { id: ref.id, name: ref.name, slug: "", team: ref.team, role: null, country: null, gameCount: 0 },
    };
  }
  return { kind: "link", playerLink: ref.playerLink, name: ref.name };
}

export default function HistoryPage() {
  const [mode, setMode] = useState<Mode>("player");
  const [player, setPlayer] = useState<PlayerSubject | null>(null);
  const [champ, setChamp] = useState<ChampionRef | null>(null);
  const [lane, setLane] = useState<number>(5);

  const selected = mode === "player" ? player !== null : champ !== null;

  function currentWireSelection(): WireSelection | null {
    if (mode === "player") {
      return player ? { mode: "player", subject: toWirePlayerSubject(player) } : null;
    }
    return champ
      ? {
          mode: "champion",
          championId: champ.id,
          championKey: champ.key,
          championName: champ.name,
          championIcon: champ.icon,
          lane,
        }
      : null;
  }

  /** Repaints mode/player/champ/lane from a landed-on entry's selection —
   *  handed to useSheetBackNav as `onApplySelection`, fired on mount-resume
   *  and every popstate. The hook owns `openGameId` itself. */
  function restoreSelection(selection: unknown) {
    if (selection === null) {
      setMode("player");
      setPlayer(null);
      setChamp(null);
      return;
    }
    const validated = restoreSelectionState(selection);
    if (!validated) return;
    if (validated.mode === "player") {
      setMode("player");
      setChamp(null);
      setPlayer(fromWirePlayerSubject(validated.subject));
    } else {
      setMode("champion");
      setPlayer(null);
      setChamp({
        id: validated.championId,
        key: validated.championKey,
        name: validated.championName,
        icon: validated.championIcon,
      });
      setLane(validated.lane);
    }
  }

  /** Cross-page handoff (a Teams-box tap on the Builds page, stashed via
   *  sessionStorage + a real navigation — see playerSelectHandoff.ts),
   *  consumed once on mount by useSheetBackNav when there's no already-
   *  seeded entry to resume. Applies its own side effects AND returns the
   *  wire-shape selection to embed in the seeded entry. */
  function seedInitialSelection(): WireSelection | null {
    const pending = consumePendingPlayerSelect();
    if (!pending) return null;
    const subject = toPlayerSubject(pending);
    setMode("player");
    setChamp(null);
    setPlayer(subject);
    return { mode: "player", subject: toWirePlayerSubject(subject) };
  }

  const sheetNav = useSheetBackNav<WireSelection>({
    namespace: HISTORY_NAV_NAMESPACE,
    onApplySelection: restoreSelection,
    seedInitialSelection,
  });
  const openGameId = sheetNav.openGameId;

  function clearSelection() {
    if (mode === "player") setPlayer(null);
    else setChamp(null);
  }

  function choosePlayer(ref: PlayerRef) {
    if (sheetNav.isRestoring()) return;
    setMode("player");
    setChamp(null);
    const subject: PlayerSubject = { kind: "tracked", ref };
    setPlayer(subject);
    sheetNav.pushSelection({ mode: "player", subject: toWirePlayerSubject(subject) });
  }

  function chooseChampion(c: ChampionRef) {
    if (sheetNav.isRestoring()) return;
    setMode("champion");
    setPlayer(null);
    setChamp(c);
    sheetNav.pushSelection({
      mode: "champion",
      championId: c.id,
      championKey: c.key,
      championName: c.name,
      championIcon: c.icon,
      lane,
    });
  }

  /** Cross-player jump from inside a game-detail sheet (tap a Teams-box row)
   *  — same-page fast path passed to ProHistoryResults as onSelectPlayer. */
  function handleSelectPlayerFromSheet(ref: PendingPlayerSelect) {
    if (sheetNav.isRestoring()) return;
    const subject = toPlayerSubject(ref);
    setMode("player");
    setChamp(null);
    setPlayer(subject);
    sheetNav.pushSelection({ mode: "player", subject: toWirePlayerSubject(subject) });
  }

  /** User tapped a card to open its sheet — pushes a SHEET-OPEN entry on top
   *  of the current selection (selection itself is unchanged). */
  function handleOpenGame(gameId: string) {
    sheetNav.openGame(gameId, currentWireSelection());
  }

  /** Explicit dismiss (✕ / Escape / backdrop) — pop the sheet-open entry so
   *  the back stack never accumulates a ghost. The resulting popstate event
   *  (handled inside the hook) is what actually clears `openGameId` — single
   *  source of truth, no double-update. */
  function handleDismissGame() {
    sheetNav.dismissGame();
  }

  return (
    <main className="mx-auto max-w-[1180px] px-4 pb-16 pt-8 sm:px-6 [&_span.text-gold]:font-semibold">
      <div>
        {/* ── Top bar (v0.51 wave B; recent-games table removed per user
            directive v0.51.2 — search is the page's primary view again) ── */}
        <div className="flex items-end justify-between gap-5">
          <div>
            <p className="text-[10px] font-medium uppercase tracking-[0.16em] text-teal">SOLO QUEUE + OFFICIAL PRO PLAY · 90-DAY WINDOW</p>
            <h1 className="mt-1.5 text-[34px] font-semibold leading-none tracking-[-0.025em] text-txt">Pro Players</h1>
          </div>
          <div className="hidden rounded-[8px] bg-panel-glass px-3 py-2 text-right text-[10px] text-mut shadow-[inset_0_0_0_1px_rgba(233,233,237,.08)] sm:block">Source filters and favorite players<br /><span className="text-txt">use the real tracked match feed</span></div>
        </div>

        {/* ── Search ── */}
        <section className="mt-5 rounded-[9px] bg-panel-glass px-4 py-4 shadow-[inset_0_0_0_1px_rgba(233,233,237,.08)] sm:px-5">
          <p className="mb-3 text-[10px] font-semibold uppercase tracking-[0.14em] text-mut">Find a player or champion</p>

          {/* Mode toggle */}
          <div className="flex justify-center mb-4">
            <SegmentedControl
              ariaLabel="Search by player or champion"
              value={mode}
              onChange={setMode}
              options={[
                { value: "player", label: "Player" },
                { value: "champion", label: "Champion" },
              ]}
            />
          </div>

          {/* Search controls */}
          <div className="flex flex-wrap items-center justify-center gap-4">
            {mode === "player" ? (
              <PlayerPicker value={player?.kind === "tracked" ? player.ref : null} onChange={choosePlayer} />
            ) : (
              <>
                <ChampionPicker value={champ} onChange={chooseChampion} withFavorites />
                <LanePillRow value={lane} onChange={setLane} />
              </>
            )}
          </div>

          {/* Favorite players/champions — quick re-select without searching
              again. Each is scoped to its own mode, and only while nothing
              is selected yet (once something's picked, the summary line
              below carries its own favorite star). */}
          {mode === "player" && player === null && <FavoritePlayerChips label="Favorites" onSelect={choosePlayer} />}
          {mode === "champion" && champ === null && <FavoriteChampionChips onSelect={chooseChampion} />}
        </section>

        {/* ── Search results ── */}
        {!selected && (
          <ProPlayersSpotlight mode={mode} onSelectPlayer={choosePlayer} onSelectChampion={chooseChampion} />
        )}

        {selected && (
          <>
            <div className="flex items-center gap-3 mb-4 px-1">
              <p className="text-[13px] text-txt">
                {mode === "player" ? (
                  <>
                    Showing recent games by{" "}
                    <span className="font-semibold">
                      {player!.kind === "tracked" ? player!.ref.name : player!.name}
                    </span>
                    {/* Favorites are tracked-pros-only (lib/favorites.ts) — a
                        link-only player (no `pros` row) has nothing to star,
                        and showing one here would churn that store's shape
                        for a player it can never actually track. */}
                    {player!.kind === "tracked" && (
                      <FavoriteStarButton
                        id={player!.ref.id}
                        name={player!.ref.name}
                        changedEvent={FAVORITES_CHANGED_EVENT}
                        checkFavorited={checkPlayerFavorited}
                        onToggle={() =>
                          toggleFavoritePlayer({
                            id: player!.ref.id,
                            name: player!.ref.name,
                            team: player!.ref.team,
                          })
                        }
                        className="ml-1 -mb-0.5 align-middle"
                      />
                    )}
                  </>
                ) : (
                  <>
                    Showing recent games on <span className="font-semibold">{champ!.name}</span>
                    <FavoriteStarButton
                      id={champ!.id}
                      name={champ!.name}
                      changedEvent={CHAMPION_FAVORITES_CHANGED_EVENT}
                      checkFavorited={checkChampionFavorited}
                      onToggle={() => toggleFavoriteChampion({ id: champ!.id, name: champ!.name })}
                      className="ml-1 -mb-0.5 align-middle"
                    />
                    <span className="text-mut"> — {LANE_LABEL[lane]}</span>
                  </>
                )}
              </p>
              <button
                type="button"
                onClick={clearSelection}
                className="ml-auto flex items-center justify-center w-6 h-6 rounded-md text-mut hover:text-txt hover:bg-panel2 transition-colors active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
                aria-label="Clear selection"
              >
                ×
              </button>
            </div>

            {mode === "player" ? (
              <ProHistoryResults
                mode="player"
                playerId={player!.kind === "tracked" ? player!.ref.id : undefined}
                playerLink={player!.kind === "link" ? player!.playerLink : undefined}
                subjectLabel={player!.kind === "tracked" ? player!.ref.name : player!.name}
                onSelectPlayer={handleSelectPlayerFromSheet}
                openGameId={openGameId}
                onOpenGame={handleOpenGame}
                onDismissGame={handleDismissGame}
              />
            ) : (
              <ProHistoryResults
                mode="champion"
                championId={champ!.id}
                championIcon={champ!.icon}
                role={lane}
                subjectLabel={champ!.name}
                onSelectPlayer={handleSelectPlayerFromSheet}
                openGameId={openGameId}
                onOpenGame={handleOpenGame}
                onDismissGame={handleDismissGame}
              />
            )}
          </>
        )}

        {/* ── Footer ── */}
        <footer className="mt-10 pt-4 border-t border-line text-center text-[11px] text-mut space-y-1">
          <p>Match data © coachless.gg / lolpros.gg / Riot Games. For personal use.</p>
          <p>Not endorsed by Riot Games.</p>
          <p>
            Pro-play match data from{" "}
            <a
              href="https://lol.fandom.com"
              target="_blank"
              rel="noopener noreferrer"
              className="text-teal hover:underline"
            >
              Leaguepedia
            </a>{" "}
            (CC BY-SA).
          </p>
          {process.env.NEXT_PUBLIC_APP_VERSION && (
            <p className="text-mut">v{process.env.NEXT_PUBLIC_APP_VERSION}</p>
          )}
        </footer>
      </div>
    </main>
  );
}
