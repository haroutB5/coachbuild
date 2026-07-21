"use client";

// ─────────────────────────────────────────────────────────────────────────────
// /mystats — "My Stats" personal match tracker (backend by engy, 2026-07-21 —
// see HANDOFF.md's "My Stats" entries + lib/mystats/**). Standalone shell
// page, same convention as /draft and /movers (not the two-Sidebar main
// layout — an auxiliary surface reachable from TabNav/Sidebar).
//
// HARD USER DIRECTIVES this page must honor:
//  (1) DISPLAY ONLY — this data never feeds any score/ranking anywhere (see
//      components/hextech/myStats.ts's header + lib/draft/recommend.ts's
//      PersonalPlayResult doc comment for where this same data resurfaces,
//      additively, on the Draft page).
//  (2) CURRENT SEASON ONLY — the "Season 2026" label (SEASON_LABEL, echoed
//      on the wire so this page never re-derives the boundary constant) is
//      shown wherever personal stats render.
//
// Both /api/mystats/* routes are `no-store` unconditionally (private
// per-user data) — fetched client-side only, no server-side caching
// surprises possible even by accident.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from "react";
import TabNav from "@/components/TabNav";
import { IconWithFallback } from "@/components/IconWithFallback";
import { getChampionIconMap, type ChampionIconEntry } from "@/components/proAssets";
import {
  fetchMyStatsSummary,
  fetchMyStatsMatchups,
  buildMyStatsRows,
  buildMyStatsMatchupRows,
  computeMyStatsOverall,
  type MyStatsSummary,
  type MyStatsChampionRow,
  type MyStatsMatchupRow,
} from "@/components/hextech/myStats";

function pct(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

type SummaryState = { status: "loading" } | { status: "error" } | { status: "ok"; summary: MyStatsSummary };

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

function TableSkeleton() {
  return (
    <div className="bg-panel border border-line rounded-xl px-5 py-4 animate-pulse space-y-3">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-panel2 flex-shrink-0" />
          <div className="flex-1 space-y-1.5">
            <div className="h-2.5 w-24 bg-panel2 rounded" />
            <div className="h-2 w-16 bg-panel2 rounded" />
          </div>
          <div className="h-3 w-12 bg-panel2 rounded flex-shrink-0" />
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

  useEffect(() => {
    getChampionIconMap().then(setChampIcons);
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchMyStatsSummary().then((data) => {
      if (cancelled) return; // gotcha (q): stale-response guard, same pattern as BuildTabContent/draft page
      setState(data ? { status: "ok", summary: data } : { status: "error" });
    });
    return () => {
      cancelled = true;
    };
  }, []);

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

  return (
    <div className="min-h-screen pb-16">
      <div className="max-w-[720px] mx-auto px-4 sm:px-6">
        <header className="pt-8 pb-5 border-b border-line mb-6">
          <TabNav />

          <div className="text-center mb-2">
            <h1 className="text-3xl font-extrabold tracking-tight text-balance">
              My <span className="text-teal">Stats</span>
            </h1>
            <p className="text-mut text-sm mt-1">Your own personal match history — for context, never for ranking.</p>
          </div>

          {state.status === "ok" && !state.summary.accountUnresolved && (
            <div className="flex flex-col items-center gap-1 mt-3">
              <p className="text-[11px] text-mut/80 tabular-nums">
                {state.summary.riotId ?? "Account"}
                <span aria-hidden="true"> &middot; </span>
                <span className="text-teal-dim font-semibold">{state.summary.season || "Current season"}</span>
              </p>
              {overall && overall.games > 0 && (
                <p className="text-[13.5px] font-bold tabular-nums text-txt">
                  {overall.games} games <span className="text-mut/60" aria-hidden="true">&middot;</span>{" "}
                  <span className={overall.winrate >= 0.5 ? "text-good" : "text-bad"}>{pct(overall.winrate)}</span> overall
                </p>
              )}
            </div>
          )}
        </header>

        {state.status === "loading" && <TableSkeleton />}

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

        {state.status === "ok" && !state.summary.accountUnresolved && rows.length > 0 && (
          <div className="bg-panel border border-line rounded-xl px-5">
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

                  {/* Always mounted (hidden via the `hidden` attribute, not
                      unmounted) so aria-controls always resolves to a real
                      element for assistive tech, per fixing-accessibility's
                      disclosure-widget guidance. The matchup fetch itself is
                      still gated on `expandedId`, so collapsing never keeps
                      a stale fetch running. */}
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
        )}

        <footer className="mt-10 pt-4 border-t border-line text-center text-[11px] text-mut space-y-1">
          <p>Your own match history — shown for context only, never blended into any recommendation or ranking.</p>
          {process.env.NEXT_PUBLIC_APP_VERSION && <p className="text-mut">v{process.env.NEXT_PUBLIC_APP_VERSION}</p>}
        </footer>
      </div>
    </div>
  );
}
