"use client";

import { useEffect, useState } from "react";
import { isFavorite, type FavoritePlayer } from "@/lib/favorites";
import { FAVORITES_CHANGED_EVENT, toggleFavoritePlayer } from "./favoritesSync";

interface FavoriteStarButtonProps {
  player: FavoritePlayer;
  size?: "sm" | "lg";
  className?: string;
}

/**
 * Star toggle for a single player. Reads favorite state after mount (avoids
 * an SSR/client hydration mismatch — favorites live in localStorage, which
 * doesn't exist on the server) and stays live-synced with every other star
 * or chip on the page via favoritesSync's window event.
 *
 * `onPointerDown`/`onMouseDown` stop propagation on top of `onClick` — this
 * button is meant to sit inside (or right next to) a larger clickable row
 * (a player result option, a "selected player" line), and starring must
 * never also trigger that row's own select/click handler.
 */
export default function FavoriteStarButton({ player, size = "sm", className = "" }: FavoriteStarButtonProps) {
  const [mounted, setMounted] = useState(false);
  const [favorited, setFavorited] = useState(false);

  useEffect(() => {
    setMounted(true);
    const refresh = () => setFavorited(isFavorite(player.id));
    refresh();
    window.addEventListener(FAVORITES_CHANGED_EVENT, refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener(FAVORITES_CHANGED_EVENT, refresh);
      window.removeEventListener("storage", refresh);
    };
  }, [player.id]);

  if (!mounted) return null;

  function handleClick(e: React.MouseEvent<HTMLButtonElement>) {
    e.preventDefault();
    e.stopPropagation();
    toggleFavoritePlayer(player);
  }

  const dim = size === "lg" ? "w-8 h-8 text-[15px]" : "w-6 h-6 text-[12px]";

  return (
    <button
      type="button"
      onPointerDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={handleClick}
      aria-pressed={favorited}
      aria-label={favorited ? `Remove ${player.name} from favorites` : `Add ${player.name} to favorites`}
      className={`inline-flex items-center justify-center flex-shrink-0 rounded-md leading-none transition-colors active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal focus-visible:ring-offset-1 focus-visible:ring-offset-panel ${dim} ${
        favorited ? "text-gold" : "text-mut hover:text-gold"
      } ${className}`}
    >
      <span aria-hidden="true">{favorited ? "★" : "☆"}</span>
    </button>
  );
}
