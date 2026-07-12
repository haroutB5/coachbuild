"use client";

// Chromeless champion search for the Hextech sidebar — same data source and
// keyboard-nav contract as components/ChampionPicker.tsx (fetch
// /api/champions, ARIA combobox, Up/Down/Home/End/Enter/Escape) but a
// deliberately separate component rather than a new variant bolted onto
// ChampionPicker: the sidebar's chromeless input (no inline selected-value
// icon, clears back to placeholder on select — the pick shows up in the
// hero/lane row instead) is different enough visual behavior that threading
// it through ChampionPicker's existing JSX risked regressing the
// /history + Builds-legacy call sites this redesign explicitly leaves alone.

import { useEffect, useRef, useState } from "react";
import type { ChampionRef } from "@/lib/types";

const FALLBACK_CHAMPIONS: ChampionRef[] = [
  { id: 112, key: "Viktor", name: "Viktor", icon: "https://cdn.coachless.gg/static-files/16.12.1/16.12.1/img/champion/Viktor.webp" },
  { id: 103, key: "Ahri", name: "Ahri", icon: "https://cdn.coachless.gg/static-files/16.12.1/16.12.1/img/champion/Ahri.webp" },
  { id: 122, key: "Darius", name: "Darius", icon: "https://cdn.coachless.gg/static-files/16.12.1/16.12.1/img/champion/Darius.webp" },
  { id: 64, key: "LeeSin", name: "Lee Sin", icon: "https://cdn.coachless.gg/static-files/16.12.1/16.12.1/img/champion/LeeSin.webp" },
  { id: 222, key: "Jinx", name: "Jinx", icon: "https://cdn.coachless.gg/static-files/16.12.1/16.12.1/img/champion/Jinx.webp" },
  { id: 412, key: "Thresh", name: "Thresh", icon: "https://cdn.coachless.gg/static-files/16.12.1/16.12.1/img/champion/Thresh.webp" },
];

interface SidebarChampionSearchProps {
  onSelect: (champ: ChampionRef) => void;
}

const LISTBOX_ID = "sidebar-champ-listbox";
const optId = (i: number) => `sidebar-champ-opt-${i}`;

export default function SidebarChampionSearch({ onSelect }: SidebarChampionSearchProps) {
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
        <svg
          aria-hidden="true"
          viewBox="0 0 20 20"
          className="absolute left-2.5 w-3.5 h-3.5 text-mut pointer-events-none"
          fill="none"
        >
          <circle cx="8.5" cy="8.5" r="6" stroke="currentColor" strokeWidth="1.5" />
          <path d="M13.5 13.5L17.5 17.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
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
          aria-controls={LISTBOX_ID}
          aria-autocomplete="list"
          aria-activedescendant={open && filtered[activeIndex] ? optId(activeIndex) : undefined}
          className="w-full bg-panel2/60 border border-line hover:border-line-gold rounded-lg py-2 pl-8 pr-3 text-[12.5px] text-txt placeholder:text-mut outline-none transition-colors focus:border-teal-dim focus-visible:ring-1 focus-visible:ring-teal focus-visible:ring-offset-1 focus-visible:ring-offset-sidebar"
        />
      </div>

      {open && (
        <div className="absolute z-50 top-full mt-1.5 left-0 w-[min(260px,80vw)] bg-panel border border-line rounded-lg shadow-[0_12px_32px_rgba(0,0,0,0.7)] overflow-hidden">
          <ul ref={listRef} id={LISTBOX_ID} role="listbox" className="max-h-[260px] overflow-y-auto divide-y divide-line/40">
            {filtered.length === 0 && <li className="px-3 py-2.5 text-[12px] text-mut">No champions found</li>}
            {filtered.map((champ, i) => {
              const isActive = i === activeIndex;
              return (
                <li key={champ.id} id={optId(i)} data-idx={i} role="option" aria-selected={isActive}>
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
