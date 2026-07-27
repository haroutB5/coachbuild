"use client";

// ─────────────────────────────────────────────────────────────────────────────
// ChampionPoolCard — /mystats' "CHAMPION POOL" card (mockup 6.png). Consumes
// the existing MyStatsChampionRow[] (myStats.ts's buildMyStatsRows — already
// games-DESC sorted server-side, not re-sorted here) plus the v0.51 wave-B
// EXTENDED summary's winrateOnBuild/winrateOffBuild for the insight line.
// ─────────────────────────────────────────────────────────────────────────────

import Link from "next/link";
import { IconWithFallback } from "@/components/IconWithFallback";
import type { MyStatsChampionRow } from "@/components/hextech/myStats";

function pctText(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

/** Per the brief's exact bands: green >=52%, grey 45-52%, red <45%. */
function wrColorClass(winrate: number): string {
  const pct = winrate * 100;
  if (pct >= 52) return "text-good";
  if (pct < 45) return "text-bad";
  return "text-mut";
}
function wrBarClass(winrate: number): string {
  const pct = winrate * 100;
  if (pct >= 52) return "bg-good";
  if (pct < 45) return "bg-bad";
  return "bg-mut/70";
}

export interface ChampionPoolCardProps {
  rows: MyStatsChampionRow[];
  /** Fractions 0-1 — both must be present for the insight line to render
   *  (an honest comparison needs both sides of the split, not a fabricated
   *  half-known claim). */
  winrateOnBuild: number | null;
  winrateOffBuild: number | null;
}

export default function ChampionPoolCard({ rows, winrateOnBuild, winrateOffBuild }: ChampionPoolCardProps) {
  if (rows.length === 0) {
    return (
      <div className="bg-panel border border-line rounded-xl p-8 text-center">
        <p className="text-mut text-[12px]">No champion pool data yet this season.</p>
      </div>
    );
  }

  const showInsight = winrateOnBuild !== null && winrateOffBuild !== null;
  const insightDiff = showInsight ? (winrateOnBuild - winrateOffBuild) * 100 : 0;

  return (
    <div className="bg-panel border border-line rounded-xl px-5">
      <p className="pt-4 pb-2 text-[11px] tracking-[0.12em] uppercase text-mut font-semibold">Champion pool</p>
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

          <div className="w-16 h-1.5 rounded-full bg-panel2 overflow-hidden flex-shrink-0 hidden sm:block">
            <div
              className={`h-full rounded-full ${wrBarClass(row.winrate)}`}
              style={{ width: `${Math.max(0, Math.min(100, row.winrate * 100))}%` }}
            />
          </div>

          <span className={`text-[12.5px] font-bold tabular-nums w-12 text-right flex-shrink-0 ${wrColorClass(row.winrate)}`}>
            {pctText(row.winrate)}
          </span>
        </Link>
      ))}

      {showInsight && (
        <p className="py-3 text-[11px] text-mut leading-relaxed border-t border-line/60">
          Insight: your WR on games where you followed the WPA build is{" "}
          <span className={insightDiff >= 0 ? "text-good font-semibold" : "text-bad font-semibold"}>
            {insightDiff >= 0 ? "+" : ""}
            {insightDiff.toFixed(1)}pp
          </span>{" "}
          {insightDiff >= 0 ? "higher" : "lower"}.
        </p>
      )}
    </div>
  );
}
