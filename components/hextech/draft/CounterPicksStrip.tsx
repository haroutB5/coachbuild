"use client";

import { useEffect, useRef, useState } from "react";
import type { LaneId } from "@/components/hextech/heroContracts";
import { LANE_TO_ROLE_ID } from "@/components/hextech/heroContracts";
import type { ChampionIconEntry } from "@/components/proAssets";
import { IconWithFallback } from "@/components/IconWithFallback";
import type { DraftCountersParams, DraftCountersResponse } from "@/components/live/draftCounters";
import { resolveCounterPickPool, splitCounterSuggestions, type CounterPickPoolSource } from "@/lib/lolalytics/pool";

type StripState =
  | { status: "loading" }
  | { status: "ok"; data: DraftCountersResponse }
  | { status: "error" };

const POOL_GROUP_LIMIT = 5;
const OVERALL_GROUP_LIMIT = 5;

function formatPct01(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function formatDelta(pp: number): string {
  return `${pp >= 0 ? "+" : ""}${pp.toFixed(1)}`;
}

function formatGames(value: number): string {
  return Math.round(value).toLocaleString();
}

function tierLabel(tier: string): string {
  // "emerald_plus" -> "Emerald+"; unknown slugs pass through rather than
  // rendering blank (the annotation must never invent a bracket).
  const m = tier.match(/^([a-z0-9]+)_plus$/i);
  if (m) return `${m[1].charAt(0).toUpperCase()}${m[1].slice(1).toLowerCase()}+`;
  return tier;
}

function poolSourceLabel(source: CounterPickPoolSource): string | null {
  if (source === "lcu") return "your most-played";
  if (source === "mystats") return "your ranked pool";
  return null;
}

function SuggestionRow({
  champId,
  name,
  winRate,
  delta2pp,
  games,
  champIcons,
}: {
  champId: number;
  name: string;
  winRate: number;
  delta2pp: number;
  games: number;
  champIcons: Map<number, ChampionIconEntry>;
}) {
  const entry = champIcons.get(champId);
  const label = entry?.name ?? name;
  return (
    <li className="flex min-w-0 items-center gap-2.5 py-1.5">
      <span className="h-8 w-8 flex-shrink-0 overflow-hidden rounded-[7px]" style={{ boxShadow: "inset 0 0 0 1px rgba(233,233,237,.12)" }}>
        <IconWithFallback src={entry?.icon ?? ""} alt={label} fallbackGlyph={label} className="h-full w-full object-cover" size={32} />
      </span>
      <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-txt">{label}</span>
      <span className="flex-shrink-0 text-[12px] font-semibold tabular-nums text-good" title="Win rate vs this enemy (lolalytics)">
        {formatPct01(winRate)}
      </span>
      <span className="w-[58px] flex-shrink-0 text-right text-[11px] tabular-nums text-txt/[0.55]" title="Normalised matchup edge (delta 2, percentage points)">
        Δ2 {formatDelta(delta2pp)}
      </span>
      <span className="w-[52px] flex-shrink-0 text-right text-[11px] tabular-nums text-txt/[0.38]" title="Matchup sample">
        {formatGames(games)}
      </span>
    </li>
  );
}

/** "Counter picks" strip for /draft's aside. Shows when a lane opponent is
 *  resolved (explicit tag or the recommend feed's statistical inference):
 *  top lolalytics counters for THAT enemy in the user's lane, split into the
 *  user's pool first and the global top beside it. Renders nothing with no
 *  resolved enemy — guessing against an arbitrary enemy would answer a
 *  question nobody asked. */
export default function CounterPicksStrip({
  enemyId,
  enemyName,
  lane,
  champIcons,
  mystatsPoolChampIds,
  lcuPoolChampIds = null,
  loadCounters,
}: {
  /** Resolved lane-opponent champion id, or null when none is resolved. */
  enemyId: number | null;
  enemyName: string | null;
  lane: LaneId;
  champIcons: Map<number, ChampionIconEntry>;
  /** This lane's played pool (mystats personalPool ids) — fallback source. */
  mystatsPoolChampIds: number[];
  /** Companion LCU pool ids when a pool endpoint exists — preferred source
   *  (pool-provider seam, see lib/lolalytics/pool.ts). Null today. */
  lcuPoolChampIds?: number[] | null;
  loadCounters: (params: DraftCountersParams, signal: AbortSignal) => Promise<DraftCountersResponse>;
}) {
  const [state, setState] = useState<StripState>({ status: "loading" });
  const reqIdRef = useRef(0);

  useEffect(() => {
    if (enemyId === null) return;
    const requestId = ++reqIdRef.current;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loading is the existing request-state transition.
    setState({ status: "loading" });
    const controller = new AbortController();
    const params = { enemy: enemyId, lane: LANE_TO_ROLE_ID[lane] };
    const request = loadCounters(params, controller.signal);
    request.catch(() => null).then(
      (data) => {
        if (controller.signal.aborted || reqIdRef.current !== requestId) return;
        setState(data ? { status: "ok", data } : { status: "error" });
      }
    );
    return () => controller.abort();
  }, [enemyId, lane, loadCounters]);

  if (enemyId === null) return null;

  const pool = resolveCounterPickPool({ lcuPoolChampIds, mystatsPoolChampIds });
  const split =
    state.status === "ok"
      ? splitCounterSuggestions(state.data.suggestions, pool, POOL_GROUP_LIMIT, OVERALL_GROUP_LIMIT)
      : null;
  const poolLabel = poolSourceLabel(pool.source);

  return (
    <section
      className="rounded-[9px] p-3.5"
      style={{ boxShadow: "inset 0 0 0 1px rgba(233,233,237,.08)", background: "#1b1d2a" }}
      aria-labelledby="counter-picks-heading"
    >
      <div className="flex items-baseline justify-between gap-2">
        <h2 id="counter-picks-heading" className="text-[10px] font-semibold uppercase tracking-[0.14em] text-accent-300">
          Counter picks
        </h2>
        {state.status === "ok" && (
          <p className="text-[10px] tabular-nums text-txt/[0.38]">
            lolalytics {tierLabel(state.data.tier)} {state.data.patch}
          </p>
        )}
      </div>
      <p className="mt-1 text-[11px] leading-[1.45] text-txt/[0.55]">
        {enemyName ?? `Champion #${enemyId}`} counters · ≥500 games per matchup
      </p>

      {state.status === "loading" && (
        <div className="mt-2 space-y-2" aria-label="Loading counter picks">
          <div className="h-11 rounded-[6px] bg-txt/[0.05]" />
          <div className="h-11 rounded-[6px] bg-txt/[0.05]" />
          <div className="h-11 rounded-[6px] bg-txt/[0.05]" />
        </div>
      )}

      {state.status === "error" && (
        <p className="mt-2 text-[11.5px] leading-[1.45] text-txt/[0.5]">
          Counter picks are unavailable right now. Lolalytics could not be fetched or its page format changed.
        </p>
      )}

      {state.status === "ok" && state.data.suggestions.length === 0 && (
        <p className="mt-2 text-[11.5px] leading-[1.45] text-txt/[0.5]">
          No reliable lolalytics counter is available for this enemy yet ({state.data.gatedRows} matchups below the 500-game gate).
        </p>
      )}

      {state.status === "ok" && split && (split.poolPicks.length > 0 || split.overallPicks.length > 0) && (
        <div className="mt-1">
          {split.poolPicks.length > 0 && (
            <div className="mt-2">
              <p className="text-[9px] font-semibold uppercase tracking-[0.12em] text-txt/[0.42]">
                Your pool{poolLabel ? ` · ${poolLabel}` : ""}
              </p>
              <ul className="divide-y divide-txt/[0.06]">
                {split.poolPicks.map((s) => (
                  <SuggestionRow key={s.champId} champId={s.champId} name={s.name} winRate={s.winRate} delta2pp={s.delta2pp} games={s.games} champIcons={champIcons} />
                ))}
              </ul>
            </div>
          )}
          {split.overallPicks.length > 0 && (
            <div className="mt-2">
              <p className="text-[9px] font-semibold uppercase tracking-[0.12em] text-txt/[0.42]">Overall</p>
              <ul className="divide-y divide-txt/[0.06]">
                {split.overallPicks.map((s) => (
                  <SuggestionRow key={s.champId} champId={s.champId} name={s.name} winRate={s.winRate} delta2pp={s.delta2pp} games={s.games} champIcons={champIcons} />
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
