// ─────────────────────────────────────────────────────────────────────────────
// championSearchBus.ts — cross-component live sync for the GlobalNav rail's
// champion search (v0.51 redesign wave A). Mirrors components/favoritesSync.ts's
// event-bus pattern exactly (native window Event, no payload on the event
// itself — see below for why this bus differs on that one point) rather than
// inventing a new mechanism: the rail's search box lives outside app/page.tsx's
// own BuildsSearchBar tree, so picking a champion there needs to reach
// app/page.tsx's handleChampionSelect(selected: ChampionRef) (app/page.tsx)
// without threading a prop through GlobalNav -> DesktopRail/MobileTabBar ->
// page.
//
// DEVIATION from favoritesSync.ts: that bus fires a bare `Event` and every
// listener re-reads localStorage itself (toggleFavorite* already wrote the
// new state before dispatching). There's no shared store to re-read here —
// the picked ChampionRef only exists in the dispatcher's hands — so this bus
// must carry the payload on the event itself. Uses `CustomEvent<ChampionRef>`
// for that reason; SSR-safe (no `window` touched at module scope, only inside
// the exported functions, same guard style as favoritesSync.ts).
// ─────────────────────────────────────────────────────────────────────────────

import type { ChampionRef } from "@/lib/types";

export const CHAMPION_SEARCH_EVENT = "cb:champion-search";

/** Fire a champion pick from the GlobalNav rail search. No-ops on the server
 *  (SSR/build) — there is no window to dispatch on and nothing listening. */
export function emitChampionSearch(ref: ChampionRef): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<ChampionRef>(CHAMPION_SEARCH_EVENT, { detail: ref }));
}

/** Subscribe to rail-search champion picks. Returns an unsubscribe function
 *  (call it from a useEffect cleanup) — mirrors the addEventListener/
 *  removeEventListener pairing every other window-event consumer in this
 *  codebase already uses (e.g. the `storage` listener alongside
 *  favoritesSync.ts's FAVORITES_CHANGED_EVENT). No-ops (returns a no-op
 *  unsubscribe) on the server for the same SSR reason as emitChampionSearch. */
export function subscribeChampionSearch(cb: (ref: ChampionRef) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = (e: Event) => {
    const detail = (e as CustomEvent<ChampionRef>).detail;
    if (detail) cb(detail);
  };
  window.addEventListener(CHAMPION_SEARCH_EVENT, handler);
  return () => window.removeEventListener(CHAMPION_SEARCH_EVENT, handler);
}
