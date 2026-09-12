"use client";

import { useEffect, useRef, useState } from "react";
import { WarningCircle } from "@phosphor-icons/react";
import { LANE_TO_ROLE_ID, LANE_LABEL, type LaneId } from "@/components/hextech/heroContracts";
import type { ChampionIconEntry } from "@/components/proAssets";
import { IconWithFallback } from "@/components/IconWithFallback";
import type { DraftCountersParams, DraftCountersResponse, DraftCounterSuggestion } from "@/components/live/draftCounters";

type StripState = { status: "loading" } | { status: "ok"; data: DraftCountersResponse } | { status: "error" };

/** Rows below this game count trigger the small-sample warning. */
export const SMALL_SAMPLE_GAMES = 20;

function formatGold(value: number): string {
  const digits = Math.abs(value).toLocaleString("en-US");
  return value > 0 ? `+${digits}` : value < 0 ? `-${digits}` : "0";
}

function CounterTable({ id, title, subtitle, badge, rows, metric, champIcons }: {
  id: string; title: string; subtitle: string; badge: string;
  rows: DraftCounterSuggestion[]; metric: "gold" | "wr";
  champIcons: Map<number, ChampionIconEntry>;
}) {
  return (
    <section id={id} aria-label={title} className="d25-tcard">
      <h3 className="d25-ttitle">{title}</h3>
      <p className="d25-tsub">{subtitle}</p>
      <span className="d25-badge">{badge}</span>
      {rows.length === 0 ? (
        <p className="d25-tempty">No matchup data for this lane.</p>
      ) : (
        <>
          <div className="d25-thead" aria-hidden="true">
            <span className="d25-h-idx">#</span>
            <span className="d25-h-champ">Champion</span>
            <span className="d25-h-val">{metric === "gold" ? "Gold @ 15" : "Win rate"}</span>
            <span className="d25-h-games">Games</span>
          </div>
          <ol className="d25-tbody">
            {rows.map((row, index) => (
              <li key={row.champId} className="d25-trow">
                <span className="d25-idx">{index + 1}</span>
                <span className="d25-champ">
                  <IconWithFallback
                    src={champIcons.get(row.champId)?.icon ?? ""}
                    alt={row.name}
                    fallbackGlyph={row.name}
                    size={32}
                    className="d25-cicon"
                  />
                  <span className="d25-cname">{row.name}</span>
                </span>
                <span className={metric === "gold" ? "d25-val-gold" : "d25-val-wr"}>
                  {metric === "gold" ? formatGold(row.goldAt15) : `${(row.winRate * 100).toFixed(2)}%`}
                </span>
                <span className="d25-games">{row.games.toLocaleString("en-US")}</span>
              </li>
            ))}
          </ol>
        </>
      )}
    </section>
  );
}

export default function CounterPicksStrip({ enemyId, enemyName, lane, champIcons, loadCounters, laneOpponentId }: {
  enemyId: number | null; enemyName: string | null; lane: LaneId;
  champIcons: Map<number, ChampionIconEntry>;
  loadCounters: (params: DraftCountersParams, signal: AbortSignal) => Promise<DraftCountersResponse>;
  laneOpponentId: number | null;
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

  if (enemyId === null) {
    return (
      <section aria-label="Counters" className="d25-counters">
        <h2 className="d25-chead-title">Counters</h2>
        <p className="d25-cempty-hint">Mark an enemy as your lane opponent to see counters.</p>
        <div className="d25-tables">
          <section aria-label="Highest lane gold advantage" className="d25-tcard">
            <h3 className="d25-ttitle">Highest lane gold advantage</h3>
            <p className="d25-tempty">No matchup selected.</p>
          </section>
          <section aria-label="Lowest match win rates" className="d25-tcard">
            <h3 className="d25-ttitle">Lowest match win rates</h3>
            <p className="d25-tempty">No matchup selected.</p>
          </section>
        </div>
      </section>
    );
  }

  const enemy = enemyName ?? `Champion #${enemyId}`;
  const enemyIcon = champIcons.get(enemyId)?.icon ?? "";
  const marked = laneOpponentId !== null && laneOpponentId === enemyId;
  const patch = state.status === "ok" ? ` · Patch ${state.data.patch}` : "";
  const smallSample = state.status === "ok" &&
    [...state.data.bestLaneCounters, ...state.data.worstPicks].some(row => row.games < SMALL_SAMPLE_GAMES);

  return (
    <section aria-label={`u.gg counters vs ${enemy}`} className="d25-counters">
      <div className="d25-chead">
        <IconWithFallback src={enemyIcon} alt={`${enemy} portrait`} fallbackGlyph={enemy} size={66} className="d25-chead-portrait" />
        <div className="d25-chead-mid">
          <div className="d25-chead-row">
            <h2 className="d25-chead-title">Counters vs {enemy}</h2>
            {marked && <span className="d25-pill-laneopp">Lane opponent</span>}
          </div>
          <p className="d25-meta">u.gg · {LANE_LABEL[lane]} · World · Emerald+ · Ranked Solo{patch}</p>
        </div>
        <p className="d25-hint">Select an enemy above to change matchup.</p>
      </div>
      {smallSample && (
        <p role="note" className="d25-warn">
          <WarningCircle size={20} weight="fill" color="#F2BE4F" aria-hidden="true" />
          <span>Small samples — compare game counts before choosing.</span>
        </p>
      )}
      {state.status === "loading" && <p role="status" className="d25-loading">Loading u.gg matchups…</p>}
      {state.status === "error" && <p role="status" className="d25-loading">u.gg counters are unavailable. Open the u.gg tab to check the site, then reselect the opponent.</p>}
      {state.status === "ok" && (
        <div className="d25-tables">
          <CounterTable
            id="d25-table-best"
            title={`Highest lane gold advantage`}
            subtitle={`Vs ${enemy} · Ranked by gold difference at 15 minutes`}
            badge={`Top ${state.data.bestLaneCounters.length}`}
            rows={state.data.bestLaneCounters}
            metric="gold"
            champIcons={champIcons}
          />
          <CounterTable
            id="d25-table-worst"
            title={`Lowest match win rates`}
            subtitle={`Vs ${enemy} · Ranked by match win rate`}
            badge={`Bottom ${state.data.worstPicks.length}`}
            rows={state.data.worstPicks}
            metric="wr"
            champIcons={champIcons}
          />
        </div>
      )}
    </section>
  );
}
