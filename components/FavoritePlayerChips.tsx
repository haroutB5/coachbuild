"use client";

import { useEffect, useState } from "react";
import { getFavorites, type FavoritePlayer } from "@/lib/favorites";
import { FAVORITES_CHANGED_EVENT, toggleFavoritePlayer } from "./favoritesSync";
import type { PlayerRef } from "./proHistory.types";

interface FavoritePlayerChipsProps {
  onSelect: (player: PlayerRef) => void;
}

/**
 * Renders one chip per favorited player, under the search input, whenever
 * player mode is active and nothing is selected yet. Tapping a chip selects
 * that player immediately (same effect as picking them from the dropdown) —
 * a favorite only carries id/name/team, which is all `ProHistoryResults`
 * needs (it fetches games by proId + shows the name; role/country/gameCount
 * are decorative fields the dropdown row itself uses, not consumed once a
 * player is selected).
 *
 * Reads localStorage only after mount: this row can render unconditionally
 * on the very first paint (player mode is the default, nothing selected by
 * default), and localStorage doesn't exist during SSR — reading it eagerly
 * would produce a server/client markup mismatch.
 */
export default function FavoritePlayerChips({ onSelect }: FavoritePlayerChipsProps) {
  const [mounted, setMounted] = useState(false);
  const [favorites, setFavorites] = useState<FavoritePlayer[]>([]);

  useEffect(() => {
    setMounted(true);
    const refresh = () => setFavorites(getFavorites());
    refresh();
    window.addEventListener(FAVORITES_CHANGED_EVENT, refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener(FAVORITES_CHANGED_EVENT, refresh);
      window.removeEventListener("storage", refresh);
    };
  }, []);

  if (!mounted || favorites.length === 0) return null;

  function select(p: FavoritePlayer) {
    onSelect({ id: p.id, name: p.name, slug: "", team: p.team, role: null, country: null, gameCount: 0 });
  }

  function unstar(e: React.MouseEvent<HTMLButtonElement>, p: FavoritePlayer) {
    e.preventDefault();
    e.stopPropagation();
    toggleFavoritePlayer(p);
  }

  return (
    <div
      className="flex flex-wrap items-center justify-center gap-2 mt-3"
      role="list"
      aria-label="Favorite players"
    >
      {favorites.map((p) => (
        <div
          key={p.id}
          role="listitem"
          className="flex items-center gap-0.5 pl-1 pr-1 py-1 rounded-full bg-panel2 border border-line hover:border-teal-dim transition-colors"
        >
          <button
            type="button"
            onClick={() => select(p)}
            className="flex items-center gap-1.5 pl-2 pr-1.5 py-1 rounded-full text-[12.5px] text-txt hover:text-teal transition-colors"
          >
            <span aria-hidden="true" className="text-gold text-[11px] leading-none">
              ★
            </span>
            <span className="truncate max-w-[110px]">{p.name}</span>
          </button>
          <button
            type="button"
            onPointerDown={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => unstar(e, p)}
            aria-label={`Remove ${p.name} from favorites`}
            className="flex items-center justify-center w-7 h-7 rounded-full text-mut hover:text-bad hover:bg-bad/10 transition-colors active:scale-95 flex-shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal"
          >
            <span aria-hidden="true">×</span>
          </button>
        </div>
      ))}
    </div>
  );
}
