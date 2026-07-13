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

function BuildLoadingSkeleton() {
  return (
    <div className="mt-5 space-y-5">
      <CardSkeleton />
      <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
        <CardSkeleton />
        <CardSkeleton className="md:col-span-2" />
      </div>
      <CardSkeleton />
    </div>
  );
}

export default function BuildTabContent({ champ, lane, onPatchResolved }: BuildTabContentProps) {
  const [state, setState] = useState<FetchState>({ status: "loading" });
  const [activeDetail, setActiveDetail] = useState<DetailRef | null>(null);
  const [lastDetail, setLastDetail] = useState<DetailRef | null>(null);

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
    async (c: ChampionRef, l: LaneId, isCancelled: () => boolean) => {
      setState({ status: "loading" });
      try {
        const roleId = LANE_TO_ROLE_ID[l];
        const res = await fetch(`/api/build?champ=${c.id}&role=${roleId}`);
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
    let cancelled = false;
    load(champ, lane, () => cancelled);
    return () => {
      cancelled = true;
    };
  }, [champ, lane, load]);

  if (state.status === "loading") return <BuildLoadingSkeleton />;

  if (state.status === "empty") {
    return (
      <div className="mt-5 bg-panel border border-line rounded-xl p-10 text-center">
        <div className="text-txt font-semibold mb-1">
          Not enough data for {champ.name} {LANE_LABEL[lane]}
        </div>
        <div className="text-mut text-sm">
          Try a different lane, or check{" "}
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
    );
  }

  if (state.status === "error") {
    return (
      <div className="mt-5 bg-panel border border-line rounded-xl p-10 text-center">
        <div className="text-txt font-semibold mb-1">Couldn&apos;t load — try again</div>
        <div className="text-mut text-sm">
          Something went wrong fetching {champ.name} {LANE_LABEL[lane]}. Check your connection and
          refresh.
        </div>
      </div>
    );
  }

  const { build } = state;
  const ver = versionFromPatch(build.patch);

  return (
    <div className="mt-5 space-y-5">
      <RunesSummonersCard runes={build.runes} spells={build.spells} onOpenDetail={openDetail} />
      <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
        <StartingCard starter={build.items.starter} onItemClick={openItemPopover} />
        <div className="md:col-span-2">
          <CoreBuildOrderCard items={build.items} onItemClick={openItemPopover} />
        </div>
      </div>
      <SituationalCard items={build.items} onItemClick={openItemPopover} />

      {/* v0.27.0 (user request: "pro players seem to build Rocketbelt on
          Viktor — create another builds and runes space based on what pro
          players are often building"). Complements the WPA recommendation
          above with a plain pick-rate count over the same champion-scoped
          pro-games feed PRO BUILDS lists — own fetch, own loading/hidden
          states (components/hextech/ProConsensusCard.tsx), refetches on
          champ/lane change same as everything else on this tab. Reuses this
          tab's own popover plumbing (openDetail) rather than standing up a
          second popover/scroll-lock instance. */}
      <ProConsensusCard champ={champ} lane={lane} ver={ver} onOpenDetail={openDetail} />

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
