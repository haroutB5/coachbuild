"use client";

import { useEffect, useRef, useState } from "react";
import type { ChampionIconEntry } from "@/components/proAssets";
import { IconWithFallback } from "@/components/IconWithFallback";
import { roleLabel, type LaneRecommendationRow, type LaneRecommendations } from "@/components/live/laneScoresClient";

type PanelState = { status: "loading" } | { status: "ok"; data: LaneRecommendations } | { status: "error" };

function formatLastPlayed(iso: string | null): string | null {
  if (!iso) return null;
  const value = new Date(iso);
  if (Number.isNaN(value.getTime())) return null;
  return value.toLocaleDateString();
}

function HistoryList({ title, subtitle, rows, tone, champIcons }: {
  title: string; subtitle: string; rows: LaneRecommendationRow[]; tone: "good" | "bad";
  champIcons: Map<number, ChampionIconEntry>;
}) {
  return <section aria-label={title} className="d25-tcard">
    <h3 className="d25-ttitle">{title}</h3>
    <p className="d25-tsub">{subtitle}</p>
    {rows.length === 0 ? <p className="d25-tempty">Nothing scored here yet.</p> :
      <>
        <div className="d25-thead" aria-hidden="true">
          <span className="d25-h-champ">Champion</span>
          <span className="d25-h-val">Score</span>
          <span className="d25-h-games">Games</span>
        </div>
        <ol className="d25-tbody">
          {rows.map(row => {
            // n=1 is a single game. It must never read with the weight of n=8,
            // so it is called out in words. No confidence score, no bar, no
            // star rating — n and the mean are the only facts we have.
            const single = row.games === 1;
            const lastPlayed = formatLastPlayed(row.lastPlayedAt);
            const name = champIcons.get(row.championId)?.name ?? row.championName;
            return <li key={row.championId} className="d25-trow d25-trow-history">
              <span className="d25-champ">
                <IconWithFallback src={champIcons.get(row.championId)?.icon ?? ""} alt={name}
                  fallbackGlyph={name} size={32} className="d25-cicon" />
                <span className="d25-cname">{name}
                  {lastPlayed && <span className="d25-clast">Last played {lastPlayed}</span>}
                </span>
              </span>
              <span className={tone === "good" ? "d25-val-good" : "d25-val-bad"}>
                {row.mean.toFixed(1)}/10 avg
              </span>
              {/* Deliberately NOT red. The mean beside it is already
                  colour-coded good/bad for matchup quality, and sample size is
                  a different axis entirely — a red "1 game only" under a green
                  9.0 would read as "this matchup is bad", which is the opposite
                  of what it says. */}
              {single
                ? <span className="d25-single">1 game only</span>
                : <span className="d25-games">{row.games} games</span>}
            </li>;
          })}
        </ol>
      </>}
  </section>;
}

/**
 * "Your lane history vs {Enemy}" — the personal counterpart to
 * CounterPicksStrip. The two sit side by side and MUST NOT read as one
 * dataset: the strip is thousands of u.gg games, this is the handful of games
 * the user scored themselves, so the provenance line states that outright and
 * repeats the total sample.
 *
 * Renders null when there is no opponent or no scored games at all — an empty
 * personal box in every champ select is noise.
 */
export default function LaneHistoryPanel({ enemyId, enemyName, roleId, champIcons, loadRecommendations, refreshKey = 0 }: {
  enemyId: number | null; enemyName: string | null; roleId: number;
  champIcons: Map<number, ChampionIconEntry>;
  loadRecommendations: (enemy: number, role: number, signal: AbortSignal) => Promise<LaneRecommendations>;
  refreshKey?: number;
}) {
  const [state, setState] = useState<PanelState>({ status: "loading" });
  const [retry, setRetry] = useState(0);
  const reqId = useRef(0);
  useEffect(() => {
    if (enemyId === null) return;
    const id = ++reqId.current;
    const controller = new AbortController();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset when the external matchup selection changes.
    setState({ status: "loading" });
    loadRecommendations(enemyId, roleId, controller.signal).then(data => {
      if (!controller.signal.aborted && id === reqId.current) setState({ status: "ok", data });
    }).catch(() => {
      if (!controller.signal.aborted && id === reqId.current) setState({ status: "error" });
    });
    return () => controller.abort();
  }, [enemyId, roleId, loadRecommendations, refreshKey, retry]);

  if (enemyId === null) return null;
  if (state.status === "ok" && state.data.totalGames === 0) return null;
  const enemy = enemyName ?? `Champion #${enemyId}`;
  const role = roleLabel(roleId);

  return <section aria-label={`Your own scored lane history vs ${enemy}`} className="d25-history">
    <h2 className="d25-history-title">Your lane history vs {enemy}</h2>
    <p className="d25-history-sub">
      Source: your own scored games on this PC{role ? ` · ${role}` : ""}
      {state.status === "ok" ? ` · ${state.data.totalGames} game${state.data.totalGames === 1 ? "" : "s"} scored vs ${enemy}` : ""}
      {" · not u.gg"}
    </p>
    {state.status === "loading" && <p role="status" className="d25-loading">Loading your scored games…</p>}
    {state.status === "error" && <div className="d25-history-error">
      <p role="status" className="d25-loading">Your lane history is unavailable. Check the companion connection and try again.</p>
      <button type="button" onClick={() => setRetry(value => value + 1)}
        className="d25-btn-outline">Retry lane history</button>
    </div>}
    {state.status === "ok" && <div className="d25-tables">
      <HistoryList title={`Your best scores vs ${enemy}`} subtitle="Your highest average lane scores · sample size shown per champion"
        rows={state.data.best} tone="good" champIcons={champIcons} />
      {state.data.worst.length > 0 && <HistoryList title={`Your worst scores vs ${enemy}`} subtitle="Lanes you scored badly · sample size shown per champion"
        rows={state.data.worst} tone="bad" champIcons={champIcons} />}
    </div>}
  </section>;
}
