"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import type { ChampionRef } from "@/lib/types";
import type { PlayerRef } from "@/components/proHistory.types";
import type { ProGameSource } from "@/components/proGames.types";
import type { PendingPlayerSelect } from "@/components/playerSelectHandoff";
import BuildsSearchBar from "@/components/hextech/BuildsSearchBar";
import ChampionHero from "@/components/hextech/ChampionHero";
import PlayerHero from "@/components/hextech/PlayerHero";
import PlayerGamesSection from "@/components/hextech/PlayerGamesSection";
import HextechTabs, { type HextechTab } from "@/components/hextech/HextechTabs";
import BuildTabContent from "@/components/hextech/BuildTabContent";
import ProBuildsTab from "@/components/hextech/ProBuildsTab";
import ProsSearchPrompt from "@/components/hextech/ProsSearchPrompt";
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
import {
  deriveMainView,
  modeAfterLaneChange,
  modeAfterChampionSelect,
  modeAfterPlayerSelect,
  isProsSearchEmpty,
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

  // v0.29.2 (Fable review 2026-07-17, P3): handleChampionSelect's late
  // getMostPlayedLane() correction below needs the CURRENT tab/gamesSource
  // at the moment it resolves, not whichever were showing when the champion
  // was picked. A tab switch or games-filter change while the lookup is
  // in-flight doesn't bump mostPlayedLaneRequestRef above (by design — it
  // doesn't change WHICH champion/lane the correction targets, only how the
  // page is currently displayed), so the correction still fires — but it
  // used to build its sheetNav.replaceSelection(...) call from the
  // CAPTURED-at-pick-time `tab`/`source` closure consts instead of live
  // state. Live UI stayed correct (tab/gamesSource state itself was never
  // touched by this bug), but the history entry the correction wrote got
  // clobbered back to the stale pick-time tab/filter — a later back/forward
  // restore would land on the wrong tab. Mirrored into refs (updated every
  // render, read imperatively at replace time) rather than adding tab/
  // gamesSource to handleChampionSelect's own dependency list, since this is
  // a one-shot async correction reading a LATER value, not a re-derivable
  // render value.
  const tabRef = useRef(tab);
  tabRef.current = tab;
  const gamesSourceRef = useRef(gamesSource);
  gamesSourceRef.current = gamesSource;

  const mainView = deriveMainView(searchMode, champ, activeLane, selectedPlayer);
  // v0.44.3 (user-reported: "When searching for pro players, dont show the
  // champion page UI"): a pure RENDER gate, checked ahead of mainView.kind at
  // the composition site below. mainView/champ/activeLane are untouched by
  // this — a PROS-mode search with nothing picked yet still carries the
  // champion view's real state underneath (see deriveMainView's own doc
  // comment for why that's deliberate), it's just not what's painted. See
  // homeSearch.ts's isProsSearchEmpty doc comment for the full rationale.
  const showProsSearchPrompt = isProsSearchEmpty(searchMode, selectedPlayer);

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
  // header comment for the full split of responsibility, and its Round-B P1
  // note for why the driven-mark bookkeeping moved into the provider
  // WITHOUT changing when/how often it fires.
  const companion = useCompanion();
  // Run-once guard for the deep-link mount effect (covers React 18 Strict
  // Mode's dev double-invoke) — separate from mostPlayedLaneRequestRef,
  // which guards a DIFFERENT race (a slow most-played-lane lookup).
  const deepLinkAppliedRef = useRef(false);

  useEffect(() => {
    // Mount-only effect reading window.location.search directly (NOT Next
    // router params / useSearchParams) — same design note as sheetNav's own
    // "why not URL query params" comment above: composing a second
    // history-mutation source with useSheetBackNav's raw pushState is a real
    // risk, and this only needs to run once at mount, not track the URL
    // live. Companion's champ-select Start-Process always opens
    // `/?championId=&role=&session=` (plan §0/§2b).
    if (deepLinkAppliedRef.current) return;
    deepLinkAppliedRef.current = true;

    // Session hydration from localStorage (the non-deep-link "returning
    // user already paired" case) is now CompanionProvider's own mount
    // effect's job (app/layout.tsx wraps every route) — this effect only
    // needs to handle a FRESH `?session=` from a companion-opened deep link.
    const parsed = parseLiveDeepLink(window.location.search);
    if (!parsed) return; // not a live deep link — default view stands, untouched

    if (parsed.session) {
      companion.setSession(parsed.session);
    }

    fetch("/api/champions")
      .then((r) => (r.ok ? (r.json() as Promise<ChampionRef[]>) : []))
      .then((champs) => {
        const found = Array.isArray(champs) ? champs.find((c) => c.id === parsed.championId) : undefined;
        if (!found) return; // unresolvable champion id (coachless gap, bad id) — leave the default view alone
        // v1.3.0: this IS a genuine companion signal (a deep-link open),
        // not a fallback/default render — auto-export effects gate on this
        // (see champSelectFollowState.ts's isCompanionDrivenChampion doc
        // comment for the wrong-champion race this generalizes the fix for).
        markCompanionDriven(found.id);
        const source = defaultSourceForKind("champion");

        if (parsed.role !== undefined) {
          // Role-BEARING deep link (ranked/normal draft — champ-select
          // assigned a real lane) is authoritative about role/lane, never
          // to be second-guessed by the fire-and-forget most-played-lane
          // correction below.
          mostPlayedLaneRequestRef.current++;
          const lane = roleIdToLane(parsed.role);
          setChamp(found);
          setActiveLane(lane);
          setSearchMode("champions");
          setGamesSource(source);
          // Corrects the seeded initial entry in place — this IS the page's
          // true starting view (a champ-select-driven open), not a user
          // action stacking on top of the STATIC_FALLBACK seed.
          sheetNav.replaceSelection(wireViewForChampion(found, lane, tabRef.current, gamesSourceRef.current));
          return;
        }

        // Role-LESS deep link (companion.ps1 v1.2.0 — custom lobbies, blind
        // pick, ARAM: champ-select never assigned assignedPosition, but the
        // companion still opens rather than silently skipping as v1.1.0
        // did). No authoritative lane here — land on the current lane
        // first (instant, non-flashing, same as a manual champion pick),
        // then let the SAME most-played-lane correction handleChampionSelect
        // uses resolve and correct in place. Deliberately does NOT bump
        // mostPlayedLaneRequestRef beforehand — that guard exists to CANCEL
        // a correction, and this is the one deep-link case that actually
        // wants one to run.
        const landedLane = activeLane;
        setChamp(found);
        setActiveLane(landedLane);
        setSearchMode("champions");
        setGamesSource(source);
        sheetNav.replaceSelection(wireViewForChampion(found, landedLane, tabRef.current, gamesSourceRef.current));

        const requestId = ++mostPlayedLaneRequestRef.current;
        getMostPlayedLane(found.id).then((bestLane) => {
          if (mostPlayedLaneRequestRef.current !== requestId) return; // superseded
          if (!bestLane || bestLane === landedLane) return; // unresolved, or already showing it
          setActiveLane(bestLane);
          sheetNav.replaceSelection(wireViewForChampion(found, bestLane, tabRef.current, gamesSourceRef.current));
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
  // browsing something else." CompanionProvider now owns the actual /status
  // poll + the phase/champSelect state + the P1 driven-mark bookkeeping
  // (see its header comment); this effect ONLY decides "given the current
  // phase/champSelect, should THIS page navigate to a different
  // champion/lane" — re-keyed off `companion.tick` instead of its own
  // setInterval so it still re-evaluates on EVERY poll tick (not just when
  // phase/champSelect happen to change value) — see CompanionProvider.tsx's
  // `tick` field doc comment for why that preserves the pre-lift cadence.
  //
  // Round-B: this used to gate on resolveChampSelectFollow's own
  // "differs from champ.id (whatever's currently shown)" check — which
  // re-fired every tick once a manual browse diverged champ.id from an
  // UNCHANGED champ-select champion, snapping the view back and fighting
  // the user. Now gated on champSelectFollowState.ts's
  // shouldFollowChampSelectChange(resolvedId) instead: re-assert ONLY when
  // the champ-select champion ITSELF actually changes (a new hover/lock),
  // never merely because the shown champion no longer matches it. A manual
  // browse away now persists until the real champ-select pick changes.
  useEffect(() => {
    let cancelled = false;
    const resolvedChampionId = resolveCurrentChampSelectChampionId(companion.champSelect);
    if (companion.phase !== "ChampSelect" || resolvedChampionId === null) return;
    if (!shouldFollowChampSelectChange(resolvedChampionId)) return;
    // Mark synchronously (before the async lookup below resolves) — same
    // "mark at decision time, not at apply time" convention
    // shouldAutoExportForLane/markAutoExported use in BuildTabContent, so a
    // second poll tick landing before this fetch resolves doesn't re-fire.
    markFollowedChampSelectChampion(resolvedChampionId);
    const target = { championId: resolvedChampionId, roleId: resolveChampSelectRoleId(companion.champSelect) };

    fetch("/api/champions")
      .then((r) => (r.ok ? (r.json() as Promise<ChampionRef[]>) : []))
      .then((champs) => {
        if (cancelled) return;
        const found = Array.isArray(champs) ? champs.find((c) => c.id === target.championId) : undefined;
        if (!found) return;
        // Redundant with CompanionProvider's own P1 tick-level mark in the
        // common case (target.championId always equals the provider's
        // resolveCurrentChampSelectChampionId result) — kept anyway,
        // unchanged from the pre-lift code, since marking is idempotent and
        // this is the exact spot the original fix's own comment called out.
        markCompanionDriven(found.id);

        if (target.roleId !== undefined) {
          mostPlayedLaneRequestRef.current++;
          const lane = roleIdToLane(target.roleId);
          setChamp(found);
          setActiveLane(lane);
          sheetNav.replaceSelection(wireViewForChampion(found, lane, tabRef.current, gamesSourceRef.current));
          return;
        }

        // Role-less follow target (blank/unmapped position) — same
        // "land on current lane, then most-played-lane correction"
        // pattern as the role-less deep-link mount effect.
        const landedLane = activeLane;
        setChamp(found);
        sheetNav.replaceSelection(wireViewForChampion(found, landedLane, tabRef.current, gamesSourceRef.current));
        const requestId = ++mostPlayedLaneRequestRef.current;
        getMostPlayedLane(found.id).then((bestLane) => {
          if (mostPlayedLaneRequestRef.current !== requestId) return;
          if (!bestLane || bestLane === landedLane) return;
          setActiveLane(bestLane);
          sheetNav.replaceSelection(wireViewForChampion(found, bestLane, tabRef.current, gamesSourceRef.current));
        });
      })
      .catch(() => {
        /* network hiccup — live-follow silently no-ops this tick, retries next poll */
      });
    return () => {
      cancelled = true;
    };
    // companion.tick MUST be a dependency — it's what re-runs this effect on
    // every poll tick (see the doc comment above); activeLane must also
    // stay, for the exact same "closure would freeze on a stale lane" reason
    // the pre-lift effect's own comment documented (the role-less branch's
    // landedLane fallback reads it). champ.id is Round-B's whole point: the
    // decision to (re)act no longer depends on it at all, so it's
    // deliberately NOT a dependency here (unlike the pre-fix version) —
    // this effect must NOT re-run just because the user manually browsed to
    // a different champion. sheetNav/the ref objects are stable across
    // renders so they're intentionally omitted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companion.tick, activeLane]);

  /** Repaints searchMode/tab/activeLane+champ/selectedPlayer from a landed-on
   *  entry — fired on mount-resume and every popstate. Delegates the actual
   *  wire->state mapping to homeSearch.ts's pure `applyWireMainView` (unit-
   *  tested there) and only owns the imperative setState calls here. */
  function restoreMainView(wire: WireMainView | null) {
    if (!wire) return;
    // v0.27.2 (bugfix, same incident as BuildTabContent's load() race —
    // HANDOFF-fronty.md's v0.27.2 entry): every OTHER navigation handler
    // (lane tap, champion pick, player pick, sheet-tap jump) bumps this ref
    // to invalidate a pending getMostPlayedLane() correction, but a browser
    // back/forward restore never did — it's not one of those handlers, it's
    // driven by useSheetBackNav's popstate listener instead. A slow
    // most-played-lane lookup for a champion the user has since navigated
    // AWAY from (via back, before the lookup resolved) could still land:
    // its requestId was never superseded, so `setActiveLane(bestLane)` +
    // `replaceSelection(wireViewForChampion(selected, ...))` would fire for
    // the STALE champion against whatever view the user has since
    // restored to, corrupting its lane and its history entry. Bumping the
    // ref on every restore (mount-resume AND popstate alike — both route
    // through this function) closes that window the same way every other
    // navigation action already does.
    mostPlayedLaneRequestRef.current++;
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
        // Read CURRENT tab/gamesSource via the refs above, not the `tab`/
        // `source` closure captured back at pick time (see the refs' doc
        // comment) — a tab or filter change while this lookup was in flight
        // must not get overwritten in the history entry this replaces.
        sheetNav.replaceSelection(wireViewForChampion(selected, bestLane, tabRef.current, gamesSourceRef.current));
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
    <div className="px-4 sm:px-6 lg:px-8 py-6">
      {/* v0.44.0 (Builds responsive plan §3a/§2e): frees desktop width
          (the 900px cap wasted a real xl monitor's width) and adds a
          defensive overflow-x-clip against any future horizontal-overflow
          regression on THIS wrapper only — never the root or an ancestor
          of a fixed-position overlay (GameDetailSheet's backdrop is
          `fixed inset-0 z-[100]`, unaffected either way since this wrapper
          has no fixed descendants).
          v0.50.0 (global nav redesign): the old `min-h-screen lg:flex` +
          two <Sidebar> renders + <main> are gone — AppShell.tsx (app/
          layout.tsx) now owns that shell (branded rail + bottom tab bar);
          this page only owns its own content, starting with
          BuildsSearchBar at the top (same handlers the two Sidebar renders
          used — R2). */}
      <div className="max-w-[900px] lg:max-w-none xl:max-w-[1440px] lg:mx-0 xl:mx-auto overflow-x-clip">
        <BuildsSearchBar
          activeLane={activeLane}
          onLaneChange={handleLaneChange}
          champ={champ}
          onSearchSelect={handleChampionSelect}
          searchMode={searchMode}
          onSearchModeChange={setSearchMode}
          onPlayerSelect={handlePlayerSelect}
          patch={patch}
        />

        {showProsSearchPrompt ? (
            <ProsSearchPrompt onSelectPlayer={handlePlayerSelect} />
          ) : mainView.kind === "champion" ? (
            <>
              <ChampionHero champ={mainView.champ} lane={mainView.lane} />

              <div className="mt-6">
                <HextechTabs value={tab} onChange={handleTabChange} />
              </div>

              {tab === "build" ? (
                <>
                  <BuildTabContent champ={mainView.champ} lane={mainView.lane} onPatchResolved={setPatch} />
                  {/* v0.32.0 (Live mode; provider-lifted v0.37.0): only
                      mounted while the companion reports gameflow phase
                      InProgress (companion.phase, from CompanionProvider's
                      single app-wide poll) — owns its own 1s live-client-data
                      poll once mounted. Absent entirely otherwise, so this
                      never reserves layout space or shows placeholder chrome
                      for a feature most sessions won't use. */}
                  {companion.phase === "InProgress" && (
                    <LivePanel champ={mainView.champ} lane={mainView.lane} />
                  )}
                </>
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
      </div>
    );
}

