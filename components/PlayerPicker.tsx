"use client";

import { useState, useRef, useEffect } from "react";
import type { PlayerRef, PlayersApiResponse } from "./proHistory.types";
import { PRO_ROLE_LABEL } from "./proHistory.types";
import FavoriteStarButton from "./FavoriteStarButton";

interface PlayerPickerProps {
  value: PlayerRef | null;
  onChange: (player: PlayerRef) => void;
}

type SearchState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ok"; players: PlayerRef[] }
  | { status: "error" };

const LISTBOX_ID = "player-listbox";
const optId = (i: number) => `player-opt-${i}`;
const MIN_CHARS = 2;
const DEBOUNCE_MS = 250;

function playerLabel(player: PlayerRef): string {
  return player.team ? `${player.name} — ${player.team}` : player.name;
}

export default function PlayerPicker({ value, onChange }: PlayerPickerProps) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [search, setSearch] = useState<SearchState>({ status: "idle" });
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Bumped on every new query so a slow, stale response can't clobber a
  // faster, more recent one (classic typeahead race).
  const reqIdRef = useRef(0);

  // Reflect external value changes in the input text: the page-level "Clear
  // selection" ✕ clears it back to placeholder, and a favorites-chip tap
  // (which sets `value` directly, bypassing this component's own `select()`)
  // needs the same "Name — Team" text a normal in-dropdown pick would show.
  useEffect(() => {
    setQuery(value ? playerLabel(value) : "");
  }, [value]);

  // Debounced live search — fires ~250ms after the user stops typing, only
  // once the query clears the 2-char floor.
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const q = query.trim();
    if (q.length < MIN_CHARS) {
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
    }, DEBOUNCE_MS);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query]);

  // Close on outside click or Escape
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

  // Keep the active option in view as it changes.
  useEffect(() => {
    if (!open) return;
    listRef.current
      ?.querySelector(`[data-idx="${activeIndex}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, open]);

  function select(player: PlayerRef) {
    reqIdRef.current++; // invalidate any in-flight search so it can't repopulate after selection
    onChange(player);
    setQuery(playerLabel(player));
    setOpen(false);
  }

  function onInputFocus(e: React.FocusEvent<HTMLInputElement>) {
    setOpen(true);
    // Highlight any existing selection text so the first keystroke replaces
    // it outright — tapping in and typing immediately re-filters.
    e.target.select();
  }

  function onInputKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
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
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setActiveIndex(0);
          if (!open) setOpen(true);
        }}
        onFocus={onInputFocus}
        onKeyDown={onInputKeyDown}
        placeholder="Search a pro player…"
        aria-label="Search a pro player"
        role="combobox"
        aria-expanded={open}
        aria-controls={LISTBOX_ID}
        aria-autocomplete="list"
        aria-activedescendant={open && results[activeIndex] ? optId(activeIndex) : undefined}
        className="w-full min-w-[220px] bg-panel2 border border-line hover:border-teal-dim rounded-xl px-4 py-2.5 text-sm text-txt placeholder:text-mut outline-none transition-colors focus:border-teal-dim focus-visible:ring-2 focus-visible:ring-teal focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
      />

      {/* Nothing renders below the input until there's actually something to
          show — no "type N characters" hint while the user is still under
          the search floor. */}
      {open && query.trim().length >= MIN_CHARS && (
        <div className="absolute z-50 top-full mt-1.5 left-0 w-[min(300px,90vw)] bg-panel border border-line rounded-xl shadow-[0_8px_32px_rgba(0,0,0,0.6)] overflow-hidden">
          <ul
            ref={listRef}
            id={LISTBOX_ID}
            role="listbox"
            aria-label="Player results"
            className="max-h-[260px] overflow-y-auto divide-y divide-line/40"
          >
            {search.status === "loading" && (
              <li className="px-4 py-3 text-[12px] text-mut">Searching…</li>
            )}
            {search.status === "error" && (
              <li className="px-4 py-3 text-[12px] text-bad">Couldn&apos;t search right now.</li>
            )}
            {search.status === "ok" && results.length === 0 && (
              <li className="px-4 py-3 text-[12px] text-mut">No players found</li>
            )}
            {search.status === "ok" &&
              results.map((player, i) => {
                const isSelected = value?.id === player.id;
                const isActive = i === activeIndex;
                const noGames = player.gameCount === 0;
                const metaParts = [
                  player.team,
                  player.role !== null ? PRO_ROLE_LABEL[player.role] : null,
                ].filter(Boolean);
                return (
                  <li
                    key={player.id}
                    id={optId(i)}
                    data-idx={i}
                    role="option"
                    aria-selected={isActive}
                    className="flex items-center"
                  >
                    <button
                      type="button"
                      tabIndex={-1}
                      onClick={() => select(player)}
                      onMouseEnter={() => setActiveIndex(i)}
                      className={`flex-1 min-w-0 flex items-center gap-2 px-3 py-2 text-sm text-left transition-colors ${
                        isActive ? "bg-teal/15" : ""
                      } ${isSelected ? "text-teal font-semibold" : noGames ? "text-mut" : "text-txt"}`}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">{player.name}</span>
                        <span className="block text-[11px] text-mut truncate">
                          {metaParts.length > 0 ? metaParts.join(" · ") : "—"}
                        </span>
                      </span>
                      <span className="text-[11px] text-mut tabular-nums flex-shrink-0">
                        {player.gameCount} games
                      </span>
                    </button>
                    <FavoriteStarButton
                      player={{ id: player.id, name: player.name, team: player.team }}
                      className="mr-2"
                    />
                  </li>
                );
              })}
          </ul>
        </div>
      )}
    </div>
  );
}
