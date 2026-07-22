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
import type { PendingPlayerSelect } from "@/components/playerSelectHandoff";
import type { ProGameSource } from "@/components/proGames.types";
import type { LaneId } from "./heroContracts";
import type { HextechTab } from "./HextechTabs";

export type SearchMode = "champions" | "pros";

// ─────────────────────────────────────────────────────────────────────────────
// Player subject (v0.26.0) — a sheet-tap "view this player's games" can land
// on either a TRACKED pro (has a `pros` row, proId-addressable) or an
// UNTRACKED prostage-only player (Leaguepedia player_link only, no `pros`
// row) — the exact same split app/history/page.tsx's own PlayerSubject has
// handled since v0.20.0's Teams-box tap support. Before this version, the
// home shell's OWN game sheet (ProBuildsTab's/PlayerGamesSection's
// GameDetailSheet, reached via ProBuildRow) never wired GameDetailSheet's
// onSelectPlayer prop at all — every such tap fell through to its cross-page
// fallback (stash + router.push("/history")), which is the user-reported
// "escapes the Hextech shell" bug. Fixing it means the home page needs the
// same two-kind subject /history already has, not just the single
// always-fully-known PlayerRef the sidebar's PROS search flow provides.
// ─────────────────────────────────────────────────────────────────────────────

export interface TrackedPlayerSubject {
  kind: "tracked";
  id: string;
  name: string;
  team: string | null;
  /** Total tracked-game count, for the hero banner. Known immediately for a
   *  sidebar PROS search pick (the /api/players search response already
   *  carries it — see trackedSubjectFromPlayerRef) — null right after a
   *  Teams-box sheet-tap, where only id/name/team are known synchronously
   *  (see subjectFromPendingPlayerSelect). PlayerHero resolves it in the
   *  background via its own /api/players lookup keyed on id when null; never
   *  fabricated as 0 — a made-up "zero games" is a real, wrong claim, not a
   *  harmless placeholder. */
  gameCount: number | null;
}

export interface LinkPlayerSubject {
  kind: "link";
  playerLink: string;
  name: string;
}

export type PlayerSubject = TrackedPlayerSubject | LinkPlayerSubject;

/** Sidebar PROS search always returns a fully-resolved PlayerRef (real
 *  gameCount/team/etc — see app/api/players/route.ts) — wraps it as a
 *  "nothing left to resolve" tracked subject. */
export function trackedSubjectFromPlayerRef(ref: PlayerRef): TrackedPlayerSubject {
  return { kind: "tracked", id: ref.id, name: ref.name, team: ref.team, gameCount: ref.gameCount };
}

/** Converts a Teams-box-tap payload (PendingPlayerSelect — tracked
 *  {id,name,team} or link {playerLink,name}, distinguished structurally, see
 *  playerSelectHandoff.ts) into a PlayerSubject — mirrors
 *  app/history/page.tsx's own toPlayerSubject. gameCount is always null for
 *  a fresh tracked tap (not known synchronously — see TrackedPlayerSubject's
 *  doc comment); PlayerHero resolves it. */
export function subjectFromPendingPlayerSelect(pending: PendingPlayerSelect): PlayerSubject {
  if ("id" in pending) {
    return { kind: "tracked", id: pending.id, name: pending.name, team: pending.team, gameCount: null };
  }
  return { kind: "link", playerLink: pending.playerLink, name: pending.name };
}

/** v0.45.2: whether PlayerHero should render a favorite-star toggle for this
 *  subject — TRACKED pros only (has a real `pros`/id-addressable identity to
 *  key lib/favorites.ts off of), never a LINK-ONLY (untracked) subject. This
 *  mirrors the exact same policy app/history/page.tsx already enforces for
 *  its own player summary line ("Favorites are tracked-pros-only... a
 *  link-only player has nothing to star" — see that file's FavoriteStarButton
 *  call site) — kept as a pure, testable predicate here rather than an inline
 *  `subject.kind === "tracked"` check duplicated at the render site, so the
 *  v0.26.0 link-only-player policy can't silently drift between the two
 *  surfaces. */
export function canFavoritePlayerSubject(subject: PlayerSubject): subject is TrackedPlayerSubject {
  return subject.kind === "tracked";
}

/** Games-list source-filter default for a player subject. A link-only
 *  (untracked) player has no soloq identity at all (see app/api/pros/
 *  route.ts's `player=` lookup, prostage-only by construction), so Pro Play
 *  is its only real option; a tracked player keeps the v0.24.0 default
 *  ("all", see defaultSourceForKind's doc comment below). Prefer this over
 *  defaultSourceForKind("player") wherever the actual subject is in hand —
 *  the lock is derived from real data (has a playerLink?), not just the view
 *  kind string. */
export function defaultSourceForPlayer(subject: PlayerSubject): ProGameSource {
  return subject.kind === "link" ? "prostage" : "all";
}

/** Discriminated view of "what the main content area should render" —
 *  derived from the sidebar's search mode plus the current champion/lane
 *  pick and the last-selected pro player. PROS mode only actually swaps the
 *  main content once a player has been picked (the initial "just switched
 *  the toggle, haven't searched yet" state stays on the champion view — the
 *  toggle alone carries no content of its own to show). */
export type MainView =
  | { kind: "champion"; champ: ChampionRef; lane: LaneId }
  | { kind: "player"; subject: PlayerSubject };

export function deriveMainView(
  mode: SearchMode,
  champ: ChampionRef,
  lane: LaneId,
  selectedPlayer: PlayerSubject | null
): MainView {
  if (mode === "pros" && selectedPlayer) {
    return { kind: "player", subject: selectedPlayer };
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

/** v0.44.3: whether the main content area should render the dedicated
 *  "search for a pro player" prompt INSTEAD of whatever deriveMainView
 *  returns. Before this, deriveMainView's own PROS-mode-with-nothing-picked
 *  fallthrough (still correct as documented above — champ/lane state is
 *  genuinely untouched, and that's exactly what let the CHAMPIONS<->PROS
 *  toggle round-trip losslessly) meant the RENDER layer had nothing else to
 *  key off, so the full champion page (hero, tabs, rank bracket, runes,
 *  every card) kept painting underneath an empty PROS search — user-
 *  reported: "When searching for pro players, dont show the champion page
 *  UI." This is a pure RENDER gate, checked ahead of mainView.kind at the
 *  composition site (app/page.tsx) — it does not change what deriveMainView
 *  returns, what state the main view carries, or how wireViewForChampion/
 *  applyWireMainView/history restoration behave; toggling back to CHAMPIONS
 *  (or picking a player) still lands on the exact same preserved
 *  champion/lane or player view as before. */
export function isProsSearchEmpty(mode: SearchMode, selectedPlayer: PlayerSubject | null): boolean {
  return mode === "pros" && selectedPlayer === null;
}

// ─────────────────────────────────────────────────────────────────────────────
// v0.24.0: the All/Solo Queue/Pro Play source filter the pre-Hextech /history
// page had (ProGamesSection.tsx, still live there) but the Hextech shell
// dropped. Reuses that page's exact ProGameSource type + SOURCE_FILTER_OPTIONS
// + empty-state copy (components/proGames.types.ts) rather than forking a
// second copy — both surfaces filter the same /api/pros?source= param.
//
// Each MAIN VIEW KIND gets its own default, not one global default, because
// the two kinds mean structurally different things: ProBuildsTab's rows are
// ALWAYS one fixed champion, and the Hextech spec's PRO BUILDS mockup shows
// only prostage (league + date) rows — so "prostage" is the default that
// pixel-matches the spec on first load. PlayerGamesSection is browsing one
// PERSON's whole history across every champion, where solo queue is that
// person's bulk of tracked games — "all" is the useful default there (the
// same default the legacy /history page already used for both modes, kept
// here only for the player view since the champion view now has a
// spec-driven reason to differ).
// ─────────────────────────────────────────────────────────────────────────────

export function defaultSourceForKind(kind: MainView["kind"]): ProGameSource {
  return kind === "champion" ? "prostage" : "all";
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
  /** v0.24.0: the games-list source filter (All/Solo Queue/Pro Play) — sub-
   *  state of the current view, same "replace, don't push" policy as `tab`
   *  (see wireViewForChampion/wireViewForPlayer's callers in app/page.tsx:
   *  a filter change replaceSelection()s the current entry; only a genuine
   *  champion/player identity change pushes a new one, resetting this field
   *  to defaultSourceForKind's default for the new view's kind). */
  source: ProGameSource;
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
  /** Unlike activeLane/champ/selectedPlayer below (kind-conditional — only
   *  the branch matching wire.view.kind is present), gamesSource is always
   *  present: it's one page-level piece of state regardless of which view
   *  is showing, same posture as `tab`. */
  gamesSource: ProGameSource;
  activeLane?: LaneId;
  champ?: ChampionRef;
  selectedPlayer?: PlayerSubject;
}

export function applyWireMainView(wire: WireMainView): HomeRestoreState {
  if (wire.view.kind === "player") {
    // A link-only subject's source is ALWAYS forced back to Pro Play on
    // restore, regardless of what the wire's own `source` field says —
    // defensive against a stale/corrupted history entry (e.g. one written
    // before this lock existed, or hand-edited) ever landing a link-only
    // player view on a filter that can only ever show "no games" (see
    // defaultSourceForPlayer's doc comment).
    const gamesSource = wire.view.subject.kind === "link" ? "prostage" : wire.source;
    return { searchMode: "pros", tab: wire.tab, gamesSource, selectedPlayer: wire.view.subject };
  }
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

/** Builds the wire shape to push/replace for a player-view change (sidebar
 *  PROS search pick, or a Teams-box sheet-tap cross-player jump). */
export function wireViewForPlayer(subject: PlayerSubject, tab: HextechTab, source: ProGameSource): WireMainView {
  return { view: { kind: "player", subject }, tab, source };
}
