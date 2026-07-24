// ─────────────────────────────────────────────────────────────────────────────
// Pure state-transition helpers for the home page's champion view (v0.22.0
// origin: the CHAMPIONS/PROS sidebar search toggle). Kept separate from
// app/page.tsx so lane-tap / champion-select / history-restore transitions
// are unit-testable without a DOM rendering harness (this repo has none —
// see vitest.config.ts, "no JSX rendering harness" in CLAUDE.md's Test
// conventions). app/page.tsx owns the actual useState calls; these functions
// only decide WHAT the next view/state should be.
//
// v0.51 Wave B cleanup (audited P3, 2026-07-24): the PROS sidebar-search /
// player-subject branch (SearchMode, PlayerSubject + its tracked/link
// variants, deriveMainView, modeAfterPlayerSelect, isProsSearchEmpty,
// canFavoritePlayerSubject, defaultSourceForPlayer, trackedSubjectFromPlayerRef,
// subjectFromPendingPlayerSelect, wireViewForPlayer) was removed as dead code
// — app/page.tsx's D1 rewrite (v0.51 Wave A) deleted the PROS search UI
// entirely (BuildsSearchBar/ProBuildsTab/PlayerHero/PlayerGamesSection/
// ProBuildRow are gone), and grep-confirmed no other file ever imported any
// of the above by name. `MainView`/`HomeRestoreState` narrowed accordingly
// (both only ever had a "champion" shape live); `WireMainView`/
// `wireViewForChampion`/`applyWireMainView`/`defaultSourceForKind` are
// unchanged in signature (still the live history-nav + games-filter-default
// surface app/page.tsx actually imports) with `applyWireMainView`'s body
// simplified to drop the now-unreachable player branch. `HomeRestoreState`
// keeps a `searchMode: "champions"` literal field (rather than removing it
// outright) purely so every surviving test's `toEqual` assertion needed zero
// extra edits beyond deleting the dead-branch test blocks — a genuinely
// mechanical P3, not a reason to churn passing tests.
// ─────────────────────────────────────────────────────────────────────────────

import type { ChampionRef } from "@/lib/types";
import type { ProGameSource } from "@/components/proGames.types";
import type { LaneId } from "./heroContracts";
import type { HextechTab } from "./HextechTabs";

/** The home page's main content area is champion-only now (see this file's
 *  header) — kept as a named type (rather than inlining into WireMainView)
 *  since it's the natural extension point if a second view kind ever comes
 *  back. */
export type MainView = { kind: "champion"; champ: ChampionRef; lane: LaneId };

/** Tapping a lane row in the sidebar always lands on that lane's champion —
 *  laneChampions/activeLane are separate page-level state, untouched by this
 *  function, so whatever champion was last active for the tapped lane is
 *  what reappears. Return type is a literal (not a removed `SearchMode`
 *  union) since "champions" is the only mode left. */
export function modeAfterLaneChange(): "champions" {
  return "champions";
}

/** Picking a champion from the sidebar search always lands in the champion
 *  view. */
export function modeAfterChampionSelect(): "champions" {
  return "champions";
}

// ─────────────────────────────────────────────────────────────────────────────
// v0.24.0: the All/Solo Queue/Pro Play source filter the pre-Hextech /history
// page had (ProGamesSection.tsx, still live there) but the Hextech shell
// dropped. Reuses that page's exact ProGameSource type + SOURCE_FILTER_OPTIONS
// + empty-state copy (components/proGames.types.ts) rather than forking a
// second copy — both surfaces filter the same /api/pros?source= param.
// ─────────────────────────────────────────────────────────────────────────────

export function defaultSourceForKind(kind: MainView["kind"]): ProGameSource {
  return kind === "champion" ? "prostage" : "all";
}

// ─────────────────────────────────────────────────────────────────────────────
// v0.23.0: back-gesture history integration for main-view changes (champion
// -> different champion, lane change). Extends the SAME useSheetBackNav<S>
// hook /history (v0.20.0) and the home page's own PRO BUILDS sheet (v0.21.1)
// already use. WireMainView wraps MainView (flat/plain-data — ChampionRef is
// a primitive-only shape, safe to hand straight to
// window.history.pushState/replaceState) plus `tab`: BUILD/PRO BUILDS is UI
// sub-state of an already-selected champion view, not a page of its own, so
// app/page.tsx's handleTabChange REPLACES the current entry's tab in place
// rather than pushing a new one.
//
// These functions are pure so the wire<->state mapping is unit-testable
// without a DOM harness (this repo has none, see CLAUDE.md's Test
// conventions) — app/page.tsx's popstate/mount-resume restore and its push/
// replace call sites are the only imperative glue left in the component.
// ─────────────────────────────────────────────────────────────────────────────

export interface WireMainView {
  view: MainView;
  tab: HextechTab;
  /** v0.24.0: the games-list source filter (All/Solo Queue/Pro Play) — sub-
   *  state of the current view, same "replace, don't push" policy as `tab`. */
  source: ProGameSource;
}

/** Fields app/page.tsx's restore needs to setState from a landed-on history
 *  entry. */
export interface HomeRestoreState {
  searchMode: "champions";
  tab: HextechTab;
  gamesSource: ProGameSource;
  activeLane?: LaneId;
  champ?: ChampionRef;
}

export function applyWireMainView(wire: WireMainView): HomeRestoreState {
  return {
    searchMode: "champions",
    tab: wire.tab,
    gamesSource: wire.source,
    activeLane: wire.view.lane,
    champ: wire.view.champ,
  };
}

/** Builds the wire shape to push/replace for a champion-view change (lane
 *  tap, search pick, or a tab switch replacing the current entry in place). */
export function wireViewForChampion(
  champ: ChampionRef,
  lane: LaneId,
  tab: HextechTab,
  source: ProGameSource
): WireMainView {
  return { view: { kind: "champion", champ, lane }, tab, source };
}
