"use client";

// Chromeless CHAMPIONS/PROS search for the Hextech sidebar. Same data-source
// and keyboard-nav contract as components/ChampionPicker.tsx (fetch
// /api/champions, ARIA combobox, Up/Down/Home/End/Enter/Escape) for the
// champion field, and components/PlayerPicker.tsx's debounced /api/players
// typeahead conventions (250ms debounce, 2-char floor, request-id race
// guard) for the pro field — but a deliberately separate component rather
// than reusing either directly: the sidebar's chromeless input (no inline
// selected-value icon, clears back to placeholder on select — the pick
// shows up in the hero/lane row instead) is different enough visual
// behavior that threading it through either picker's existing JSX risked
// regressing the /history + Builds-legacy call sites this redesign
// explicitly leaves alone.
//
// v0.22.0: added the PROS mode (search a tracked pro player instead of a
// champion — the toggle sits directly above the input as two small
// uppercase-tracked tabs, same underline vocabulary as HextechTabs, so it
// reads as this field's own header rather than a bolted-on control). Mode
// state itself lives at the page level (app/page.tsx via
// hextech/homeSearch.ts) — both Sidebar renders (collapsed mobile bar, full
// desktop column) share one mode so resizing the viewport never shows a
// stale toggle state.

import { useEffect, useRef, useState } from "react";
import type { ChampionRef } from "@/lib/types";
import type { PlayerRef, PlayersApiResponse } from "@/components/proHistory.types";
import type { SearchMode } from "./homeSearch";

const FALLBACK_CHAMPIONS: ChampionRef[] = [
  { id: 112, key: "Viktor", name: "Viktor", icon: "https://cdn.coachless.gg/static-files/16.12.1/16.12.1/img/champion/Viktor.webp" },
  { id: 103, key: "Ahri", name: "Ahri", icon: "https://cdn.coachless.gg/static-files/16.12.1/16.12.1/img/champion/Ahri.webp" },
  { id: 122, key: "Darius", name: "Darius", icon: "https://cdn.coachless.gg/static-files/16.12.1/16.12.1/img/champion/Darius.webp" },
  { id: 64, key: "LeeSin", name: "Lee Sin", icon: "https://cdn.coachless.gg/static-files/16.12.1/16.12.1/img/champion/LeeSin.webp" },
  { id: 222, key: "Jinx", name: "Jinx", icon: "https://cdn.coachless.gg/static-files/16.12.1/16.12.1/img/champion/Jinx.webp" },
  { id: 412, key: "Thresh", name: "Thresh", icon: "https://cdn.coachless.gg/static-files/16.12.1/16.12.1/img/champion/Thresh.webp" },
];

const SEARCH_ICON = (
  <svg
    aria-hidden="true"
    viewBox="0 0 20 20"
    className="absolute left-2.5 w-3.5 h-3.5 text-mut pointer-events-none"
    fill="none"
  >
    <circle cx="8.5" cy="8.5" r="6" stroke="currentColor" strokeWidth="1.5" />
    <path d="M13.5 13.5L17.5 17.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
);

// ── Champion field (unchanged behavior from the pre-v0.22.0 component) ────

const CHAMP_LISTBOX_ID = "sidebar-champ-listbox";
const champOptId = (i: number) => `sidebar-champ-opt-${i}`;

function ChampionSearchField({ onSelect }: { onSelect: (champ: ChampionRef) => void }) {
  const [champions, setChampions] = useState<ChampionRef[]>(FALLBACK_CHAMPIONS);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    fetch("/api/champions")
      .then((r) => {
        if (!r.ok) throw new Error("champions 404");
        return r.json();
      })
      .then((data: ChampionRef[]) => {
        if (Array.isArray(data) && data.length > 0) setChampions(data);
      })
      .catch(() => {
        /* stay on fallback */
      });
  }, []);

  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  const filtered = query.trim()
    ? champions.filter(
        (c) =>
          c.name.toLowerCase().includes(query.toLowerCase()) ||
          c.key.toLowerCase().includes(query.toLowerCase())
      )
    : champions;

  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector(`[data-idx="${activeIndex}"]`)?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, open]);

  function select(champ: ChampionRef) {
    onSelect(champ);
    setQuery("");
    setOpen(false);
  }

  function onFocus() {
    setOpen(true);
    setActiveIndex(0);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!open) setOpen(true);
      setActiveIndex((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Home") {
      e.preventDefault();
      setActiveIndex(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setActiveIndex(Math.max(filtered.length - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const champ = filtered[activeIndex];
      if (champ) select(champ);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  return (
    <div ref={containerRef} className="relative">
      <div className="relative flex items-center">
        {SEARCH_ICON}
        <input
          id="sidebar-champion-search"
          name="sidebar-champion-search"
          type="text"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActiveIndex(0);
            if (!open) setOpen(true);
          }}
          onFocus={onFocus}
          onKeyDown={onKeyDown}
          placeholder="Search champion…"
          aria-label="Search champion"
          role="combobox"
          aria-expanded={open}
          aria-controls={CHAMP_LISTBOX_ID}
          aria-autocomplete="list"
          aria-activedescendant={open && filtered[activeIndex] ? champOptId(activeIndex) : undefined}
          className="w-full bg-panel2/60 border border-line hover:border-line-gold rounded-lg py-2 pl-8 pr-3 text-[12.5px] text-txt placeholder:text-mut outline-none transition-colors focus:border-teal-dim focus-visible:ring-1 focus-visible:ring-teal focus-visible:ring-offset-1 focus-visible:ring-offset-sidebar"
        />
      </div>

      {open && (
        <div className="absolute z-50 top-full mt-1.5 left-0 w-[min(260px,80vw)] bg-panel border border-line rounded-lg shadow-[0_12px_32px_rgba(0,0,0,0.7)] overflow-hidden">
          <ul ref={listRef} id={CHAMP_LISTBOX_ID} role="listbox" className="max-h-[260px] overflow-y-auto divide-y divide-line/40">
            {filtered.length === 0 && <li className="px-3 py-2.5 text-[12px] text-mut">No champions found</li>}
            {filtered.map((champ, i) => {
              const isActive = i === activeIndex;
              return (
                <li key={champ.id} id={champOptId(i)} data-idx={i} role="option" aria-selected={isActive}>
                  <button
                    type="button"
                    tabIndex={-1}
                    onClick={() => select(champ)}
                    onMouseEnter={() => setActiveIndex(i)}
                    className={`w-full flex items-center gap-2.5 px-3 py-2 text-[12.5px] text-left transition-colors ${
                      isActive ? "bg-teal/12" : ""
                    } text-txt`}
                  >
                    <span className="flex-shrink-0 w-5 h-5 rounded overflow-hidden bg-black/30">
                      <img
                        src={champ.icon}
                        alt=""
                        width={20}
                        height={20}
                        loading="lazy"
                        decoding="async"
                        className="w-full h-full object-cover"
                        onError={(e) => {
                          (e.currentTarget as HTMLImageElement).style.display = "none";
                        }}
                      />
                    </span>
                    {champ.name}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

// ── Pro player field (v0.22.0) ─────────────────────────────────────────────
// Same debounced-typeahead conventions as components/PlayerPicker.tsx
// (250ms debounce, 2-char floor before firing, request-id race guard so a
// slow stale response can never clobber a faster recent one) hitting the
// SAME GET /api/players?q= endpoint /history uses — but chromeless-styled to
// match ChampionSearchField above rather than PlayerPicker's bordered/pill
// treatment, and deliberately without PlayerPicker's favorite-star affordance
// (this is a quick jump-to-player field, not the favorites-management
// surface /history already owns).

const PLAYER_LISTBOX_ID = "sidebar-player-listbox";
const playerOptId = (i: number) => `sidebar-player-opt-${i}`;
const PLAYER_MIN_CHARS = 2;
const PLAYER_DEBOUNCE_MS = 250;

type PlayerSearchState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ok"; players: PlayerRef[] }
  | { status: "error" };

function PlayerSearchField({ onSelect }: { onSelect: (player: PlayerRef) => void }) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [search, setSearch] = useState<PlayerSearchState>({ status: "idle" });
  const containerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Bumped on every new query so a slow, stale response can't clobber a
  // faster, more recent one (same race guard as PlayerPicker.tsx).
  const reqIdRef = useRef(0);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const q = query.trim();
    if (q.length < PLAYER_MIN_CHARS) {
      setSearch({ status: "idle" });
      return;
    }
    debounceRef.current = setTimeout(() => {
      const reqId = ++reqIdRef.current;
      setSearch({ status: "loading" });
      fetch(`/api/players?q=${encodeURIComponent(q)}`)
        .then((r) => {
          if (!r.ok) throw new Error(`players fetch ${r.status}`);
          return r.json();
        })
        .then((data: PlayersApiResponse) => {
          if (reqId !== reqIdRef.current) return; // superseded by a newer keystroke
          const players = Array.isArray(data?.players) ? data.players : [];
          setSearch({ status: "ok", players });
          setActiveIndex(0);
        })
        .catch(() => {
          if (reqId !== reqIdRef.current) return;
          setSearch({ status: "error" });
        });
    }, PLAYER_DEBOUNCE_MS);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query]);

  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  const results = search.status === "ok" ? search.players : [];

  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector(`[data-idx="${activeIndex}"]`)?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, open]);

  function select(player: PlayerRef) {
    reqIdRef.current++; // invalidate any in-flight search so it can't repopulate after selection
    onSelect(player);
    setQuery("");
    setOpen(false);
    setSearch({ status: "idle" });
  }

  function onFocus(e: React.FocusEvent<HTMLInputElement>) {
    setOpen(true);
    e.target.select();
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!open) setOpen(true);
      setActiveIndex((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Home") {
      e.preventDefault();
      setActiveIndex(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setActiveIndex(Math.max(results.length - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const player = results[activeIndex];
      if (player) select(player);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  return (
    <div ref={containerRef} className="relative">
      <div className="relative flex items-center">
        {SEARCH_ICON}
        <input
          id="sidebar-player-search"
          name="sidebar-player-search"
          type="text"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActiveIndex(0);
            if (!open) setOpen(true);
          }}
          onFocus={onFocus}
          onKeyDown={onKeyDown}
          placeholder="Search pro player…"
          aria-label="Search pro player"
          role="combobox"
          aria-expanded={open}
          aria-controls={PLAYER_LISTBOX_ID}
          aria-autocomplete="list"
          aria-activedescendant={open && results[activeIndex] ? playerOptId(activeIndex) : undefined}
          className="w-full bg-panel2/60 border border-line hover:border-line-gold rounded-lg py-2 pl-8 pr-3 text-[12.5px] text-txt placeholder:text-mut outline-none transition-colors focus:border-teal-dim focus-visible:ring-1 focus-visible:ring-teal focus-visible:ring-offset-1 focus-visible:ring-offset-sidebar"
        />
      </div>

      {/* Nothing renders below the input until there's actually something to
          show — no "type N characters" hint while under the search floor,
          same posture as PlayerPicker.tsx. */}
      {open && query.trim().length >= PLAYER_MIN_CHARS && (
        <div className="absolute z-50 top-full mt-1.5 left-0 w-[min(260px,80vw)] bg-panel border border-line rounded-lg shadow-[0_12px_32px_rgba(0,0,0,0.7)] overflow-hidden">
          <ul ref={listRef} id={PLAYER_LISTBOX_ID} role="listbox" aria-label="Player results" className="max-h-[260px] overflow-y-auto divide-y divide-line/40">
            {search.status === "loading" && <li className="px-3 py-2.5 text-[12px] text-mut">Searching…</li>}
            {search.status === "error" && <li className="px-3 py-2.5 text-[12px] text-bad">Couldn&apos;t search right now.</li>}
            {search.status === "ok" && results.length === 0 && (
              <li className="px-3 py-2.5 text-[12px] text-mut">No players found</li>
            )}
            {search.status === "ok" &&
              results.map((player, i) => {
                const isActive = i === activeIndex;
                const noGames = player.gameCount === 0;
                return (
                  <li key={player.id} id={playerOptId(i)} data-idx={i} role="option" aria-selected={isActive}>
                    <button
                      type="button"
                      tabIndex={-1}
                      onClick={() => select(player)}
                      onMouseEnter={() => setActiveIndex(i)}
                      className={`w-full flex items-center gap-2.5 px-3 py-2 text-[12.5px] text-left transition-colors ${
                        isActive ? "bg-teal/12" : ""
                      } ${noGames ? "text-mut" : "text-txt"}`}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">{player.name}</span>
                        <span className="block text-[10.5px] text-mut truncate">{player.team ?? "—"}</span>
                      </span>
                      <span className="text-[10.5px] text-mut tabular-nums flex-shrink-0">{player.gameCount}g</span>
                    </button>
                  </li>
                );
              })}
          </ul>
        </div>
      )}
    </div>
  );
}

// ── Mode toggle + wrapper ───────────────────────────────────────────────────

interface SidebarChampionSearchProps {
  mode: SearchMode;
  onModeChange: (mode: SearchMode) => void;
  onSelectChampion: (champ: ChampionRef) => void;
  onSelectPlayer: (player: PlayerRef) => void;
}

/** Two small uppercase-tracked tabs sitting directly above the search input
 *  — same underline-active vocabulary as HextechTabs (BUILD/PRO BUILDS), just
 *  scaled down and given a bottom-border edge shared with the field below it,
 *  so the pair reads as one attached control rather than two separate boxes. */
function ModeToggle({ mode, onModeChange }: { mode: SearchMode; onModeChange: (mode: SearchMode) => void }) {
  const tabClass = (active: boolean) =>
    `flex-1 pb-1.5 text-[10px] font-bold uppercase tracking-[0.08em] text-center border-b-2 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-teal ${
      active ? "text-teal border-teal" : "text-mut border-line hover:text-txt/80"
    }`;

  return (
    <div role="tablist" aria-label="Search champions or pro players" className="flex mb-1.5">
      <button type="button" role="tab" aria-selected={mode === "champions"} onClick={() => onModeChange("champions")} className={tabClass(mode === "champions")}>
        Champions
      </button>
      <button type="button" role="tab" aria-selected={mode === "pros"} onClick={() => onModeChange("pros")} className={tabClass(mode === "pros")}>
        Pros
      </button>
    </div>
  );
}

export default function SidebarChampionSearch({
  mode,
  onModeChange,
  onSelectChampion,
  onSelectPlayer,
}: SidebarChampionSearchProps) {
  return (
    <div>
      <ModeToggle mode={mode} onModeChange={onModeChange} />
      {mode === "champions" ? (
        <ChampionSearchField onSelect={onSelectChampion} />
      ) : (
        <PlayerSearchField onSelect={onSelectPlayer} />
      )}
    </div>
  );
}
