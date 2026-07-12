"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import type { ChampionRef } from "@/lib/types";
import type { PlayerRef } from "@/components/proHistory.types";
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
  type SearchMode,
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

  // Tracks which lanes the user has since picked a champion for via search —
  // the live lane-defaults resolution (which can land well after mount, see
  // heroContracts.ts) must never clobber a manual pick that happened first.
  const overriddenLanesRef = useRef<Set<LaneId>>(new Set());

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
    });
    return () => {
      cancelled = true;
    };
    // Mount-only: the live sweep is a one-shot resolution, not re-run per
    // lane switch (LANE_ORDER/getLaneDefaultChampions are both stable).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const champ = laneChampions[activeLane];
  const mainView = deriveMainView(searchMode, champ, activeLane, selectedPlayer);

  // Back-gesture history integration for the home page's game-detail
  // sheet — same useSheetBackNav hook /history uses (extracted from its
  // original pushState/popstate machinery in v0.21.1). No selection concept
  // here (S = null): opening a sheet just needs its own back-stack entry so
  // browser/iOS back-swipe closes it instead of navigating away from the
  // page. Lives at this top-level page component (not inside ProBuildsTab or
  // PlayerGamesSection) so its popstate listener stays registered across a
  // BUILD<->PRO BUILDS tab switch AND a CHAMPIONS<->PROS mode switch — shared
  // by both since only one of ProBuildsTab/PlayerGamesSection is ever
  // mounted at a time (v0.22.0's PROS mode replaces the whole main-content
  // area, it doesn't add a third tab alongside BUILD/PRO BUILDS).
  const sheetNav = useSheetBackNav<null>();

  const handleLaneChange = useCallback((lane: LaneId) => {
    setActiveLane(lane);
    setSearchMode(modeAfterLaneChange());
  }, []);

  const handleChampionSelect = useCallback(
    (selected: ChampionRef) => {
      overriddenLanesRef.current.add(activeLane);
      setLaneChampions((prev) => ({ ...prev, [activeLane]: selected }));
      setSearchMode(modeAfterChampionSelect());
    },
    [activeLane]
  );

  const handlePlayerSelect = useCallback((player: PlayerRef) => {
    setSelectedPlayer(player);
    setSearchMode(modeAfterPlayerSelect());
  }, []);

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
                <HextechTabs value={tab} onChange={setTab} />
              </div>

              {tab === "build" ? (
                <BuildTabContent champ={mainView.champ} lane={mainView.lane} onPatchResolved={setPatch} />
              ) : (
                <ProBuildsTab
                  champ={mainView.champ}
                  lane={mainView.lane}
                  openGameId={sheetNav.openGameId}
                  onOpenGame={(gameId) => sheetNav.openGame(gameId, null)}
                  onDismissGame={sheetNav.dismissGame}
                />
              )}
            </>
          ) : (
            <>
              <PlayerHero player={mainView.player} />
              <PlayerGamesSection
                player={mainView.player}
                openGameId={sheetNav.openGameId}
                onOpenGame={(gameId) => sheetNav.openGame(gameId, null)}
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
