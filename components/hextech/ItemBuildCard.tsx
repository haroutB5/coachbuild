"use client";

import { useSyncExternalStore } from "react";
import type { BuildResponse, ChampionRef } from "@/lib/types";
import type { LaneId } from "./heroContracts";
import CoreBuildOrderCard from "./CoreBuildOrderCard";
import SituationalCard from "./SituationalCard";
import HiddenGemCard from "./HiddenGemCard";
import SupportItemCard from "./SupportItemCard";
import { hasSession } from "@/components/live/companionClient";
import { ACCENT_CARD_CLASS, CARD_CLASS, SectionLabel } from "./builds/BuildVisuals";
import { applyLabel, importItemBuild, useApplyAction } from "./builds/applyActions";
import ForThisGameCard from "./ForThisGameCard";

const subscribeToSession = () => () => {};

/** The item-set write, unchanged in behaviour. Its click sequence moved to
 *  builds/applyActions.ts (importItemBuild + useApplyAction) so the hero's
 *  IMPORT BUILD button runs THIS action rather than a second copy of it — the
 *  hero button used to be a `scrollIntoView` that landed on this very card.
 *
 *  Hides rather than disables when unpaired: unchanged, and now paired with the
 *  hero's visible "pair the companion" reason, which explains the page-level
 *  absence in one place instead of repeating it beside every small control. */
function AddToClientButton({ champ, lane, build }: { champ: ChampionRef; lane: LaneId; build: BuildResponse }) {
  const ready = useSyncExternalStore(subscribeToSession, hasSession, () => false);
  const { phase, run } = useApplyAction();

  if (!ready) return null;
  const label = applyLabel(phase, { idle: "Add to client", busy: "Adding…", done: "Added" });
  return (
    <button
      type="button"
      onClick={() => run(() => importItemBuild({ champ, lane, build }))}
      disabled={phase.status === "applying"}
      title={phase.status === "success" || phase.status === "error" ? phase.message : undefined}
      className="rounded-[7px] px-2.5 py-1.5 text-[9px] font-semibold uppercase tracking-[0.08em] text-[#e9e9ed]/70 shadow-[inset_0_0_0_1px_rgba(233,233,237,0.14)] transition-colors hover:bg-white/[0.07] disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#9184d9]"
    >
      {label}
    </button>
  );
}
/** `2026-09-02T04:13:48.531Z` -> `2026-09-02 04:13 UTC`; anything unparseable
 *  is shown as-is rather than as "Invalid Date". */
export function formatAsOf(iso: string | undefined): string {
  if (!iso) return "earlier";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  return new Date(t).toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

interface ItemBuildCardProps {
  champ: ChampionRef;
  lane: LaneId;
  build: BuildResponse;
  ver: string;
  /** True when the service worker served this build out of its cache while
   *  offline (lib/buildCache.ts). Renders the quiet offline line below; the
   *  server-stale line takes precedence when both are somehow true. */
  servedOffline?: boolean;
  onItemClick: (id: number) => void;
}

export default function ItemBuildCard({ champ, lane, build, ver, servedOffline, onItemClick }: ItemBuildCardProps) {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 px-0.5">
        <div>
          <SectionLabel>WPA build</SectionLabel>
          <p className="mt-1 text-[11px] text-[#9397ab]/60">The highest-value path for this champion and lane.</p>
          {/* 0.122.0 -- the one place a served-from-cache build says so. Quiet
              on purpose: the build is still this champion's build, just not
              recomputed today. Absent on every fresh response. */}
          {build.stale && (
            <p className="mt-1 text-[11px] text-accent-400/80" data-testid="build-stale-note">
              Cached copy from {formatAsOf(build.asOf)}; the stats source is not answering right now.
            </p>
          )}
          {!build.stale && servedOffline && (
            <p className="mt-1 text-[11px] text-accent-400/80" data-testid="build-offline-note">
              Offline — showing your last cached copy. Reconnect to refresh.
            </p>
          )}
        </div>
        <AddToClientButton champ={champ} lane={lane} build={build} />
      </div>
      <CoreBuildOrderCard items={build.items} onItemClick={onItemClick} />
      {/* 0.120.0 -- the ONE comp-driven surface on this page, and it renders
          nothing outside champ select or on an incomplete comp. It sits
          directly under the WPA order for the same reason the shop block sits
          directly under `WPA build`: it is that build with at most two slots
          swapped, and reading them adjacent is what makes the swap legible. */}
      <ForThisGameCard
        championId={champ.id}
        lane={lane}
        build={build}
        onItemClick={onItemClick}
      />
      <div className="grid gap-4 lg:grid-cols-2">
        <section className={`${CARD_CLASS} min-w-0 p-4`}>
          <SituationalCard items={build.items} onItemClick={onItemClick} />
        </section>
        <HiddenGemCard items={build.items} ver={ver} onItemClick={onItemClick} />
      </div>
      {lane === "support" && (
        <section className={`${ACCENT_CARD_CLASS} p-4`}>
          <SupportItemCard champ={champ} build={build} ver={ver} onItemClick={onItemClick} />
        </section>
      )}
    </div>
  );
}
