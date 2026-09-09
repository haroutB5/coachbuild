"use client";

import { useEffect, useRef, useState } from "react";
import { LANE_TO_ROLE_ID, LANE_LABEL, type LaneId } from "@/components/hextech/heroContracts";
import type { ChampionIconEntry } from "@/components/proAssets";
import { IconWithFallback } from "@/components/IconWithFallback";
import type { DraftCountersParams, DraftCountersResponse, DraftCounterSuggestion } from "@/components/live/draftCounters";

type StripState = { status: "loading" } | { status: "ok"; data: DraftCountersResponse } | { status: "error" };

function CounterList({ title, subtitle, rows, metric, champIcons }: {
  title: string; subtitle: string; rows: DraftCounterSuggestion[]; metric: "gold" | "wr";
  champIcons: Map<number, ChampionIconEntry>;
}) {
  return <section className="min-w-0 rounded-lg bg-panel p-4">
    <h3 className="text-sm font-semibold text-txt">{title}</h3>
    <p className="mt-1 text-xs text-mut">{subtitle}</p>
    {rows.length === 0 ? <p className="mt-4 text-sm text-mut">No matchup data for this lane.</p> :
      <ol className="mt-3 max-h-[660px] overflow-y-auto divide-y divide-txt/[0.06]">
        {rows.map((row, index) => <li key={row.champId} className="flex items-center gap-2.5 py-2">
          <span className="w-4 text-right text-xs text-mut">{index + 1}</span>
          <span className="h-8 w-8 shrink-0 overflow-hidden rounded">
            <IconWithFallback src={champIcons.get(row.champId)?.icon ?? ""} alt={row.name}
              fallbackGlyph={row.name} size={32} className="h-full w-full object-cover" />
          </span>
          <span className="min-w-0 flex-1 truncate text-sm">{row.name}</span>
          <span className="shrink-0 text-right">
            <span className={`block text-xs font-semibold tabular-nums ${metric === "wr" ? "text-bad" : "text-good"}`}>
              {metric === "gold" ? `${row.goldAt15 > 0 ? "+" : ""}${row.goldAt15.toLocaleString()} GD15` : `${(row.winRate * 100).toFixed(2)}% WR`}
            </span>
            <span className="block text-[11px] tabular-nums text-mut">{row.games.toLocaleString()} games</span>
          </span>
        </li>)}
      </ol>}
  </section>;
}

export default function CounterPicksStrip({ enemyId, enemyName, lane, champIcons, loadCounters }: {
  enemyId: number | null; enemyName: string | null; lane: LaneId;
  champIcons: Map<number, ChampionIconEntry>;
  loadCounters: (params: DraftCountersParams, signal: AbortSignal) => Promise<DraftCountersResponse>;
}) {
  const [state, setState] = useState<StripState>({ status: "loading" });
  const reqId = useRef(0);
  useEffect(() => {
    if (enemyId === null) return;
    const id = ++reqId.current;
    const controller = new AbortController();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset when the external matchup selection changes.
    setState({ status: "loading" });
    loadCounters({ enemy: enemyId, lane: LANE_TO_ROLE_ID[lane] }, controller.signal).then(data => {
      if (!controller.signal.aborted && id === reqId.current) setState({ status: "ok", data });
    }).catch(() => {
      if (!controller.signal.aborted && id === reqId.current) setState({ status: "error" });
    });
    return () => controller.abort();
  }, [enemyId, lane, loadCounters]);
  if (enemyId === null) return null;
  const enemy = enemyName ?? `Champion #${enemyId}`;
  return <section aria-label={`u.gg counters vs ${enemy}`} className="space-y-3">
    <p className="text-xs text-mut">Source: u.gg · {LANE_LABEL[lane]} · World · Emerald+ · Ranked Solo
      {state.status === "ok" ? ` · Patch ${state.data.patch}` : ""}</p>
    {state.status === "loading" && <p role="status" className="text-sm text-mut">Loading u.gg matchups…</p>}
    {state.status === "error" && <p role="status" className="text-sm text-mut">u.gg counters are unavailable. Open the u.gg tab to check the site, then reselect the opponent.</p>}
    {state.status === "ok" && <div className="grid gap-4 md:grid-cols-2">
      <CounterList title={`Best Lane Counters vs ${enemy}`} subtitle="Top 15 · highest gold advantage at 15 minutes"
        rows={state.data.bestLaneCounters.slice(0, 15)} metric="gold" champIcons={champIcons} />
      <CounterList title={`Worst Picks vs ${enemy}`} subtitle="Top 10 · lowest win rate in this matchup"
        rows={state.data.worstPicks.slice(0, 10)} metric="wr" champIcons={champIcons} />
    </div>}
  </section>;
}
