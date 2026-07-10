"use client";

import { useState, useRef, useEffect } from "react";
import type { ChampionRef } from "@/lib/types";

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
}

const LISTBOX_ID = "champ-listbox";
const optId = (i: number) => `champ-opt-${i}`;

export default function ChampionPicker({ value, onChange }: ChampionPickerProps) {
  const [champions, setChampions] = useState<ChampionRef[]>(FALLBACK_CHAMPIONS);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

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

  const filtered = query.trim()
    ? champions.filter((c) =>
        c.name.toLowerCase().includes(query.toLowerCase()) ||
        c.key.toLowerCase().includes(query.toLowerCase())
      )
    : champions;

  // Keep the active option in view as it changes.
  useEffect(() => {
    if (!open) return;
    listRef.current
      ?.querySelector(`[data-idx="${activeIndex}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, open]);

  function openMenu() {
    setOpen(true);
    const i = value ? filtered.findIndex((c) => c.id === value.id) : 0;
    setActiveIndex(i >= 0 ? i : 0);
    setTimeout(() => inputRef.current?.focus(), 50);
  }

  function select(champ: ChampionRef) {
    onChange(champ);
    setQuery("");
    setOpen(false);
  }

  function onInputKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
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
    }
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => (open ? setOpen(false) : openMenu())}
        className="flex items-center gap-2.5 bg-panel2 border border-line hover:border-teal-dim rounded-xl px-4 py-2.5 transition-colors text-left min-w-[200px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={LISTBOX_ID}
      >
        {value ? (
          <>
            <ChampIcon icon={value.icon} name={value.name} size={28} />
            <span className="font-semibold text-txt">{value.name}</span>
          </>
        ) : (
          <span className="text-mut">Pick a champion…</span>
        )}
        <span className="ml-auto text-mut text-xs">▾</span>
      </button>

      {open && (
        <div className="absolute z-50 top-full mt-1.5 left-0 w-[280px] bg-panel border border-line rounded-xl shadow-[0_8px_32px_rgba(0,0,0,0.6)] overflow-hidden">
          <div className="p-2 border-b border-line">
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActiveIndex(0);
              }}
              onKeyDown={onInputKeyDown}
              placeholder="Search champion…"
              role="combobox"
              aria-expanded={open}
              aria-controls={LISTBOX_ID}
              aria-autocomplete="list"
              aria-activedescendant={
                open && filtered[activeIndex] ? optId(activeIndex) : undefined
              }
              className="w-full bg-panel2 border border-line rounded-lg px-3 py-1.5 text-sm text-txt placeholder:text-mut outline-none focus:border-teal-dim"
            />
          </div>
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
                >
                  <button
                    type="button"
                    tabIndex={-1}
                    onClick={() => select(champ)}
                    onMouseEnter={() => setActiveIndex(i)}
                    className={`w-full flex items-center gap-2.5 px-3 py-2 text-sm text-left transition-colors ${
                      isActive ? "bg-teal/15" : ""
                    } ${isSelected ? "text-teal font-semibold" : "text-txt"}`}
                  >
                    <ChampIcon icon={champ.icon} name={champ.name} size={24} />
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

function ChampIcon({ icon, name, size }: { icon: string; name: string; size: number }) {
  return (
    <span
      className="flex-shrink-0 rounded-md overflow-hidden bg-black/20"
      style={{ width: size, height: size }}
    >
      <img
        src={icon}
        alt={name}
        width={size}
        height={size}
        className="w-full h-full object-cover"
        onError={(e) => {
          (e.currentTarget as HTMLImageElement).style.display = "none";
        }}
      />
    </span>
  );
}
