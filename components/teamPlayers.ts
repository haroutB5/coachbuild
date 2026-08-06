"use client";

// ─────────────────────────────────────────────────────────────────────────────
// teamPlayers.ts — client fetch for GET /api/pros/team-players, the sheet's
// per-player Teams-box data. Mirrors prostageTimeline.ts's module-level
// cache + in-flight dedup pattern (same reasoning: reopening the sheet for
// the same game shouldn't refetch, and a transient network error shouldn't
// get stuck cached).
//
// Contract (engy — concurrent work, see HANDOFF-fronty.md/HANDOFF-engy.md for
// the exact shape this was built against; engy is moving allyPlayers/
// enemyPlayers OUT of GET /api/pros into this dedicated endpoint so opening
// the sheet doesn't force every card's initial /api/pros fetch to carry full
// 10-player rosters):
//   soloq:    GET /api/pros/team-players?source=soloq&gameId=<id>&championId=<id>
//   prostage: GET /api/pros/team-players?source=prostage&gameId=<id>&player=<playerLink>
//   200 {"allyPlayers": TeamCompPlayer[5] | null, "enemyPlayers": TeamCompPlayer[5] | null}
//     — null on either side means "unavailable for this game", never a
//     partial/wrong array; TeamComp's existing players-undefined-or-null
//     degrade path (render the icon-only LegacyRosterBody strip) already
//     handles that with no changes needed here.
//   network / non-2xx / unexpected body — transient, never cached, resolves
//     to "error" (GameDetailSheet treats this the same as "unavailable":
//     falls back to the icon strip rather than getting stuck on a skeleton).
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from "react";
import type { ProGame, TeamCompPlayer } from "./proGames.types";

export interface TeamPlayersResponse {
  allyPlayers: TeamCompPlayer[] | null;
  enemyPlayers: TeamCompPlayer[] | null;
}

export type TeamPlayersState =
  | { status: "loading" }
  | { status: "ok"; allyPlayers: TeamCompPlayer[] | null; enemyPlayers: TeamCompPlayer[] | null }
  | { status: "error" };

type FetchResult =
  | { kind: "ok"; allyPlayers: TeamCompPlayer[] | null; enemyPlayers: TeamCompPlayer[] | null }
  | { kind: "error" };

/** Builds the query string for a given game, or null when the game doesn't
 *  carry enough identity to ask for team players at all (a prostage row
 *  missing `playerLink` — see proGames.types.ts's comment on that field for
 *  why it can be absent today). Null short-circuits to a no-network
 *  "unavailable" result in loadTeamPlayers below, same as
 *  useProstageTimeline's missing-playerLink branch. */
function teamPlayersQuery(game: Pick<ProGame, "id" | "source" | "championId" | "playerLink">): string | null {
  if (game.source === "soloq") {
    return `source=soloq&gameId=${encodeURIComponent(game.id)}&championId=${encodeURIComponent(String(game.championId))}`;
  }
  if (game.playerLink) {
    return `source=prostage&gameId=${encodeURIComponent(game.id)}&player=${encodeURIComponent(game.playerLink)}`;
  }
  return null;
}

async function fetchOnce(qs: string): Promise<FetchResult> {
  try {
    const res = await fetch(`/api/pros/team-players?${qs}`);
    if (!res.ok) return { kind: "error" };
    const json = (await res.json()) as { allyPlayers?: unknown; enemyPlayers?: unknown };
    const allyPlayers = Array.isArray(json?.allyPlayers) ? (json.allyPlayers as TeamCompPlayer[]) : null;
    const enemyPlayers = Array.isArray(json?.enemyPlayers) ? (json.enemyPlayers as TeamCompPlayer[]) : null;
    return { kind: "ok", allyPlayers, enemyPlayers };
  } catch {
    return { kind: "error" };
  }
}

// Keyed by `${gameId}::${qs}` (qs already encodes source+championId/player).
// Only the terminal "ok" result is cached — an "error" must stay uncached so
// a later reopen of the sheet (or a manual retry, if one's ever added) hits
// the network again instead of being stuck.
const resultCache = new Map<string, TeamPlayersState>();
const inFlight = new Map<string, Promise<TeamPlayersState>>();

/** Resolves (and caches) one game's team-players fetch. Exported — not just
 *  `useTeamPlayers` — so the fetch/cache/dedup logic is directly
 *  unit-testable without a React/jsdom harness (mock `fetch`), matching
 *  itemDetail.ts/runeDetail.ts/prostageTimeline.ts's convention. */
export async function loadTeamPlayers(
  game: Pick<ProGame, "id" | "source" | "championId" | "playerLink">
): Promise<TeamPlayersState> {
  const qs = teamPlayersQuery(game);
  if (!qs) return { status: "ok", allyPlayers: null, enemyPlayers: null };

  const key = `${game.id}::${qs}`;
  const cached = resultCache.get(key);
  if (cached) return cached;

  let pending = inFlight.get(key);
  if (!pending) {
    pending = (async (): Promise<TeamPlayersState> => {
      const result = await fetchOnce(qs);
      if (result.kind === "ok") {
        return { status: "ok", allyPlayers: result.allyPlayers, enemyPlayers: result.enemyPlayers };
      }
      return { status: "error" };
    })();
    inFlight.set(key, pending);
  }

  try {
    const result = await pending;
    if (result.status !== "error") resultCache.set(key, result);
    return result;
  } finally {
    inFlight.delete(key);
  }
}

/** Fetches a game's per-player Teams-box roster, gated on `open` — GameDetail
 *  Sheet mounts one of these per card with `open` toggling visibility, so
 *  fetching only once it actually opens keeps the initial page load from
 *  kicking off a team-players fetch for every card at once, same rationale
 *  as the sheet's own item-name-map fetch. */
export function useTeamPlayers(
  game: Pick<ProGame, "id" | "source" | "championId" | "playerLink">,
  open: boolean
): TeamPlayersState {
  const [state, setState] = useState<TeamPlayersState>({ status: "loading" });
  const requestKey = `${game.id}:${game.source}:${game.championId}:${game.playerLink ?? ""}`;
  const [previousRequestKey, setPreviousRequestKey] = useState(requestKey);
  const [wasOpen, setWasOpen] = useState(open);
  if (open && (!wasOpen || requestKey !== previousRequestKey)) {
    setWasOpen(true);
    setPreviousRequestKey(requestKey);
    setState({ status: "loading" });
  } else if (!open && wasOpen) {
    setWasOpen(false);
  }

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    loadTeamPlayers(game).then((result) => {
      if (!cancelled) setState(result);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game.id, game.source, game.championId, game.playerLink, open]);

  return state;
}
