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
