"use client";

import { useState, useRef, useEffect, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import type { ChampionRef } from "@/lib/types";
import { isFavoriteChampion } from "@/lib/favorites";
import FavoriteStarButton from "./FavoriteStarButton";
import { CHAMPION_FAVORITES_CHANGED_EVENT, toggleFavoriteChampion } from "./favoritesSync";
import { computeDropdownPosition, type DropdownCoords } from "./dropdownPosition";
import { openSearchFromPointer } from "./searchOpenState";
import { matchChampions } from "./championSearch";

// Module-level (stable reference) so FavoriteStarButton's subscribe effect
// doesn't re-run on every ChampionPicker re-render (e.g. each keystroke).
const checkChampionFavorited = (id: string | number) => isFavoriteChampion(Number(id));
const subscribeToHydration = () => () => {};
const getHydratedSnapshot = () => true;
const getServerHydratedSnapshot = () => false;

const FALLBACK_CHAMPIONS: ChampionRef[] = [
  { id: 112, key: "Viktor", name: "Viktor", icon: "https://cdn.coachless.gg/static-files/16.12.1/16.12.1/img/champion/Viktor.webp" },
  { id: 103, key: "Ahri", name: "Ahri", icon: "https://cdn.coachless.gg/static-files/16.12.1/16.12.1/img/champion/Ahri.webp" },
  { id: 86, key: "Garen", name: "Garen", icon: "https://cdn.coachless.gg/static-files/16.12.1/16.12.1/img/champion/Garen.webp" },
  { id: 64, key: "LeeSin", name: "Lee Sin", icon: "https://cdn.coachless.gg/static-files/16.12.1/16.12.1/img/champion/LeeSin.webp" },
  { id: 51, key: "Caitlyn", name: "Caitlyn", icon: "https://cdn.coachless.gg/static-files/16.12.1/16.12.1/img/champion/Caitlyn.webp" },
  { id: 412, key: "Thresh", name: "Thresh", icon: "https://cdn.coachless.gg/static-files/16.12.1/16.12.1/img/champion/Thresh.webp" },
];

interface ChampionPickerProps {
  value: ChampionRef | null;
  onChange: (champ: ChampionRef) => void;
  /** Shows a favorite star on each dropdown option. Opt-in (default false)
   *  so the Builds page's ChampionPicker instance is unaffected — only the
   *  /history champion picker passes this. */
  withFavorites?: boolean;
  /** What this particular picker DOES. /draft renders two of these plus the
   *  global TopBar search, and all three carried the identical "Search
   *  champion…" placeholder for three different behaviours — the page gave you
   *  no way to tell which box did what. Defaults to the generic wording, so
   *  every other call site is unchanged. */
  placeholder?: string;
  /** Focus the input and open the list on mount. For pickers that only exist
   *  BECAUSE the user just clicked something to summon them (the /draft team
   *  slots) — making them click a second time into the box before they can
   *  type is a wasted interaction. Off by default so the always-present
   *  pickers (Builds, /history) do not steal focus on page load. */
  autoFocus?: boolean;
}

const LISTBOX_ID = "champ-listbox";
const optId = (i: number) => `champ-opt-${i}`;

export default function ChampionPicker({
  value,
  onChange,
  withFavorites = false,
  placeholder = "Search champion…",
  autoFocus = false,
}: ChampionPickerProps) {
  // The accessible name tracks the visible placeholder rather than being pinned
  // to the generic wording — otherwise a screen-reader user hears "Search
  // champion" three times on /draft with no way to tell the boxes apart, which
  // is the same defect sighted users had. Trailing ellipsis is prompt
  // punctuation, not part of the name.
  const pickerLabel = placeholder.replace(/[….]+$/, "");
  const [champions, setChampions] = useState<ChampionRef[]>(FALLBACK_CHAMPIONS);
  const [query, setQuery] = useState("");
  const [selectionCleared, setSelectionCleared] = useState(value === null);
  if (value === null && !selectionCleared) {
    setSelectionCleared(true);
    setQuery("");
  } else if (value !== null && selectionCleared) {
    setSelectionCleared(false);
  }
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  // Results dropdown is portaled to document.body (see doc comment above the
  // JSX below) so it escapes any clip-path/overflow ancestor — the /draft
  // tactical panels (`.dt-panel`) clip-path their chamfered corners, which
  // was silently clipping the dropdown away entirely for the enemy/my-
  // champion pickers. `mounted` gates the portal so SSR never tries to touch
  // `document`; `coords` is null until the first position measurement lands
  // (avoids a one-frame flash at (0,0)); `dropdownRef` lets the outside-click
  // handler recognize clicks inside the now-detached-from-containerRef list.
  const mounted = useSyncExternalStore(subscribeToHydration, getHydratedSnapshot, getServerHydratedSnapshot);
  const [coords, setCoords] = useState<DropdownCoords | null>(null);

  // Focus on mount when summoned. Deliberately calls .focus() rather than using
  // the DOM `autoFocus` attribute: the existing onFocus handler is what opens
  // the list and selects any current text, so routing through it keeps one code
  // path for "the input became active" instead of two that can drift.
  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus]);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Fetch champion list from API; silently fall back to hardcoded list
  useEffect(() => {
    fetch("/api/champions")
      .then((r) => {
        if (!r.ok) throw new Error("champions 404");
        return r.json();
      })
      .then((data: ChampionRef[]) => {
        if (Array.isArray(data) && data.length > 0) setChampions(data);
      })
      .catch(() => {/* stay on fallback */});
  }, []);

  // If the parent clears the selection (e.g. the page-level "Clear
  // selection" ×), reflect that by emptying the input back to placeholder.
  // Close on outside click or Escape. The dropdown is portaled out of
  // containerRef's DOM subtree, so "outside" must also exclude dropdownRef —
  // otherwise a mousedown on a result row would close the dropdown (removing
  // it from the DOM) before the row's own click/select handler ever fires.
  useEffect(() => {
    function onDown(e: MouseEvent) {
      const target = e.target as Node;
      const insideContainer = containerRef.current?.contains(target);
      const insideDropdown = dropdownRef.current?.contains(target);
      if (!insideContainer && !insideDropdown) setOpen(false);
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

  // Position the portaled dropdown off the input row's rect while open, and
  // keep it glued to the anchor across resize. A real page/ancestor scroll
  // closes it instead of repositioning (simpler and robust — every other
  // sheet/picker in this app already closes on outside interaction, and the
  // anchor can move inside an arbitrary number of scroll containers). Scroll
  // events that originate INSIDE the dropdown itself (the results list's own
  // `overflow-y-auto`) are ignored so scrolling the list doesn't close it —
  // `scroll` events bubble/capture from any scrollable descendant, so a
  // naive window-capture listener would otherwise fire on every wheel tick
  // over the results.
  useEffect(() => {
    if (!open) {
      // Drop any stale measurement so the next open re-measures from
      // scratch instead of flashing at last time's position for a frame.
      // eslint-disable-next-line react-hooks/set-state-in-effect -- plain reset-on-close; kept beside this effect's geometry writes so the coords lifecycle stays in one place (deriving open ? coords : null would split it).
      setCoords(null);
      return;
    }
    function measure() {
      const el = containerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      setCoords(
        computeDropdownPosition(
          { top: rect.top, bottom: rect.bottom, left: rect.left },
          { width: window.innerWidth, height: window.innerHeight }
        )
      );
    }
    measure();
    function onScroll(e: Event) {
      if (dropdownRef.current && dropdownRef.current.contains(e.target as Node)) return;
      setOpen(false);
    }
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open]);

  const filtered = matchChampions(query, champions);

  // Keep the active option in view as it changes.
  useEffect(() => {
    if (!open) return;
    listRef.current
      ?.querySelector(`[data-idx="${activeIndex}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, open]);

  function select(champ: ChampionRef) {
    onChange(champ);
    setQuery(champ.name);
    setOpen(false);
  }

  function onInputFocus(e: React.FocusEvent<HTMLInputElement>) {
    setOpen(true);
    const i = value ? filtered.findIndex((c) => c.id === value.id) : 0;
    setActiveIndex(i >= 0 ? i : 0);
    // Highlight any existing selection text so the first keystroke replaces
    // it outright — tapping in and typing immediately re-filters.
    e.target.select();
  }

  function onInputPointer() {
    const next = openSearchFromPointer({ open, activeIndex });
    setOpen(next.open);
    setActiveIndex(next.activeIndex);
  }

  function onInputKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
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
    <div ref={containerRef} className="relative min-w-0 w-full">
      <div className="relative flex min-w-0 w-full items-center">
        {value && (
          <span className="absolute left-2.5 top-1/2 -translate-y-1/2 flex items-center pointer-events-none">
            <ChampIcon icon={value.icon} name={value.name} size={22} eager />
          </span>
        )}
        <input
          ref={inputRef}
          id="champion-search"
          name="champion-search"
          type="text"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActiveIndex(0);
            if (!open) setOpen(true);
          }}
          onFocus={onInputFocus}
          onClick={onInputPointer}
          onKeyDown={onInputKeyDown}
          placeholder={placeholder}
          aria-label={pickerLabel}
          role="combobox"
          aria-expanded={open}
          aria-controls={LISTBOX_ID}
          aria-autocomplete="list"
          aria-activedescendant={
            open && filtered[activeIndex] ? optId(activeIndex) : undefined
          }
          className={`w-full min-w-0 bg-panel2 border border-line hover:border-teal-dim rounded-xl py-2.5 text-sm text-txt placeholder:text-mut outline-none transition-colors focus:border-teal-dim focus-visible:ring-2 focus-visible:ring-teal focus-visible:ring-offset-2 focus-visible:ring-offset-bg ${
            value ? "pl-10 pr-8" : "pl-4 pr-8"
          }`}
        />
      </div>

      {open &&
        mounted &&
        coords &&
        createPortal(
          <div
            ref={dropdownRef}
            style={{
              position: "fixed",
              top: coords.top,
              bottom: coords.bottom,
              left: coords.left,
              width: coords.width,
            }}
            className="z-50 bg-panel border border-line rounded-xl shadow-[0_8px_32px_rgba(0,0,0,0.6)] overflow-hidden"
          >
          <ul
            ref={listRef}
            id={LISTBOX_ID}
            role="listbox"
            className="max-h-[240px] overflow-y-auto divide-y divide-line/40"
          >
            {filtered.length === 0 && (
              <li className="px-4 py-3 text-sm text-mut">No champions found</li>
            )}
            {filtered.map((champ, i) => {
              const isSelected = value?.id === champ.id;
              const isActive = i === activeIndex;
              return (
                <li
                  key={champ.id}
                  id={optId(i)}
                  data-idx={i}
                  role="option"
                  aria-selected={isActive}
                  className="flex items-center"
                >
                  <button
                    type="button"
                    tabIndex={-1}
                    onClick={() => select(champ)}
                    onMouseEnter={() => setActiveIndex(i)}
                    className={`flex-1 min-w-0 flex items-center gap-2.5 px-3 py-2 text-sm text-left transition-colors ${
                      isActive ? "bg-teal/15" : ""
                    } ${isSelected ? "text-teal font-semibold" : "text-txt"}`}
                  >
                    <ChampIcon icon={champ.icon} name={champ.name} size={24} />
                    {champ.name}
                  </button>
                  {withFavorites && (
                    <FavoriteStarButton
                      id={champ.id}
                      name={champ.name}
                      changedEvent={CHAMPION_FAVORITES_CHANGED_EVENT}
                      checkFavorited={checkChampionFavorited}
                      onToggle={() => toggleFavoriteChampion({ id: champ.id, name: champ.name })}
                      className="mr-2"
                    />
                  )}
                </li>
              );
            })}
          </ul>
          </div>,
          document.body
        )}
    </div>
  );
}

function ChampIcon({
  icon,
  name,
  size,
  eager,
}: {
  icon: string;
  name: string;
  size: number;
  /** The combobox's own selected-value crest is always visible the instant
   *  this component mounts (it sits inline in the input, never off-screen) —
   *  lazy-loading it would just delay showing something already on screen,
   *  so it opts out of the dropdown rows' default lazy behavior. */
  eager?: boolean;
}) {
  return (
    <span
      className="flex-shrink-0 rounded-md overflow-hidden bg-black/20"
      style={{ width: size, height: size }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- Champion icons use runtime CDN URLs and this wrapper owns the fixed box plus error fallback. */}
      <img
        src={icon}
        alt={name}
        width={size}
        height={size}
        loading={eager ? "eager" : "lazy"}
        decoding="async"
        className="w-full h-full object-cover"
        onError={(e) => {
          (e.currentTarget as HTMLImageElement).style.display = "none";
        }}
      />
    </span>
  );
}
