"use client";

// ─────────────────────────────────────────────────────────────────────────────
// ChampionPoolCard — /mystats' "CHAMPION POOL" card (mockup 6.png). Consumes
// the existing MyStatsChampionRow[] (myStats.ts's buildMyStatsRows — already
// games-DESC sorted server-side, not re-sorted here).
//
// 2026-07-29 redesign: the on-build/off-build insight line MOVED OUT of this
// card and became the delta chip on the KPI strip's BUILD ADHERENCE cell (see
// mystats/StatTiles.tsx). It was never about the champion pool — it is a
// whole-account comparison that happened to be parked at the bottom of the
// nearest list. The capability is intact, just relocated; do not re-add it
// here or the same pp figure renders twice on one screen.
// ─────────────────────────────────────────────────────────────────────────────

import Link from "next/link";
import { IconWithFallback } from "@/components/IconWithFallback";
import PanelHeading from "@/components/hextech/PanelHeading";
import type { MyStatsChampionRow } from "@/components/hextech/myStats";

function pctText(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

/**
 * Per the original brief's bands: green >=52%, grey 45-52%, red <45%.
 *
 * `lowSample` (fewer than MYSTATS_LOW_SAMPLE_THRESHOLD games) forces grey,
 * 2026-07-29. Without it this card painted "Shen · Mid · 2g · 100.0%" in the
 * same signal green as a 19-game champion, which reads as a strength rather
 * than as two games — and the /mystats matchup table directly below it has
 * always muted its own low-sample rows, so the page contradicted itself. Colour
 * is state, not decoration: a number that cannot yet mean anything gets no
 * colour.
 */
function wrColorClass(winrate: number, lowSample: boolean): string {
  if (lowSample) return "text-mut";
  const pct = winrate * 100;
  if (pct >= 52) return "text-good";
  if (pct < 45) return "text-bad";
  return "text-mut";
}
function wrBarClass(winrate: number, lowSample: boolean): string {
  if (lowSample) return "bg-mut/50";
  const pct = winrate * 100;
  if (pct >= 52) return "bg-good";
  if (pct < 45) return "bg-bad";
  return "bg-mut/70";
}

export interface ChampionPoolCardProps {
  rows: MyStatsChampionRow[];
}

export default function ChampionPoolCard({ rows }: ChampionPoolCardProps) {
  if (rows.length === 0) {
    return (
      <div className="bg-panel border border-line rounded-xl p-8 text-center">
        <p className="text-mut text-[12px]">No champion pool data yet this season.</p>
      </div>
    );
  }

  const totalGames = rows.reduce((sum, r) => sum + r.games, 0);

  return (
    <div className="bg-panel border border-line rounded-xl px-4 sm:px-5 pt-4 pb-1">
      {/* Meta names this list's own denominator: these are SEASON records per
          (champion, role), summing to the same total the KPI strip shows —
          deliberately not the recent-games window next to it. */}
      <PanelHeading meta={`${rows.length} champions · ${totalGames} games`}>Champion pool</PanelHeading>
      {rows.map((row) => (
        // Your own most-played champions are the shortest possible route into a
        // build — leaving them inert made this the third dead-end list in the app.
        <Link
          // Rows are per (champion, ROLE), not per champion — `buildMyStatsRows`
          // maps one record per pair. Keying on championId alone gave DUPLICATE
          // React keys the moment a champion was played in two roles, which is
          // common: this account had Viktor x3, Swain x3, Galio/Karma/Mel x2.
          // Duplicate keys make reconciliation undefined, so a re-render could
          // reuse the wrong row's DOM node.
          key={`${row.championId}-${row.role}`}
          href={`/?championId=${row.championId}&role=${row.role}`}
          aria-label={`See the build for ${row.name} ${row.roleLabel}`}
          className="flex items-center gap-3 py-2.5 border-b border-line last:border-b-0 rounded-md transition-colors hover:bg-white/[0.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal"
        >
          <span className="w-8 h-8 rounded-lg bg-black/30 border border-line overflow-hidden flex items-center justify-center flex-shrink-0">
            <IconWithFallback src={row.icon} alt="" fallbackGlyph={row.name} className="w-full h-full object-cover" size={32} />
          </span>

          <div className="min-w-0 flex-1">
            <p className="text-[12.5px] text-txt font-semibold truncate">{row.name}</p>
            {/* The ROLE is what distinguishes two rows for the same champion.
                Without it this card rendered visually IDENTICAL lines — this
                account had two "Mel 1g 0.0%" rows with nothing to tell them
                apart, which reads as a duplication bug rather than as two
                different lanes. `roleLabel` was already on the row, unused. */}
            <p className="text-[10px] text-mut tabular-nums">
              {row.roleLabel} · {row.games}g
            </p>
          </div>

          <div className="w-16 h-1.5 rounded-full bg-white/[0.06] overflow-hidden flex-shrink-0 hidden sm:block">
            <div
              className={`h-full rounded-full ${wrBarClass(row.winrate, row.lowSample)}`}
              style={{ width: `${Math.max(0, Math.min(100, row.winrate * 100))}%` }}
            />
          </div>

          <span
            className={`text-[12.5px] font-bold tabular-nums w-12 text-right flex-shrink-0 ${wrColorClass(
              row.winrate,
              row.lowSample
            )}`}
          >
            {pctText(row.winrate)}
          </span>
        </Link>
      ))}
    </div>
  );
}
