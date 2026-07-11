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
// ─────────────────────────────────────────────────────────────────────────────

import type { FavoritePlayer } from "@/lib/favorites";

export type PendingPlayerSelect = FavoritePlayer;

const KEY = "coachbuild:pendingPlayerSelect:v1";

function isPendingPlayerSelectShape(v: unknown): v is PendingPlayerSelect {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    typeof o.name === "string" &&
    (o.team === null || typeof o.team === "string")
  );
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
