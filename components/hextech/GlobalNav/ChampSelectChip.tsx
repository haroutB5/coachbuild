"use client";

// TopBar's champ-select status chip — "● CHAMP SELECT — SWAIN · TOP", gold-
// outlined + pulsing dot while genuinely live, hidden otherwise. Pure wiring:
// reads useCompanion() (the app-wide poll) and hands champSelectChipModel
// (engo's pinned contract) already-RESOLVED strings — per that model's own
// doc comment, it takes `{championName, role}` display strings, not the raw
// wire snapshot (CompanionChampSelectSnapshot only carries numeric ids), so
// this component owns the id -> name / roleId -> lane-label resolution
// before calling it (same split champSelectFollow.ts's own helpers already
// established: pure decision logic stays id-based, display resolution is the
// caller's job).
import { useEffect, useState } from "react";
import type { ChampionRef } from "@/lib/types";
import { useCompanion } from "@/components/live/CompanionProvider";
import { resolveCurrentChampSelectChampionId, resolveChampSelectRoleId } from "@/components/live/champSelectFollow";
import { roleIdToLane } from "@/components/live/deepLink";
import { LANE_LABEL } from "@/components/hextech/heroContracts";
import { champSelectChipModel } from "./champSelectChipModel";

interface ChampSelectChipProps {
  /** Notifies the caller (TopBar.tsx) whether this chip actually rendered
   *  content this tick, so TopBar can collapse its own chrome (border/
   *  padding/background) when nothing else in the bar is visible either —
   *  see topBarChrome.ts. Optional: this component still self-hides via its
   *  own `if (!model.show) return null` with no caller wired up. */
  onVisibleChange?: (visible: boolean) => void;
}

export default function ChampSelectChip({ onVisibleChange }: ChampSelectChipProps = {}) {
  const companion = useCompanion();
  const [champions, setChampions] = useState<ChampionRef[]>([]);

  const championId = companion.statusFresh ? resolveCurrentChampSelectChampionId(companion.champSelect) : null;
  const roleId = companion.statusFresh ? resolveChampSelectRoleId(companion.champSelect) : undefined;

  // Only fetch the champion list once champ select is actually live and a
  // champion id has resolved — this chip is hidden entirely outside that
  // state, so there's nothing to resolve most of the time.
  useEffect(() => {
    if (championId === null || champions.length > 0) return;
    fetch("/api/champions")
      .then((r) => (r.ok ? (r.json() as Promise<ChampionRef[]>) : []))
      .then((data) => {
        if (Array.isArray(data) && data.length > 0) setChampions(data);
      })
      .catch(() => {
        /* stays unresolved this tick — model degrades to the honest
           "still picking" label rather than a guessed name */
      });
  }, [championId, champions.length]);

  const championName = championId !== null ? champions.find((c) => c.id === championId)?.name ?? null : null;
  const role = roleId !== undefined ? LANE_LABEL[roleIdToLane(roleId)] : null;

  const model = champSelectChipModel({
    phase: companion.phase,
    champSelect: companion.champSelect ? { championName, role } : null,
    clientConnected: companion.clientConnected,
    statusFresh: companion.statusFresh,
  });

  useEffect(() => {
    onVisibleChange?.(model.show);
  }, [model.show, onVisibleChange]);

  if (!model.show) return null;

  const isLive = model.tone === "live";
  const dotClass = isLive ? "bg-teal animate-pulse" : "bg-mut";

  return (
    <div className="flex-shrink-0 flex items-center">
      {/* Mobile: dot only */}
      <span className={`sm:hidden w-2 h-2 rounded-full ${dotClass}`} role="img" aria-label={model.label} title={model.label} />
      {/* sm+: full pill */}
      <div
        className={`hidden sm:flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-[10.5px] font-bold uppercase tracking-[0.05em] whitespace-nowrap ${
          isLive ? "border-line-gold bg-teal/10 text-teal" : "border-line text-mut"
        }`}
      >
        <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${dotClass}`} aria-hidden="true" />
        {model.label}
      </div>
    </div>
  );
}
