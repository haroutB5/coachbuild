"use client";

// Global top bar rendered above <main> on every chrome-bearing route. The
// search keeps the existing champion-search bus and keyboard navigation; the
// center phase spine and right action are shell-only chrome.
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { usePathname, useRouter } from "next/navigation";
import { MagnifyingGlass } from "@phosphor-icons/react";
import type { ChampionRef } from "@/lib/types";
import { useCompanion } from "@/components/live/CompanionProvider";
import { emitChampionSearch } from "../championSearchBus";
import { openSearchFromPointer } from "../../searchOpenState";
import { computeDropdownPosition, type DropdownCoords } from "../../dropdownPosition";
import { matchChampions } from "../../championSearch";
import ApplyRunesButton from "./ApplyRunesButton";
import { phaseSpineModel, PHASE_SPINE_STEPS } from "./phaseSpineModel";
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
      const liveVersion = liveVersionFromChampMap(championMap);
      const liveFallback = FALLBACK_CHAMPIONS.map((champion) => withLiveIconVersion(champion, liveVersion));
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
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        inputRef.current?.focus();
        setOpen(true);
      }
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  // Portal the list so the top bar's overflow clip and future containing
  // blocks cannot swallow it. Position follows the existing picker contract.
  useEffect(() => {
    if (!open) {
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
    if (pathname !== "/") router.push("/");
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
        <MagnifyingGlass aria-hidden="true" size={15} weight="light" className="pointer-events-none absolute left-3 text-txt/[0.45]" />
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
          placeholder="Search champion, item or pro…"
          aria-label="Search champion, item or pro"
          role="combobox"
          aria-expanded={open}
          aria-controls={LISTBOX_ID}
          aria-autocomplete="list"
          aria-activedescendant={open && filtered[activeIndex] ? optId(activeIndex) : undefined}
          className="h-11 w-full rounded-[8px] border border-[rgba(233,233,237,0.1)] bg-panel2 pl-8 pr-12 text-[13px] text-txt outline-none transition-colors duration-[120ms] ease-in placeholder:text-txt/40 hover:border-accent/40 focus-visible:border-accent focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2 lg:h-[34px]"
        />
        <span className="pointer-events-none absolute right-2 flex items-center rounded-[5px] border border-[rgba(233,233,237,0.14)] px-1.5 py-[3px] text-[10px] font-medium leading-none text-txt/[0.45]">
          ⌘K
        </span>
      </div>

      {open && mounted && coords && createPortal(
        <div
          ref={dropdownRef}
          style={{ position: "fixed", top: coords.top, bottom: coords.bottom, left: coords.left, width: coords.width }}
          className="z-50 overflow-hidden rounded-[8px] border border-[rgba(233,233,237,0.12)] bg-panel shadow-[0_12px_32px_rgba(0,0,0,0.7)]"
        >
          <ul ref={listRef} id={LISTBOX_ID} role="listbox" className="max-h-[300px] divide-y divide-txt/[0.05] overflow-y-auto">
            {filtered.length === 0 && <li className="px-3 py-2.5 text-[12px] text-txt/[0.55]">No champions found</li>}
            {filtered.map((champ, i) => {
              const isActive = i === activeIndex;
              return (
                <li key={champ.id} id={optId(i)} data-idx={i} role="option" aria-selected={isActive}>
                  <button
                    type="button"
                    tabIndex={-1}
                    onClick={() => select(champ)}
                    onMouseEnter={() => setActiveIndex(i)}
                    className={`flex w-full items-center gap-2.5 px-3 py-3 text-left text-[12.5px] text-txt transition-colors duration-[120ms] ease-in focus-visible:outline-none focus-visible:outline-2 focus-visible:outline-accent ${isActive ? "bg-teal/[0.12]" : "hover:bg-txt/[0.04]"}`}
                  >
                    <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center overflow-hidden rounded bg-black/30">
                      {champ.icon && (
                        /* eslint-disable-next-line @next/next/no-img-element */
                        <img
                          src={champ.icon}
                          alt=""
                          width={20}
                          height={20}
                          loading="lazy"
                          decoding="async"
                          className="h-full w-full object-cover"
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

function PhaseSpine() {
  const companion = useCompanion();
  const [phaseHistory, setPhaseHistory] = useState<{ session: string | null; phases: string[] }>({
    session: null,
    phases: [],
  });

  // The model is pure, so this small effect owns the companion-session
  // history that the provider intentionally exposes only as its current
  // snapshot. A fresh client-backed poll is the only thing allowed to enter
  // the history; a stale/no-client response cannot manufacture a completed
  // step. The model counts the current phase immediately, so the first poll
  // paints its active node without waiting for this effect's follow-up render.
  useEffect(() => {
    const { session, phase, clientConnected, statusFresh } = companion;
    const observedPhase = statusFresh && clientConnected ? phase : null;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- phase history is a deliberate session-scoped projection of the companion poll stream.
    setPhaseHistory((previous) => {
      if (observedPhase === null) {
        return previous.session === session ? previous : { session, phases: [] };
      }
      if (previous.session !== session) return { session, phases: [observedPhase] };
      if (previous.phases.includes(observedPhase)) return previous;
      return { session, phases: [...previous.phases, observedPhase] };
    });
  }, [companion]);

  const model = phaseSpineModel({
    phase: companion.phase,
    clientConnected: companion.clientConnected,
    statusFresh: companion.statusFresh,
    observedPhases: phaseHistory.session === companion.session ? phaseHistory.phases : [],
  });

  return (
    <div
      aria-label="Game phase"
      className="hidden h-[28px] w-[450px] flex-shrink-0 items-center justify-center rounded-[9px] border border-[rgba(233,233,237,0.08)] bg-panel2 px-3 lg:flex"
      role="list"
    >
      {PHASE_SPINE_STEPS.map((label, index) => {
        const state = model.states[index];
        const nextState = model.states[index + 1];
        const connectorStyle =
          state === "active"
            ? { background: "linear-gradient(to right, rgba(145,132,217,.5), rgba(233,233,237,.06))" }
            : nextState === "active"
              ? { background: "linear-gradient(to right, rgba(233,233,237,.06), rgba(145,132,217,.5))" }
              : { background: "rgba(233,233,237,.06)" };

        return (
          <div key={label} className="contents">
            <div
              className="flex items-center gap-1.5 whitespace-nowrap"
              role="listitem"
              aria-current={state === "active" ? "step" : undefined}
            >
              <span
                aria-hidden="true"
                className={`block flex-shrink-0 rounded-full ${
                  state === "active"
                    ? "h-1.5 w-1.5 bg-accent shadow-[0_0_10px_2px_rgba(145,132,217,0.55)]"
                    : state === "complete"
                      ? "h-[5px] w-[5px] bg-neutral-600"
                      : "h-[5px] w-[5px] bg-neutral-800"
                }`}
              />
              <span
                className={`text-[9px] font-medium uppercase tracking-[0.12em] ${
                    state === "active" ? "font-semibold text-accent-400" : state === "complete" ? "text-txt/[0.42]" : "text-txt/[0.30]"
                }`}
              >
                {label}
              </span>
            </div>
            {index < PHASE_SPINE_STEPS.length - 1 && <span aria-hidden="true" className="mx-2 h-px w-[26px] flex-shrink-0" style={connectorStyle} />}
          </div>
        );
      })}
    </div>
  );
}

export default function TopBar() {
  const pathname = usePathname();
  const { hideSearchOnMobile } = topBarChromeConfig(pathname);

  return (
    <div
      className={`${hideSearchOnMobile ? "hidden lg:flex" : "flex"} relative z-30 h-14 flex-shrink-0 items-center overflow-x-clip border-b border-[rgba(233,233,237,0.08)] bg-bg px-3 sm:px-4 lg:px-5`}
    >
      <div className="w-full min-w-0 flex-1 lg:w-[280px] lg:flex-none">
        <TopBarChampionSearch />
      </div>
      <div className="hidden min-w-0 flex-1 lg:block" />
      <PhaseSpine />
      <div className="hidden min-w-0 flex-1 lg:block" />
      <ApplyRunesButton />
    </div>
  );
}
