"use client";

import { useEffect, useState, useCallback } from "react";
import type { BuildResponse, ChampionRef } from "@/lib/types";
import type { LaneId } from "./heroContracts";
import { LANE_TO_ROLE_ID, LANE_LABEL } from "./heroContracts";
import RunesSummonersCard from "./RunesSummonersCard";
import ItemBuildCard from "./ItemBuildCard";
import ProConsensusCard from "./ProConsensusCard";
import SkillOrderCard from "./SkillOrderCard";
import HextechTabs from "./HextechTabs";
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
  | { status: "ok"; build: BuildResponse }
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
// `otp` (2026-07-28) is a second full-width row directly under `pro`, same
// shape for the same reason: the OTP card renders the identical wide
// grid internally (see ProConsensusCard's lg:grid-cols-[5fr_7fr] body), so
// giving it its own full-width area keeps both consensus cards visually
// identical instead of squeezing one into a column.
const BUILD_GRID_CLASS =
  "grid grid-cols-1 gap-5 [grid-template-areas:'runes'_'itembuild'_'skillorder'_'pro'_'otp'] lg:grid-cols-[5fr_7fr] lg:gap-x-5 lg:gap-y-5 lg:[grid-template-areas:'runes_itembuild'_'skillorder_skillorder'_'pro_pro'_'otp_otp']";

// Mobile-only BUILD|PRO segmented control (peak usage is a 30s champ select —
// the pre-existing shape here was one ~3,000px scroll: Runes -> Starting ->
// Support -> Core -> Optimized -> Situational -> Pro Consensus). `lg:hidden`
// below matches BUILD_GRID_CLASS's own breakpoint exactly: below `lg` this
// tab renders one column at a time; at `lg`+ the grid already reflows into
// the existing 2-column desktop composition and the control disappears
// entirely, per spec ("desktop keeps the current single-scroll layout").
// "otp" added 2026-07-28. It gets its OWN tab rather than sharing "pro":
// pros and one-tricks answer different questions ("what does the meta's best
// execution look like" vs "what does the person who has played this 700 times
// build"), and stacking both consensus cards under one tab would rebuild the
// exact ~3,000px champ-select scroll this control exists to kill.
type MobileBuildTab = "build" | "pro" | "otp";
const MOBILE_TAB_OPTIONS: { value: MobileBuildTab; label: string }[] = [
  { value: "build", label: "Build" },
  { value: "pro", label: "Pro" },
  { value: "otp", label: "OTP" },
];

function BuildLoadingSkeleton() {
  return (
    <div className={BUILD_GRID_CLASS}>
      <CardSkeleton className="[grid-area:runes]" />
      <CardSkeleton className="[grid-area:itembuild] min-h-[280px]" />
      <CardSkeleton className="[grid-area:skillorder]" />
      <CardSkeleton className="[grid-area:pro]" />
      <CardSkeleton className="[grid-area:otp]" />
    </div>
  );
}

export default function BuildTabContent({ champ, lane, rankBracket, rankHydrated, onPatchResolved }: BuildTabContentProps) {
  const [state, setState] = useState<FetchState>({ status: "loading" });
  const [activeDetail, setActiveDetail] = useState<DetailRef | null>(null);
  const [lastDetail, setLastDetail] = useState<DetailRef | null>(null);
  // Mobile BUILD|PRO split (defaults to BUILD on load, per spec). Below `lg`
  // only one of the two card groups is VISIBLE at a time — both stay
  // mounted (see the [grid-area:*] wrappers in the render below), so
  // switching tabs never re-triggers ProConsensusCard's /api/pros fetch or
  // loses RunesSummonersCard/ItemBuildCard state. Desktop (`lg`+) ignores
  // this entirely — both groups always render there, same as before.
  const [mobileTab, setMobileTab] = useState<MobileBuildTab>("build");

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
        setState({ status: "ok", build: data[0] });
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
    return (
      <div className="mt-5 space-y-5">
        <BuildLoadingSkeleton />
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

  const { build } = state;
  const ver = versionFromPatch(build.patch);

  return (
    <div className="mt-5 space-y-5">
      {/* v0.51.0 (Builds redesign, mockup 4/5): below `lg` a plain
          single-column stack (Runes, Item Build, Pro Consensus). At `lg`+ the
          SAME three cards reflow into a 2-column composition — RUNES spans
          both rows on the left, ITEM BUILD (top) + PRO CONSENSUS (bottom) on
          the right — via grid-template-areas (BUILD_GRID_CLASS above). */}
      {/* Mobile-only (lg:hidden matches BUILD_GRID_CLASS's own breakpoint) —
          real tab semantics (role=tablist/tab/aria-selected via HextechTabs,
          generalized for this reuse — see that file's own comment), not a
          decorative toggle. Absent entirely at `lg`+, where both groups
          below always render regardless of `mobileTab`. */}
      <div className="lg:hidden mb-1">
        <HextechTabs
          options={MOBILE_TAB_OPTIONS}
          value={mobileTab}
          onChange={setMobileTab}
          ariaLabel="Build view"
        />
      </div>

      <div className={BUILD_GRID_CLASS}>
        {/* v0.62.x: `hidden lg:block` mirrors the codebase's standard
            responsive-visibility idiom (same mechanism as e.g. `hidden
            sm:block`) — below `lg` this collapses the group to zero layout
            footprint via display:none (also correctly pulling it out of the
            tab order/a11y tree) whenever the OTHER mobile tab is active; at
            `lg`+ the override always wins, so desktop is unaffected by
            `mobileTab`. RunesSummonersCard/ItemBuildCard/ProConsensusCard
            stay mounted the whole time — only visibility toggles, so
            switching BUILD -> PRO -> BUILD never re-fires ProConsensusCard's
            /api/pros fetch or drops any of the three cards' own state.
            role=tabpanel/aria-labelledby wire these to HextechTabs' own
            auto-generated tab ids (hextech-tab-build/hextech-tab-pro) —
            correct below `lg` where the tablist is live; at `lg`+ the
            tablist itself is `lg:hidden` (removed from the a11y tree), so
            the reference is inert rather than wrong — an accepted, common
            trade-off for a mobile-only control that stays mounted at every
            breakpoint (see HANDOFF-fronty.md for the full reasoning). */}
        <div
          className={`[grid-area:runes] ${mobileTab !== "build" ? "hidden lg:block" : ""}`}
          role="tabpanel"
          id="hextech-tabpanel-build"
          aria-labelledby="hextech-tab-build"
        >
          <RunesSummonersCard
            runes={build.runes}
            spells={build.spells}
            onOpenDetail={openDetail}
            championName={build.champion.name}
            roleLabel={build.roleLabel}
            build={build}
            lane={lane}
          />
        </div>
        <div
          className={`[grid-area:itembuild] ${mobileTab !== "build" ? "hidden lg:block" : ""}`}
          role="tabpanel"
          aria-labelledby="hextech-tab-build"
        >
          <ItemBuildCard champ={champ} lane={lane} build={build} ver={ver} onItemClick={openItemPopover} />
        </div>
        {/* 2026-07-27 (recommended skill order feature) — a RECOMMENDATION
            card (max-priority string + per-ability path), grouped with
            RunesSummonersCard/ItemBuildCard under the "Build" mobile tab
            rather than "Pro" — like ItemBuildCard, it's a build recommendation
            this tab surfaces directly, not a community/pro-play data view the
            way ProConsensusCard is. Own fetch/loading/hidden states
            (components/hextech/SkillOrderCard.tsx) — a null API payload
            renders no card, collapsing this grid cell to zero height exactly
            like ProConsensusCard's own N=0 state already does. */}
        <div
          className={`[grid-area:skillorder] ${mobileTab !== "build" ? "hidden lg:block" : ""}`}
          role="tabpanel"
          aria-labelledby="hextech-tab-build"
        >
          <SkillOrderCard champ={champ} lane={lane} />
        </div>
        <div
          className={`[grid-area:pro] ${mobileTab !== "pro" ? "hidden lg:block" : ""}`}
          role="tabpanel"
          id="hextech-tabpanel-pro"
          aria-labelledby="hextech-tab-pro"
        >
          {/* v0.27.0 (user request: "pro players seem to build Rocketbelt on
              Viktor — create another builds and runes space based on what pro
              players are often building"). Complements the WPA recommendation
              above with a plain pick-rate count over the same champion-scoped
              pro-games feed PRO BUILDS lists — own fetch, own loading/hidden
              states (components/hextech/ProConsensusCard.tsx), refetches on
              champ/lane change same as everything else on this tab. Reuses
              this tab's own popover plumbing (openDetail) rather than
              standing up a second popover/scroll-lock instance. A hidden
              (N=0) ProConsensusCard renders null, collapsing this grid cell
              to zero height cleanly — grid-template-areas doesn't reserve
              empty space for a null child. */}
          <ProConsensusCard champ={champ} lane={lane} ver={ver} onOpenDetail={openDetail} build={build} />
        </div>
        <div
          className={`[grid-area:otp] ${mobileTab !== "otp" ? "hidden lg:block" : ""}`}
          role="tabpanel"
          id="hextech-tabpanel-otp"
          aria-labelledby="hextech-tab-otp"
        >
          {/* 2026-07-28 (user request: "add a OTP section in builds for champs
              as well, same as we have for pro"). Same component, `variant="otp"`
              — it swaps the feed to /api/otp (op.gg's top Master+ one-tricks for
              this champion, 100+ games each, their recent ranked games) and the
              wording that describes it, and nothing else. Sharing the component
              is the point: the starter/boots partition (HARD RULE 2) and the
              per-slot honest denominators are enforced in ONE place.

              `build` is deliberately NOT passed: it exists only to render the
              two companion apply buttons, which the OTP variant suppresses (see
              ProConsensusCard's header comment — a third LCU rune-page title is
              a companion-side change). Passing it would be dead weight that
              reads like the buttons are meant to be there. */}
          <ProConsensusCard
            champ={champ}
            lane={lane}
            variant="otp"
            ver={ver}
            onOpenDetail={openDetail}
          />
        </div>
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
