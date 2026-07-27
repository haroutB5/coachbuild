"use client";

// ─────────────────────────────────────────────────────────────────────────────
// components/hextech/ChampionPickPrompt.tsx — what Builds shows before you have
// picked anything (fresh install, or storage cleared).
//
// REDESIGNED 2026-07-27 (user directive: the old version was a huge bordered
// card with two paragraphs of prose and ~400px of pure empty space below it —
// "that large text with nothing else" on a real phone). The prompt itself is
// now ONE line; the space it used to waste is filled with real, already-
// available data instead:
//
//  - "Your Lanes"    — the signed-in account's own most-played champion per
//                       lane (GET /api/mystats/summary, DISPLAY-ONLY per the
//                       repo's hard rule — this never feeds a score/ranking,
//                       it only routes a tap). Hidden entirely when the
//                       account can't resolve or has no games yet.
//  - "Recently viewed" — a short local list of champions actually looked at on
//                       THIS device (lib/recentChampions.ts, new, additive —
//                       separate from lib/lastChampion.ts's single-slot
//                       memory). Empty on a fresh browser; hidden until it
//                       has something real to show.
//  - "Trending this patch" — the biggest win-rate movers between the last two
//                       patches (GET /api/patch-movers, already computed for
//                       /movers — reused here, not recomputed).
//
// Every section is real data with an honest degrade: unresolved/empty/failed
// sources simply don't render (never a fake placeholder row, never an
// invented number) — see each section's guard below. If literally nothing is
// available (new device, DB unconfigured, movers unsupported), the original
// short explanatory line still shows so the page never looks broken.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from "react";
import Link from "next/link";
import { LANE_ORDER, LANE_LABEL, LANE_TO_ROLE_ID, type LaneId } from "./heroContracts";
import { fetchMyStatsSummary, buildMyStatsRows, type MyStatsRecord, type MyStatsChampionRow } from "./myStats";
import { getChampionIconMap, type ChampionIconEntry } from "@/components/proAssets";
import { IconWithFallback } from "@/components/IconWithFallback";
import { readRecentChampions, type RecentChampionEntry } from "@/lib/recentChampions";
import type { Mover } from "./MoverRow";

interface ChampionPickPromptProps {
  /** Selects `championId` and lands directly on `lane` — every section below
   *  already knows both, so this skips the async "most-played lane" lookup
   *  app/page.tsx's search path uses for a blind pick. */
  onQuickPick: (championId: number, lane: LaneId) => void;
}

// Abbreviated to fit a 5-across row on a 375px phone — same shorthand
// ChampionHero's own lane pills use (LANE_LABEL's full words stay in
// aria-label/title for accessibility).
const LANE_SHORT: Record<LaneId, string> = { top: "TOP", jungle: "JG", mid: "MID", bot: "BOT", support: "SUP" };
// role 0-4 -> LaneId, the exact inverse of heroContracts' LANE_TO_ROLE_ID.
const ROLE_TO_LANE: LaneId[] = LANE_ORDER.slice().sort((a, b) => LANE_TO_ROLE_ID[a] - LANE_TO_ROLE_ID[b]);

interface MoversWire {
  patch: string;
  prevPatch: string;
  movers: Mover[];
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

export default function ChampionPickPrompt({ onQuickPick }: ChampionPickPromptProps) {
  const [iconMap, setIconMap] = useState<Map<number, ChampionIconEntry> | null>(null);
  const [myRecords, setMyRecords] = useState<MyStatsRecord[] | null>(null); // null while loading
  const [myUnavailable, setMyUnavailable] = useState(false);
  const [recent, setRecent] = useState<RecentChampionEntry[]>([]);
  const [movers, setMovers] = useState<MoversWire | null>(null); // null while loading
  const [moversUnavailable, setMoversUnavailable] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getChampionIconMap().then((m) => {
      if (!cancelled) setIconMap(m);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchMyStatsSummary().then((summary) => {
      if (cancelled) return;
      if (!summary || summary.accountUnresolved || summary.records.length === 0) {
        setMyUnavailable(true);
        return;
      }
      // Only lane-resolvable roles (0-4) — an "Other"/ARAM record has no
      // lane to quick-pick into.
      const resolvable = summary.records.filter((r) => r.role >= 0 && r.role <= 4);
      if (resolvable.length === 0) {
        setMyUnavailable(true);
        return;
      }
      setMyRecords(resolvable);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    setRecent(readRecentChampions());
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/patch-movers")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: MoversWire | { unsupported: true } | null) => {
        if (cancelled) return;
        if (!data || "unsupported" in data || !Array.isArray(data.movers) || data.movers.length === 0) {
          setMoversUnavailable(true);
          return;
        }
        setMovers(data);
      })
      .catch(() => {
        if (!cancelled) setMoversUnavailable(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const iconOf = (championId: number) => iconMap?.get(championId);
  const myDecorated = myRecords ? buildMyStatsRows(myRecords, iconOf) : null;

  // Top record per lane (myDecorated already arrives games-DESC — first match
  // per role is that lane's most-played), keyed by LaneId.
  const laneTop = new Map<LaneId, MyStatsChampionRow>();
  if (myDecorated) {
    for (const row of myDecorated) {
      const lane = ROLE_TO_LANE[row.role];
      if (lane && !laneTop.has(lane)) laneTop.set(lane, row);
    }
  }

  const myLoading = myRecords === null && !myUnavailable;
  const moversLoading = movers === null && !moversUnavailable;
  const stillLoading = myLoading || moversLoading;

  const hasLaneData = laneTop.size > 0;
  const hasRecent = recent.length > 0;
  const topMovers = movers?.movers.slice(0, 4) ?? [];
  const hasMovers = topMovers.length > 0;
  const hasAnyContent = hasLaneData || hasRecent || hasMovers;

  return (
    <div className="mt-2">
      <div className="rounded-2xl border border-line bg-panel/60 px-5 py-7 sm:px-6 sm:py-8 text-center sm:text-left">
        <p className="text-[10.5px] tracking-[1.5px] uppercase text-teal font-bold">Builds</p>
        <h2 className="mt-2 font-display text-xl sm:text-2xl text-txt tracking-[-0.01em]">
          Search a champion to see their build.
        </h2>
        {/* The old two-paragraph explainer only earns its space back when
            there's genuinely nothing else to show. */}
        {!stillLoading && !hasAnyContent && (
          <p className="mx-auto sm:mx-0 mt-3 max-w-md text-[13.5px] leading-relaxed text-mut">
            Runes, summoners, item order and pro builds for any champion and lane — use the search at
            the top.
          </p>
        )}
      </div>

      {stillLoading && (
        <div className="mt-5 rounded-2xl border border-line bg-panel/40 p-4 animate-pulse space-y-3" aria-hidden="true">
          <div className="grid grid-cols-5 gap-1.5">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="aspect-square rounded-xl bg-panel2" />
            ))}
          </div>
          <div className="h-16 rounded-xl bg-panel2" />
        </div>
      )}

      {!stillLoading && (
        <div className="mt-5 space-y-5">
          {hasLaneData && (
            <section aria-label="Your lanes">
              <p className="text-[10px] tracking-[0.12em] uppercase text-mut font-semibold mb-2 px-0.5">
                Your Lanes
              </p>
              <div className="grid grid-cols-5 gap-1.5">
                {LANE_ORDER.map((lane) => {
                  const row = laneTop.get(lane);
                  if (!row) {
                    return (
                      <div
                        key={lane}
                        aria-label={`No ${LANE_LABEL[lane]} data yet`}
                        className="flex flex-col items-center gap-1 rounded-xl border border-line/60 bg-panel/30 py-2.5 opacity-40"
                      >
                        <span className="text-[9px] tracking-[0.08em] uppercase text-mut font-semibold">
                          {LANE_SHORT[lane]}
                        </span>
                        <span aria-hidden="true" className="w-8 h-8 rounded-lg bg-panel2 flex items-center justify-center text-mut text-[11px]">
                          —
                        </span>
                      </div>
                    );
                  }
                  return (
                    <button
                      key={lane}
                      type="button"
                      onClick={() => onQuickPick(row.championId, lane)}
                      aria-label={`${row.name} — your ${LANE_LABEL[lane]}, ${pct(row.winrate)} win rate over ${row.games} games`}
                      className="flex flex-col items-center gap-1 rounded-xl border border-line bg-panel py-2.5 min-h-[44px] transition-colors hover:border-teal-dim hover:bg-panel2 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal"
                    >
                      <span className="text-[9px] tracking-[0.08em] uppercase text-mut font-semibold">
                        {LANE_SHORT[lane]}
                      </span>
                      <IconWithFallback
                        src={row.icon}
                        alt={row.name}
                        fallbackGlyph={row.name}
                        size={32}
                        className="w-8 h-8 rounded-lg object-cover"
                      />
                      <span className="text-[10.5px] font-bold tabular-nums text-txt">{pct(row.winrate)}</span>
                    </button>
                  );
                })}
              </div>
            </section>
          )}

          {hasRecent && (
            <section aria-label="Recently viewed champions">
              <p className="text-[10px] tracking-[0.12em] uppercase text-mut font-semibold mb-2 px-0.5">
                Recently Viewed
              </p>
              <div className="flex flex-wrap gap-2">
                {recent.map((entry) => {
                  const entry2 = iconOf(entry.championId);
                  const name = entry2?.name ?? `Champion #${entry.championId}`;
                  return (
                    <button
                      key={entry.championId}
                      type="button"
                      onClick={() => onQuickPick(entry.championId, entry.lane)}
                      className="flex items-center gap-1.5 pl-1.5 pr-3 py-1 min-h-[44px] rounded-full bg-panel2 border border-line hover:border-teal-dim transition-colors active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal"
                    >
                      <IconWithFallback
                        src={entry2?.icon ?? ""}
                        alt={name}
                        fallbackGlyph={name}
                        size={28}
                        className="w-7 h-7 rounded-md object-cover flex-shrink-0"
                      />
                      <span className="text-[12.5px] text-txt truncate max-w-[110px]">{name}</span>
                    </button>
                  );
                })}
              </div>
            </section>
          )}

          {hasMovers && (
            <section aria-label="Trending this patch">
              <div className="flex items-baseline justify-between mb-2 px-0.5">
                <p className="text-[10px] tracking-[0.12em] uppercase text-mut font-semibold">
                  Trending This Patch
                </p>
                {movers && (
                  <span className="text-[10.5px] text-mut/70 tabular-nums">
                    {movers.prevPatch} &rarr; {movers.patch}
                  </span>
                )}
              </div>
              <div className="rounded-xl border border-line bg-panel divide-y divide-line">
                {topMovers.map((m) => {
                  const icon = iconOf(m.championId)?.icon ?? "";
                  const lane = m.role >= 0 && m.role <= 4 ? ROLE_TO_LANE[m.role] : null;
                  const positive = m.deltaPp >= 0;
                  return (
                    <button
                      key={`${m.championId}-${m.role}`}
                      type="button"
                      onClick={() => onQuickPick(m.championId, lane ?? "mid")}
                      className="w-full flex items-center gap-2.5 px-3 py-2.5 min-h-[44px] text-left transition-colors hover:bg-panel2 active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal focus-visible:ring-inset"
                    >
                      <IconWithFallback
                        src={icon}
                        alt={m.championName}
                        fallbackGlyph={m.championName}
                        size={28}
                        className="w-7 h-7 rounded-md object-cover flex-shrink-0"
                      />
                      <span className="flex-1 min-w-0 text-[12.5px] text-txt font-semibold truncate">
                        {m.championName}
                        {lane && <span className="ml-1.5 text-[10px] text-mut font-normal">{LANE_SHORT[lane]}</span>}
                      </span>
                      <span
                        className={`text-[12.5px] font-bold tabular-nums flex-shrink-0 ${positive ? "text-good" : "text-bad"}`}
                      >
                        {positive ? "+" : ""}
                        {m.deltaPp.toFixed(2)}pp
                      </span>
                    </button>
                  );
                })}
              </div>
              <Link
                href="/movers"
                // min-h-[44px] + vertical padding: measured at 17px tall on a
                // 390px viewport, well under the 44px touch guideline, and this
                // is the only tap target on the redesigned Builds surface that
                // was. `inline-flex items-center` keeps it reading as a text
                // link while giving the tappable box real height.
                className="mt-1 inline-flex items-center min-h-[44px] py-2 text-[11.5px] text-teal hover:underline px-0.5"
              >
                See all patch movers &rarr;
              </Link>
            </section>
          )}
        </div>
      )}

      <p className="mt-6 text-[12px] text-center sm:text-left text-mut/70">
        Playing right now? Install the companion and Builds follows your champ select automatically.
      </p>
    </div>
  );
}
