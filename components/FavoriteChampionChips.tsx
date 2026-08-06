"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { getFavoriteChampions, type FavoriteChampion } from "@/lib/favorites";
import { CHAMPION_FAVORITES_CHANGED_EVENT, toggleFavoriteChampion } from "./favoritesSync";
import { getChampionIconMap, type ChampionIconEntry } from "./proAssets";
import { IconWithFallback } from "./IconWithFallback";
import type { ChampionRef } from "@/lib/types";

const subscribeToHydration = () => () => {};
const getHydratedSnapshot = () => true;
const getServerHydratedSnapshot = () => false;

interface FavoriteChampionChipsProps {
  onSelect: (champ: ChampionRef) => void;
}

/**
 * Renders one chip per favorited champion, under the search input, whenever
 * champion mode is active and nothing is selected yet. Tapping a chip
 * selects that champion immediately (same effect as picking from the
 * dropdown) — mirrors FavoritePlayerChips exactly, with one difference: a
 * favorite champion only carries id/name (see lib/favorites.ts — no `icon`,
 * unlike ChampionRef), so the icon is resolved from the shared
 * `proAssets.getChampionIconMap()` cache (the same module-level-cached
 * /api/champions fetch TeamComp/ProHistoryResults already use) instead of
 * being stored per-favorite. `key` isn't recoverable from that map either,
 * but nothing downstream of a champion selection reads `.key` (only
 * id/icon/name), so a harmless fallback is fine.
 *
 * Reads localStorage only after mount — same hydration-safety rationale as
 * FavoritePlayerChips (this row can render unconditionally on first paint;
 * localStorage doesn't exist during SSR).
 */
export default function FavoriteChampionChips({ onSelect }: FavoriteChampionChipsProps) {
  const mounted = useSyncExternalStore(subscribeToHydration, getHydratedSnapshot, getServerHydratedSnapshot);
  const [favorites, setFavorites] = useState<FavoriteChampion[]>([]);
  const [iconMap, setIconMap] = useState<Map<number, ChampionIconEntry> | null>(null);

  useEffect(() => {
    const refresh = () => setFavorites(getFavoriteChampions());
    refresh();
    window.addEventListener(CHAMPION_FAVORITES_CHANGED_EVENT, refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener(CHAMPION_FAVORITES_CHANGED_EVENT, refresh);
      window.removeEventListener("storage", refresh);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    getChampionIconMap().then((m) => {
      if (!cancelled) setIconMap(m);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!mounted || favorites.length === 0) return null;

  function select(c: FavoriteChampion) {
    const icon = iconMap?.get(c.id)?.icon ?? "";
    onSelect({ id: c.id, key: c.name, name: c.name, icon });
  }

  function unstar(e: React.MouseEvent<HTMLButtonElement>, c: FavoriteChampion) {
    e.preventDefault();
    e.stopPropagation();
    toggleFavoriteChampion(c);
  }

  return (
    <div
      className="flex flex-wrap items-center justify-center gap-2 mt-3"
      role="list"
      aria-label="Favorite champions"
    >
      {favorites.map((c) => {
        const icon = iconMap?.get(c.id)?.icon ?? "";
        return (
          <div
            key={c.id}
            role="listitem"
            className="flex items-center gap-0.5 pl-1 pr-1 py-1 rounded-full bg-panel2 border border-line hover:border-teal-dim transition-colors"
          >
            <button
              type="button"
              onClick={() => select(c)}
              className="flex items-center gap-1.5 pl-1.5 pr-1.5 py-0.5 rounded-full text-[12.5px] text-txt hover:text-teal transition-colors"
            >
              <IconWithFallback
                src={icon}
                alt={c.name}
                className="w-5 h-5 rounded-sm object-cover flex-shrink-0"
                size={20}
              />
              <span className="truncate max-w-[100px]">{c.name}</span>
            </button>
            <button
              type="button"
              onPointerDown={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => unstar(e, c)}
              aria-label={`Remove ${c.name} from favorites`}
              className="flex items-center justify-center w-7 h-7 rounded-full text-mut hover:text-bad hover:bg-bad/10 transition-colors active:scale-95 flex-shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal"
            >
              <span aria-hidden="true">×</span>
            </button>
          </div>
        );
      })}
    </div>
  );
}
