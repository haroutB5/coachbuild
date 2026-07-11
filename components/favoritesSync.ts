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

import {
  toggleFavorite,
  toggleFavoriteChampion as toggleFavoriteChampionStore,
  type FavoritePlayer,
  type FavoriteChampion,
} from "@/lib/favorites";

export const FAVORITES_CHANGED_EVENT = "coachbuild:favorites-changed";
// Separate event name from the player one above — a champion star/chip
// shouldn't force every player-favorite consumer on the page to re-render
// (and vice versa), even though both fire from the same user gesture shape.
export const CHAMPION_FAVORITES_CHANGED_EVENT = "coachbuild:champion-favorites-changed";

/** Toggle a player's favorite state and notify every listening component. */
export function toggleFavoritePlayer(p: FavoritePlayer): FavoritePlayer[] {
  const next = toggleFavorite(p);
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(FAVORITES_CHANGED_EVENT));
  }
  return next;
}

/** Toggle a champion's favorite state and notify every listening component. */
export function toggleFavoriteChampion(c: FavoriteChampion): FavoriteChampion[] {
  const next = toggleFavoriteChampionStore(c);
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(CHAMPION_FAVORITES_CHANGED_EVENT));
  }
  return next;
}
