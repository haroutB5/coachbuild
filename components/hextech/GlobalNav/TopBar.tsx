"use client";

// Global top bar (CoachBuild v0.51 redesign) — sticky chrome rendered above
// <main> on EVERY route (mounted by AppShell.tsx, outside any page's own
// content). Three zones: champion search (left), champ-select status chip
// (center-right), gold "Apply runes" action (right).
//
// Search wiring: this bar owns its OWN champion combobox (same fetch-
// /api/champions + arrow-key-nav contract as SidebarChampionSearch.tsx's
// ChampionSearchField / ChampionPicker.tsx — those aren't exported as a
// reusable headless piece, so this mirrors the same shape rather than
// reaching into either). On select: if the current route isn't "/", navigate
// there first, then emit on the next tick so the Builds page's subscriber is
// mounted before the event fires; if already on "/", emit immediately.
// app/page.tsx (the ONLY current subscriber) owns actually changing the
// shown champion — this bar never touches page-level state directly.
import { useEffect, useRef, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import type { ChampionRef } from "@/lib/types";
import { emitChampionSearch } from "../championSearchBus";
import ChampSelectChip from "./ChampSelectChip";
import ApplyRunesButton from "./ApplyRunesButton";

const FALLBACK_CHAMPIONS: ChampionRef[] = [
  { id: 112, key: "Viktor", name: "Viktor", icon: "https://cdn.coachless.gg/static-files/16.12.1/16.12.1/img/champion/Viktor.webp" },
  { id: 103, key: "Ahri", name: "Ahri", icon: "https://cdn.coachless.gg/static-files/16.12.1/16.12.1/img/champion/Ahri.webp" },
  { id: 86, key: "Garen", name: "Garen", icon: "https://cdn.coachless.gg/static-files/16.12.1/16.12.1/img/champion/Garen.webp" },
  { id: 64, key: "LeeSin", name: "Lee Sin", icon: "https://cdn.coachless.gg/static-files/16.12.1/16.12.1/img/champion/LeeSin.webp" },
  { id: 222, key: "Jinx", name: "Jinx", icon: "https://cdn.coachless.gg/static-files/16.12.1/16.12.1/img/champion/Jinx.webp" },
  { id: 412, key: "Thresh", name: "Thresh", icon: "https://cdn.coachless.gg/static-files/16.12.1/16.12.1/img/champion/Thresh.webp" },
];

const SEARCH_ICON = (
  <svg aria-hidden="true" viewBox="0 0 20 20" className="absolute left-3 w-3.5 h-3.5 text-mut pointer-events-none" fill="none">
    <circle cx="8.5" cy="8.5" r="6" stroke="currentColor" strokeWidth="1.5" />
    <path d="M13.5 13.5L17.5 17.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
);

const LISTBOX_ID = "topbar-champ-listbox";
const optId = (i: number) => `topbar-champ-opt-${i}`;

function TopBarChampionSearch() {
  const router = useRouter();
  const pathname = usePathname();
  const [champions, setChampions] = useState<ChampionRef[]>(FALLBACK_CHAMPIONS);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    fetch("/api/champions")
      .then((r) => (r.ok ? (r.json() as Promise<ChampionRef[]>) : []))
      .then((data) => {
        if (Array.isArray(data) && data.length > 0) setChampions(data);
      })
      .catch(() => {
        /* stay on fallback */
      });
  }, []);

  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
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
    ? champions.filter((c) => c.name.toLowerCase().includes(query.toLowerCase()) || c.key.toLowerCase().includes(query.toLowerCase()))
    : champions;

  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector(`[data-idx="${activeIndex}"]`)?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, open]);

  function select(champ: ChampionRef) {
    // On any route other than "/", land on Builds first, then emit next tick
    // so app/page.tsx's subscribeChampionSearch listener is mounted before
    // the event fires — a same-tick emit right after router.push would race
    // the new page's own mount effect.
    if (pathname !== "/") {
      router.push("/");
      window.setTimeout(() => emitChampionSearch(champ), 0);
    } else {
      emitChampionSearch(champ);
    }
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
    } else if (e.key === "Enter") {
      e.preventDefault();
      const champ = filtered[activeIndex];
      if (champ) select(champ);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  return (
    <div ref={containerRef} className="relative w-full">
      <div className="relative flex items-center">
        {SEARCH_ICON}
        <input
          id="topbar-champion-search"
          name="topbar-champion-search"
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
          className="w-full bg-panel2/70 border border-line hover:border-line-gold rounded-lg py-2 pl-8 pr-3 text-[12.5px] text-txt placeholder:text-mut outline-none transition-colors focus:border-teal-dim focus-visible:ring-1 focus-visible:ring-teal"
        />
      </div>

      {open && (
        <div className="absolute z-50 top-full mt-1.5 left-0 w-[min(280px,90vw)] bg-panel border border-line rounded-lg shadow-[0_12px_32px_rgba(0,0,0,0.7)] overflow-hidden">
          <ul ref={listRef} id={LISTBOX_ID} role="listbox" className="max-h-[300px] overflow-y-auto divide-y divide-line/40">
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
                    className={`w-full flex items-center gap-2.5 px-3 py-2 text-[12.5px] text-left transition-colors text-txt ${isActive ? "bg-teal/12" : ""}`}
                  >
                    <span className="flex-shrink-0 w-5 h-5 rounded overflow-hidden bg-black/30">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
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

export default function TopBar() {
  return (
    <div className="sticky top-0 z-30 bg-sidebar/95 backdrop-blur border-b border-line px-3 sm:px-4 lg:px-6 py-2.5 flex items-center gap-2.5 sm:gap-3 overflow-x-clip">
      <div className="flex-1 min-w-0 max-w-[420px]">
        <TopBarChampionSearch />
      </div>
      <ChampSelectChip />
      <ApplyRunesButton />
    </div>
  );
}
