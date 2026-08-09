"use client";

import { useEffect, useRef, useState } from "react";
import { useCompanion } from "@/components/live/CompanionProvider";
import { resolveChampSelectRoleId, resolveCurrentChampSelectChampionId } from "@/components/live/champSelectFollow";
import { roleIdToLane } from "@/components/live/deepLink";
import { type LaneId } from "@/components/hextech/heroContracts";
import LiveCompanionOverlay from "@/components/hextech/companion/LiveCompanionOverlay";

function roleParamToLane(raw: string | null): LaneId | null {
  if (raw == null || raw === "") return null;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 4) return null;
  return roleIdToLane(parsed as 0 | 1 | 2 | 3 | 4);
}

/** Chrome-free second-monitor surface. The shared live component keeps the
 * existing /skills -> resolveNextSkill data path, while this route owns only
 * the champ-select/deep-link identity and the larger presentation scale. */
export default function CompactPage() {
  const companion = useCompanion();
  const [lane, setLane] = useState<LaneId | null>(null);
  const [initialChampionId, setInitialChampionId] = useState<number | null>(null);
  const mountedRef = useRef(false);

  useEffect(() => {
    if (mountedRef.current) return;
    mountedRef.current = true;
    const params = new URLSearchParams(window.location.search);
    const session = params.get("session");
    if (session) companion.setSession(session);

    const laneFromParam = roleParamToLane(params.get("role"));
    if (laneFromParam) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- URL parameters hydrate once after SSR.
      setLane(laneFromParam);
    }

    const championId = Number.parseInt(params.get("championId") ?? "", 10);
    if (Number.isFinite(championId) && championId > 0) {
      setInitialChampionId(championId);
    }
  }, [companion]);

  const liveChampionId =
    companion.statusFresh && companion.phase === "ChampSelect"
      ? resolveCurrentChampSelectChampionId(companion.champSelect)
      : null;
  const liveRoleId =
    companion.statusFresh && companion.phase === "ChampSelect"
      ? resolveChampSelectRoleId(companion.champSelect)
      : undefined;
  const championId = liveChampionId ?? initialChampionId;
  const liveLane = liveRoleId === undefined ? null : roleIdToLane(liveRoleId);
  const effectiveLane = liveLane ?? lane;

  return (
    <main className="flex min-h-screen items-center justify-center bg-[#0f1319] px-4 py-6 text-txt sm:px-8">
      <LiveCompanionOverlay championId={championId} lane={effectiveLane} scale="compact" />
    </main>
  );
}
