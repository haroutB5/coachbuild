"use client";

import { useEffect, useState, useCallback } from "react";
import type { BuildResponse, ChampionRef } from "@/lib/types";
import type { LaneId } from "./heroContracts";
import { LANE_TO_ROLE_ID, LANE_LABEL } from "./heroContracts";
import RunesSummonersCard from "./RunesSummonersCard";
import ItemBuildCard from "./ItemBuildCard";
import ProConsensusCard from "./ProConsensusCard";
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
  | { status: "error" };

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
// 7fr/5fr two-column composition at lg+, RUNES spanning both rows on the
// left per mockup 4/5 — ITEM BUILD top-right, PRO CONSENSUS bottom-right).
//
// v0.51.0 (Builds redesign): Starting/Support/Core/Situational collapsed
// from four separate grid areas into ONE "itembuild" area (ItemBuildCard.tsx
// now owns their composition as labeled sub-sections inside a single bordered
// card, matching the mockup's merged "ITEM BUILD" card) — a real
// simplification over the previous per-card area map, not just a rename.
const BUILD_GRID_CLASS =
  "grid grid-cols-1 gap-5 [grid-template-areas:'runes'_'itembuild'_'pro'] lg:grid-cols-[7fr_5fr] lg:gap-x-5 lg:gap-y-5 lg:[grid-template-areas:'runes_itembuild'_'runes_pro']";

// Mobile-only BUILD|PRO segmented control (peak usage is a 30s champ select —
// the pre-existing shape here was one ~3,000px scroll: Runes -> Starting ->
// Support -> Core -> Optimized -> Situational -> Pro Consensus). `lg:hidden`
// below matches BUILD_GRID_CLASS's own breakpoint exactly: below `lg` this
// tab renders one column at a time; at `lg`+ the grid already reflows into
// the existing 2-column desktop composition and the control disappears
// entirely, per spec ("desktop keeps the current single-scroll layout").
type MobileBuildTab = "build" | "pro";
const MOBILE_TAB_OPTIONS: { value: MobileBuildTab; label: string }[] = [
  { value: "build", label: "Build" },
  { value: "pro", label: "Pro" },
];

function BuildLoadingSkeleton() {
  return (
    <div className={BUILD_GRID_CLASS}>
      <CardSkeleton className="[grid-area:runes]" />
      <CardSkeleton className="[grid-area:itembuild] min-h-[280px]" />
      <CardSkeleton className="[grid-area:pro]" />
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
          setState({ status: "error" });
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
        if (!isCancelled()) setState({ status: "error" });
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
          <div className="text-txt font-semibold mb-1">Couldn&apos;t load — try again</div>
          <div className="text-mut text-sm">
            Something went wrong fetching {champ.name} {LANE_LABEL[lane]}. Check your connection and
            refresh.
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
          className={`[grid-area:runes] ${mobileTab === "pro" ? "hidden lg:block" : ""}`}
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
          className={`[grid-area:itembuild] ${mobileTab === "pro" ? "hidden lg:block" : ""}`}
          role="tabpanel"
          aria-labelledby="hextech-tab-build"
        >
          <ItemBuildCard champ={champ} lane={lane} build={build} ver={ver} onItemClick={openItemPopover} />
        </div>
        <div
          className={`[grid-area:pro] ${mobileTab === "build" ? "hidden lg:block" : ""}`}
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
