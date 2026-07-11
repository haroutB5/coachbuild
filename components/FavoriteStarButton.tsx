"use client";

import { useEffect, useState } from "react";

interface FavoriteStarButtonProps {
  /** Stable identifier for the starred item — player id (string) or
   *  champion id (number). Only used for lookups/aria, never rendered. */
  id: string | number;
  /** Display name, used only for the aria-label. */
  name: string;
  /** Window event this button re-checks favorite state on (see
   *  favoritesSync.ts) — pass a different event per entity type so a player
   *  star doesn't re-render on a champion toggle and vice versa. */
  changedEvent: string;
  /** Stable module-level lookup, e.g. `isFavorite` or `isFavoriteChampion`.
   *  Must be a stable reference (module-level function, not an inline
   *  closure) — it's a dependency of the mount/subscribe effect below, and a
   *  fresh closure every render would tear down + resubscribe the window
   *  listeners on every parent re-render. */
  checkFavorited: (id: string | number) => boolean;
  /** Fires the actual toggle (store write + event dispatch). Safe to pass an
   *  inline closure — only used inside the click handler, never in a
   *  dependency array. */
  onToggle: () => void;
  size?: "sm" | "lg";
  className?: string;
}

/**
 * Star toggle for a single favoritable item (player or champion). Reads
 * favorite state after mount (avoids an SSR/client hydration mismatch —
 * favorites live in localStorage, which doesn't exist on the server) and
 * stays live-synced with every other star or chip on the page via the
 * entity-specific window event passed in `changedEvent`.
 *
 * `onPointerDown`/`onMouseDown` stop propagation on top of `onClick` — this
 * button is meant to sit inside (or right next to) a larger clickable row
 * (a player/champion result option, a "selected X" line), and starring must
 * never also trigger that row's own select/click handler.
 */
export default function FavoriteStarButton({
  id,
  name,
  changedEvent,
  checkFavorited,
  onToggle,
  size = "sm",
  className = "",
}: FavoriteStarButtonProps) {
  const [mounted, setMounted] = useState(false);
  const [favorited, setFavorited] = useState(false);

  useEffect(() => {
    setMounted(true);
    const refresh = () => setFavorited(checkFavorited(id));
    refresh();
    window.addEventListener(changedEvent, refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener(changedEvent, refresh);
      window.removeEventListener("storage", refresh);
    };
  }, [id, changedEvent, checkFavorited]);

  if (!mounted) return null;

  function handleClick(e: React.MouseEvent<HTMLButtonElement>) {
    e.preventDefault();
    e.stopPropagation();
    onToggle();
  }

  const dim = size === "lg" ? "w-8 h-8 text-[15px]" : "w-6 h-6 text-[12px]";

  return (
    <button
      type="button"
      onPointerDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={handleClick}
      aria-pressed={favorited}
      aria-label={favorited ? `Remove ${name} from favorites` : `Add ${name} to favorites`}
      className={`inline-flex items-center justify-center flex-shrink-0 rounded-md leading-none transition-colors active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal focus-visible:ring-offset-1 focus-visible:ring-offset-panel ${dim} ${
        favorited ? "text-gold" : "text-mut hover:text-gold"
      } ${className}`}
    >
      <span aria-hidden="true">{favorited ? "★" : "☆"}</span>
    </button>
  );
}
