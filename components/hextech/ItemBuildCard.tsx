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
interface ItemBuildCardProps {
  champ: ChampionRef;
  lane: LaneId;
  build: BuildResponse;
  ver: string;
  onItemClick: (id: number) => void;
}

export default function ItemBuildCard({ champ, lane, build, ver, onItemClick }: ItemBuildCardProps) {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 px-0.5">
        <div><SectionLabel>WPA build</SectionLabel><p className="mt-1 text-[11px] text-[#9397ab]/60">The highest-value path for this champion and lane.</p></div>
        <AddToClientButton champ={champ} lane={lane} build={build} />
      </div>
      <CoreBuildOrderCard items={build.items} onItemClick={onItemClick} />
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
