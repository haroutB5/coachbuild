"use client";

import { useEffect, useState } from "react";
import type { ProGame, ProGamesApiResponse } from "./proGames.types";
import ProGameCard from "./ProGameCard";

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

function ProGamesSkeleton() {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 animate-pulse">
      {[0, 1].map((i) => (
        <div
          key={i}
          className="bg-gradient-to-b from-panel to-[#0d121a] border border-line rounded-2xl p-4 h-[168px]"
        >
          <div className="h-3 w-1/3 bg-line rounded mb-3" />
          <div className="flex gap-2 mb-4">
            <div className="w-11 h-11 rounded-full bg-line" />
            <div className="w-6 h-6 rounded-full bg-line" />
            <div className="w-6 h-6 rounded-full bg-line" />
          </div>
          <div className="flex gap-1.5">
            {[0, 1, 2, 3, 4, 5].map((j) => (
              <div key={j} className="w-9 h-9 rounded-lg bg-line" />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export default function ProGamesSection({
  championId,
  championName,
  role,
  limit = 20,
}: ProGamesSectionProps) {
  const [state, setState] = useState<ProGamesState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });

    fetch(`/api/pros?championId=${championId}&role=${role}&limit=${limit}`)
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
  }, [championId, role, limit]);

  return (
    <section className="mt-8">
      <div className="flex items-baseline gap-2 mb-3 px-1">
        <h2 className="text-[11px] tracking-[1.5px] uppercase text-teal font-bold">Pro Games</h2>
        {state.status === "ok" && (
          <span className="text-[11px] text-mut tabular-nums">{state.games.length} tracked</span>
        )}
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
            No tracked pro games yet for {championName}
          </div>
          <div className="text-[11.5px] text-mut">Check back after their next solo queue session.</div>
        </div>
      )}

      {state.status === "ok" && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {state.games.map((game) => (
            <ProGameCard key={game.id} game={game} />
          ))}
        </div>
      )}
    </section>
  );
}
