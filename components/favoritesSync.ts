// ─────────────────────────────────────────────────────────────────────────────
// favoritesSync.ts — cross-component live sync for favorite-player state.
//
// lib/favorites.ts (owned by a concurrent build, do not edit) is a plain
// localStorage read/write module with no subscription mechanism. Multiple
// UI surfaces render favorite state at once (PlayerPicker dropdown rows, the
// selected-player star, the favorites chip row) — without a shared signal,
// starring in one place wouldn't visually update the others until their next
// unrelated re-render. This wraps `toggleFavorite` to also fire a window
// event every consumer listens for, plus the native `storage` event so
// multiple tabs stay in sync too.
// ─────────────────────────────────────────────────────────────────────────────

import { toggleFavorite, type FavoritePlayer } from "@/lib/favorites";

export const FAVORITES_CHANGED_EVENT = "coachbuild:favorites-changed";

/** Toggle a player's favorite state and notify every listening component. */
export function toggleFavoritePlayer(p: FavoritePlayer): FavoritePlayer[] {
  const next = toggleFavorite(p);
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(FAVORITES_CHANGED_EVENT));
  }
  return next;
}
