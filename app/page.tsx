"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import type { ChampionRef } from "@/lib/types";
import type { PlayerRef } from "@/components/proHistory.types";
import type { ProGameSource } from "@/components/proGames.types";
import Sidebar from "@/components/hextech/Sidebar";
import ChampionHero from "@/components/hextech/ChampionHero";
import PlayerHero from "@/components/hextech/PlayerHero";
import PlayerGamesSection from "@/components/hextech/PlayerGamesSection";
import HextechTabs, { type HextechTab } from "@/components/hextech/HextechTabs";
import BuildTabContent from "@/components/hextech/BuildTabContent";
import ProBuildsTab from "@/components/hextech/ProBuildsTab";
import { useSheetBackNav } from "@/components/useSheetBackNav";
import {
  LANE_ORDER,
  STATIC_FALLBACK_LANE_CHAMPIONS,
  getLaneDefaultChampions,
  type LaneId,
} from "@/components/hextech/heroContracts";
import {
  deriveMainView,
  modeAfterLaneChange,
  modeAfterChampionSelect,
  modeAfterPlayerSelect,
  defaultSourceForKind,
  applyWireMainView,
  wireViewForChampion,
  wireViewForPlayer,
  type SearchMode,
  type WireMainView,
} from "@/components/hextech/homeSearch";

const INITIAL_LANE: LaneId = "mid";

export default function HomePage() {
  const [activeLane, setActiveLane] = useState<LaneId>(INITIAL_LANE);
  // Seeded with the mockup's own picks (Darius/Lee Sin/Viktor/Jinx/Thresh) so
  // the page pixel-matches the spec screenshot on first paint — replaced by
  // the live-computed /api/lane-defaults result once it resolves (see the
  // effect below). engo's getLaneDefaults() genuinely computes "most played
  // per lane" from live data and may diverge from the mockup's picks for up
  // to 3 of 5 lanes (see components/hextech/heroContracts.ts's header note
  // and HANDOFF.md) — that's expected, not a bug.
  const [laneChampions, setLaneChampions] = useState<Record<LaneId, ChampionRef>>(
    STATIC_FALLBACK_LANE_CHAMPIONS
  );
  const [tab, setTab] = useState<HextechTab>("build");
  const [patch, setPatch] = useState<string | null>(null);

  // v0.22.0: CHAMPIONS/PROS sidebar search mode + the last-selected pro
  // player. Neither is cleared by toggling the other — champion selection
  // (laneChampions/activeLane above) is untouched by a PROS-mode excursion,
  // and selectedPlayer is likewise kept around so flipping back to PROS
  // without a fresh search re-shows the same player. See homeSearch.ts for
  // the derivation/transition logic (kept pure + unit-tested there).
  const [searchMode, setSearchMode] = useState<SearchMode>("champions");
  const [selectedPlayer, setSelectedPlayer] = useState<PlayerRef | null>(null);

  // v0.24.0: All/Solo Queue/Pro Play games-list filter — sub-state of
  // whichever main view is showing (ProBuildsTab or PlayerGamesSection), same
  // replace-not-push history policy as `tab` (see homeSearch.ts's WireMainView
  // doc comment). Starts at the champion view's default since the page always
  // mounts on a champion view.
  const [gamesSource, setGamesSource] = useState<ProGameSource>(defaultSourceForKind("champion"));

  // Tracks which lanes the user has since picked a champion for via search —
  // the live lane-defaults resolution (which can land well after mount, see
  // heroContracts.ts) must never clobber a manual pick that happened first.
  const overriddenLanesRef = useRef<Set<LaneId>>(new Set());

  // True once the user has done ANYTHING that changes the main view or tab
  // (lane tap, champion/player search pick, or a BUILD/PRO BUILDS switch —
  // set at the top of each real handler below, not on a restore replay).
  // Exists solely to guard the live-lane-defaults correction in the effect
  // below: while this stays false, activeLane is guaranteed still exactly
  // INITIAL_LANE, tab is guaranteed still "build", and no sheet can be open
  // (every path that opens one requires a tab switch or a player pick
  // first) — so the correction can safely target INITIAL_LANE/"build"
  // without needing a live ref-mirror of either.
  const hasInteractedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    getLaneDefaultChampions().then((resolved) => {
      if (cancelled || !resolved) return;
      setLaneChampions((prev) => {
        const next = { ...prev };
        for (const lane of LANE_ORDER) {
          if (!overriddenLanesRef.current.has(lane)) next[lane] = resolved[lane];
        }
        return next;
      });
      // v0.23.0: the seeded initial history entry (`sheetNav`, declared
      // below) captured the STATIC_FALLBACK champion for INITIAL_LANE
      // synchronously at mount, before this async sweep could possibly have
      // resolved. If the user hasn't touched the page since, keep that
      // entry's champion in sync with the just-resolved live pick too —
      // otherwise a "back past everything" press would restore a fallback
      // the user never actually saw (verified live to diverge for 3 of 5
      // lanes, see heroContracts.ts's header note), not what the page has
      // actually been showing the whole time.
      if (!cancelled && !hasInteractedRef.current && !overriddenLanesRef.current.has(INITIAL_LANE)) {
        sheetNav.replaceSelection(
          wireViewForChampion(resolved[INITIAL_LANE], INITIAL_LANE, "build", defaultSourceForKind("champion"))
        );
      }
    });
    return () => {
      cancelled = true;
    };
    // Mount-only: the live sweep is a one-shot resolution, not re-run per
    // lane switch (LANE_ORDER/getLaneDefaultChampions are both stable). See
    // the comment above for why closing over the mount-time `sheetNav` is
    // safe (its methods only ever touch stable refs/window.history, never
    // per-render state).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const champ = laneChampions[activeLane];
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
      const lane = applied.activeLane;
      const restoredChamp = applied.champ;
      setActiveLane(lane);
      setLaneChampions((prev) => ({ ...prev, [lane]: restoredChamp }));
    }
    if (applied.selectedPlayer !== undefined) {
      setSelectedPlayer(applied.selectedPlayer);
    }
  }

  const handleLaneChange = useCallback(
    (lane: LaneId) => {
      if (sheetNav.isRestoring()) return;
      setActiveLane(lane);
      setSearchMode(modeAfterLaneChange());
      // A lane tap is a champion-identity change (possibly a different
      // champion entirely) — reset the games filter to the champion view's
      // default rather than carrying over whatever the previous champion had
      // set (see homeSearch.ts's WireMainView doc comment).
      const source = defaultSourceForKind("champion");
      setGamesSource(source);
      sheetNav.pushSelection(wireViewForChampion(laneChampions[lane], lane, tab, source));
    },
    [laneChampions, tab, sheetNav]
  );

  const handleChampionSelect = useCallback(
    (selected: ChampionRef) => {
      if (sheetNav.isRestoring()) return;
      overriddenLanesRef.current.add(activeLane);
      setLaneChampions((prev) => ({ ...prev, [activeLane]: selected }));
      setSearchMode(modeAfterChampionSelect());
      // Identity change — reset the filter, same rationale as handleLaneChange.
      const source = defaultSourceForKind("champion");
      setGamesSource(source);
      sheetNav.pushSelection(wireViewForChampion(selected, activeLane, tab, source));
    },
    [activeLane, tab, sheetNav]
  );

  const handlePlayerSelect = useCallback(
    (player: PlayerRef) => {
      if (sheetNav.isRestoring()) return;
      setSelectedPlayer(player);
      setSearchMode(modeAfterPlayerSelect());
      // New player identity — reset to the player view's own default (All),
      // not whatever the champion view (or a previous player) had set.
      const source = defaultSourceForKind("player");
      setGamesSource(source);
      sheetNav.pushSelection(wireViewForPlayer(player, tab, source));
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
      setGamesSource(next);
      if (mainView.kind === "champion") {
        sheetNav.replaceSelection(wireViewForChampion(mainView.champ, mainView.lane, tab, next));
      } else {
        sheetNav.replaceSelection(wireViewForPlayer(mainView.player, tab, next));
      }
    },
    [sheetNav, mainView, tab]
  );

  return (
    <div className="min-h-screen lg:flex">
      <Sidebar
        activeLane={activeLane}
        onLaneChange={handleLaneChange}
        laneChampions={laneChampions}
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
        laneChampions={laneChampions}
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
                />
              )}
            </>
          ) : (
            <>
              <PlayerHero player={mainView.player} />
              <PlayerGamesSection
                player={mainView.player}
                source={gamesSource}
                onSourceChange={handleSourceChange}
                openGameId={sheetNav.openGameId}
                onOpenGame={(gameId) => sheetNav.openGame(gameId, { view: mainView, tab, source: gamesSource })}
                onDismissGame={sheetNav.dismissGame}
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
