"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import type { ChampionRef } from "@/lib/types";
import ChampionHero from "@/components/hextech/ChampionHero";
import type { HextechTab } from "@/components/hextech/HextechTabs";
import BuildTabContent from "@/components/hextech/BuildTabContent";
import ChampionPickPrompt from "@/components/hextech/ChampionPickPrompt";
import dynamic from "next/dynamic";
// Round-B P3 fix (companion CIM cost section, item 5c): code-split via
// next/dynamic — LivePanel only ever mounts for a session with a paired
// companion reporting phase===InProgress (see the render site below), so
// most page loads never need its JS at all. ssr:false is safe (and
// intentional): LivePanel is itself a "use client" component driven
// entirely by browser-only state (localStorage session/port, its own
// fetch/poll effects) with nothing to render server-side.
const LivePanel = dynamic(() => import("@/components/live/LivePanel"), { ssr: false });
import { parseLiveDeepLink, roleIdToLane } from "@/components/live/deepLink";
import { readLastChampion, writeLastChampion } from "@/lib/lastChampion";
import { resolveVisitSession, shouldPersistLastChampion } from "@/lib/lastChampionSession";
import { resolveCurrentChampSelectChampionId, resolveChampSelectRoleId } from "@/components/live/champSelectFollow";
import {
  markCompanionDriven,
  shouldFollowChampSelectChange,
  markFollowedChampSelectChampion,
} from "@/components/live/champSelectFollowState";
import { useCompanion } from "@/components/live/CompanionProvider";
import { useSheetBackNav } from "@/components/useSheetBackNav";
import {
  STATIC_FALLBACK_LANE_CHAMPIONS,
  getMostPlayedLane,
  type LaneId,
} from "@/components/hextech/heroContracts";
import { applyWireMainView, wireViewForChampion, defaultSourceForKind, type WireMainView } from "@/components/hextech/homeSearch";
import { subscribeChampionSearch } from "@/components/hextech/championSearchBus";
import { DEFAULT_RANK_BRACKET } from "@/lib/rankBrackets";
import { readStoredRankBracketId, writeStoredRankBracketId } from "@/components/hextech/rankBracketStorage";

const INITIAL_LANE: LaneId = "mid";

// v0.51.0 (D1, global-nav + Builds redesign): the BUILD/PRO BUILDS tab strip
// and the sidebar's PROS search mode are both retired from "/" — this page
// now renders ONE unified build view per champion+lane (mockups 4/5).
// Pro-play browsing lives on /history. `tab`/`source` below are no longer
// user-facing state (nothing ever changes them), but WireMainView's wire
// shape still carries them for the back-nav history entries (homeSearch.ts
// is engo's pure-module territory — kept as-is rather than reshaping its
// contract mid-wave) — fixed constants instead of live state.
const FIXED_TAB: HextechTab = "build";

export default function HomePage() {
  const [activeLane, setActiveLane] = useState<LaneId>(INITIAL_LANE);
  // v0.26.0 (issue 2): lanes are LANE SELECTORS for the champion being
  // viewed, not independent per-lane champion slots — one `champ` for the
  // whole page, not a Record<LaneId, ChampionRef>. Seeded with the mockup's
  // own Mid pick (Viktor, STATIC_FALLBACK_LANE_CHAMPIONS.mid — the same
  // fallback data lib/laneDefaults.ts/heroContracts.ts already share) so the
  // page pixel-matches the spec screenshot on first paint.
  const [champ, setChamp] = useState<ChampionRef>(STATIC_FALLBACK_LANE_CHAMPIONS[INITIAL_LANE]);

  // Open on the champion YOU last looked at, not on the mockup's Viktor.
  //
  // The seed above exists so SSR/first paint has something concrete; leaving it
  // as the landing state meant every session opened on a champion the user never
  // picked (user directive 2026-07-25: "stop showing viktor by default"). This
  // is not the app choosing — it restores the user's own most recent choice,
  // which is the best available predictor between games. Mount-only, so it never
  // fights a champ-select follow or a deep link that lands later.
  const [lastChampHydrated, setLastChampHydrated] = useState(false);
  // False until the user has an actual selection — a restored one, a search, a
  // deep link, or a champ-select follow. While false the page shows the pick
  // prompt instead of the Viktor seed. `champ` stays non-null throughout so no
  // downstream component has to learn a nullable contract.
  const [champChosen, setChampChosen] = useState(false);
  useEffect(() => {
    const session = resolveVisitSession(
      STATIC_FALLBACK_LANE_CHAMPIONS[INITIAL_LANE],
      INITIAL_LANE,
      readLastChampion()
    );
    if (session.chosen) {
      setChamp(session.champ);
      setActiveLane(session.lane);
      setChampChosen(true);
    }
    setLastChampHydrated(true);
  }, []);

  // Persist every settled selection (champion or lane) once hydration has run —
  // writing before that would immediately overwrite the stored value with the
  // Viktor seed on first paint.
  //
  // `champChosen` is the second half of that guard and is NOT optional (P0 fix,
  // 2026-07-26, reproduced on prod). Hydration completing does not mean the user
  // has a selection: when nothing is stored, this effect still runs with `champ`
  // sitting on the Viktor seed and `champChosen` false, so it persisted Viktor
  // on a brand-new device with no user action at all. The pick prompt rendered
  // correctly on that first visit and then never again — one reload later the
  // page opened on VIKTOR MID, which is exactly the behaviour user directive
  // 2026-07-25 ("stop showing viktor by default") removed. Nothing in the test
  // suite or a code-clean read catches it; it only shows up on a second visit.
  // Persist a selection the USER made, never the seed that stands in for one.
  //
  // The rule itself lives in lib/lastChampionSession.ts so it is covered by a
  // real two-visit regression test — see that module's header for why an
  // inline guard here was untestable and therefore able to regress silently.
  useEffect(() => {
    if (!shouldPersistLastChampion({ hydrated: lastChampHydrated, chosen: champChosen })) return;
    writeLastChampion(champ, activeLane);
  }, [champ, activeLane, lastChampHydrated, champChosen]);
  const [patch, setPatch] = useState<string | null>(null);

  // Feature 3 (rank brackets) — LIFTED from BuildTabContent (v0.51.0) so
  // ChampionHero's own elo pill row (mockup 4/5) can render/drive the SAME
  // selector BuildTabContent's fetch keys off — single source of truth,
  // ChampionHero and BuildTabContent are siblings under this page. Same
  // hydrate-after-mount + gate-the-first-fetch contract BuildTabContent used
  // to own directly (see rankHydrated's original doc comment, preserved
  // here): initialize to the default bracket (matches SSR), correct from
  // localStorage in a mount-only effect, and don't let BuildTabContent fire
  // its fetch before that correction lands.
  const [rankBracket, setRankBracket] = useState<string>(DEFAULT_RANK_BRACKET.id);
  const [rankHydrated, setRankHydrated] = useState(false);
  useEffect(() => {
    setRankBracket(readStoredRankBracketId());
    setRankHydrated(true);
  }, []);
  function handleRankChange(id: string) {
    setRankBracket(id);
    writeStoredRankBracketId(id);
  }

  // v0.26.0: invalidates an in-flight getMostPlayedLane() correction (see
  // handleChampionSelect) the moment ANY other lane/champion action happens
  // first — same request-id race-guard idiom SidebarChampionSearch's
  // PlayerSearchField already uses for its own debounced fetch, applied here
  // so a slow lookup for an OLD pick can never clobber a lane the user has
  // since chosen for themselves (manually, or by picking yet another
  // champion).
  const mostPlayedLaneRequestRef = useRef(0);

  // Back-gesture history integration for the home page (v0.23.0) — same
  // useSheetBackNav hook /history uses, instantiated with WireMainView
  // (homeSearch.ts) so main-view changes (a fresh champion pick, a lane tap)
  // each get their own back-stack entry. v0.51.0: the PROS/player-view and
  // BUILD/PRO-BUILDS-tab branches of the original wiring are gone (D1) —
  // every wire this page ever pushes/replaces is a "champion" kind now, tab
  // is always FIXED_TAB, and `source` is a constant (see homeSearch.ts's
  // WireMainView shape — kept unchanged, just fed fixed values here rather
  // than reshaping its contract mid-wave).
  const source = defaultSourceForKind("champion");
  const sheetNav = useSheetBackNav<WireMainView>({
    onApplySelection: restoreMainView,
    seedInitialSelection: () => ({
      view: { kind: "champion", champ, lane: activeLane },
      tab: FIXED_TAB,
      source,
    }),
  });

  // ── Live mode (v0.32.0; provider-lifted v0.37.0) ────────────────────────
  //
  // Companion pairing session/phase/champSelect now live in
  // CompanionProvider (app/layout.tsx) — THE single app-wide status poll
  // (plan §6c). This page only CONSUMES that context: its own mount effect
  // below still owns the deep-link-specific session override (a companion-
  // opened tab's `?session=` is page-navigation-specific, not something
  // every route needs to parse), and its own follow effect further down
  // still owns "given the current phase/champSelect, should THIS page
  // navigate to a different champion/lane" — see CompanionProvider.tsx's
  // header comment for the full split of responsibility.
  const companion = useCompanion();
  // Run-once guard for the deep-link mount effect (covers React 18 Strict
  // Mode's dev double-invoke) — separate from mostPlayedLaneRequestRef,
  // which guards a DIFFERENT race (a slow most-played-lane lookup).
  const deepLinkAppliedRef = useRef(false);

  useEffect(() => {
    // Mount-only effect reading window.location.search directly (NOT Next
    // router params / useSearchParams) — composing a second history-
    // mutation source with useSheetBackNav's raw pushState is a real risk,
    // and this only needs to run once at mount. Companion's champ-select
    // Start-Process opens `/?championId=&role=&session=` once a champion has
    // resolved, and — since companion 1.7.0 — a SESSION-ONLY `/?session=` on
    // champ-select entry (the pre-warm, before anyone has hovered anything).
    if (deepLinkAppliedRef.current) return;
    deepLinkAppliedRef.current = true;

    // Session adoption is deliberately SEPARATE from (and ahead of) the
    // deep-link parse: the pre-warm link has no championId, so parseLiveDeepLink
    // correctly rejects it as "not a champion deep link" — but the token on it
    // is exactly as real, and pairing is what makes this tab poll /status,
    // count as attached, and live-follow the first hover in place. Dropping it
    // here would leave the pre-warmed tab inert and get a SECOND tab opened at
    // the first pick, which is the tab-spam this whole area exists to avoid.
    const sessionParam = new URLSearchParams(window.location.search).get("session");
    if (sessionParam) companion.setSession(sessionParam);

    const parsed = parseLiveDeepLink(window.location.search);
    if (!parsed) return; // no champion to apply — default view stands, untouched

    fetch("/api/champions")
      .then((r) => (r.ok ? (r.json() as Promise<ChampionRef[]>) : []))
      .then((champs) => {
        const found = Array.isArray(champs) ? champs.find((c) => c.id === parsed.championId) : undefined;
        if (!found) return; // unresolvable champion id (coachless gap, bad id) — leave the default view alone
        // v1.3.0: this IS a genuine companion signal (a deep-link open),
        // not a fallback/default render — auto-export effects gate on this.
        markCompanionDriven(found.id);

        if (parsed.role !== undefined) {
          // Role-BEARING deep link (ranked/normal draft — champ-select
          // assigned a real lane) is authoritative about role/lane, never
          // to be second-guessed by the fire-and-forget most-played-lane
          // correction below.
          mostPlayedLaneRequestRef.current++;
          const lane = roleIdToLane(parsed.role);
          setChamp(found);
          setChampChosen(true);
          setActiveLane(lane);
          sheetNav.replaceSelection(wireViewForChampion(found, lane, FIXED_TAB, source));
          return;
        }

        // Role-LESS deep link (custom lobbies, blind pick, ARAM). No
        // authoritative lane here — land on the current lane first
        // (instant, non-flashing), then let the SAME most-played-lane
        // correction handleChampionSelect uses resolve and correct in
        // place.
        const landedLane = activeLane;
        setChamp(found);
        setChampChosen(true);
        setActiveLane(landedLane);
        sheetNav.replaceSelection(wireViewForChampion(found, landedLane, FIXED_TAB, source));

        const requestId = ++mostPlayedLaneRequestRef.current;
        getMostPlayedLane(found.id).then((bestLane) => {
          if (mostPlayedLaneRequestRef.current !== requestId) return; // superseded
          if (!bestLane || bestLane === landedLane) return; // unresolved, or already showing it
          setActiveLane(bestLane);
          sheetNav.replaceSelection(wireViewForChampion(found, bestLane, FIXED_TAB, source));
        });
      })
      .catch(() => {
        /* network hiccup — deep link silently no-ops, default view stands */
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Live-follow effect (v1.3.0 attached-tab behavior; provider-lifted
  // v0.37.0; Round-B P2 "follow-fights-user" fix) — "the tab follows the
  // user's champ-select hovers in place, UNLESS the user is manually
  // browsing something else." Re-keyed off `companion.tick` so it
  // re-evaluates on EVERY poll tick, not just when phase/champSelect happen
  // to change value.
  useEffect(() => {
    let cancelled = false;
    const resolvedChampionId = resolveCurrentChampSelectChampionId(companion.champSelect);
    if (companion.phase !== "ChampSelect" || resolvedChampionId === null) return;
    if (!shouldFollowChampSelectChange(resolvedChampionId)) return;
    markFollowedChampSelectChampion(resolvedChampionId);
    const target = { championId: resolvedChampionId, roleId: resolveChampSelectRoleId(companion.champSelect) };

    fetch("/api/champions")
      .then((r) => (r.ok ? (r.json() as Promise<ChampionRef[]>) : []))
      .then((champs) => {
        if (cancelled) return;
        const found = Array.isArray(champs) ? champs.find((c) => c.id === target.championId) : undefined;
        if (!found) return;
        markCompanionDriven(found.id);

        if (target.roleId !== undefined) {
          mostPlayedLaneRequestRef.current++;
          const lane = roleIdToLane(target.roleId);
          setChamp(found);
          setChampChosen(true);
          setActiveLane(lane);
          sheetNav.replaceSelection(wireViewForChampion(found, lane, FIXED_TAB, source));
          return;
        }

        const landedLane = activeLane;
        setChamp(found);
        setChampChosen(true);
        sheetNav.replaceSelection(wireViewForChampion(found, landedLane, FIXED_TAB, source));
        const requestId = ++mostPlayedLaneRequestRef.current;
        getMostPlayedLane(found.id).then((bestLane) => {
          if (mostPlayedLaneRequestRef.current !== requestId) return;
          if (!bestLane || bestLane === landedLane) return;
          setActiveLane(bestLane);
          sheetNav.replaceSelection(wireViewForChampion(found, bestLane, FIXED_TAB, source));
        });
      })
      .catch(() => {
        /* network hiccup — live-follow silently no-ops this tick, retries next poll */
      });
    return () => {
      cancelled = true;
    };
    // companion.tick MUST be a dependency — see the doc comment above;
    // activeLane must also stay (the role-less branch's landedLane fallback
    // reads it). champ.id is deliberately NOT a dependency — this effect
    // must NOT re-run just because the user manually browsed to a different
    // champion. sheetNav/the ref objects are stable across renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companion.tick, activeLane]);

  /** Repaints activeLane/champ from a landed-on entry — fired on mount-resume
   *  and every popstate. Delegates the actual wire->state mapping to
   *  homeSearch.ts's pure `applyWireMainView` and only owns the imperative
   *  setState calls here. */
  function restoreMainView(wire: WireMainView | null) {
    if (!wire) return;
    mostPlayedLaneRequestRef.current++;
    const applied = applyWireMainView(wire);
    if (applied.activeLane !== undefined && applied.champ !== undefined) {
      setActiveLane(applied.activeLane);
      setChamp(applied.champ);
      // NOT an unconditional "the user chose something". useSheetBackNav seeds
      // its initial selection from current state on mount and applies it right
      // back through here — with the Viktor seed still in `champ`. Marking
      // chosen there defeated the pick prompt entirely (caught in the browser:
      // fresh install still rendered VIKTOR). A genuine back-navigation TO a
      // Viktor view can only happen after a real pick, which has already set
      // this flag, so the id check costs nothing in that case.
      if (applied.champ.id !== STATIC_FALLBACK_LANE_CHAMPIONS[INITIAL_LANE].id) {
        setChampChosen(true);
      }
    }
  }

  const handleLaneChange = useCallback(
    (lane: LaneId) => {
      if (sheetNav.isRestoring()) return;
      mostPlayedLaneRequestRef.current++; // cancel any in-flight most-played-lane correction (see handleChampionSelect)
      setActiveLane(lane);
      // v0.26.0 (issue 2): a lane tap now stays on the SAME champion — it's
      // a LANE selector for whichever champion is already showing, not a
      // champion switch.
      sheetNav.pushSelection(wireViewForChampion(champ, lane, FIXED_TAB, source));
    },
    [champ, sheetNav, source]
  );

  const handleChampionSelect = useCallback(
    (selected: ChampionRef) => {
      if (sheetNav.isRestoring()) return;
      setChamp(selected);
      setChampChosen(true);
      // Land on the CURRENT lane first — an instant, non-flashing
      // transition, corrected below if a better lane resolves.
      const landedLane = activeLane;
      sheetNav.pushSelection(wireViewForChampion(selected, landedLane, FIXED_TAB, source));

      // v0.26.0 (issue 2): land a fresh champion pick on ITS most-played
      // lane, not whatever lane happened to be active before the pick.
      // Fire-and-forget: never blocks the pick. A manual lane tap or
      // another champion pick before this resolves wins outright
      // (request-id guard).
      const requestId = ++mostPlayedLaneRequestRef.current;
      getMostPlayedLane(selected.id).then((bestLane) => {
        if (mostPlayedLaneRequestRef.current !== requestId) return; // superseded
        if (!bestLane || bestLane === landedLane) return; // unresolved, or already showing it
        setActiveLane(bestLane);
        sheetNav.replaceSelection(wireViewForChampion(selected, bestLane, FIXED_TAB, source));
      });
    },
    [activeLane, sheetNav, source]
  );

  // v0.51.0 (global top bar): the TopBar's champion search lives OUTSIDE this
  // page (AppShell, every route) and communicates via a tiny pub/sub bus
  // (championSearchBus.ts, engo's pinned contract) rather than prop drilling
  // through AppShell/layout. Subscribing here is exactly equivalent to the
  // old BuildsSearchBar's onSearchSelect={handleChampionSelect} wiring — same
  // handler, same push-a-history-entry behavior — just decoupled from where
  // the input physically lives.
  useEffect(() => subscribeChampionSearch((ref) => handleChampionSelect(ref)), [handleChampionSelect]);

  return (
    <div className="px-4 sm:px-6 lg:px-8 py-6">
      {/* v0.44.0 (Builds responsive plan §3a/§2e): frees desktop width; adds a
          defensive overflow-x-clip against any future horizontal-overflow
          regression on THIS wrapper only.
          v0.50.0/v0.51.0 (global nav + top bar): search/lanes/tabs are all
          gone from this page's own body now — AppShell's TopBar owns
          champion search, ChampionHero owns lane + rank-bracket selection
          (mockup 4/5), and the BUILD/PRO BUILDS tab strip + PROS search mode
          are retired (D1) in favor of one unified build view. */}
      <div className="max-w-[900px] lg:max-w-none xl:max-w-[1440px] lg:mx-0 xl:mx-auto overflow-x-clip">
        {/* Nothing picked yet (fresh install / cleared storage) — prompt rather
            than assert a champion. Gated on lastChampHydrated so the restored
            selection isn't flashed past on the way in. */}
        {lastChampHydrated && !champChosen ? (
          <ChampionPickPrompt />
        ) : (
          <>
            <ChampionHero
              champ={champ}
              lane={activeLane}
              onLaneChange={handleLaneChange}
              rankBracket={rankBracket}
              onRankChange={handleRankChange}
            />

            <BuildTabContent
              champ={champ}
              lane={activeLane}
              rankBracket={rankBracket}
              rankHydrated={rankHydrated}
              onPatchResolved={setPatch}
            />
          </>
        )}
        {/* v0.32.0 (Live mode; provider-lifted v0.37.0): only mounted while
            the companion reports gameflow phase InProgress — owns its own
            1s live-client-data poll once mounted. Absent entirely
            otherwise, so this never reserves layout space or shows
            placeholder chrome for a feature most sessions won't use. */}
        {companion.phase === "InProgress" && <LivePanel champ={champ} lane={activeLane} />}

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
    </div>
  );
}
