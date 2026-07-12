// ─────────────────────────────────────────────────────────────────────────────
// Pure state-transition helpers for the home page's CHAMPIONS/PROS sidebar
// search toggle (v0.22.0). Kept separate from app/page.tsx so the mode-
// switch / player-select / lane-tap-exit transitions are unit-testable
// without a DOM rendering harness (this repo has none — see
// vitest.config.ts, "no JSX rendering harness" in CLAUDE.md's Test
// conventions). app/page.tsx owns the actual useState calls; these functions
// only decide WHAT the next mode/view should be.
// ─────────────────────────────────────────────────────────────────────────────

import type { ChampionRef } from "@/lib/types";
import type { PlayerRef } from "@/components/proHistory.types";
import type { LaneId } from "./heroContracts";
import type { HextechTab } from "./HextechTabs";

export type SearchMode = "champions" | "pros";

/** Discriminated view of "what the main content area should render" —
 *  derived from the sidebar's search mode plus the current champion/lane
 *  pick and the last-selected pro player. PROS mode only actually swaps the
 *  main content once a player has been picked (the initial "just switched
 *  the toggle, haven't searched yet" state stays on the champion view — the
 *  toggle alone carries no content of its own to show). */
export type MainView =
  | { kind: "champion"; champ: ChampionRef; lane: LaneId }
  | { kind: "player"; player: PlayerRef };

export function deriveMainView(
  mode: SearchMode,
  champ: ChampionRef,
  lane: LaneId,
  selectedPlayer: PlayerRef | null
): MainView {
  if (mode === "pros" && selectedPlayer) {
    return { kind: "player", player: selectedPlayer };
  }
  return { kind: "champion", champ, lane };
}

/** Tapping a lane row in the sidebar is inherently champion-oriented — it
 *  always exits PROS mode back to CHAMPIONS, landing on that lane's
 *  champion (laneChampions/activeLane are separate page-level state,
 *  untouched by this function, so whatever champion was last active for the
 *  tapped lane is what reappears — nothing here needs to "restore" it). */
export function modeAfterLaneChange(): SearchMode {
  return "champions";
}

/** Picking a champion from the sidebar search always lands in CHAMPIONS
 *  mode. Covers the defensive case of a champion pick firing while PROS mode
 *  was still active (not reachable through today's UI, since the champion
 *  search field only renders in CHAMPIONS mode — kept for robustness against
 *  a future call site). */
export function modeAfterChampionSelect(): SearchMode {
  return "champions";
}

/** Picking a player from the sidebar search always switches to PROS mode —
 *  combined with deriveMainView above, this is what actually swaps the main
 *  content to the player view. */
export function modeAfterPlayerSelect(): SearchMode {
  return "pros";
}

// ─────────────────────────────────────────────────────────────────────────────
// v0.23.0: back-gesture history integration for main-view changes (champion
// <-> player, champion -> different champion). Extends the SAME
// useSheetBackNav<S> hook /history (v0.20.0) and the home page's own
// PRO BUILDS sheet (v0.21.1) already use, but instantiated here with a real
// selection type instead of `null` — see app/page.tsx's `sheetNav` wiring.
//
// WireMainView wraps MainView (already flat/plain-data — ChampionRef and
// PlayerRef are both primitive-only shapes, safe to hand straight to
// window.history.pushState/replaceState) plus `tab`: BUILD/PRO BUILDS is UI
// sub-state of an already-selected champion view, not a page of its own, so
// app/page.tsx's handleTabChange REPLACES the current entry's tab in place
// rather than pushing a new one — "previous page" (the user's own words for
// this request) means champion/player identity, not which tab was open.
//
// These two functions are pure so the wire<->state mapping is unit-testable
// without a DOM harness (this repo has none, see CLAUDE.md's Test
// conventions) — app/page.tsx's popstate/mount-resume restore and its push/
// replace call sites are the only imperative glue left in the component.
// ─────────────────────────────────────────────────────────────────────────────

export interface WireMainView {
  view: MainView;
  tab: HextechTab;
}

/** Fields app/page.tsx's restore needs to setState from a landed-on history
 *  entry. `activeLane`/`champ` are only present for a champion-kind wire;
 *  `selectedPlayer` only for a player-kind one — deliberately omitted rather
 *  than nulled out on the other branch, mirroring deriveMainView's own
 *  "never cleared by toggling" contract (tested above): backing onto a
 *  champion view shouldn't blank out the last-selected player, since flipping
 *  the PROS toggle without a fresh search is expected to re-show them (same
 *  as today's live-navigation behavior). */
export interface HomeRestoreState {
  searchMode: SearchMode;
  tab: HextechTab;
  activeLane?: LaneId;
  champ?: ChampionRef;
  selectedPlayer?: PlayerRef;
}

export function applyWireMainView(wire: WireMainView): HomeRestoreState {
  if (wire.view.kind === "player") {
    return { searchMode: "pros", tab: wire.tab, selectedPlayer: wire.view.player };
  }
  return { searchMode: "champions", tab: wire.tab, activeLane: wire.view.lane, champ: wire.view.champ };
}

/** Builds the wire shape to push/replace for a champion-view change (lane
 *  tap, search pick, or a tab switch replacing the current entry in place). */
export function wireViewForChampion(champ: ChampionRef, lane: LaneId, tab: HextechTab): WireMainView {
  return { view: { kind: "champion", champ, lane }, tab };
}

/** Builds the wire shape to push for a player pick. */
export function wireViewForPlayer(player: PlayerRef, tab: HextechTab): WireMainView {
  return { view: { kind: "player", player }, tab };
}
