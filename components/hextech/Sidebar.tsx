"use client";

import Link from "next/link";
import type { ChampionRef } from "@/lib/types";
import type { PlayerRef } from "@/components/proHistory.types";
import { LANE_ORDER, LANE_LABEL, type LaneId } from "./heroContracts";
import type { SearchMode } from "./homeSearch";
import SidebarChampionSearch from "./SidebarChampionSearch";

interface SidebarProps {
  activeLane: LaneId;
  onLaneChange: (lane: LaneId) => void;
  /** v0.26.0 (issue 2): lanes are now LANE SELECTORS for the champion being
   *  viewed, not independent per-lane champion slots — every row shares this
   *  ONE current champion, not `laneChampions[lane]`. */
  champ: ChampionRef;
  onSearchSelect: (champ: ChampionRef) => void;
  /** v0.22.0: CHAMPIONS/PROS search-mode toggle, lifted to the page level
   *  (app/page.tsx) so both Sidebar renders (collapsed mobile bar, full
   *  desktop column — both always mounted, see the two call sites below)
   *  share one mode instead of drifting independently across a resize. */
  searchMode: SearchMode;
  onSearchModeChange: (mode: SearchMode) => void;
  onPlayerSelect: (player: PlayerRef) => void;
  /** e.g. "16.12" — shown in the footer once the first build response
   *  resolves; null renders "Patch —" rather than a guessed value. */
  patch: string | null;
  /** Renders the sidebar as a horizontal top bar instead of the fixed-width
   *  left column — used below the 1024px breakpoint (see app/page.tsx). */
  collapsed?: boolean;
}

export default function Sidebar({
  activeLane,
  onLaneChange,
  champ,
  onSearchSelect,
  searchMode,
  onSearchModeChange,
  onPlayerSelect,
  patch,
  collapsed = false,
}: SidebarProps) {
  return (
    <aside
      className={
        collapsed
          ? "lg:hidden w-full bg-sidebar border-b border-line px-4 py-4"
          : "hidden lg:flex lg:flex-col w-[220px] flex-shrink-0 bg-sidebar border-r border-line min-h-screen px-4 py-5"
      }
    >
      <div className={collapsed ? "flex items-center justify-between gap-4" : ""}>
        <h1
          className="font-display text-[19px] font-semibold tracking-[0.12em] text-teal uppercase select-none"
          style={{ textShadow: "0 0 18px rgba(200,170,110,0.25)" }}
        >
          Coachbuild
        </h1>

        {collapsed && (
          <div className="flex-1 max-w-[240px]">
            <SidebarChampionSearch
              mode={searchMode}
              onModeChange={onSearchModeChange}
              onSelectChampion={onSearchSelect}
              onSelectPlayer={onPlayerSelect}
            />
          </div>
        )}
      </div>

      {!collapsed && (
        <div className="mt-4">
          <SidebarChampionSearch
            mode={searchMode}
            onModeChange={onSearchModeChange}
            onSelectChampion={onSearchSelect}
            onSelectPlayer={onPlayerSelect}
          />
        </div>
      )}

      {/* v0.22.1 (user request): LANES is champion-oriented chrome — hide the
          whole section while the search is in PROS mode (both breakpoints).
          Switching back to CHAMPIONS restores it, and the CHAMPIONS tab remains
          the way out of a player view now that lane-tap-exit is hidden with it. */}
      {searchMode === "champions" && (
      <div className={collapsed ? "mt-3 -mx-4 px-4 overflow-x-auto" : "mt-6"}>
        <p className="text-[10px] tracking-[0.14em] uppercase text-mut font-semibold mb-2 px-0.5">
          Lanes
        </p>
        <nav
          aria-label="Lanes"
          className={collapsed ? "flex gap-2" : "flex flex-col gap-1"}
        >
          {LANE_ORDER.map((lane) => {
            const active = lane === activeLane;
            return (
              <button
                key={lane}
                type="button"
                onClick={() => onLaneChange(lane)}
                aria-pressed={active}
                aria-label={active ? `${LANE_LABEL[lane]} — ${champ.name} (current)` : `${champ.name} ${LANE_LABEL[lane]}`}
                className={`text-left rounded-lg transition-colors active:scale-[0.98] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-teal focus-visible:ring-offset-1 focus-visible:ring-offset-sidebar ${
                  collapsed ? "flex-shrink-0 min-w-[92px] px-3 py-2" : "px-3 py-2"
                } ${
                  active
                    ? "bg-panel2 border border-line-gold shadow-[0_2px_10px_rgba(0,0,0,0.35)]"
                    : "border border-transparent hover:bg-panel2/60"
                }`}
              >
                <div className={`text-[12.5px] font-medium ${active ? "text-txt" : "text-txt/85"}`}>
                  {LANE_LABEL[lane]}
                </div>
                {/* v0.26.0 (issue 2): lanes select a LANE for the current
                    champion, not a different champion per row — showing a
                    per-lane champion name here was the bug (implied Top
                    would jump to a different champion than Mid). Only the
                    ACTIVE row names the champion now, as a "you are viewing
                    X here" reminder; a non-breaking space on the other rows
                    keeps every row the same height (no layout jump on tap). */}
                <div className="text-[11px] text-mut truncate leading-tight mt-0.5">
                  {active ? champ.name : " "}
                </div>
              </button>
            );
          })}
        </nav>
      </div>
      )}

      {!collapsed && (
        <div className="mt-auto pt-6 space-y-1">
          <p className="text-[10.5px] text-mut tabular-nums">
            Patch {patch ?? "—"}
          </p>
          <p className="text-[10.5px] text-mut">
            WPA data &middot; coachless.gg
          </p>
          <Link
            href="/history"
            className="inline-block text-[10.5px] text-mut/80 hover:text-teal-dim transition-colors underline decoration-dotted underline-offset-2"
          >
            Pro players
          </Link>
        </div>
      )}

      {/* Mobile/collapsed: the desktop footer's "Pro players" link has no
          other home in the horizontal top-bar layout — /history must stay
          reachable below the 1024px breakpoint too, just folded into this
          one muted line instead of a multi-line footer block. */}
      {collapsed && (
        <div className="mt-2.5 flex items-center gap-2 text-[10.5px] text-mut">
          <span className="tabular-nums">Patch {patch ?? "—"}</span>
          <span aria-hidden="true">&middot;</span>
          <Link
            href="/history"
            className="text-mut/80 hover:text-teal-dim transition-colors underline decoration-dotted underline-offset-2"
          >
            Pro players
          </Link>
        </div>
      )}
    </aside>
  );
}
