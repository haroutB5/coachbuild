"use client";

// Builds page search + lane row (v0.50.0, global-nav-plan.md Decision 2).
// Replaces both hextech Sidebar renders app/page.tsx used to mount (the
// collapsed mobile top-bar version AND the full desktop column) now that
// global nav (DesktopRail/MobileTabBar, AppShell.tsx) owns cross-route
// navigation — this component owns ONLY champion/pro search + lane
// selection, rendered once at the top of the page's own content, above
// ChampionHero/PlayerHero.
//
// Props are the SAME handlers both old Sidebar renders received
// (activeLane/onLaneChange/champ/onSearchSelect/searchMode/
// onSearchModeChange/onPlayerSelect/patch) — see app/page.tsx's call site.
// R2: no new history mutation happens here; every callback is wired straight
// through to app/page.tsx's existing handleLaneChange/handleChampionSelect/
// handlePlayerSelect, which already own sheetNav's push/replace calls.
import type { ChampionRef } from "@/lib/types";
import type { PlayerRef } from "@/components/proHistory.types";
import { LANE_ORDER, LANE_LABEL, type LaneId } from "./heroContracts";
import type { SearchMode } from "./homeSearch";
import SidebarChampionSearch from "./SidebarChampionSearch";

interface BuildsSearchBarProps {
  activeLane: LaneId;
  onLaneChange: (lane: LaneId) => void;
  /** v0.26.0: lanes are LANE SELECTORS for the champion being viewed — one
   *  shared current champion, not a per-lane slot. Same contract as the old
   *  Sidebar prop. */
  champ: ChampionRef;
  onSearchSelect: (champ: ChampionRef) => void;
  searchMode: SearchMode;
  onSearchModeChange: (mode: SearchMode) => void;
  onPlayerSelect: (player: PlayerRef) => void;
  /** e.g. "16.13" — null renders nothing (no guessed value). */
  patch: string | null;
}

export default function BuildsSearchBar({
  activeLane,
  onLaneChange,
  champ,
  onSearchSelect,
  searchMode,
  onSearchModeChange,
  onPlayerSelect,
  patch,
}: BuildsSearchBarProps) {
  return (
    <div className="mb-6 bg-sidebar border border-line rounded-xl px-4 py-4">
      <SidebarChampionSearch
        mode={searchMode}
        onModeChange={onSearchModeChange}
        onSelectChampion={onSearchSelect}
        onSelectPlayer={onPlayerSelect}
      />

      {/* Same v0.22.1 policy as the old Sidebar: LANES is champion-oriented
          chrome, hidden entirely while the search is in PROS mode. */}
      {searchMode === "champions" && (
        <div className="mt-4">
          <p className="text-[10px] tracking-[0.14em] uppercase text-mut font-semibold mb-2 px-0.5">Lanes</p>
          {/* Fixed 5-column grid (not overflow-x) — R3. Same layout the old
              collapsed-mobile Sidebar already proved fits at 390px; now used
              at every breakpoint since there's only one bar to render. */}
          <nav aria-label="Lanes" className="grid grid-cols-5 gap-1.5">
            {LANE_ORDER.map((lane) => {
              const active = lane === activeLane;
              return (
                <button
                  key={lane}
                  type="button"
                  onClick={() => onLaneChange(lane)}
                  aria-pressed={active}
                  aria-label={
                    active ? `${LANE_LABEL[lane]} — ${champ.name} (current)` : `${champ.name} ${LANE_LABEL[lane]}`
                  }
                  className={`flex flex-col items-center justify-center px-1 py-2 text-center rounded-lg transition-colors active:scale-[0.98] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-teal focus-visible:ring-offset-1 focus-visible:ring-offset-sidebar ${
                    active
                      ? "bg-panel2 border border-line-gold shadow-[0_2px_10px_rgba(0,0,0,0.35)]"
                      : "border border-transparent hover:bg-panel2/60"
                  }`}
                >
                  <div className={`font-medium whitespace-nowrap text-[11px] ${active ? "text-txt" : "text-txt/85"}`}>
                    {LANE_LABEL[lane]}
                  </div>
                </button>
              );
            })}
          </nav>
        </div>
      )}

      {patch && <p className="mt-3 text-[10.5px] text-mut tabular-nums">Patch {patch}</p>}
    </div>
  );
}
