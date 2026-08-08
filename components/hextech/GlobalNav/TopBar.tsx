"use client";

// Global top bar (CoachBuild v0.51 redesign) — sticky chrome rendered above
// <main> on EVERY route (mounted by AppShell.tsx, outside any page's own
// content). Three zones: champion search (left), champ-select status chip
// (center-right), gold "Apply runes" action (right).
//
// Mobile parity (v0.63.4): Apply Runes is desktop-only on every route
// (ApplyRunesButton.tsx — it drives a same-machine League-client bridge that
// has no meaning on a phone). The champion search is ALSO hidden below `lg`
// on routes whose page already owns a champion/player search (/history,
// /draft — see topBarChrome.ts), so mobile never stacks two-to-three search
// boxes on one screen. Desktop keeps the search everywhere except /draft,
// whose own control row is the primary champion search. See TopBar()'s
// own `emptyOnMobile` for how the bar avoids rendering as an empty bordered
// strip when both zones are hidden on those two routes.
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
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { useRouter, usePathname } from "next/navigation";
import type { ChampionRef } from "@/lib/types";
import { emitChampionSearch } from "../championSearchBus";
import { openSearchFromPointer } from "../../searchOpenState";
import { computeDropdownPosition, type DropdownCoords } from "../../dropdownPosition";
import { matchChampions } from "../../championSearch";
import ChampSelectChip from "./ChampSelectChip";
import ApplyRunesButton from "./ApplyRunesButton";
import { topBarChromeConfig } from "./topBarChrome";
import { getChampionMap, liveVersionFromChampMap, withLiveIconVersion } from "../heroContracts";

const FALLBACK_CHAMPIONS: ChampionRef[] = [
  { id: 112, key: "Viktor", name: "Viktor", icon: "" },
  { id: 103, key: "Ahri", name: "Ahri", icon: "" },
  { id: 86, key: "Garen", name: "Garen", icon: "" },
  { id: 64, key: "LeeSin", name: "Lee Sin", icon: "" },
  { id: 222, key: "Jinx", name: "Jinx", icon: "" },
  { id: 412, key: "Thresh", name: "Thresh", icon: "" },
];

const SEARCH_ICON = (
  <svg aria-hidden="true" viewBox="0 0 20 20" className="absolute left-3 w-3.5 h-3.5 text-mut pointer-events-none" fill="none">
    <circle cx="8.5" cy="8.5" r="6" stroke="currentColor" strokeWidth="1.5" />
    <path d="M13.5 13.5L17.5 17.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
);

const LISTBOX_ID = "topbar-champ-listbox";
const optId = (i: number) => `topbar-champ-opt-${i}`;
const subscribeToHydration = () => () => {};
const getHydratedSnapshot = () => true;
const getServerHydratedSnapshot = () => false;

function TopBarChampionSearch() {
  const router = useRouter();
  const pathname = usePathname();
  const [champions, setChampions] = useState<ChampionRef[]>(FALLBACK_CHAMPIONS);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const mounted = useSyncExternalStore(subscribeToHydration, getHydratedSnapshot, getServerHydratedSnapshot);
  const [coords, setCoords] = useState<DropdownCoords | null>(null);

  useEffect(() => {
    getChampionMap().then((championMap) => {
      // The shared map gives this always-mounted search the same live icon
      // source as the page pickers. The empty-map branch deliberately stays
      // glyph-only rather than issuing requests to a retired CDN folder.
      const liveVersion = liveVersionFromChampMap(championMap);
      const liveFallback = FALLBACK_CHAMPIONS.map((champion) =>
        withLiveIconVersion(champion, liveVersion)
      );
      setChampions(championMap.size > 0 ? Array.from(championMap.values()) : liveFallback);
    });
  }, []);

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

  // The list is portaled to document.body so neither the bar's horizontal
  // overflow clip nor any future containing-block/stacking-context change can
  // swallow it on Safari. Position it from the input's viewport rect and use
  // the same resize/scroll behavior as ChampionPicker: resize re-measures,
  // page/ancestor scroll closes, and scrolling inside the list is ignored.
  useEffect(() => {
    if (!open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- plain reset-on-close; kept beside this effect's geometry writes so the coords lifecycle stays in one place (deriving open ? coords : null would split it).
      setCoords(null);
      return;
    }
    function measure() {
      const el = inputRef.current;
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
      if (dropdownRef.current?.contains(e.target as Node)) return;
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

  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector(`[data-idx="${activeIndex}"]`)?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, open]);

  function select(champ: ChampionRef) {
    // On any route other than "/", land on Builds first. The bus owns the
    // asynchronous handoff, so this remains safe while the destination page
    // is still mounting.
    if (pathname !== "/") {
      router.push("/");
    }
    emitChampionSearch(champ);
    setQuery("");
    setOpen(false);
  }

  function onFocus() {
    setOpen(true);
    setActiveIndex(0);
  }

  function onPointerOpen() {
    const next = openSearchFromPointer({ open, activeIndex });
    setOpen(next.open);
    setActiveIndex(next.activeIndex);
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
          ref={inputRef}
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
          onClick={onPointerOpen}
          onKeyDown={onKeyDown}
          placeholder="Search champion…"
          aria-label="Search champion"
          role="combobox"
          aria-expanded={open}
          aria-controls={LISTBOX_ID}
          aria-autocomplete="list"
          aria-activedescendant={open && filtered[activeIndex] ? optId(activeIndex) : undefined}
          className="w-full bg-panel2/70 border border-line hover:border-line-gold rounded-lg py-[11px] pl-8 pr-3 text-[12.5px] text-txt placeholder:text-mut outline-none transition-colors focus:border-teal-dim focus-visible:ring-1 focus-visible:ring-teal"
        />
      </div>

      {open && mounted && coords && createPortal(
        <div
          ref={dropdownRef}
          style={{
            position: "fixed",
            top: coords.top,
            bottom: coords.bottom,
            left: coords.left,
            width: coords.width,
          }}
          className="z-50 bg-panel border border-line rounded-lg shadow-[0_12px_32px_rgba(0,0,0,0.7)] overflow-hidden"
        >
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
                    className={`w-full flex items-center gap-2.5 px-3 py-3 text-[12.5px] text-left transition-colors text-txt ${isActive ? "bg-teal/12" : ""}`}
                  >
                    <span className="flex-shrink-0 w-5 h-5 rounded overflow-hidden bg-black/30">
                      {champ.icon && (
                        /* eslint-disable-next-line @next/next/no-img-element */
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
                      )}
                    </span>
                    {champ.name}
                  </button>
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

export default function TopBar() {
  const pathname = usePathname();
  const { hideSearchOnMobile } = topBarChromeConfig(pathname);

  // On /history and /draft (hideSearchOnMobile), below `lg` the search box is
  // hidden (the page already owns its own) and Apply Runes is ALWAYS hidden
  // below `lg` (ApplyRunesButton.tsx, every route) — so the chip is the ONLY
  // thing that can still be showing there. Track whether it actually is, so
  // the bar's own chrome (border/padding/background) can collapse below `lg`
  // when it would otherwise be a bordered strip with nothing in it. Default
  // false matches ChampSelectChip's own default-hidden state (no companion
  // session on first paint), so this never causes a hydration mismatch.
  const [chipVisible, setChipVisible] = useState(false);
  const emptyOnMobile = hideSearchOnMobile && !chipVisible;
  const emptyOnDraft = pathname === "/draft" && !chipVisible;
  const hideSearchOnDraft = pathname === "/draft";

  return (
    <div
      className={`${emptyOnDraft ? "hidden" : emptyOnMobile ? "hidden lg:flex" : "flex"} sticky top-0 z-30 bg-sidebar/95 backdrop-blur border-b border-line px-3 sm:px-4 lg:px-6 py-2.5 items-center gap-2.5 sm:gap-3 overflow-x-clip`}
    >
      {!hideSearchOnDraft && <div className={hideSearchOnMobile ? "hidden lg:block flex-1 min-w-0 max-w-[420px]" : "flex-1 min-w-0 max-w-[420px]"}>
        <TopBarChampionSearch />
      </div>}
      <ChampSelectChip onVisibleChange={setChipVisible} />
      {pathname !== "/draft" && <ApplyRunesButton />}
    </div>
  );
}
