"use client";

import { useState, useSyncExternalStore } from "react";
import type { BuildResponse, ChampionRef } from "@/lib/types";
import type { LaneId } from "./heroContracts";
import CoreBuildOrderCard from "./CoreBuildOrderCard";
import SituationalCard from "./SituationalCard";
import HiddenGemCard from "./HiddenGemCard";
import SupportItemCard from "./SupportItemCard";
import { applyItemSetsForBuild } from "./itemSetsApply";
import { hasSession, getStoredSession, getStoredPort } from "@/components/live/companionClient";
import { ACCENT_CARD_CLASS, CARD_CLASS, SectionLabel } from "./builds/BuildVisuals";

const subscribeToSession = () => () => {};

type ItemSetsUiState =
  | { status: "idle" }
  | { status: "applying" }
  | { status: "success"; message: string }
  | { status: "error"; message: string };

function AddToClientButton({ champ, lane, roleLabel, build }: { champ: ChampionRef; lane: LaneId; roleLabel: string; build: BuildResponse }) {
  const ready = useSyncExternalStore(subscribeToSession, hasSession, () => false);
  const [state, setState] = useState<ItemSetsUiState>({ status: "idle" });

  async function handleClick() {
    const session = getStoredSession();
    const port = getStoredPort();
    if (!session || !port) {
      setState({ status: "error", message: "Companion not connected — open /live-setup and reconnect." });
      window.setTimeout(() => setState({ status: "idle" }), 3500);
      return;
    }
    setState({ status: "applying" });
    const result = await applyItemSetsForBuild({ champ, lane, roleLabel, build, port, session });
    setState(result.ok ? { status: "success", message: "Item build added — check your shop in game." } : { status: "error", message: result.hint ?? "Couldn't add item builds — try again." });
    window.setTimeout(() => setState({ status: "idle" }), 3500);
  }

  if (!ready) return null;
  const label = state.status === "applying" ? "Adding…" : state.status === "success" ? "Added" : state.status === "error" ? "Retry" : "Add to client";
  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={state.status === "applying"}
      title={state.status === "success" || state.status === "error" ? state.message : undefined}
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
        <AddToClientButton champ={champ} lane={lane} roleLabel={build.roleLabel} build={build} />
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
