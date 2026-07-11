// ─────────────────────────────────────────────────────────────────────────────
// playerSelectHandoff.ts — one-shot sessionStorage handoff for "tap a player
// inside a game-detail sheet -> land on /history in Player mode, already
// loaded for them."
//
// GameDetailSheet is mounted from TWO surfaces: /history's own
// ProHistoryResults (which owns the player/mode state directly — the tap can
// just call a callback prop, no navigation needed) and the Builds page's
// ProGamesSection (a completely different page/state tree). For the second
// case there's no callback to call, so the tap instead stashes the picked
// player here and does a real `router.push("/history")`; /history reads it
// back once on mount and clears it, same shape either path produces.
//
// sessionStorage (not localStorage) is deliberate: this is a one-shot piece
// of navigation state, not a persistent preference — it should NOT survive
// past the page load that consumes it, and should NOT leak between tabs the
// way lib/favorites.ts's localStorage store intentionally does.
//
// Reuses lib/favorites.ts's FavoritePlayer shape (id/name/team) rather than
// declaring a duplicate — same fields, same semantics (proId-as-id, display
// name, org/team string or null).
//
// PendingPlayerSelect is a union of that tracked shape PLUS LinkPlayerSelect
// (playerLink/name) — an untracked prostage player tapped from a Teams-box
// row that has no `pros` row at all. Both same-page (/history's onSelectPlayer
// callback) and cross-page (this file's stash/consume) paths carry either
// kind through unchanged; consumers discriminate structurally (`"id" in ref`).
// ─────────────────────────────────────────────────────────────────────────────

import type { FavoritePlayer } from "@/lib/favorites";

/** Untracked prostage player (Teams-box tap on a roster slot with no `pros`
 *  row, i.e. no `proId` — only a raw Leaguepedia `playerLink`). Deliberately
 *  NOT tagged with an explicit `kind` field — the two arms of
 *  PendingPlayerSelect are distinguished structurally (tracked always has
 *  `id`, link never does) so a plain `{id, name, team}` object literal
 *  (what every existing call site and test already constructs) keeps
 *  matching the tracked arm without change. */
export interface LinkPlayerSelect {
  playerLink: string;
  name: string;
}

export type PendingPlayerSelect = FavoritePlayer | LinkPlayerSelect;

const KEY = "coachbuild:pendingPlayerSelect:v1";

// Plain booleans (not nested type predicates) — a type predicate's parameter
// type must be assignable to the type it narrows to, which a plain interface
// without an index signature (FavoritePlayer/LinkPlayerSelect) never is
// against `Record<string, unknown>`. The outer function below is the only
// one that needs an actual `is` predicate.
function hasTrackedShape(o: Record<string, unknown>): boolean {
  return (
    typeof o.id === "string" &&
    typeof o.name === "string" &&
    (o.team === null || typeof o.team === "string")
  );
}

function hasLinkShape(o: Record<string, unknown>): boolean {
  return typeof o.playerLink === "string" && typeof o.name === "string";
}

function isPendingPlayerSelectShape(v: unknown): v is PendingPlayerSelect {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return hasTrackedShape(o) || hasLinkShape(o);
}

/** Stash the tapped player right before navigating away to /history.
 *  Silently no-ops (never throws) on SSR or when sessionStorage is
 *  unavailable (private-mode Safari, storage disabled) — worst case the
 *  navigation still happens, just without the auto-select. */
export function stashPendingPlayerSelect(player: PendingPlayerSelect): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(KEY, JSON.stringify(player));
  } catch {
    // ignore — see header comment
  }
}

/** Read + clear the stashed player, if any. Validated so a corrupted or
 *  hand-edited storage value can't crash the consuming page — malformed
 *  entries are treated as "nothing pending," same discipline as
 *  lib/favorites.ts's getFavorites(). */
export function consumePendingPlayerSelect(): PendingPlayerSelect | null {
  if (typeof window === "undefined") return null;
  let raw: string | null;
  try {
    raw = window.sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
  if (!raw) return null;

  try {
    window.sessionStorage.removeItem(KEY);
  } catch {
    // ignore — see header comment
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    return isPendingPlayerSelectShape(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
