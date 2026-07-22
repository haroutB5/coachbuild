"use client";

import { useEffect, useState, useCallback } from "react";
import type { BuildResponse, ChampionRef } from "@/lib/types";
import type { LaneId } from "./heroContracts";
import { LANE_TO_ROLE_ID, LANE_LABEL } from "./heroContracts";
import RunesSummonersCard from "./RunesSummonersCard";
import StartingCard from "./StartingCard";
import CoreBuildOrderCard from "./CoreBuildOrderCard";
import SituationalCard from "./SituationalCard";
import ProConsensusCard from "./ProConsensusCard";
import { versionFromPatch } from "@/components/proAssets";
import ItemDetailPopover from "@/components/ItemDetailPopover";
import EntityDetailPopover, { type EntityKind } from "@/components/EntityDetailPopover";
import { useBodyScrollLock } from "@/components/useBodyScrollLock";
import SegmentedControl from "@/components/SegmentedControl";
import { RANK_BRACKETS, DEFAULT_RANK_BRACKET, RANK_FILTERING_SUPPORTED } from "@/lib/rankBrackets";
import { readStoredRankBracketId, writeStoredRankBracketId } from "./rankBracketStorage";

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
// grid below — grid-template-areas keeps a SINGLE set of area names
// ("runes"/"starting"/"core"/"situational"/"pro") mapped to a genuinely
// different layout per breakpoint (single column, plan's original DOM order,
// below lg; a 7fr/5fr two-column composition — left: runes+core, right:
// starting+pro+situational — at lg+) without duplicating any component
// instance or relying on CSS Grid auto-placement (which can't reproduce two
// independent-height columns from a flat DOM order). Every grid consumer
// below (skeleton + the real ok-branch grid) must keep this exact area map
// in sync, or the loading skeleton will reflow into a different shape than
// the resolved content once it lands (defeats the whole "skeleton mirrors
// the grid" point of this pass).
const BUILD_GRID_CLASS =
  "grid grid-cols-1 gap-5 [grid-template-areas:'runes'_'starting'_'core'_'situational'_'pro'] lg:grid-cols-[7fr_5fr] lg:gap-x-5 lg:gap-y-5 lg:[grid-template-areas:'runes_starting'_'core_pro'_'core_situational']";

function BuildLoadingSkeleton() {
  return (
    <div className={BUILD_GRID_CLASS}>
      <CardSkeleton className="[grid-area:runes]" />
      <CardSkeleton className="[grid-area:starting]" />
      <CardSkeleton className="[grid-area:core]" />
      <CardSkeleton className="[grid-area:situational]" />
      <CardSkeleton className="[grid-area:pro]" />
    </div>
  );
}

/** Feature 3 (rank brackets) — compact selector rendered near the champion/
 *  lane pickers (ChampionHero/HextechTabs sit just above this tab's content
 *  on app/page.tsx). Rendered in every fetch state (loading/empty/error/ok)
 *  so a user who picks a bracket with no data for this champ+lane can switch
 *  right back without losing their place. Hidden entirely when
 *  RANK_FILTERING_SUPPORTED is false (defensive — see lib/rankBrackets.ts). */
function RankBracketSelector({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  if (!RANK_FILTERING_SUPPORTED) return null;
  return (
    // v0.44.0 (Builds responsive plan §2c): below `sm`, 7 rank-bracket pills
    // don't fit one inline row — SegmentedControl's new layout="scroll"
    // (default "inline" everywhere else) renders a horizontally-scrollable,
    // snap-scrolling strip with a static edge fade instead of wrapping to a
    // ragged 4+3 or overflowing the viewport (the root cause of the mobile
    // right-edge void — see plan §1). Single "scroll" render degrades to a
    // normal non-scrolling row once the content fits (sm+, per §3e "inline
    // right-aligned"), so no separate desktop-only render is needed.
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
      <p className="text-[10.5px] tracking-[0.14em] uppercase text-mut font-semibold">Rank bracket</p>
      <SegmentedControl
        ariaLabel="Filter build data by rank bracket"
        size="sm"
        layout="scroll"
        value={value}
        onChange={onChange}
        options={RANK_BRACKETS.map((b) => ({ value: b.id, label: b.label }))}
      />
    </div>
  );
}

export default function BuildTabContent({ champ, lane, onPatchResolved }: BuildTabContentProps) {
  const [state, setState] = useState<FetchState>({ status: "loading" });
  const [activeDetail, setActiveDetail] = useState<DetailRef | null>(null);
  const [lastDetail, setLastDetail] = useState<DetailRef | null>(null);

  // Feature 3 (rank brackets) — single source of truth for both the
  // selector's shown value AND the `rank=` fetch param below (never two
  // separate variables that could desync). Initialized to the default
  // bracket (matches SSR, since `window` doesn't exist there) and corrected
  // from localStorage in a mount-only effect — see rankBracketStorage.ts.
  // `rankHydrated` gates the fetch effect so a returning user with a
  // NON-default stored bracket doesn't briefly fetch (and flash) the
  // default bracket's build before the corrected value lands — the fetch
  // effect below waits one tick for this instead of firing twice.
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
        <RankBracketSelector value={rankBracket} onChange={handleRankChange} />
        <BuildLoadingSkeleton />
      </div>
    );
  }

  if (state.status === "empty") {
    return (
      <div className="mt-5 space-y-5">
        <RankBracketSelector value={rankBracket} onChange={handleRankChange} />
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
        <RankBracketSelector value={rankBracket} onChange={handleRankChange} />
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
      <RankBracketSelector value={rankBracket} onChange={handleRankChange} />

      {/* v0.44.0 (Builds responsive plan §3c/§3d): below `lg` this is a
          plain single-column stack in the tab's original order (Runes,
          Starting, Core, Situational, ProConsensus) — the retired
          `md:grid-cols-3` Starting/Core pairing no longer kicks in at any
          width below lg. At `lg`+ the SAME five cards reflow into a real
          2-column composition (left: Runes+Core, right: Starting+
          ProConsensus+Situational) via grid-template-areas — see
          BUILD_GRID_CLASS's doc comment above for why areas were used
          instead of two nested left/right wrapper divs (area assignment
          lets each breakpoint have a genuinely different visual order from
          the SAME DOM nodes, no duplicate mounts, no reordered fetch
          effects). */}
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
          />
        </div>
        <div className="[grid-area:starting]">
          <StartingCard starter={build.items.starter} onItemClick={openItemPopover} />
        </div>
        <div className="[grid-area:core]">
          <CoreBuildOrderCard items={build.items} onItemClick={openItemPopover} />
        </div>
        <div className="[grid-area:situational]">
          <SituationalCard items={build.items} onItemClick={openItemPopover} />
        </div>
        <div className="[grid-area:pro]">
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
