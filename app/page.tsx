"use client";

import { useState, useCallback, useRef } from "react";
import type { ChampionRef } from "@/lib/types";
import type { PlayerRef } from "@/components/proHistory.types";
import type { ProGameSource } from "@/components/proGames.types";
import type { PendingPlayerSelect } from "@/components/playerSelectHandoff";
import Sidebar from "@/components/hextech/Sidebar";
import ChampionHero from "@/components/hextech/ChampionHero";
import PlayerHero from "@/components/hextech/PlayerHero";
import PlayerGamesSection from "@/components/hextech/PlayerGamesSection";
import HextechTabs, { type HextechTab } from "@/components/hextech/HextechTabs";
import BuildTabContent from "@/components/hextech/BuildTabContent";
import ProBuildsTab from "@/components/hextech/ProBuildsTab";
import { useSheetBackNav } from "@/components/useSheetBackNav";
import {
  STATIC_FALLBACK_LANE_CHAMPIONS,
  getMostPlayedLane,
  type LaneId,
} from "@/components/hextech/heroContracts";
import {
  deriveMainView,
  modeAfterLaneChange,
  modeAfterChampionSelect,
  modeAfterPlayerSelect,
  defaultSourceForKind,
  defaultSourceForPlayer,
  applyWireMainView,
  wireViewForChampion,
  wireViewForPlayer,
  trackedSubjectFromPlayerRef,
  subjectFromPendingPlayerSelect,
  type SearchMode,
  type WireMainView,
  type PlayerSubject,
} from "@/components/hextech/homeSearch";

const INITIAL_LANE: LaneId = "mid";

export default function HomePage() {
  const [activeLane, setActiveLane] = useState<LaneId>(INITIAL_LANE);
  // v0.26.0 (issue 2): lanes are LANE SELECTORS for the champion being
  // viewed, not independent per-lane champion slots — one `champ` for the
  // whole page, not a Record<LaneId, ChampionRef>. Seeded with the mockup's
  // own Mid pick (Viktor, STATIC_FALLBACK_LANE_CHAMPIONS.mid — the same
  // fallback data lib/laneDefaults.ts/heroContracts.ts already share) so the
  // page pixel-matches the spec screenshot on first paint.
  const [champ, setChamp] = useState<ChampionRef>(STATIC_FALLBACK_LANE_CHAMPIONS[INITIAL_LANE]);
  const [tab, setTab] = useState<HextechTab>("build");
  const [patch, setPatch] = useState<string | null>(null);

  // v0.22.0: CHAMPIONS/PROS sidebar search mode + the last-selected pro
  // player. Neither is cleared by toggling the other — champion selection
  // (champ/activeLane above) is untouched by a PROS-mode excursion, and
  // selectedPlayer is likewise kept around so flipping back to PROS without
  // a fresh search re-shows the same player. See homeSearch.ts for the
  // derivation/transition logic (kept pure + unit-tested there).
  const [searchMode, setSearchMode] = useState<SearchMode>("champions");
  const [selectedPlayer, setSelectedPlayer] = useState<PlayerSubject | null>(null);

  // v0.24.0: All/Solo Queue/Pro Play games-list filter — sub-state of
  // whichever main view is showing (ProBuildsTab or PlayerGamesSection), same
  // replace-not-push history policy as `tab` (see homeSearch.ts's WireMainView
  // doc comment). Starts at the champion view's default since the page always
  // mounts on a champion view.
  const [gamesSource, setGamesSource] = useState<ProGameSource>(defaultSourceForKind("champion"));

  // v0.26.0: invalidates an in-flight getMostPlayedLane() correction (see
  // handleChampionSelect) the moment ANY other lane/champion/player action
  // happens first — same request-id race-guard idiom
  // SidebarChampionSearch's PlayerSearchField already uses for its own
  // debounced fetch, applied here so a slow lookup for an OLD pick can never
  // clobber a lane the user has since chosen for themselves (manually, or by
  // picking yet another champion/player).
  const mostPlayedLaneRequestRef = useRef(0);

  const mainView = deriveMainView(searchMode, champ, activeLane, selectedPlayer);

  // Back-gesture history integration for the home page (v0.23.0) — same
  // useSheetBackNav hook /history uses (extracted from its original
  // pushState/popstate machinery in v0.21.1), now instantiated with a real
  // selection type (WireMainView, homeSearch.ts) instead of `null` so main-
  // view changes (champion <-> player, champion -> different champion, lane
  // tap) each get their own back-stack entry, not just the sheet. Lives at
  // this top-level page component (not inside ProBuildsTab or
  // PlayerGamesSection) so its popstate listener stays registered across a
  // BUILD<->PRO BUILDS tab switch AND a CHAMPIONS<->PROS mode switch — shared
  // by both since only one of ProBuildsTab/PlayerGamesSection is ever
  // mounted at a time (v0.22.0's PROS mode replaces the whole main-content
  // area, it doesn't add a third tab alongside BUILD/PRO BUILDS).
  //
  // Design note (deviating from a URL-query-param design): the obvious
  // alternative is making `c`/`lane`/`p` real Next router query params via
  // useSearchParams + router.push, for deep-linking + reload-preserves-view.
  // Not worth the risk here — it would mean composing TWO independent
  // history-mutation systems (Next's router-driven pushState + this hook's
  // raw window.history.pushState for the sheet), and the brief's own
  // watch-out ("verify the tab-switch-while-sheet-open ghost doesn't get
  // worse") is exactly the failure mode that composition invites: Next's App
  // Router also listens for popstate to resync its own route cache, and nothing
  // guarantees a raw pushState the router didn't originate lands cleanly
  // against it. /history already proves the WireSelection-over-useSheetBackNav
  // pattern works end to end (v0.20.0, gotcha (n) in CLAUDE.md) for exactly
  // this shape of problem (selection + a sheet nested on top) — reusing it
  // here is the minimal-risk move that still satisfies the actual ask
  // ("when I go back it should take me to the previous page I was in").
  // Consequence: no deep-linking / shareable player-view URLs, and a reload
  // on a fresh tab always lands on the default champion (same as today) —
  // but a same-tab reload DOES preserve the current view, since the hook's
  // mount effect resumes `history.state` for the CURRENT entry across a
  // same-tab refresh (see useSheetBackNav.ts).
  const sheetNav = useSheetBackNav<WireMainView>({
    onApplySelection: restoreMainView,
    // Captures the FIRST render's mainView/tab (STATIC_FALLBACK champ,
    // INITIAL_LANE, tab="build") — the hook only invokes this once, inside a
    // mount-only effect, so later renders' closures are never seen. This is
    // what lets backing all the way past every later selection correctly
    // land on the page's true starting view instead of a no-op (unlike
    // /history, whose mount default is "nothing selected" and so seeds
    // `null`).
    seedInitialSelection: () => ({ view: mainView, tab, source: gamesSource }),
  });

  /** Repaints searchMode/tab/activeLane+champ/selectedPlayer from a landed-on
   *  entry — fired on mount-resume and every popstate. Delegates the actual
   *  wire->state mapping to homeSearch.ts's pure `applyWireMainView` (unit-
   *  tested there) and only owns the imperative setState calls here. */
  function restoreMainView(wire: WireMainView | null) {
    if (!wire) return;
    const applied = applyWireMainView(wire);
    setSearchMode(applied.searchMode);
    setTab(applied.tab);
    setGamesSource(applied.gamesSource);
    if (applied.activeLane !== undefined && applied.champ !== undefined) {
      setActiveLane(applied.activeLane);
      setChamp(applied.champ);
    }
    if (applied.selectedPlayer !== undefined) {
      setSelectedPlayer(applied.selectedPlayer);
    }
  }

  const handleLaneChange = useCallback(
    (lane: LaneId) => {
      if (sheetNav.isRestoring()) return;
      mostPlayedLaneRequestRef.current++; // cancel any in-flight most-played-lane correction (see handleChampionSelect)
      setActiveLane(lane);
      setSearchMode(modeAfterLaneChange());
      // v0.26.0 (issue 2): a lane tap now stays on the SAME champion — it's
      // a LANE selector for whichever champion is already showing, not a
      // champion switch (the user-reported bug: viewing Ahri and tapping Top
      // must show Ahri Top, not switch to a different champion). BUILD/PRO
      // BUILDS refetch for (champ, new lane) via their own champ+lane-keyed
      // effects; nothing else to do here. Still resets the games filter to
      // the champion view's own default — a different lane can have a very
      // different pro-play sample size, same policy v0.24.0 already shipped
      // for this call site.
      const source = defaultSourceForKind("champion");
      setGamesSource(source);
      // Lane changes still get their own back-gesture step — unchanged by
      // issue 2 (see homeSearch.ts's WireMainView doc comment; the v0.23.0
      // policy was about "which page," and a lane is still its own step).
      sheetNav.pushSelection(wireViewForChampion(champ, lane, tab, source));
    },
    [champ, tab, sheetNav]
  );

  const handleChampionSelect = useCallback(
    (selected: ChampionRef) => {
      if (sheetNav.isRestoring()) return;
      setChamp(selected);
      setSearchMode(modeAfterChampionSelect());
      const source = defaultSourceForKind("champion");
      setGamesSource(source);
      // Land on the CURRENT lane first — an instant, non-flashing
      // transition, corrected below if a better lane resolves.
      const landedLane = activeLane;
      sheetNav.pushSelection(wireViewForChampion(selected, landedLane, tab, source));

      // v0.26.0 (issue 2): land a fresh champion pick on ITS most-played
      // lane, not whatever lane happened to be active before the pick
      // (searching Ahri while Support was showing should land on Ahri Mid,
      // not Ahri Support). Derived cheaply — see heroContracts.ts's
      // getMostPlayedLane doc comment for why this is a 5-call inversion of
      // lib/laneDefaults.ts's per-lane sweep rather than a new backend
      // endpoint. Fire-and-forget: never blocks the pick. If the lookup
      // resolves to something other than the lane just shown, correct the
      // SAME history entry in place (replaceSelection, not a second push) —
      // one user gesture (search a champion) should undo in one back-press,
      // not two, same rationale as the old mount-time lane-defaults
      // correction this replaces. A manual lane tap or another champion/
      // player pick before this resolves wins outright (request-id guard,
      // bumped at the top of every one of those handlers); resolving to null
      // (no data anywhere) or to the lane already showing is a no-op, per
      // the brief's own "keep the previous lane" fallback guidance.
      const requestId = ++mostPlayedLaneRequestRef.current;
      getMostPlayedLane(selected.id).then((bestLane) => {
        if (mostPlayedLaneRequestRef.current !== requestId) return; // superseded
        if (!bestLane || bestLane === landedLane) return; // unresolved, or already showing it
        setActiveLane(bestLane);
        sheetNav.replaceSelection(wireViewForChampion(selected, bestLane, tab, source));
      });
    },
    [activeLane, tab, sheetNav]
  );

  const handlePlayerSelect = useCallback(
    (player: PlayerRef) => {
      if (sheetNav.isRestoring()) return;
      mostPlayedLaneRequestRef.current++; // leaving champion view — cancel any pending lane correction
      const subject = trackedSubjectFromPlayerRef(player);
      setSelectedPlayer(subject);
      setSearchMode(modeAfterPlayerSelect());
      // New player identity — reset to the player view's own default (All
      // for a tracked pick — the sidebar PROS search never returns a
      // link-only result, see defaultSourceForPlayer), not whatever the
      // champion view (or a previous player) had set.
      const source = defaultSourceForPlayer(subject);
      setGamesSource(source);
      sheetNav.pushSelection(wireViewForPlayer(subject, tab, source));
    },
    [tab, sheetNav]
  );

  /** Teams-box "view this player's games" tap from INSIDE an open game sheet
   *  (ProBuildsTab's or PlayerGamesSection's GameDetailSheet, reached via
   *  ProBuildRow) — the v0.26.0 fix for issue 1 ("escapes the Hextech
   *  shell"). Before this version neither call site wired
   *  GameDetailSheet's onSelectPlayer prop at all, so every such tap fell
   *  through to its cross-page fallback (stash + router.push("/history")),
   *  landing on the legacy page's pill-tab layout instead of staying in the
   *  shell. Handles BOTH player kinds GameDetailSheet can hand back —
   *  tracked (has `id`) and link-only untracked (has `playerLink` only) —
   *  via the same structural discriminant app/history/page.tsx's own
   *  equivalent handler already uses (subjectFromPendingPlayerSelect,
   *  homeSearch.ts).
   *
   *  Back-navigation design decision: mirrors /history's OWN cross-player-
   *  jump policy exactly (app/history/page.tsx, v0.20.0) — GameDetailSheet
   *  already calls onClose() (a plain visual close, not a history pop)
   *  before invoking this, then this pushes a NEW selection entry on top
   *  rather than dismissing the sheet's own back-stack entry. Net effect:
   *  backing out of the new player's view lands back on the ORIGINAL view
   *  with its game sheet still open (restored from that untouched entry) —
   *  one more back then closes it. Chosen over "back lands on the view with
   *  the sheet already closed" because (a) it's the exact, already-shipped,
   *  already-tested behavior /history has for this same interaction — zero
   *  new back-nav branches to write or verify — and (b) it's arguably the
   *  more useful trail anyway: the game you were looking at when you jumped
   *  is one back-press away, not gone. */
  const handleSelectPlayerFromSheet = useCallback(
    (pending: PendingPlayerSelect) => {
      if (sheetNav.isRestoring()) return;
      mostPlayedLaneRequestRef.current++; // leaving champion view — cancel any pending lane correction
      const subject = subjectFromPendingPlayerSelect(pending);
      setSelectedPlayer(subject);
      setSearchMode(modeAfterPlayerSelect());
      const source = defaultSourceForPlayer(subject);
      setGamesSource(source);
      sheetNav.pushSelection(wireViewForPlayer(subject, tab, source));
    },
    [tab, sheetNav]
  );

  /** BUILD/PRO BUILDS is UI sub-state of an already-selected champion view,
   *  not a page of its own — replaces the current history entry's tab field
   *  in place instead of pushing a new one (see the design note above), so
   *  a back-press after switching tabs skips straight to the PREVIOUS
   *  champion/player, not back through each tab flip.
   *
   *  If a sheet is open when the tab changes, the tab content that owned it
   *  (ProBuildsTab or BuildTabContent) is about to unmount — dismiss the
   *  sheet for real (a genuine history.back()) instead of replacing over it,
   *  so its entry gets POPPED rather than silently orphaned (this was the
   *  HANDOFF-documented "tab-switch-while-sheet-open leaves an un-popped
   *  entry" gap; closed here as a byproduct of wiring tab into history).
   *  Trade-off: the resulting popstate restores tab to whatever the
   *  underlying selection entry held, which may not be `next` if that entry
   *  predates this tab switch — accepted, since a sheet-open entry should
   *  ALWAYS be consumed by a real back() (never silently replaced), and this
   *  is a rare compound action (switch tabs while a sheet is open) rather
   *  than the champion/player navigation this task is actually about. */
  const handleTabChange = useCallback(
    (next: HextechTab) => {
      if (sheetNav.openGameId !== null) {
        sheetNav.dismissGame();
        return;
      }
      setTab(next);
      sheetNav.replaceSelection(wireViewForChampion(champ, activeLane, next, gamesSource));
    },
    [sheetNav, champ, activeLane, gamesSource]
  );

  /** v0.24.0: the All/Solo Queue/Pro Play games-list filter — sub-state of
   *  the current view, same replace-not-push policy as handleTabChange above
   *  (and the same sheet-open trade-off: if a sheet is open, the filter
   *  click just closes it via a real back() first rather than changing the
   *  filter underneath an open sheet whose game might not survive the new
   *  filter — the user's next click applies the filter for real). */
  const handleSourceChange = useCallback(
    (next: ProGameSource) => {
      if (sheetNav.openGameId !== null) {
        sheetNav.dismissGame();
        return;
      }
      if (mainView.kind === "champion") {
        setGamesSource(next);
        sheetNav.replaceSelection(wireViewForChampion(mainView.champ, mainView.lane, tab, next));
        return;
      }
      // Player view: a link-only (untracked) subject has no soloq identity
      // at all — PlayerGamesSection renders a locked, explanatory label
      // instead of a live control for it (mirrors /history's own
      // ProHistoryResults treatment), so this branch is unreachable via a
      // real click for a link subject — clamp defensively anyway rather than
      // trusting the caller never fires it (see defaultSourceForPlayer).
      const clamped = mainView.subject.kind === "link" ? "prostage" : next;
      setGamesSource(clamped);
      sheetNav.replaceSelection(wireViewForPlayer(mainView.subject, tab, clamped));
    },
    [sheetNav, mainView, tab]
  );

  return (
    <div className="min-h-screen lg:flex">
      <Sidebar
        activeLane={activeLane}
        onLaneChange={handleLaneChange}
        champ={champ}
        onSearchSelect={handleChampionSelect}
        searchMode={searchMode}
        onSearchModeChange={setSearchMode}
        onPlayerSelect={handlePlayerSelect}
        patch={patch}
        collapsed
      />
      <Sidebar
        activeLane={activeLane}
        onLaneChange={handleLaneChange}
        champ={champ}
        onSearchSelect={handleChampionSelect}
        searchMode={searchMode}
        onSearchModeChange={setSearchMode}
        onPlayerSelect={handlePlayerSelect}
        patch={patch}
      />

      <main className="flex-1 min-w-0 px-4 sm:px-6 lg:px-8 py-6 pb-16">
        <div className="max-w-[900px] mx-auto">
          {mainView.kind === "champion" ? (
            <>
              <ChampionHero champ={mainView.champ} lane={mainView.lane} />

              <div className="mt-6">
                <HextechTabs value={tab} onChange={handleTabChange} />
              </div>

              {tab === "build" ? (
                <BuildTabContent champ={mainView.champ} lane={mainView.lane} onPatchResolved={setPatch} />
              ) : (
                <ProBuildsTab
                  champ={mainView.champ}
                  lane={mainView.lane}
                  source={gamesSource}
                  onSourceChange={handleSourceChange}
                  openGameId={sheetNav.openGameId}
                  onOpenGame={(gameId) => sheetNav.openGame(gameId, { view: mainView, tab, source: gamesSource })}
                  onDismissGame={sheetNav.dismissGame}
                  onSelectPlayer={handleSelectPlayerFromSheet}
                />
              )}
            </>
          ) : (
            <>
              <PlayerHero subject={mainView.subject} />
              <PlayerGamesSection
                subject={mainView.subject}
                source={gamesSource}
                onSourceChange={handleSourceChange}
                openGameId={sheetNav.openGameId}
                onOpenGame={(gameId) => sheetNav.openGame(gameId, { view: mainView, tab, source: gamesSource })}
                onDismissGame={sheetNav.dismissGame}
                onSelectPlayer={handleSelectPlayerFromSheet}
              />
            </>
          )}

          <footer className="mt-10 pt-4 border-t border-line text-center text-[11px] text-mut space-y-1">
            <p>Build data and icons © coachless.gg / Riot Games. For personal use.</p>
            <p>Not endorsed by Riot Games.</p>
            <p>
              Pro-play match data from{" "}
              <a
                href="https://lol.fandom.com"
                target="_blank"
                rel="noopener noreferrer"
                className="text-teal hover:underline"
              >
                Leaguepedia
              </a>{" "}
              (CC BY-SA).
            </p>
            {process.env.NEXT_PUBLIC_APP_VERSION && (
              <p className="text-mut">v{process.env.NEXT_PUBLIC_APP_VERSION}</p>
            )}
          </footer>
        </div>
      </main>
    </div>
  );
}
