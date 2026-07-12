"use client";

import { useEffect, useState } from "react";
import type { ChampionRef } from "@/lib/types";
import type { ProGame, ProGamesApiResponse } from "@/components/proGames.types";
import { getChampionIconMap, type ChampionIconEntry } from "@/components/proAssets";
import { LANE_TO_ROLE_ID, type LaneId } from "./heroContracts";
import ProBuildRow from "./ProBuildRow";

interface ProBuildsTabProps {
  champ: ChampionRef;
  lane: LaneId;
}

type State =
  | { status: "loading" }
  | { status: "ok"; games: ProGame[] }
  | { status: "empty" }
  | { status: "error" };

function RowSkeleton() {
  return <div className="h-[52px] bg-panel border border-line rounded-xl animate-pulse" />;
}

export default function ProBuildsTab({ champ, lane }: ProBuildsTabProps) {
  const [state, setState] = useState<State>({ status: "loading" });
  const [championMap, setChampionMap] = useState<Map<number, ChampionIconEntry> | null>(null);

  useEffect(() => {
    getChampionIconMap().then(setChampionMap);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    const role = LANE_TO_ROLE_ID[lane];
    // Pro Builds is scoped to official esports games specifically (the spec
    // rows all carry a league name + date, which only prostage rows have) —
    // not a user-toggleable source filter like the legacy /history page,
    // deliberately just "all" replaced with "prostage" for this tab.
    fetch(`/api/pros?championId=${champ.id}&role=${role}&limit=20&source=prostage`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`pros fetch ${res.status}`);
        const data: ProGamesApiResponse = await res.json();
        if (cancelled) return;
        const games = Array.isArray(data?.games) ? data.games : [];
        setState(games.length > 0 ? { status: "ok", games } : { status: "empty" });
      })
      .catch(() => {
        if (!cancelled) setState({ status: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [champ.id, lane]);

  if (state.status === "loading") {
    return (
      <div className="mt-5 space-y-2.5">
        <RowSkeleton />
        <RowSkeleton />
        <RowSkeleton />
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div className="mt-5 bg-panel border border-line rounded-xl p-10 text-center">
        <div className="text-txt font-semibold mb-1">Couldn&apos;t load pro builds</div>
        <div className="text-mut text-sm">Check your connection and try again.</div>
      </div>
    );
  }

  if (state.status === "empty") {
    return (
      <div className="mt-5 bg-panel border border-line rounded-xl p-10 text-center">
        <div className="text-txt font-semibold mb-1">
          No pro-play games tracked yet for {champ.name}
        </div>
        <div className="text-mut text-sm">Check back after the next official match.</div>
      </div>
    );
  }

  const role = LANE_TO_ROLE_ID[lane];

  return (
    <div className="mt-5 space-y-2.5">
      {state.games.map((game) => {
        const enemyId = game.enemyChampionIds?.[role];
        const enemyLaner = enemyId !== undefined ? championMap?.get(enemyId) : undefined;
        return (
          <ProBuildRow
            key={game.id}
            game={game}
            championIcon={champ.icon}
            championDisplayName={champ.name}
            enemyLaner={enemyLaner}
          />
        );
      })}
    </div>
  );
}
