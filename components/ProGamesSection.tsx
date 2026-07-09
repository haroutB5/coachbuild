"use client";

import { useEffect, useState } from "react";
import type { ProGame, ProGamesApiResponse, ProGameSource } from "./proGames.types";
import { SOURCE_FILTER_OPTIONS, proGamesEmptyTitle, proGamesEmptySub } from "./proGames.types";
import ProGameCard from "./ProGameCard";
import ProGamesSkeleton from "./ProGamesSkeleton";
import SegmentedControl from "./SegmentedControl";

interface ProGamesSectionProps {
  championId: number;
  championName: string;
  role: number; // 0-4 = lane filter; 5 (auto, the default after a champion pick) = all lanes
  limit?: number;
}

type ProGamesState =
  | { status: "loading" }
  | { status: "ok"; games: ProGame[] }
  | { status: "empty" }
  | { status: "error" };

export default function ProGamesSection({
  championId,
  championName,
  role,
  limit = 20,
}: ProGamesSectionProps) {
  const [state, setState] = useState<ProGamesState>({ status: "loading" });
  const [source, setSource] = useState<ProGameSource>("all");

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });

    fetch(`/api/pros?championId=${championId}&role=${role}&limit=${limit}&source=${source}`)
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
  }, [championId, role, limit, source]);

  return (
    <section className="mt-8">
      <div className="flex items-center gap-2 mb-3 px-1 flex-wrap">
        <h2 className="text-[11px] tracking-[1.5px] uppercase text-teal font-bold">Pro Games</h2>
        {state.status === "ok" && (
          <span className="text-[11px] text-mut tabular-nums">{state.games.length} tracked</span>
        )}
        <div className="ml-auto">
          <SegmentedControl
            ariaLabel="Filter pro games by source"
            value={source}
            onChange={setSource}
            options={SOURCE_FILTER_OPTIONS}
            size="sm"
          />
        </div>
      </div>

      {state.status === "loading" && <ProGamesSkeleton />}

      {state.status === "error" && (
        <p className="text-[12px] text-mut px-1">
          Couldn&apos;t load pro games right now — the build recommendations above are unaffected.
        </p>
      )}

      {state.status === "empty" && (
        <div className="bg-gradient-to-b from-panel to-[#0d121a] border border-line rounded-2xl px-5 py-6 text-center">
          <div className="text-[13px] text-txt font-medium mb-1">
            {proGamesEmptyTitle(source, championName)}
          </div>
          <div className="text-[11.5px] text-mut">{proGamesEmptySub(source)}</div>
        </div>
      )}

      {state.status === "ok" && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {state.games.map((game) => (
            <ProGameCard key={game.id} game={game} championDisplayName={championName} />
          ))}
        </div>
      )}
    </section>
  );
}
