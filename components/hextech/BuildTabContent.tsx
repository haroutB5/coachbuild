"use client";

import { useEffect, useState, useCallback } from "react";
import type { BuildResponse, ChampionRef } from "@/lib/types";
import type { LaneId } from "./heroContracts";
import { LANE_TO_ROLE_ID, LANE_LABEL } from "./heroContracts";
import RunesSummonersCard from "./RunesSummonersCard";
import ItemBuildCard from "./ItemBuildCard";
import ProConsensusCard from "./ProConsensusCard";
import FeaturedOtpCard from "./FeaturedOtpCard";
import SkillOrderCard from "./SkillOrderCard";
import HextechTabs from "./HextechTabs";
import {
  BUILD_TAB_OPTIONS,
  DEFAULT_BUILD_TAB,
  buildTabId,
  buildTabPanelId,
  type BuildTab,
} from "./buildTabLayout";
import { resolveAltKeystone, type AltKeystone } from "./altKeystone";
import { versionFromPatch } from "@/components/proAssets";
import ItemDetailPopover from "@/components/ItemDetailPopover";
import EntityDetailPopover, { type EntityKind } from "@/components/EntityDetailPopover";
import { useBodyScrollLock } from "@/components/useBodyScrollLock";
import { DEFAULT_RANK_BRACKET } from "@/lib/rankBrackets";

/** Which tap-for-detail popover is open — items share the "item" kind,
 *  runes/shards/summoner spells route through EntityDetailPopover's own
 *  EntityKind. Mirrors GameDetailSheet's activeDetail/lastDetail pattern:
 *  `lastDetail` is NOT cleared on close so the popover can play its own
 *  exit transition instead of being yanked from the tree mid-fade; `open`
 *  is driven by `activeDetail !== null`. This is overlay state only — never
 *  history-backed (v0.23.0 policy: popovers aren't a nav step). */
type DetailRef = { kind: "item" | EntityKind; id: number };

interface BuildTabContentProps {
  champ: ChampionRef;
  lane: LaneId;
  /** v0.51.0: rank-bracket selection LIFTED to app/page.tsx (ChampionHero's
   *  own elo pill row now drives it — see that component). This tab no
   *  longer owns the selector or its localStorage hydration; it just fetches
   *  keyed on whatever the page hands down. */
  rankBracket: string;
  /** Mirrors the page's own hydrate-after-mount gate (see app/page.tsx) so
   *  this tab doesn't fire a wasted/flashing fetch for the default bracket
   *  before a returning user's stored bracket is read. */
  rankHydrated: boolean;
  /** Fires once a build response resolves, so the sidebar footer can show
   *  the resolved data patch without a second fetch. */
  onPatchResolved?: (patch: string) => void;
}

type FetchState =
  | { status: "loading" }
  /** `build` is still `data[0]` and still the ONLY thing rendered as the
   *  recommendation — this feature did not change which setup is picked.
   *  `altKeystone` is the one fact salvaged from the rest of the array: the
   *  best withheld keystone worth telling the user about, or null (the common
   *  case). Resolved HERE, once per response, rather than in the card's render
   *  — the full BuildResponse[] is deliberately not held in state, so nothing
   *  downstream can start rendering a second variant's items/shards/secondary
   *  rows by reaching for it (see altKeystone.ts on why exposing a whole
   *  alternative page would surface lib/recommend.ts's `bestAboveFloor`
   *  fallback). */
  | { status: "ok"; build: BuildResponse; altKeystone: AltKeystone | null }
  | { status: "empty" }
  /** `network` = the request never completed (fetch threw) — the user's
   *  connection genuinely might be the problem. `upstream` = the request
   *  reached us and the SERVER failed, which in practice is almost always
   *  api.coachless.gg being down (observed returning 502 while its own
   *  website stayed up). Telling a user with a working connection to "check
   *  your connection" sends them to debug the one thing that is fine, so the
   *  two cases must not share a message. */
  | { status: "error"; reason: "network" | "upstream" };

function CardSkeleton({ className = "" }: { className?: string }) {
  return (
    <div className={`bg-panel border border-line rounded-xl p-5 animate-pulse ${className}`}>
      <div className="h-2.5 w-28 bg-panel2 rounded mb-4" />
      <div className="flex gap-3">
        <div className="w-12 h-12 rounded-full bg-panel2" />
        <div className="space-y-2 flex-1">
          <div className="h-3 w-24 bg-panel2 rounded" />
          <div className="h-2.5 w-12 bg-panel2 rounded" />
        </div>
      </div>
    </div>
  );
}

// v0.44.0 (Builds responsive plan §3c/§3d/§4): shared with the ok-branch's
// grid below — grid-template-areas keeps a SINGLE set of area names mapped
// to a genuinely different layout per breakpoint (single column below lg; a
// 7fr/5fr two-column composition at lg+).
//
// v0.51.0 (Builds redesign): Starting/Support/Core/Situational collapsed
// from four separate grid areas into ONE "itembuild" area (ItemBuildCard.tsx
// now owns their composition as labeled sub-sections inside a single bordered
// card, matching the mockup's merged "ITEM BUILD" card) — a real
// simplification over the previous per-card area map, not just a rename.
//
// v0.63.1 (desktop bottom-rag fix): at lg+, "runes" USED TO span both rows
// (`'runes_itembuild'_'runes_pro'`) so RUNES & SUMMONERS sat beside ITEM
// BUILD *and* PRO CONSENSUS combined. RunesSummonersCard's own content is
// short and roughly fixed-height (same rune/shard/summoner tile count on
// every champion — measured ~315px regardless of champ) while ITEM BUILD
// alone already runs 800-900px, so pairing RUNES against the itembuild+pro
// combined height (1400-2000px+) made the dead space under it hopeless to
// close honestly. Now PRO CONSENSUS spans the full row width below BOTH
// columns instead (`'pro_pro'`) — RUNES only has to match ITEM BUILD's
// height, which RunesSummonersCard's own `lg:h-full` + internal rhythm (see
// that file) closes the rest of the way. This is a genuine grid rebalance,
// not "pulling Pro Consensus up as filler" — it becomes its own full-width
// row, not squeezed into the runes column.
//
// v0.63.2 (column-proportion fix, measured on Brand support @ 1440x900):
// the column split stayed `7fr_5fr` (RUNES wider, 652px, ITEM BUILD
// narrower, 466px) even after v0.63.1 removed RUNES' row-span — backwards,
// since ITEM BUILD carries far more content (Starting/Support/Core/
// Situational, 800px+) than RunesSummonersCard's fixed ~315px. Measured
// BOTH orderings directly (not just reasoned about the box model): at
// `7fr_5fr` the row-1 height was 804px with ~490px of dead space under
// RUNES' content. Flipping to `5fr_7fr` (RUNES 466px, ITEM BUILD 652px)
// improved BOTH sides at once — RUNES' own content naturally wraps more at
// the narrower width, cutting its dead space to ~155px, AND ItemBuildCard
// renders MORE compactly with the extra width (fewer forced wraps in its
// item rows), dropping row-1 height 804px -> 674px. Not a tradeoff: the
// narrower column was never earning its width, and the wider one badly
// needed it.
// 2026-07-27 (recommended skill order feature) — new "skillorder" area added
// as its OWN full-width row between ITEM BUILD and PRO CONSENSUS, both in the
// mobile stack and at `lg`+. Deliberately NOT folded into the runes column:
// v0.63.2 just finished balancing RUNES' column height against ITEM BUILD's
// (see that changelog entry above) by matching RunesSummonersCard's fixed
// ~315px content against ItemBuildCard's ~650px+ — adding a second card to
// that column would reopen the exact height-matching problem that fix closed.
// A dedicated full-width row is simpler and keeps both existing columns
// untouched.
// 2026-07-29 (DESKTOP TABS) — `pro` and `otp` ARE NO LONGER IN THIS TEMPLATE.
// They used to be two more full-width rows below the two-column area, because
// desktop rendered all five sections as one page. Build/Pro/OTP are now the
// navigation at every width (user directive: "I dont want them all in a single
// long page"), so each tab owns its own panel and this grid describes the BUILD
// tab alone: RUNES beside ITEM BUILD, SKILL ORDER full-width beneath. That is
// byte-for-byte the composition desktop already showed for those three cards —
// the change is what no longer FOLLOWS them, not how they sit.
// 2026-07-29 (mobile tab void fix): below `lg` this is a FLEX COLUMN, not a
// grid, and the named-area template is scoped to `lg:` only.
//
// The bug it fixes: a `grid-template-areas` with five named rows declares five
// EXPLICIT rows, and `row-gap` applies between every adjacent pair of them
// whether or not anything occupies them. Below `lg` only one tab's area is
// visible (the other four wrappers are `hidden`, i.e. `display:none`, so they
// measure 0), but the four 20px gaps survived — so each tab opened with a void
// proportional to how far down the template its area sat. Measured on the
// production build at 390px, with `grid-template-rows` naming the culprit:
//
//   BUILD  rows 370.75 1233.38 307.25 0 0   ->  0px above, 40px dead BELOW
//   PRO    rows 0 0 0 1407.25 0             -> 60px above (3 gaps)
//   OTP    rows 0 0 0 0 977.14              -> 80px above (4 gaps)
//
// A flex column has no explicit tracks: a `display:none` child is not a flex
// item at all, so it contributes neither a line nor a gap, and the one visible
// panel sits flush. This is why the fix is a different FORMATTING CONTEXT
// rather than a negative margin — the row template now describes what is
// actually rendered at that breakpoint instead of being corrected after the
// fact.
//
// The children keep their unprefixed `[grid-area:*]` classes: those are
// grid-item properties and are inert on a flex item, and mobile DOM order
// (runes, itembuild, skillorder) already matches the old mobile template
// exactly, so nothing moves. At `lg`+ `lg:grid` restores the grid and the areas
// apply as before — the desktop composition is untouched.
//
// The void this comment describes cannot recur in the shape it took, because
// the three panels are SIBLINGS of this grid now rather than cells inside it:
// each tab's panel is its own element, and a hidden one is `display:none` on a
// `space-y` parent, which contributes no line and no gap. The row-template
// reasoning is kept anyway — it is still what governs THIS grid's own three
// cards, all of which are visible together on the BUILD tab at every width.
const BUILD_GRID_CLASS =
  "flex flex-col gap-5 lg:grid lg:grid-cols-[5fr_7fr] lg:gap-x-5 lg:gap-y-5 lg:[grid-template-areas:'runes_itembuild'_'skillorder_skillorder']";

// THE BUILD|PRO|OTP TAB SET NOW LIVES IN buildTabLayout.ts.
//
// It used to be declared here as `MobileBuildTab` / `MOBILE_TAB_OPTIONS`, and
// that name is a lie as of 2026-07-29: these are the Builds page's tabs at
// EVERY width, not a mobile-only control. The spec this file used to state —
// "desktop keeps the current single-scroll layout", with the strip `lg:hidden`
// and every panel escaping its gate through `lg:block` — was reversed by user
// directive: "redesign and add the tabs for WPA, Pro, OTP build pages on
// Desktop version just like in mobile. I dont want them all in a single long
// page."
//
// What has NOT changed is why the tabs exist at all: peak usage is a 30-second
// champ select, and the shape before them was one ~3,000px scroll (Runes ->
// Starting -> Support -> Core -> Optimized -> Situational -> Pro Consensus).
// A 1920px screen does not fix that; it just turns a long scroll into a long
// scroll with wider cards. Nor has the reason OTP is its own tab rather than
// sharing "pro" (see buildTabLayout.ts's own note).
//
// Switching tabs must stay INSTANT — see the panel wrappers below for how that
// is guaranteed (all three panels stay mounted; only `display` toggles, and no
// transition is attached to the swap).

/** Skeleton for ONE tab. Before this it drew all five cards at once regardless
 *  of which tab was showing — correct when desktop rendered all five, a
 *  guaranteed layout jump now that it renders one.
 *
 *  The grid-area classes are written out LITERALLY rather than interpolated
 *  from a card list. Tailwind's JIT scanner reads source text, so a
 *  `[grid-area:${id}]` template would only ever work by accident — via the same
 *  literal appearing somewhere else in the file — and would silently produce an
 *  unstyled skeleton the day that other call site moved. See buildTabLayout.ts
 *  for why no card-membership constant exists to map over. */
function BuildLoadingSkeleton({ tab }: { tab: BuildTab }) {
  // Pro and OTP are a single full-width card each — no grid to mirror.
  if (tab !== "build") return <CardSkeleton className="min-h-[280px]" />;
  return (
    <div className={BUILD_GRID_CLASS}>
      <CardSkeleton className="[grid-area:runes]" />
      <CardSkeleton className="[grid-area:itembuild] min-h-[280px]" />
      <CardSkeleton className="[grid-area:skillorder]" />
    </div>
  );
}

export default function BuildTabContent({ champ, lane, rankBracket, rankHydrated, onPatchResolved }: BuildTabContentProps) {
  const [state, setState] = useState<FetchState>({ status: "loading" });
  const [activeDetail, setActiveDetail] = useState<DetailRef | null>(null);
  const [lastDetail, setLastDetail] = useState<DetailRef | null>(null);
  // The BUILD|PRO|OTP split, at EVERY width as of 2026-07-29 (this was
  // `mobileTab` and was ignored at `lg`+). Exactly one panel is VISIBLE at a
  // time; all three stay MOUNTED (see the panel wrappers in the render below),
  // so switching tabs never re-triggers ProConsensusCard's /api/pros fetch or
  // FeaturedOtpCard's /api/otp/featured fetch, and never loses
  // RunesSummonersCard/ItemBuildCard/SkillOrderCard state.
  const [buildTab, setBuildTab] = useState<BuildTab>(DEFAULT_BUILD_TAB);

  function openDetail(kind: "item" | EntityKind, id: number) {
    setLastDetail({ kind, id });
    setActiveDetail({ kind, id });
  }
  function openItemPopover(id: number) {
    openDetail("item", id);
  }
  function closeDetail() {
    setActiveDetail(null);
  }

  // No enclosing sheet on this tab (unlike GameDetailSheet's popovers, which
  // sit over a page the sheet already scroll-locks) — lock body scroll
  // ourselves while a popover is mounted, iOS rubber-band-safe. Deliberately
  // NOT keyed on `lastDetail` (that flag is never cleared back to null once
  // a popover has ever been opened, by design — it just remembers which
  // kind/id to keep rendering through the exit fade) — a lock tied to it
  // would stay engaged for the rest of the tab's life after the FIRST tap.
  // Instead this mirrors DetailPopover's own internal rendered/visible
  // split: locked from open until its exit transition (150ms, matching
  // DetailPopover's EXIT_MS) finishes.
  const [popoverMounted, setPopoverMounted] = useState(false);
  useEffect(() => {
    if (activeDetail !== null) {
      setPopoverMounted(true);
      return;
    }
    const t = setTimeout(() => setPopoverMounted(false), 150);
    return () => clearTimeout(t);
  }, [activeDetail]);
  useBodyScrollLock(popoverMounted);

  // Escape closes the popover only — there's no enclosing modal here to
  // fall through to on a second press (contrast GameDetailSheet's two-stage
  // Escape handler).
  useEffect(() => {
    if (activeDetail === null) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") closeDetail();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [activeDetail]);

  // v0.27.2 (bugfix — see HANDOFF-fronty.md's v0.27.2 entry): this fetch had
  // NO stale-response guard, unlike ProConsensusCard's own effect below
  // (which has always had a `cancelled` flag). A champ/lane change fires a
  // brand-new fetch on every render without cancelling the PREVIOUS one, so
  // two in-flight `/api/build` requests can resolve OUT OF ORDER — e.g. a
  // fresh champion pick (cache MISS, slow) immediately followed by a browser
  // back-navigation to the champion just left (cache HIT, near-instant): the
  // HIT applies first (correct), then the MISS resolves LATER and silently
  // overwrites it with the WRONG (superseded) champion's entire build —
  // runes/summoners/items all swap under the still-correct header, since
  // ChampionHero/Sidebar read the separate, correctly-guarded `champ`/
  // `activeLane` page state, not this component's own `state.build`.
  // Reproduced live on prod (Slow 3G, Viktor -> Ahri search -> immediate
  // back): `/api/build?champ=103...` (Ahri, MISS) landed after
  // `/api/build?champ=112...` (Viktor, HIT, age 1439s) and clobbered the
  // page with Ahri's Electrocute/Ignite build under the "VIKTOR" header.
  // Fixed with the exact same `cancelled`-closure pattern ProConsensusCard
  // already uses — every setState is guarded so a superseded response is
  // inert no matter which order the two requests actually resolve in.
  const load = useCallback(
    async (c: ChampionRef, l: LaneId, rank: string, isCancelled: () => boolean) => {
      setState({ status: "loading" });
      try {
        const roleId = LANE_TO_ROLE_ID[l];
        // Feature 3: `rank` is only appended when non-default — keeps the
        // historical default request byte-identical to before this feature
        // (same CDN/Next fetch-cache key), per the engine handoff's contract
        // note ("the 'all' default MUST be first... byte-identical to the
        // app's historical default").
        const rankParam = rank && rank !== DEFAULT_RANK_BRACKET.id ? `&rank=${rank}` : "";
        const res = await fetch(`/api/build?champ=${c.id}&role=${roleId}${rankParam}`);
        if (isCancelled()) return;
        if (res.status === 404) {
          setState({ status: "empty" });
          return;
        }
        if (!res.ok) {
          // The request REACHED us and the server answered badly — not a
          // client-side connectivity problem. Do not blame the user's network.
          setState({ status: "error", reason: "upstream" });
          return;
        }
        const data: BuildResponse[] = await res.json();
        if (isCancelled()) return;
        if (!Array.isArray(data) || data.length === 0) {
          setState({ status: "empty" });
          return;
        }
        // Spec shows a single primary build, not the top-3 variant switcher
        // the legacy Builds page rendered — the #1 ranked setup only.
        //
        // 2026-07-29: variants 2 and 3 are no longer discarded WHOLESALE. The
        // engine's header states its contract — "Variants prefer different
        // primary trees" — and its entire design for "a genuinely different
        // keystone exists" is to put that keystone in a later variant. Dropping
        // the array here deleted that escape hatch while the engine kept
        // relying on it, which is why 16.6% of populated champion/role pairs
        // displayed a negative-WPA keystone with a positive, adoption-cleared
        // one unrendered. One fact is now salvaged from the tail — the
        // keystone, its WPA, its sample and its tree — and nothing else: the
        // pick, the ranking and every other slot on the card are untouched.
        setState({ status: "ok", build: data[0], altKeystone: resolveAltKeystone(data) });
        onPatchResolved?.(data[0].patch);
      } catch {
        // fetch() itself threw, so the request never completed — this is the
        // only case where the user's connection is a plausible cause.
        if (!isCancelled()) setState({ status: "error", reason: "network" });
      }
    },
    [onPatchResolved]
  );

  useEffect(() => {
    // Wait for the mount-only localStorage read above (see rankHydrated's
    // own doc comment) — avoids a wasted/flashing fetch for the default
    // bracket when a returning user actually has a different one stored.
    if (!rankHydrated) return;
    let cancelled = false;
    load(champ, lane, rankBracket, () => cancelled);
    return () => {
      cancelled = true;
    };
  }, [champ, lane, rankBracket, rankHydrated, load]);

  // NOTE (v0.41.0): champ-select AUTO-EXPORT was LIFTED OUT of this component
  // to the app-wide companion layer (components/live/AutoExporter.tsx, mounted
  // in app/layout.tsx). It used to live here, but this tab only mounts on the
  // Builds page ("/", tab === "build"); since companion 1.5.0 the user drafts
  // from /draft (which suppresses opening the Builds page), so the exporter
  // anchored here never ran. AutoExporter fetches the picked champion's build
  // itself off the app-wide /status poll and pushes through the SAME apply
  // pipelines + the SAME champSelectFollowState dedup — exactly one owner, so
  // an open Builds page can no longer double-push. The MANUAL Apply buttons
  // (RunesSummonersCard's own click handlers) are untouched and still live.

  if (state.status === "loading") {
    // The tab strip renders DURING loading now. It used to appear only once the
    // build resolved, so the whole page below it jumped down by the strip's
    // height (44px + border) on every champion change — a self-inflicted layout
    // shift on the app's hottest path. It also means a user who lands mid-fetch
    // can already choose the tab they want.
    return (
      <div className="mt-5 space-y-5">
        <HextechTabs
          options={BUILD_TAB_OPTIONS}
          value={buildTab}
          onChange={setBuildTab}
          ariaLabel="Build view"
          className="mb-1"
        />
        <BuildLoadingSkeleton tab={buildTab} />
      </div>
    );
  }

  if (state.status === "empty") {
    return (
      <div className="mt-5 space-y-5">
        <div className="bg-panel border border-line rounded-xl p-10 text-center">
          <div className="text-txt font-semibold mb-1">
            Not enough data for {champ.name} {LANE_LABEL[lane]}
          </div>
          <div className="text-mut text-sm">
            Try a different lane or rank bracket, or check{" "}
            <a
              href="https://coachless.gg"
              target="_blank"
              rel="noopener noreferrer"
              className="text-teal hover:underline"
            >
              coachless.gg
            </a>{" "}
            directly.
          </div>
        </div>
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div className="mt-5 space-y-5">
        <div className="bg-panel border border-line rounded-xl p-10 text-center">
          <div className="text-txt font-semibold mb-1">
            {state.reason === "upstream" ? "Build data is unavailable right now" : "Couldn't load — try again"}
          </div>
          <div className="text-mut text-sm">
            {state.reason === "upstream" ? (
              <>
                The stats source this app reads ({champ.name} {LANE_LABEL[lane]}) isn&apos;t responding.
                That&apos;s upstream of CoachBuild, so refreshing may not help until it recovers.
              </>
            ) : (
              <>
                Couldn&apos;t reach CoachBuild while fetching {champ.name} {LANE_LABEL[lane]}. Check your
                connection and refresh.
              </>
            )}
          </div>
        </div>
      </div>
    );
  }

  const { build, altKeystone } = state;
  const ver = versionFromPatch(build.patch);

  return (
    <div className="mt-5 space-y-5">
      {/* THE NAVIGATION, AT EVERY WIDTH (2026-07-29). This wrapper used to be
          `lg:hidden`; the panels below used to escape their own gate through
          `lg:block`, so at `lg`+ everything rendered at once. Both are gone.
          Real tab semantics (role=tablist/tab/aria-selected, roving tabindex,
          Left/Right/Home/End) come from HextechTabs — see that file's header
          for the keyboard contract this change made load-bearing. */}
      <HextechTabs
        options={BUILD_TAB_OPTIONS}
        value={buildTab}
        onChange={setBuildTab}
        ariaLabel="Build view"
        className="mb-1"
      />

      {/* ── ONE PANEL PER TAB ────────────────────────────────────────────────
          Previously each of the FIVE cards carried its own `role="tabpanel"`,
          three of them pointing at the same `hextech-tab-build` with only one
          of the three owning the `hextech-tabpanel-build` id the tab's
          `aria-controls` names. That was three panels for one tab and two
          unreachable ids, and it survived review because at `lg` the tablist
          was removed from the a11y tree, so the whole relationship was inert
          exactly where it was wrong. Making the tablist live at every width
          killed that premise, so the structure is now what it always claimed
          to be: exactly one tabpanel per tab, each with the id its own tab
          points at, each labelled by that tab.

          `tabIndex={0}` on every panel is the ARIA Tabs pattern's own
          recommendation — it gives the keyboard user a stop on the panel
          itself, which is where Tab lands after the roving tablist.

          VISIBILITY IS `hidden` (display:none) AND NOTHING ELSE. No opacity
          transition, no height animation, no unmount. Peak usage is a
          30-second champ select: a tab switch has to be a repaint, not an
          animation, and a transition here would delay content on the app's
          hottest path. It also means the inactive panels' cards stay MOUNTED —
          switching Build -> Pro -> Build re-fires nothing and loses no state —
          while being correctly removed from the tab order and the a11y tree.
          `prefers-reduced-motion` needs no handling here because there is no
          motion to reduce. */}
      <div
        role="tabpanel"
        id={buildTabPanelId("build")}
        aria-labelledby={buildTabId("build")}
        tabIndex={0}
        className={buildTab === "build" ? "" : "hidden"}
      >
        <div className={BUILD_GRID_CLASS}>
          <div className="[grid-area:runes]">
            <RunesSummonersCard
              runes={build.runes}
              spells={build.spells}
              onOpenDetail={openDetail}
              championName={build.champion.name}
              roleLabel={build.roleLabel}
              build={build}
              lane={lane}
              altKeystone={altKeystone}
            />
          </div>
          <div className="[grid-area:itembuild]">
            <ItemBuildCard champ={champ} lane={lane} build={build} ver={ver} onItemClick={openItemPopover} />
          </div>
          {/* 2026-07-27 (recommended skill order feature) — a RECOMMENDATION
              card (max-priority string + per-ability path), grouped with
              RunesSummonersCard/ItemBuildCard under the "Build" tab rather than
              "Pro": like ItemBuildCard, it's a build recommendation this page
              produces, not a community/pro-play data view the way
              ProConsensusCard is. Own fetch/loading/hidden states
              (components/hextech/SkillOrderCard.tsx) — a null API payload
              renders no card, collapsing this grid cell to zero height. */}
          <div className="[grid-area:skillorder]">
            <SkillOrderCard champ={champ} lane={lane} />
          </div>
        </div>
      </div>

      {/* PRO — ProConsensusCard alone, no outer grid, deliberately.
          This card already spanned the full content width before the tabs
          change (it was the `'pro pro'` row) and already carries its own
          measured desktop composition: `lg:grid-cols-[5fr_7fr]` splitting its
          rune page from its Starting+Items column, with the proportions
          arrived at by measuring three splits live on Viktor mid at 1440x900
          (see that file). Owning the tab does not make it wider than it
          already was, so wrapping it in a second grid would add a container
          that changes nothing. The composition work for this change went into
          FeaturedOtpCard instead, which genuinely had none. */}
      <div
        role="tabpanel"
        id={buildTabPanelId("pro")}
        aria-labelledby={buildTabId("pro")}
        tabIndex={0}
        className={buildTab === "pro" ? "" : "hidden"}
      >
        {/* v0.27.0 (user request: "pro players seem to build Rocketbelt on
            Viktor — create another builds and runes space based on what pro
            players are often building"). A plain pick-rate count over the
            champion-scoped pro-games feed — own fetch, own loading/hidden
            states, refetches on champ/lane change. Reuses this tab's popover
            plumbing (openDetail) rather than standing up a second instance. */}
        <ProConsensusCard champ={champ} lane={lane} ver={ver} onOpenDetail={openDetail} build={build} />
      </div>

      {/* OTP — FeaturedOtpCard alone, same reasoning as PRO above: it was
          already the full-width `'otp otp'` row. Its BODY is where this
          change's desktop composition work landed — see that file's
          "DESKTOP COMPOSITION" note. */}
      <div
        role="tabpanel"
        id={buildTabPanelId("otp")}
        aria-labelledby={buildTabId("otp")}
        tabIndex={0}
        className={buildTab === "otp" ? "" : "hidden"}
      >
        <FeaturedOtpCard champ={champ} ver={ver} lane={lane} build={build} />
      </div>

      {/* Always mounted (once any item/rune/shard/spell has ever been
          opened) so its own rendered/visible exit transition — DetailPopover's
          own decoupled pattern — gets to play out on close instead of being
          yanked from the tree mid-fade. `lastDetail` intentionally persists
          across close; only `activeDetail` toggles the `open` prop. Overlay
          state only — never pushed to any nav/history mechanism. */}
      {lastDetail && lastDetail.kind === "item" && (
        <ItemDetailPopover itemId={lastDetail.id} ver={ver} open={activeDetail !== null} onClose={closeDetail} />
      )}
      {lastDetail && lastDetail.kind !== "item" && (
        <EntityDetailPopover
          kind={lastDetail.kind}
          id={lastDetail.id}
          ver={ver}
          open={activeDetail !== null}
          onClose={closeDetail}
        />
      )}
    </div>
  );
}
