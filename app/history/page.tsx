"use client";

import { useEffect, useRef, useState } from "react";
import type { ChampionRef } from "@/lib/types";
import TabNav from "@/components/TabNav";
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
// state today — a back gesture just leaves the page entirely. This wires
// `window.history.pushState`/`popstate` so back steps through: sheet-open ->
// the selection it was opened on -> the selection before that -> ... ->
// wherever the user came from (no extra entry for the initial load, so the
// LAST back always exits correctly).
//
// Every entry is SELF-SUFFICIENT (full mode/subject/lane + which game's sheet
// is open, if any) rather than a delta — popstate only ever hands back a
// single state object for the entry landed on, never a diff from the
// previous one, so each entry must carry everything needed to repaint the
// page from scratch.
//
// Two distinct "closing a sheet" paths, deliberately NOT unified:
//  - Explicit dismiss (✕ / Escape / backdrop) -> GameDetailSheet's onDismiss
//    -> history.back(), POPPING the sheet-open entry so the stack never
//    accumulates ghosts.
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

interface WirePlayerSubjectTracked {
  kind: "tracked";
  id: string;
  name: string;
  team: string | null;
}
interface WirePlayerSubjectLink {
  kind: "link";
  playerLink: string;
  name: string;
}
type WirePlayerSubject = WirePlayerSubjectTracked | WirePlayerSubjectLink;

type WireSelection =
  | { mode: "player"; subject: WirePlayerSubject }
  | {
      mode: "champion";
      championId: number;
      championKey: string;
      championName: string;
      championIcon: string;
      lane: number;
    };

/** The full `history.pushState`/`replaceState` payload for this page.
 *  `v: 1` lets a future shape change tell an old (already-in-the-user's-
 *  back-stack) entry apart from a new one instead of guessing from field
 *  presence. */
interface NavHistoryState {
  v: 1;
  selection: WireSelection | null;
  openGameId: string | null;
}

function isNavHistoryState(v: unknown): v is NavHistoryState {
  return typeof v === "object" && v !== null && (v as { v?: unknown }).v === 1;
}

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

function PromptState() {
  return (
    <div className="mt-6 glass-card rounded-2xl p-12 text-center">
      <div className="text-4xl mb-3 opacity-40" aria-hidden="true">
        🔍
      </div>
      <div className="text-txt font-semibold mb-1">
        Search a pro player or champion to see their recent games
      </div>
      <div className="text-mut text-sm">
        Try a name like &ldquo;Faker&rdquo; or a champion like &ldquo;Viktor&rdquo;.
      </div>
    </div>
  );
}

export default function HistoryPage() {
  const [mode, setMode] = useState<Mode>("player");
  const [player, setPlayer] = useState<PlayerSubject | null>(null);
  const [champ, setChamp] = useState<ChampionRef | null>(null);
  const [lane, setLane] = useState<number>(5);
  const [openGameId, setOpenGameId] = useState<string | null>(null);
  // True while a popstate-driven restore is applying state — guards the push
  // helpers below from ever re-entrantly pushing a NEW entry while we're in
  // the middle of restoring an OLD one (they aren't wired to fire from that
  // path today, but this is cheap, direct insurance against a future wiring
  // change accidentally looping back->push->back).
  const restoringRef = useRef(false);

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

  /** Pushes a brand-new SELECTION entry (player picked / champion picked /
   *  cross-player jump) — always with openGameId reset to null, so a fresh
   *  selection made while a sheet was open "replaces sensibly" (the sheet
   *  belonged to the OLD selection's game list; the new selection starts
   *  clean, no sheet forced open). Resets the LIVE `openGameId` state too,
   *  not just the pushed entry's field — prostage `game.id` is per-MATCH,
   *  not per-player, so a cross-player jump to a teammate/opponent from the
   *  SAME match would otherwise leave the stale id matching that player's
   *  own row for it and auto-open their sheet on arrival. */
  function pushSelectionState(selection: WireSelection | null) {
    setOpenGameId(null);
    if (restoringRef.current) return;
    const state: NavHistoryState = { v: 1, selection, openGameId: null };
    window.history.pushState(state, "");
  }

  function applyHistoryState(state: NavHistoryState | null) {
    const selection = state?.selection ?? null;
    if (!selection) {
      setMode("player");
      setPlayer(null);
      setChamp(null);
    } else if (selection.mode === "player") {
      setMode("player");
      setChamp(null);
      setPlayer(fromWirePlayerSubject(selection.subject));
    } else {
      setMode("champion");
      setPlayer(null);
      setChamp({
        id: selection.championId,
        key: selection.championKey,
        name: selection.championName,
        icon: selection.championIcon,
      });
      setLane(selection.lane);
    }
    setOpenGameId(state?.openGameId ?? null);
  }

  function clearSelection() {
    if (mode === "player") setPlayer(null);
    else setChamp(null);
  }

  function choosePlayer(ref: PlayerRef) {
    if (restoringRef.current) return;
    setMode("player");
    setChamp(null);
    const subject: PlayerSubject = { kind: "tracked", ref };
    setPlayer(subject);
    pushSelectionState({ mode: "player", subject: toWirePlayerSubject(subject) });
  }

  function chooseChampion(c: ChampionRef) {
    if (restoringRef.current) return;
    setMode("champion");
    setPlayer(null);
    setChamp(c);
    pushSelectionState({
      mode: "champion",
      championId: c.id,
      championKey: c.key,
      championName: c.name,
      championIcon: c.icon,
      lane,
    });
  }

  /** Cross-player jump from inside a game-detail sheet (tap a Teams-box row)
   *  — same-page fast path passed to ProHistoryResults as onSelectPlayer.
   *  Also doubles as the pure "apply this pick" step for the mount-time
   *  cross-page handoff below (that path pushes nothing — see the mount
   *  effect's own reasoning). */
  function handleSelectPlayerFromSheet(ref: PendingPlayerSelect) {
    if (restoringRef.current) return;
    const subject = toPlayerSubject(ref);
    setMode("player");
    setChamp(null);
    setPlayer(subject);
    pushSelectionState({ mode: "player", subject: toWirePlayerSubject(subject) });
  }

  /** User tapped a card to open its sheet — pushes a SHEET-OPEN entry on top
   *  of the current selection (selection itself is unchanged). */
  function handleOpenGame(gameId: string) {
    setOpenGameId(gameId);
    if (restoringRef.current) return;
    const state: NavHistoryState = { v: 1, selection: currentWireSelection(), openGameId: gameId };
    window.history.pushState(state, "");
  }

  /** Explicit dismiss (✕ / Escape / backdrop) — pop the sheet-open entry so
   *  the back stack never accumulates a ghost. The resulting popstate event
   *  (handled below) is what actually clears `openGameId` — single source
   *  of truth, no double-update. */
  function handleDismissGame() {
    window.history.back();
  }

  // Mount: either resume an already-seeded entry (a same-tab refresh — the
  // browser retains history.state for the CURRENT entry across a reload) or
  // seed one fresh. Cross-page handoff (a Teams-box tap on the Builds page,
  // stashed via sessionStorage + a real navigation — see
  // playerSelectHandoff.ts) is consumed here, once, and folds into the
  // SEEDED initial state via replaceState rather than a push: this is the
  // page's starting point, not a "change," so back from here correctly
  // exits to wherever the user came from (no extra entry).
  useEffect(() => {
    const existing = window.history.state;
    if (isNavHistoryState(existing)) {
      applyHistoryState(existing);
      return;
    }

    const pending = consumePendingPlayerSelect();
    let initialSelection: WireSelection | null = null;
    if (pending) {
      const subject = toPlayerSubject(pending);
      setMode("player");
      setChamp(null);
      setPlayer(subject);
      initialSelection = { mode: "player", subject: toWirePlayerSubject(subject) };
    }
    const seeded: NavHistoryState = { v: 1, selection: initialSelection, openGameId: null };
    window.history.replaceState(seeded, "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Back/forward: repaint from whatever entry the browser landed on. Scroll
  // position is left to the browser's own default (restoring to the top
  // reads fine here and avoids an extra scrollTo jump) — see dispatch notes.
  useEffect(() => {
    function onPopState(e: PopStateEvent) {
      restoringRef.current = true;
      applyHistoryState(isNavHistoryState(e.state) ? e.state : null);
      // Released on the next microtask — after this synchronous batch of
      // state updates has been scheduled, so a genuinely new user action
      // right after a restore is never mistaken for part of it.
      queueMicrotask(() => {
        restoringRef.current = false;
      });
    }
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  return (
    <div className="min-h-screen pb-16">
      <div className="max-w-[1080px] mx-auto px-4 sm:px-6">
        {/* ── Top bar ── */}
        <header className="pt-8 pb-5 border-b border-line mb-6">
          <TabNav />

          <div className="text-center mb-4">
            <h1 className="text-3xl font-extrabold tracking-tight text-balance">
              Pro<span className="text-teal">&apos;s</span>
            </h1>
            <p className="text-mut text-sm mt-1">
              Recent games from tracked pros — search a player or champion.
            </p>
          </div>

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
          {mode === "player" && player === null && <FavoritePlayerChips onSelect={choosePlayer} />}
          {mode === "champion" && champ === null && <FavoriteChampionChips onSelect={chooseChampion} />}
        </header>

        {/* ── Main content ── */}
        {!selected && <PromptState />}

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
    </div>
  );
}
