"use client";

// ItemBuildCard — v0.51.0 Builds redesign (mockup 4/5's merged "ITEM BUILD"
// card). Wraps Starting + (Support, role-gated) + Core Build Order +
// Situational as labeled sub-sections inside ONE bordered card with a single
// "ADD TO CLIENT" action, replacing the four separate bordered cards the
// pre-redesign grid rendered side by side. Each section component
// (StartingCard/SupportItemCard/CoreBuildOrderCard/SituationalCard) already
// owns its own label + content — this card only supplies the outer chrome +
// header + divide-y hairlines between them (no data reshaping).
import { useEffect, useState } from "react";
import type { BuildResponse, ChampionRef } from "@/lib/types";
import type { LaneId } from "./heroContracts";
import StartingCard from "./StartingCard";
import CoreBuildOrderCard from "./CoreBuildOrderCard";
import SituationalCard from "./SituationalCard";
import HiddenGemCard from "./HiddenGemCard";
import SupportItemCard from "./SupportItemCard";
import { applyItemSetsForBuild } from "./itemSetsApply";
import { hasSession, getStoredSession, getStoredPort } from "@/components/live/companionClient";

type ItemSetsUiState =
  | { status: "idle" }
  | { status: "applying" }
  | { status: "success"; message: string }
  | { status: "error"; message: string };

/** "ADD TO CLIENT" — same underlying pipeline as RunesSummonersCard's own
 *  "Add item builds" button (itemSetsApply.ts's applyItemSetsForBuild), just
 *  the mockup's exact label for this card's header action. Kept as its own
 *  small local component (same duplication convention this codebase already
 *  uses for ApplyRunesButton/ItemSetsButton across RunesSummonersCard.tsx and
 *  ProConsensusCard.tsx) rather than sharing one across files. */
function AddToClientButton({
  champ,
  lane,
  roleLabel,
  build,
}: {
  champ: ChampionRef;
  lane: LaneId;
  roleLabel: string;
  build: BuildResponse;
}) {
  const [ready, setReady] = useState(false);
  const [state, setState] = useState<ItemSetsUiState>({ status: "idle" });

  useEffect(() => {
    setReady(hasSession());
  }, []);

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
    setState(
      result.ok
        ? { status: "success", message: "Item build added — check your shop in game." }
        : { status: "error", message: result.hint ?? "Couldn't add item builds — try again." }
    );
    window.setTimeout(() => setState({ status: "idle" }), 3500);
  }

  if (!ready) return null;

  const label =
    state.status === "applying" ? "Adding…" : state.status === "success" ? "Added" : state.status === "error" ? "Retry" : "Add to client";
  const tooltip = state.status === "success" || state.status === "error" ? state.message : undefined;

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={state.status === "applying"}
      title={tooltip}
      aria-label={`Add to client${tooltip ? ` — ${tooltip}` : ""}`}
      className="flex-shrink-0 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-txt bg-panel2 border border-line hover:border-line-gold disabled:opacity-60 disabled:cursor-not-allowed rounded-md px-2.5 py-1.5 transition-colors active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal focus-visible:ring-offset-2 focus-visible:ring-offset-panel"
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
    <div className="bg-panel border border-line rounded-xl p-5">
      <div className="flex items-start justify-between gap-3 mb-1">
        <p className="text-[10.5px] tracking-[0.14em] uppercase text-mut font-semibold">Item Build</p>
        <AddToClientButton champ={champ} lane={lane} roleLabel={build.roleLabel} build={build} />
      </div>
      <div className="divide-y divide-line/60">
        <StartingCard starter={build.items.starter} onItemClick={onItemClick} />
        {lane === "support" && <SupportItemCard champ={champ} build={build} ver={ver} onItemClick={onItemClick} />}
        <CoreBuildOrderCard items={build.items} onItemClick={onItemClick} />
        <SituationalCard items={build.items} onItemClick={onItemClick} />
        {/* 2026-07-28 — the fourth build category, shown on the page as well as
            in the shop. Renders null when nothing qualifies (common by design),
            so the card list simply ends at Situational for those champions. */}
        <HiddenGemCard items={build.items} ver={ver} onItemClick={onItemClick} />
      </div>
    </div>
  );
}
