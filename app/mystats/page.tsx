"use client";

// ─────────────────────────────────────────────────────────────────────────────
// /mystats — "My Stats" personal match tracker (backend by engy, 2026-07-21 —
// see HANDOFF.md's "My Stats" entries + lib/mystats/**). v0.51 wave B:
// rebuilt around StatTiles/RecentGamesList/ChampionPoolCard (mockup 6.png),
// consuming the EXTENDED /api/mystats/summary (buildAdherencePct,
// winrateOnBuild, winrateOffBuild, priorSplitWinrate, recentGames[]) engo is
// adding concurrently in myStats.ts's normalizer. Every extended field is
// read through MyStatsSummaryExtended (declared locally below, NOT added to
// myStats.ts itself — that file is engo's pure-.ts contract territory this
// wave) and defaults to null/[] when absent, so this page renders correctly
// whether or not that normalizer update has landed yet in the working tree.
//
// HARD USER DIRECTIVES this page must honor:
//  (1) DISPLAY ONLY — this data never feeds any score/ranking anywhere.
//  (2) CURRENT SEASON ONLY — the "Season 2026" label is shown wherever
//      personal stats render.
//
// Both /api/mystats/* routes are `no-store` unconditionally (private
// per-user data) — fetched client-side only, no server-side caching
// surprises possible even by accident.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from "react";
import { IconWithFallback } from "@/components/IconWithFallback";
import MyStatsRefresher from "@/components/hextech/MyStatsRefresher";
import PageHeader from "@/components/hextech/PageHeader";
import StatTiles from "@/components/hextech/mystats/StatTiles";
import RecentGamesList, { type RecentGameRow } from "@/components/hextech/mystats/RecentGamesList";
import ChampionPoolCard from "@/components/hextech/mystats/ChampionPoolCard";
import { getChampionIconMap, type ChampionIconEntry } from "@/components/proAssets";
import {
  fetchMyStatsSummary,
  fetchMyStatsMatchups,
  buildMyStatsRows,
  buildMyStatsMatchupRows,
  computeMyStatsOverall,
  computeMainChampion,
  type MyStatsSummary,
  type MyStatsChampionRow,
  type MyStatsMatchupRow,
} from "@/components/hextech/myStats";

// ── v0.51 wave-B extended wire contract (declared here, not in myStats.ts —
// see header comment above) ─────────────────────────────────────────────────
interface MyStatsSummaryExtended extends MyStatsSummary {
  buildAdherencePct?: number | null;
  winrateOnBuild?: number | null;
  winrateOffBuild?: number | null;
  priorSplitWinrate?: number | null;
  recentGames?: RecentGameRow[];
}

function pct(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

type SummaryState = { status: "loading" } | { status: "error" } | { status: "ok"; summary: MyStatsSummaryExtended };

type DetailState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error" }
  | { status: "empty" }
  | { status: "ok"; matchups: MyStatsMatchupRow[] };

function EmptyPanel({ title, body }: { title: string; body: string }) {
  return (
    <div className="bg-panel border border-line rounded-xl p-8 text-center">
      <div className="text-txt font-semibold mb-1 text-[13.5px]">{title}</div>
      <div className="text-mut text-[12px]">{body}</div>
    </div>
  );
}

function TilesSkeleton() {
  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 animate-pulse">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="bg-panel border border-line rounded-xl p-4 space-y-2">
          <div className="h-2 w-14 bg-panel2 rounded" />
          <div className="h-5 w-16 bg-panel2 rounded" />
        </div>
      ))}
    </div>
  );
}

export default function MyStatsPage() {
  const [champIcons, setChampIcons] = useState<Map<number, ChampionIconEntry>>(new Map());
  const [state, setState] = useState<SummaryState>({ status: "loading" });
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<DetailState>({ status: "idle" });
  // v0.50.0: bumped by MyStatsRefresher's onRefreshed when the on-demand
  // incremental ingest actually found new games.
  const [refetchKey, setRefetchKey] = useState(0);

  useEffect(() => {
    getChampionIconMap().then(setChampIcons);
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchMyStatsSummary().then((data) => {
      if (cancelled) return; // stale-response guard, same pattern as BuildTabContent/draft page
      setState(data ? { status: "ok", summary: data as MyStatsSummaryExtended } : { status: "error" });
    });
    return () => {
      cancelled = true;
    };
  }, [refetchKey]);

  useEffect(() => {
    if (expandedId === null) {
      setDetail({ status: "idle" });
      return;
    }
    let cancelled = false;
    setDetail({ status: "loading" });
    fetchMyStatsMatchups(expandedId).then((data) => {
      if (cancelled) return;
      if (!data) {
        setDetail({ status: "error" });
        return;
      }
      const rows = buildMyStatsMatchupRows(data.matchups, (id) => champIcons.get(id));
      setDetail(rows.length === 0 ? { status: "empty" } : { status: "ok", matchups: rows });
    });
    return () => {
      cancelled = true;
    };
  }, [expandedId, champIcons]);

  function toggleRow(championId: number) {
    setExpandedId((prev) => (prev === championId ? null : championId));
  }

  const rows: MyStatsChampionRow[] =
    state.status === "ok" ? buildMyStatsRows(state.summary.records, (id) => champIcons.get(id)) : [];
  const overall = state.status === "ok" ? computeMyStatsOverall(state.summary.records) : null;
  // Summed across roles — NOT rows[0], which is one (champion, role) record and
  // understated the headline whenever a champion was played in two lanes.
  const mainRow =
    state.status === "ok"
      ? computeMainChampion(state.summary.records, (id) => champIcons.get(id))
      : null;
  const recentGames = state.status === "ok" ? state.summary.recentGames ?? [] : [];

  return (
    <div className="min-h-screen pb-16">
      <div className="max-w-[1100px] mx-auto px-4 sm:px-6">
        <PageHeader
          title="My Stats"
          subtitle={
            state.status === "ok" && !state.summary.accountUnresolved
              ? `${state.summary.season || "Season"} · ${state.summary.riotId ?? "Account"} · from your local match history`
              : "Your own personal match history — for context, never for ranking."
          }
          right={<MyStatsRefresher onRefreshed={() => setRefetchKey((k) => k + 1)} />}
        />

        {state.status === "loading" && <TilesSkeleton />}

        {state.status === "error" && (
          <EmptyPanel
            title="Couldn't load your stats"
            body="Something went wrong fetching your personal match history. Try again shortly."
          />
        )}

        {state.status === "ok" && state.summary.accountUnresolved && (
          <EmptyPanel
            title="Account not linked yet"
            body="Your Riot account hasn't been resolved on the server yet — this is set once via a server config value and should populate automatically once ingest runs."
          />
        )}

        {state.status === "ok" && !state.summary.accountUnresolved && rows.length === 0 && (
          <EmptyPanel
            title="No games yet this season"
            body={`No recorded games for ${state.summary.season || "the current season"} yet — check back after your next few games.`}
          />
        )}

        {state.status === "ok" && !state.summary.accountUnresolved && rows.length > 0 && overall && (
          <div className="space-y-5">
            <StatTiles
              games={overall.games}
              seasonLabel={state.summary.season || ""}
              winrate={overall.winrate}
              priorSplitWinrate={state.summary.priorSplitWinrate ?? null}
              mainChampionName={mainRow?.name ?? null}
              mainChampionGames={mainRow?.games ?? null}
              mainChampionWinrate={mainRow?.winrate ?? null}
              buildAdherencePct={state.summary.buildAdherencePct ?? null}
            />

            <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-5">
              <RecentGamesList games={recentGames} iconOf={(id) => champIcons.get(id)} />
              <ChampionPoolCard
                rows={rows}
                winrateOnBuild={state.summary.winrateOnBuild ?? null}
                winrateOffBuild={state.summary.winrateOffBuild ?? null}
              />
            </div>

            {/* Secondary section — the pre-wave-B per-champion expandable
                matchup table, lightly restyled. Capability preserved
                verbatim (same fetch/toggle logic), just demoted below the
                new tiles/lists as a secondary drill-down. */}
            <div className="bg-panel border border-line rounded-xl px-5">
              <p className="pt-4 pb-2 text-[11px] tracking-[0.12em] uppercase text-mut font-semibold">
                Matchup history
              </p>
              <p className="sr-only" role="status">
                {rows.length} champions with recorded games this season, sorted by games played.
              </p>
              {rows.map((row) => {
                const expanded = expandedId === row.championId;
                const detailId = `mystats-detail-${row.championId}`;
                return (
                  <div key={row.championId} className="border-b border-line last:border-b-0">
                    <button
                      type="button"
                      onClick={() => toggleRow(row.championId)}
                      aria-expanded={expanded}
                      aria-controls={detailId}
                      className="w-full flex items-center gap-3 py-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal focus-visible:ring-offset-2 focus-visible:ring-offset-bg rounded-lg"
                    >
                      <span className="w-9 h-9 rounded-lg bg-black/30 border border-line overflow-hidden flex items-center justify-center flex-shrink-0">
                        <IconWithFallback src={row.icon} alt="" fallbackGlyph={row.name} className="w-full h-full object-cover" size={36} />
                      </span>

                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="text-[13px] text-txt font-semibold truncate">{row.name}</span>
                          <span className="text-[9px] tracking-[0.06em] uppercase font-bold px-1.5 py-0.5 rounded bg-panel2 text-mut border border-line flex-shrink-0">
                            {row.roleLabel}
                          </span>
                          {row.lowSample && (
                            <span className="text-[9px] tracking-[0.06em] uppercase font-bold px-1.5 py-0.5 rounded bg-panel2 text-mut border border-line flex-shrink-0">
                              Low sample
                            </span>
                          )}
                        </div>
                        <div className="text-[10.5px] text-mut tabular-nums mt-0.5">
                          {row.games}g &middot; {row.wins}W-{row.losses}L
                        </div>
                      </div>

                      <div className="text-right flex-shrink-0">
                        <div
                          className={`text-[13.5px] font-bold tabular-nums ${
                            row.lowSample ? "text-mut" : row.winrate >= 0.5 ? "text-good" : "text-bad"
                          }`}
                        >
                          {pct(row.winrate)}
                        </div>
                      </div>

                      <span
                        className={`text-mut text-[11px] transition-transform duration-150 flex-shrink-0 ${expanded ? "rotate-180" : ""}`}
                        aria-hidden="true"
                      >
                        &#9662;
                      </span>
                    </button>

                    <div id={detailId} hidden={!expanded} className="pb-3 pl-12 pr-1">
                      {expanded && detail.status === "loading" && <p className="text-[11px] text-mut py-2">Loading matchups…</p>}
                      {expanded && detail.status === "error" && (
                        <p className="text-[11px] text-bad py-2">Couldn&apos;t load matchups — try again.</p>
                      )}
                      {expanded && detail.status === "empty" && (
                        <p className="text-[11px] text-mut py-2">No lane-opponent data recorded for this champion.</p>
                      )}
                      {expanded && detail.status === "ok" && (
                        <div className="space-y-1.5 py-1">
                          {detail.matchups.map((m) => (
                            <div key={m.oppChampionId} className="flex items-center gap-2.5">
                              <span className="w-6 h-6 rounded bg-black/30 border border-line overflow-hidden flex items-center justify-center flex-shrink-0">
                                <IconWithFallback src={m.icon} alt="" fallbackGlyph={m.name} className="w-full h-full object-cover" size={24} />
                              </span>
                              <span className="text-[11.5px] text-txt flex-1 truncate">vs {m.name}</span>
                              <span className="text-[10.5px] text-mut tabular-nums flex-shrink-0">{m.games}g</span>
                              <span
                                className={`text-[11px] font-semibold tabular-nums w-20 text-right flex-shrink-0 ${
                                  m.lowSample ? "text-mut" : m.winrate >= 0.5 ? "text-good" : "text-bad"
                                }`}
                              >
                                {m.wins}-{m.losses} ({pct(m.winrate)})
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <footer className="mt-10 pt-4 border-t border-line text-center text-[11px] text-mut space-y-1">
          <p>Your own match history — shown for context only, never blended into any recommendation or ranking.</p>
          {process.env.NEXT_PUBLIC_APP_VERSION && <p className="text-mut">v{process.env.NEXT_PUBLIC_APP_VERSION}</p>}
        </footer>
      </div>
    </div>
  );
}
