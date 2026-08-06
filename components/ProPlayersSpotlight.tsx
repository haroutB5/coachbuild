"use client";

// ─────────────────────────────────────────────────────────────────────────────
// components/ProPlayersSpotlight.tsx — what /history shows before you've
// searched anything (REDESIGNED 2026-07-27, user directive).
//
// The old empty state was a title + toggle + search + three favourite chips
// (Bwipo/Caps/Faker for this user), then a large card with just a magnifying
// glass and "Search a pro player or champion..." — dead space directly under
// real, already-saved favourites. This replaces that dead card with an actual
// preview of one favourite's recent games, reusing the exact same
// ProHistoryResults/`GET /api/pros` path the page uses once you search —
// no new backend, no invented numbers.
//
// Priority order per favourite mode:
//  1. The most-recently-starred favourite (lib/favorites.ts — newest-first)
//     gets spotlighted with its real recent games.
//  2. No favourites (player mode only) -> resolve ONE well-known pro via the
//     existing player typeahead (`GET /api/players?q=`) and spotlight them
//     labeled "Popular" instead of "Favorite" — honest about why they're
//     showing. If none of the curated names resolve (API down, DB empty),
//     falls through to plain text, never a fabricated card.
//  3. Champion mode with no favourite champions: no real "notable champion"
//     signal exists for this app, so it falls straight to the short prompt
//     rather than guessing — same "honest degrade" rule as everywhere else.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ChampionRef } from "@/lib/types";
import type { PlayerRef } from "./proHistory.types";
import {
  getFavorites,
  getFavoriteChampions,
  type FavoritePlayer,
  type FavoriteChampion,
} from "@/lib/favorites";
import { FAVORITES_CHANGED_EVENT, CHAMPION_FAVORITES_CHANGED_EVENT } from "./favoritesSync";
import { getChampionIconMap, type ChampionIconEntry } from "./proAssets";
import ProHistoryResults from "./ProHistoryResults";
import ProGamesSkeleton from "./ProGamesSkeleton";

const subscribeToHydration = () => () => {};
const getHydratedSnapshot = () => true;
const getServerHydratedSnapshot = () => false;

type Mode = "player" | "champion";

interface ProPlayersSpotlightProps {
  mode: Mode;
  onSelectPlayer: (ref: PlayerRef) => void;
  onSelectChampion: (champ: ChampionRef) => void;
}

/** Curated, ordered — tried in sequence until one resolves via the real
 *  player typeahead. Not a fabricated stat: every field shown afterward
 *  (games, W/L, builds) comes straight from `GET /api/pros`, same as any
 *  searched player. */
const NOTABLE_PRO_QUERIES = ["Faker", "Chovy", "Caps", "Ruler"];

function favoriteToPlayerRef(p: FavoritePlayer): PlayerRef {
  return { id: p.id, name: p.name, slug: "", team: p.team, role: null, country: null, gameCount: 0 };
}

interface PlayersApiRow {
  id: string;
  name: string;
  slug: string;
  team: string | null;
  role: number | null;
  country: string | null;
  gameCount: number;
}

type FallbackState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ok"; player: PlayerRef }
  | { status: "none" };

function SpotlightSkeleton() {
  return (
    <div className="mt-6 animate-pulse" aria-hidden="true">
      <div className="h-3 w-32 bg-panel2 rounded mb-3" />
      <ProGamesSkeleton />
    </div>
  );
}

function PromptCard() {
  return (
    <div className="mt-6 glass-card rounded-2xl p-12 text-center">
      <div className="text-4xl mb-3 opacity-40" aria-hidden="true">
        🔍
      </div>
      <div className="text-txt font-semibold mb-1">Search a pro player or champion to see their recent games</div>
      <div className="text-mut text-sm">
        Try a name like &ldquo;Faker&rdquo; or a champion like &ldquo;Viktor&rdquo;.
      </div>
    </div>
  );
}

interface SpotlightHeaderProps {
  eyebrow: string;
  title: string;
  onOpen: () => void;
}

function SpotlightHeader({ eyebrow, title, onOpen }: SpotlightHeaderProps) {
  return (
    <div className="flex items-baseline justify-between gap-3 mb-3">
      <p className="text-[13px] text-txt min-w-0 truncate">
        <span className="text-[10px] tracking-[0.1em] uppercase text-gold font-bold mr-2">{eyebrow}</span>
        <span className="font-semibold">{title}</span>
      </p>
      <button
        type="button"
        onClick={onOpen}
        className="flex-shrink-0 text-[11.5px] text-teal hover:underline min-h-[44px] px-1 -my-2"
      >
        View full history &rarr;
      </button>
    </div>
  );
}

export default function ProPlayersSpotlight({ mode, onSelectPlayer, onSelectChampion }: ProPlayersSpotlightProps) {
  const mounted = useSyncExternalStore(subscribeToHydration, getHydratedSnapshot, getServerHydratedSnapshot);
  const [playerFavs, setPlayerFavs] = useState<FavoritePlayer[]>([]);
  const [champFavs, setChampFavs] = useState<FavoriteChampion[]>([]);
  const [iconMap, setIconMap] = useState<Map<number, ChampionIconEntry> | null>(null);
  const [fallback, setFallback] = useState<FallbackState>({ status: "idle" });

  useEffect(() => {
    const refreshPlayers = () => setPlayerFavs(getFavorites());
    const refreshChamps = () => setChampFavs(getFavoriteChampions());
    refreshPlayers();
    refreshChamps();
    window.addEventListener(FAVORITES_CHANGED_EVENT, refreshPlayers);
    window.addEventListener(CHAMPION_FAVORITES_CHANGED_EVENT, refreshChamps);
    window.addEventListener("storage", refreshPlayers);
    window.addEventListener("storage", refreshChamps);
    return () => {
      window.removeEventListener(FAVORITES_CHANGED_EVENT, refreshPlayers);
      window.removeEventListener(CHAMPION_FAVORITES_CHANGED_EVENT, refreshChamps);
      window.removeEventListener("storage", refreshPlayers);
      window.removeEventListener("storage", refreshChamps);
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

  // Notable-pro fallback — only fires once (guarded by fallbackStartedRef,
  // NOT by fallback.status itself: that state is ALSO this effect's own
  // dependency, so gating on it directly would have the effect's cleanup
  // cancel its own in-flight fetch the instant setFallback({status:"loading"})
  // causes a re-render — caught live: the request completed in ~1ms but the
  // result was silently discarded because `cancelled` had already flipped
  // true by the time it resolved). A ref sidesteps that self-cancellation
  // entirely. Only fires when player mode has zero favourites to spotlight
  // instead; if the user later stars someone, the favourite branch below
  // takes priority regardless of what this resolved to.
  const fallbackStartedRef = useRef(false);
  useEffect(() => {
    if (!mounted || mode !== "player" || playerFavs.length > 0 || fallbackStartedRef.current) return;
    fallbackStartedRef.current = true;
    let cancelled = false;
    setFallback({ status: "loading" });
    (async () => {
      for (const name of NOTABLE_PRO_QUERIES) {
        try {
          const res = await fetch(`/api/players?q=${encodeURIComponent(name)}`);
          if (!res.ok) continue;
          const data: { players?: PlayersApiRow[] } = await res.json();
          const rows = Array.isArray(data.players) ? data.players : [];
          const match = rows.find((r) => r.name.toLowerCase() === name.toLowerCase()) ?? rows[0];
          if (match) {
            if (!cancelled) {
              setFallback({
                status: "ok",
                player: {
                  id: match.id,
                  name: match.name,
                  slug: match.slug,
                  team: match.team,
                  role: (match.role ?? null) as PlayerRef["role"],
                  country: match.country,
                  gameCount: match.gameCount,
                },
              });
            }
            return;
          }
        } catch {
          // try the next curated name
        }
      }
      if (!cancelled) setFallback({ status: "none" });
    })();
    return () => {
      cancelled = true;
    };
  }, [mounted, mode, playerFavs.length]);

  if (!mounted) return <SpotlightSkeleton />;

  if (mode === "champion") {
    if (champFavs.length === 0) return <PromptCard />;
    const fav = champFavs[0];
    const icon = iconMap?.get(fav.id)?.icon ?? "";
    return (
      <div className="mt-6">
        <SpotlightHeader
          eyebrow="Favorite"
          title={fav.name}
          onOpen={() => onSelectChampion({ id: fav.id, key: fav.name, name: fav.name, icon })}
        />
        <ProHistoryResults mode="champion" championId={fav.id} championIcon={icon} role={5} subjectLabel={fav.name} limit={4} />
      </div>
    );
  }

  // mode === "player"
  if (playerFavs.length > 0) {
    const fav = playerFavs[0];
    return (
      <div className="mt-6">
        <SpotlightHeader eyebrow="Favorite" title={fav.name} onOpen={() => onSelectPlayer(favoriteToPlayerRef(fav))} />
        <ProHistoryResults mode="player" playerId={fav.id} subjectLabel={fav.name} limit={4} />
      </div>
    );
  }

  if (fallback.status === "loading" || fallback.status === "idle") return <SpotlightSkeleton />;

  if (fallback.status === "ok") {
    const p = fallback.player;
    return (
      <div className="mt-6">
        <SpotlightHeader eyebrow="Popular" title={p.name} onOpen={() => onSelectPlayer(p)} />
        <ProHistoryResults mode="player" playerId={p.id} subjectLabel={p.name} limit={4} />
      </div>
    );
  }

  return <PromptCard />;
}
