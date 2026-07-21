"use client";

import Link from "next/link";
import type { ChampionRef } from "@/lib/types";
import type { PlayerRef } from "@/components/proHistory.types";
import { LANE_ORDER, LANE_LABEL, type LaneId } from "./heroContracts";
import type { SearchMode } from "./homeSearch";
import SidebarChampionSearch from "./SidebarChampionSearch";
import MobileNavMenu from "./MobileNavMenu";
import { NAV_LINKS } from "./navLinks";

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
      <div className={collapsed ? "flex items-center gap-3" : ""}>
        <h1
          className="flex-shrink-0 font-display text-[19px] font-semibold tracking-[0.12em] text-teal uppercase select-none"
          style={{ textShadow: "0 0 18px rgba(200,170,110,0.25)" }}
        >
          Coachbuild
        </h1>

        {collapsed && (
          <>
            <div className="flex-1 min-w-0">
              <SidebarChampionSearch
                mode={searchMode}
                onModeChange={onSearchModeChange}
                onSelectChampion={onSearchSelect}
                onSelectPlayer={onPlayerSelect}
              />
            </div>
            <MobileNavMenu patch={patch} />
          </>
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
      <div className={collapsed ? "mt-3" : "mt-6"}>
        <p className="text-[10px] tracking-[0.14em] uppercase text-mut font-semibold mb-2 px-0.5">
          Lanes
        </p>
        <nav
          aria-label="Lanes"
          /* v0.27.0 (user request): collapsed (mobile top-bar) lanes were
             overflow-x-auto with a 92px-min-width row, forcing ~492px of
             content into ~358px of available width at 390px, so Support
             scrolled off-screen. All 5 lanes are pure lane selectors
             (v0.26.0), not champion picks, so a fixed 5-column grid that
             actually fits the viewport beats a scroll strip nobody could
             tell was scrollable. Desktop keeps its vertical list untouched. */
          className={collapsed ? "grid grid-cols-5 gap-1.5" : "flex flex-col gap-1"}
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
                className={`rounded-lg transition-colors active:scale-[0.98] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-teal focus-visible:ring-offset-1 focus-visible:ring-offset-sidebar ${
                  collapsed
                    ? "flex flex-col items-center justify-center px-1 py-2 text-center"
                    : "text-left px-3 py-2"
                } ${
                  active
                    ? "bg-panel2 border border-line-gold shadow-[0_2px_10px_rgba(0,0,0,0.35)]"
                    : "border border-transparent hover:bg-panel2/60"
                }`}
              >
                <div
                  className={`font-medium whitespace-nowrap ${collapsed ? "text-[11px]" : "text-[12.5px]"} ${
                    active ? "text-txt" : "text-txt/85"
                  }`}
                >
                  {LANE_LABEL[lane]}
                </div>
                {/* v0.26.0 (issue 2): lanes select a LANE for the current
                    champion, not a different champion per row — showing a
                    per-lane champion name here was the bug (implied Top
                    would jump to a different champion than Mid). Only the
                    ACTIVE row names the champion now, as a "you are viewing
                    X here" reminder; a non-breaking space on the other rows
                    keeps every row the same height (no layout jump on tap).
                    v0.27.0: dropped entirely on the collapsed mobile bar -- it was
                    competing for the 5-column width budget in ~358px for a fact
                    ChampionHero already states one scroll below; desktop keeps it,
                    plenty of room there. */}
                {!collapsed && (
                  <div className="text-[11px] text-mut truncate leading-tight mt-0.5">
                  {active ? champ.name : " "}
                  </div>
                )}
              </button>
            );
          })}
        </nav>
      </div>
      )}

      {/* v0.44.0 (Builds responsive plan §3b/§4): desktop footer links now
          render from the shared NAV_LINKS registry (components/hextech/
          navLinks.ts) instead of 5 hardcoded <Link>s, so mobile's
          MobileNavMenu and this footer can never drift on which routes are
          reachable or their labels. */}
      {!collapsed && (
        <div className="mt-auto pt-6 space-y-1">
          <p className="text-[10.5px] text-mut tabular-nums">
            Patch {patch ?? "—"}
          </p>
          <p className="text-[10.5px] text-mut">
            WPA data &middot; coachless.gg
          </p>
          {/* flex column with gaps — inline-block links inside space-y-* run
              together on one line with no separators (caught in the v0.44.0
              acceptance screenshot: "Pro playersPatch moversCompanion"). */}
          <div className="flex flex-col gap-1 pt-1">
            {NAV_LINKS.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="self-start text-[10.5px] text-mut/80 hover:text-teal-dim transition-colors underline decoration-dotted underline-offset-2"
              >
                {link.label}
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* v0.44.0: the collapsed (mobile) dotted utility-links row moved into
          MobileNavMenu's "More" disclosure (rendered in the top-bar row 1
          above) — 5 equal-weight cross-route links no longer fight for width
          against Patch/lane chrome in ~358px, and each link is now a real
          ≥44px tap target instead of a dotted-underline inline run. */}
    </aside>
  );
}
